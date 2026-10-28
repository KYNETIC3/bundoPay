import json
from contextlib import asynccontextmanager

import httpx
import pytest

from app.checkout import router as checkout
from app.main import app


class FakeConn:
    """One merchant uses the app's own PayPal account; records which merchants were asked for."""

    def __init__(self, merchants):
        self.merchants = merchants
        self.calls = []

    async def execute(self, sql, params):
        self.calls.append((sql, params))
        rows = self.merchants

        class Cur:
            async def fetchall(self):
                return rows

        return Cur()


@pytest.fixture
def store(monkeypatch, settings, gateway):
    checkout._calls.clear()
    monkeypatch.setattr(checkout, "get_settings", lambda: settings)
    monkeypatch.setattr(checkout, "get_gateway", lambda: gateway)
    fake = FakeConn([{"id": "merchant-1"}])

    @asynccontextmanager
    async def connection():
        yield fake

    monkeypatch.setattr(checkout, "connection", connection)
    recorded = []

    async def record_capture(conn, merchant_id, capture):
        recorded.append((merchant_id, capture))
        return True

    monkeypatch.setattr(checkout, "record_capture", record_capture)
    return {"conn": fake, "recorded": recorded}


@pytest.fixture
async def client():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        yield c


def completed_capture(order_id="5O190127TN364715T"):
    return {
        "id": order_id,
        "status": "COMPLETED",
        "purchase_units": [
            {
                "payments": {
                    "captures": [
                        {
                            "id": "3C679366HH908993F",
                            "status": "COMPLETED",
                            "amount": {"currency_code": "USD", "value": "40.00"},
                            "create_time": "2026-10-28T10:00:00Z",
                        }
                    ]
                }
            }
        ],
    }


async def test_config_gives_the_public_client_id_and_products_but_never_the_secret(client, store):
    body = (await client.get("/checkout/config")).json()
    assert body["enabled"] is True
    assert body["client_id"] == "PARTNER_CLIENT"
    assert [p["id"] for p in body["products"]] == ["tote", "jacket", "wholesale"]
    assert "PARTNER_SECRET" not in json.dumps(body)


async def test_the_price_comes_from_the_catalog_not_the_browser(client, store, paypal):
    route = paypal.post("/v2/checkout/orders").mock(return_value=httpx.Response(201, json={"id": "5O190127TN364715T"}))
    resp = await client.post("/checkout/orders", json={"product_id": "tote", "amount": "0.01"})
    assert resp.status_code == 200 and resp.json() == {"orderId": "5O190127TN364715T"}
    sent = json.loads(route.calls.last.request.content)
    assert sent["intent"] == "CAPTURE"
    assert sent["purchase_units"][0]["amount"] == {"currency_code": "USD", "value": "40.00"}
    assert route.calls.last.request.headers["PayPal-Request-Id"].startswith("store-")
    # The app's own account is the payee: no auth assertion for another merchant.
    assert "PayPal-Auth-Assertion" not in route.calls.last.request.headers


async def test_unknown_products_are_refused(client, store, paypal):
    route = paypal.post("/v2/checkout/orders")
    assert (await client.post("/checkout/orders", json={"product_id": "free-money"})).status_code == 404
    assert not route.called


async def test_capture_is_idempotent_and_records_the_sale_for_the_tax_reserve(client, store, paypal):
    route = paypal.post("/v2/checkout/orders/5O190127TN364715T/capture").mock(
        return_value=httpx.Response(201, json=completed_capture())
    )
    body = (await client.post("/checkout/orders/5O190127TN364715T/capture")).json()
    assert body == {"status": "COMPLETED", "capture_id": "3C679366HH908993F", "amount": "40.00", "currency": "USD", "recorded": True}
    assert route.calls.last.request.headers["PayPal-Request-Id"] == "capture-5O190127TN364715T"
    [(merchant_id, capture)] = store["recorded"]
    assert merchant_id == "merchant-1" and capture["id"] == "3C679366HH908993F" and str(capture["amount"]) == "40.00"
    # Only merchants whose PayPal account is the app's own account get the sale.
    assert store["conn"].calls[0][1] == ("PARTNERPAYERID",)


async def test_an_uncompleted_capture_records_nothing(client, store, paypal):
    pending = completed_capture()
    pending["purchase_units"][0]["payments"]["captures"][0]["status"] = "PENDING"
    paypal.post("/v2/checkout/orders/5O190127TN364715T/capture").mock(return_value=httpx.Response(201, json=pending))
    body = (await client.post("/checkout/orders/5O190127TN364715T/capture")).json()
    assert body["recorded"] is False and store["recorded"] == []


async def test_a_malformed_order_id_never_reaches_paypal(client, store, paypal):
    assert (await client.post("/checkout/orders/not-an-id/capture")).status_code == 400


async def test_the_public_store_is_rate_limited(client, store, paypal, monkeypatch):
    monkeypatch.setattr(checkout, "MAX_CALLS", 2)
    paypal.post("/v2/checkout/orders").mock(return_value=httpx.Response(201, json={"id": "5O190127TN364715T"}))
    codes = [(await client.post("/checkout/orders", json={"product_id": "tote"})).status_code for _ in range(3)]
    assert codes == [200, 200, 429]


async def test_the_store_is_off_without_sandbox_keys(client, store, monkeypatch, settings):
    monkeypatch.setattr(checkout, "get_settings", lambda: settings.model_copy(update={"paypal_partner_client_secret": ""}))
    assert (await client.post("/checkout/orders", json={"product_id": "tote"})).status_code == 503
