from fastapi.testclient import TestClient

from app.main import app
from app.paypal_gateway import PayPalError


@app.get("/_test/paypal-403")
async def _raise_403():
    raise PayPalError(403, "NOT_AUTHORIZED", "Authorization failed due to insufficient permissions.", "dbg1")


def test_paypal_errors_reach_the_browser_with_cors_headers():
    client = TestClient(app)  # no context manager: skips lifespan, so no database is needed
    resp = client.get("/_test/paypal-403", headers={"Origin": "http://localhost:3000"})
    assert resp.status_code == 502
    assert resp.headers["access-control-allow-origin"] == "http://localhost:3000"
    detail = resp.json()["detail"]
    assert detail["code"] == "paypal_error" and detail["debug_id"] == "dbg1"
    assert "permission" in detail["message"]
