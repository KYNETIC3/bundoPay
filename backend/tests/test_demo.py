from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app import deps
from app.auth import CurrentMerchant, current_merchant
from app.config import get_settings
from app.demo import router as demo_router
from app.demo import service
from app.jobs import worker
from app.main import app

DEMO = CurrentMerchant(id=uuid4(), email="Judge@BundoPay.test")
OTHER = CurrentMerchant(id=uuid4(), email="someone@example.com")


@pytest.fixture
def demo_settings(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "demo_email", "judge@bundopay.test")
    monkeypatch.setattr(s, "demo_account_emails", "op@x.test, tax@x.test, buf@x.test, ad@x.test")
    monkeypatch.setattr(demo_router, "_last_reset", 0.0)
    return s


@pytest.fixture
def client():
    yield TestClient(app)  # no lifespan, no database
    app.dependency_overrides.clear()


def test_info_never_serves_the_password(demo_settings, client, monkeypatch):
    monkeypatch.setattr(demo_settings, "demo_password", "s3cret-password")
    body = client.get("/demo/info").json()
    assert body == {"enabled": True, "email": "judge@bundopay.test"}
    assert "s3cret" not in str(body)


def test_info_reports_disabled_without_demo_email(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "demo_email", "")
    assert client.get("/demo/info").json() == {"enabled": False, "email": None}


def test_only_the_demo_account_can_reset(demo_settings, client, monkeypatch):
    called = []
    monkeypatch.setattr(service, "reset", lambda mid: called.append(mid) or _done())
    app.dependency_overrides[current_merchant] = lambda: OTHER
    assert client.post("/demo/reset").status_code == 403
    assert called == []


def test_demo_reset_is_case_insensitive_and_rate_limited(demo_settings, client, monkeypatch):
    called = []
    monkeypatch.setattr(service, "reset", lambda mid: called.append(mid) or _done())
    app.dependency_overrides[current_merchant] = lambda: DEMO
    assert client.post("/demo/reset").status_code == 200
    second = client.post("/demo/reset")
    assert second.status_code == 429 and "seconds" in second.json()["detail"]
    assert called == [DEMO.id]


def test_reset_needs_four_account_emails(demo_settings, monkeypatch):
    monkeypatch.setattr(demo_settings, "demo_account_emails", "op@x.test,tax@x.test")
    with pytest.raises(service.DemoError):
        service.account_emails()


def test_nightly_reset_scheduled_only_when_demo_enabled(demo_settings, monkeypatch):
    jobs = {j.func.__name__ for j in worker.make_scheduler().get_jobs()}
    assert "reset_demo_account" in jobs
    monkeypatch.setattr(demo_settings, "demo_email", "")
    assert "reset_demo_account" not in {j.func.__name__ for j in worker.make_scheduler().get_jobs()}


def test_llm_rate_limit_is_per_user(monkeypatch):
    monkeypatch.setattr(get_settings(), "llm_requests_per_10_minutes", 2)
    deps._llm_calls.clear()
    deps.llm_rate_limit(DEMO)
    deps.llm_rate_limit(DEMO)
    with pytest.raises(deps.HTTPException) as exc:
        deps.llm_rate_limit(DEMO)
    assert exc.value.status_code == 429
    deps.llm_rate_limit(OTHER)  # someone else still has their own allowance
    deps._llm_calls.clear()


async def _done():
    return None
