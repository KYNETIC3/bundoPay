from contextlib import asynccontextmanager
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.auth import CurrentMerchant, current_merchant
from app.disputes import router as disputes_router
from app.main import app

A = CurrentMerchant(id=uuid4(), email="a@example.com")
B = CurrentMerchant(id=uuid4(), email="b@example.com")

# merchant_records as stored, newest first (the query's order by imported_at desc).
TABLE = [
    (A.id, "shipments", {"order_id": "A-2", "carrier": "UPS", "tracking_number": "1Z2", "status": "delivered"}),
    (B.id, "shipments", {"order_id": "B-1", "carrier": "DHL", "tracking_number": "JD1"}),
    (A.id, "shipments", {"order_id": "A-1", "carrier": "USPS", "tracking_number": "94001"}),
    (A.id, "orders", {"order_id": "A-1", "order_date": "2026-10-01", "total": "40.00", "currency": "USD"}),
]


class FakeConn:
    """Serves merchant_records filtered the way the SQL filters them, and records what was asked."""

    def __init__(self):
        self.calls = []

    async def execute(self, sql, params):
        self.calls.append((sql, params))
        merchant_id, kind, limit = params
        rows = [{"data": d} for m, k, d in TABLE if m == merchant_id and k == kind][:limit]

        class Cur:
            async def fetchall(self):
                return rows

        return Cur()


@pytest.fixture
def conn(monkeypatch):
    fake = FakeConn()

    @asynccontextmanager
    async def connection():
        yield fake

    monkeypatch.setattr(disputes_router, "connection", connection)
    return fake


@pytest.fixture
def client():
    yield TestClient(app)  # no lifespan, no database
    app.dependency_overrides.clear()


def _as(merchant):
    app.dependency_overrides[current_merchant] = lambda: merchant


def test_returns_only_the_callers_rows_newest_first_with_every_column(client, conn):
    _as(A)
    body = client.get("/data/records?kind=shipments").json()

    assert body["kind"] == "shipments"
    assert [r["order_id"] for r in body["rows"]] == ["A-2", "A-1"]
    assert body["rows"][0]["status"] == "delivered"
    assert body["rows"][1]["status"] is None  # absent optional column comes back as null
    sql, params = conn.calls[0]
    assert params == (A.id, "shipments", 5000)
    assert "merchant_id = %s" in sql and "order by imported_at desc" in sql


def test_merchant_b_cannot_see_merchant_a_rows(client, conn):
    _as(B)
    rows = client.get("/data/records?kind=shipments").json()["rows"]
    assert [r["order_id"] for r in rows] == ["B-1"]
    assert client.get("/data/records?kind=orders").json()["rows"] == []


def test_limit_is_passed_through_and_capped(client, conn):
    _as(A)
    assert len(client.get("/data/records?kind=shipments&limit=1").json()["rows"]) == 1
    assert conn.calls[-1][1][2] == 1
    for bad in (0, 5001):
        assert client.get(f"/data/records?kind=shipments&limit={bad}").status_code == 422


def test_unknown_kind_is_400(client, conn):
    _as(A)
    resp = client.get("/data/records?kind=customers")
    assert resp.status_code == 400
    assert conn.calls == []


def test_requires_sign_in(client, conn):
    assert client.get("/data/records?kind=orders").status_code == 401
    assert conn.calls == []
