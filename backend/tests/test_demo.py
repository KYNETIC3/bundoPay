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
    monkeypatch.setattr(demo_settings, "gemini_api_key", "")
    body = client.get("/demo/info").json()
    assert body == {"enabled": True, "email": "judge@bundopay.test", "ai": False}
    assert "s3cret" not in str(body)


def test_info_reports_disabled_without_demo_email(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "demo_email", "")
    monkeypatch.setattr(get_settings(), "gemini_api_key", "k")
    assert client.get("/demo/info").json() == {"enabled": False, "email": None, "ai": True}


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


def test_demo_policies_are_the_runbook_rules():
    specs = {d.spec.kind: d.spec.model_dump(mode="json") for d in service.DEMO_POLICIES}
    assert specs == {
        "tax_reserve": {"kind": "tax_reserve", "rate": "0.0825"},
        "dispute_buffer": {"kind": "dispute_buffer", "coverage": "1.00", "volume_pct": "0.0200"},
        "ad_sweep": {"kind": "ad_sweep", "weekday": 4, "hour": 9, "amount": "15000.00"},
    }


async def test_reset_seeds_three_approved_policies(monkeypatch):
    calls = []

    async def create(conn, mid, doc, *, created_by):
        calls.append(("create", doc.spec.kind, created_by))
        return {"policy_id": f"p-{doc.spec.kind}", "version": 1, "spec_hash": f"h-{doc.spec.kind}"}

    async def approve(conn, mid, pid, version, *, spec_hash_seen, approver):
        calls.append(("approve", pid, spec_hash_seen))

    class Conn:
        async def execute(self, sql, params=None):
            calls.append(("sql", "simulated_hash" in sql))

    monkeypatch.setattr(service, "create_policy", create)
    monkeypatch.setattr(service, "approve_version", approve)
    await service.seed_policies(Conn(), DEMO.id)
    assert [c for c in calls if c[0] == "approve"] == [
        ("approve", "p-tax_reserve", "h-tax_reserve"), ("approve", "p-dispute_buffer", "h-dispute_buffer"),
        ("approve", "p-ad_sweep", "h-ad_sweep"),
    ]
    assert calls.count(("sql", True)) == 3 and all(c[2] == "owner" for c in calls if c[0] == "create")


def test_progress_is_demo_only_and_derived_from_data(demo_settings, client, monkeypatch):
    steps = {"sale": True, "reserve": True, "dispute": False, "approved": False, "verified": False}

    async def progress(mid):
        assert mid == DEMO.id
        return steps

    monkeypatch.setattr(service, "progress", progress)
    app.dependency_overrides[current_merchant] = lambda: OTHER
    assert client.get("/demo/progress").status_code == 403
    app.dependency_overrides[current_merchant] = lambda: DEMO
    assert client.get("/demo/progress").json() == {"steps": steps}


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
