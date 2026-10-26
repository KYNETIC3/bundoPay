import httpx
import respx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.demo import router as demo


def client(monkeypatch, **kw):
    s = Settings(supabase_url="http://sb.test", supabase_service_role_key="svc", _env_file=None, **kw)
    monkeypatch.setattr(demo, "get_settings", lambda: s)
    demo._session_times.clear()
    app = FastAPI()
    app.include_router(demo.router)
    return TestClient(app)


def test_no_demo_configured(monkeypatch):
    assert client(monkeypatch).post("/demo/session").status_code == 404


def test_returns_the_demo_session_without_exposing_the_password(monkeypatch):
    c = client(monkeypatch, demo_email="judge@x.co", demo_password="pw-secret")
    with respx.mock(base_url="http://sb.test") as m:
        m.post("/auth/v1/token").mock(return_value=httpx.Response(200, json={"access_token": "a", "refresh_token": "r", "user": {}}))
        r = c.post("/demo/session")
    assert r.json() == {"access_token": "a", "refresh_token": "r"} and "pw-secret" not in r.text


def test_rate_limited(monkeypatch):
    c = client(monkeypatch, demo_email="judge@x.co", demo_password="pw")
    with respx.mock(base_url="http://sb.test") as m:
        m.post("/auth/v1/token").mock(return_value=httpx.Response(200, json={"access_token": "a", "refresh_token": "r"}))
        codes = [c.post("/demo/session").status_code for _ in range(demo.SESSION_MAX_PER_WINDOW + 1)]
    assert codes[-1] == 429
