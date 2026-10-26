"""The $0.01 account check: verified only when PayPal says the cent arrived."""

from uuid import uuid4

import httpx

from app.treasury import router

ACCT = {"role": "tax_reserve", "name": "Tax", "paypal_email": "tax@biz.example", "details_hash": "h1"}


def use(monkeypatch, gateway):
    monkeypatch.setattr(router, "get_gateway", lambda: gateway)


def batch(paypal, status, batch_id="B1"):
    paypal.post("/v1/payments/payouts").mock(return_value=httpx.Response(201, json={"batch_header": {"payout_batch_id": batch_id}}))
    paypal.get(f"/v1/payments/payouts/{batch_id}").mock(return_value=httpx.Response(200, json={
        "batch_header": {"batch_status": "SUCCESS"}, "items": [{"transaction_status": status}]}))


async def test_success_verifies(monkeypatch, gateway, paypal):
    use(monkeypatch, gateway)
    batch(paypal, "SUCCESS")
    status, message = await router._test_payout(uuid4(), ACCT, "USD")
    assert status == "SUCCESS" and "tax@biz.example" in message
    sent = paypal.calls[-2].request.content.decode()
    assert '"value":"0.01"' in sent.replace(" ", "")


async def test_unclaimed_tells_the_user_to_create_the_sandbox_account(monkeypatch, gateway, paypal):
    use(monkeypatch, gateway)
    batch(paypal, "UNCLAIMED")
    status, message = await router._test_payout(uuid4(), ACCT, "USD")
    assert status == "UNCLAIMED" and "developer.paypal.com" in message


async def test_paypal_rejection_sends_nothing_and_explains(monkeypatch, gateway, paypal):
    use(monkeypatch, gateway)
    paypal.post("/v1/payments/payouts").mock(return_value=httpx.Response(400, json={"name": "VALIDATION_ERROR", "message": "Receiver is invalid"}))
    status, message = await router._test_payout(uuid4(), ACCT, "USD")
    assert status == "ERROR" and "Nothing was sent" in message
