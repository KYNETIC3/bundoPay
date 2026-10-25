from contextlib import asynccontextmanager
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.auth import CurrentMerchant, current_merchant
from app.main import app
from app.treasury import router as treasury_router

ME = CurrentMerchant(id=uuid4(), email="owner@example.com")


class FakeConn:
    """Answers the two insights queries in order and records what was asked."""

    def __init__(self, results):
        self.results, self.calls = list(results), []

    async def execute(self, sql, params):
        self.calls.append((sql, params))
        rows = self.results.pop(0)

        class Cur:
            async def fetchall(self):
                return rows

        return Cur()


@pytest.fixture
def client():
    app.dependency_overrides[current_merchant] = lambda: ME
    yield TestClient(app)  # no lifespan, no database
    app.dependency_overrides.clear()


def _use(monkeypatch, conn):
    @asynccontextmanager
    async def connection():
        yield conn

    monkeypatch.setattr(treasury_router, "connection", connection)


def test_insights_returns_the_whole_window_and_auto_refunds(client, monkeypatch):
    dispute = uuid4()
    moves = [{"id": "m1", "kind": "tax_reserve", "amount": "12.50", "verdict": "allow", "status": "succeeded", "role": "tax_reserve"}]
    conn = FakeConn([moves, [{"dispute_id": dispute}]])
    _use(monkeypatch, conn)

    body = client.get("/treasury/insights?days=30").json()

    assert body == {"movements": moves, "auto_refunded": [str(dispute)]}
    # Scoped to this merchant and the requested window, with no row cap.
    assert all(params == (ME.id, 30) for _, params in conn.calls)
    assert "limit" not in conn.calls[0][0]


@pytest.mark.parametrize("days", [0, 367, "x"])
def test_insights_rejects_bad_windows(client, monkeypatch, days):
    _use(monkeypatch, FakeConn([]))
    assert client.get(f"/treasury/insights?days={days}").status_code == 422
