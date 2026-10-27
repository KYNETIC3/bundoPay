import httpx
import respx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import signup
from app.config import Settings


def client(monkeypatch, on: bool):
    s = Settings(auto_confirm_signups=on, supabase_url="http://sb.test", supabase_service_role_key="svc", _env_file=None)
    monkeypatch.setattr(signup, "get_settings", lambda: s)
    app = FastAPI()
    app.include_router(signup.router)
    return TestClient(app)


def test_off_by_default(monkeypatch):
    c = client(monkeypatch, False)
    assert c.get("/auth/config").json() == {"auto_confirm_signups": False}
    assert c.post("/auth/signup", json={"email": "a@b.co", "password": "longenough"}).status_code == 404


def test_creates_a_confirmed_user_without_email(monkeypatch):
    c = client(monkeypatch, True)
    with respx.mock(base_url="http://sb.test") as m:
        route = m.post("/auth/v1/admin/users").mock(return_value=httpx.Response(200, json={"id": "u1"}))
        assert c.post("/auth/signup", json={"email": "a@b.co", "password": "longenough"}).json() == {"status": "created"}
    assert b'"email_confirm":true' in route.calls[0].request.content.replace(b" ", b"")


def test_existing_email_says_sign_in(monkeypatch):
    c = client(monkeypatch, True)
    with respx.mock(base_url="http://sb.test") as m:
        m.post("/auth/v1/admin/users").mock(return_value=httpx.Response(422, json={"msg": "A user with this email address has already been registered"}))
        r = c.post("/auth/signup", json={"email": "a@b.co", "password": "longenough"})
    assert r.status_code == 409 and "Sign in" in r.json()["detail"]
