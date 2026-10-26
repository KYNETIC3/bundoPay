import time

import httpx

from fastapi import APIRouter, Depends, HTTPException

from app.auth import CurrentMerchant, current_merchant
from app.config import get_settings

from . import service

router = APIRouter(prefix="/demo")
RESET_COOLDOWN_SECONDS = 60
_last_reset = 0.0


@router.get("/info")
async def info() -> dict:
    """Public: lets the login page say a demo login exists. The password is never served."""
    email = get_settings().demo_email
    return {"enabled": bool(email), "email": email or None}


@router.post("/reset")
async def reset(merchant: CurrentMerchant = Depends(current_merchant)) -> dict:
    global _last_reset
    if not service.is_demo(merchant.email):
        raise HTTPException(403, "Only the demo account can be reset.")
    wait = RESET_COOLDOWN_SECONDS - (time.monotonic() - _last_reset)
    if wait > 0:
        raise HTTPException(429, f"The demo was just reset. Try again in {int(wait) + 1} seconds.")
    _last_reset = time.monotonic()
    try:
        await service.reset(merchant.id)
    except service.DemoError as exc:
        raise HTTPException(500, str(exc)) from exc
    return {"status": "reset"}


SESSION_WINDOW_SECONDS = 60
SESSION_MAX_PER_WINDOW = 20
_session_times: list[float] = []


@router.post("/session")
async def session() -> dict:
    """Public, one click: signs in to the shared demo account and hands the browser its session, so judges and
    investors never type a password or connect PayPal. The demo is already connected to the sandbox business account."""
    s = get_settings()
    if not (s.demo_email and s.demo_password and s.supabase_service_role_key):
        raise HTTPException(404, "The demo isn't set up on this server.")
    now = time.monotonic()
    _session_times[:] = [t for t in _session_times if now - t < SESSION_WINDOW_SECONDS]
    if len(_session_times) >= SESSION_MAX_PER_WINDOW:
        raise HTTPException(429, "Lots of people are opening the demo. Try again in a minute.")
    _session_times.append(now)
    key = s.supabase_service_role_key
    async with httpx.AsyncClient(base_url=f"{s.supabase_url}/auth/v1", timeout=20, headers={"apikey": key}) as client:
        r = await client.post("/token", params={"grant_type": "password"}, json={"email": s.demo_email, "password": s.demo_password})
    if r.status_code != 200:
        raise HTTPException(502, "The demo login didn't work. Run `python -m app.demo` on the server to set it up.")
    body = r.json()
    return {"access_token": body["access_token"], "refresh_token": body["refresh_token"]}
