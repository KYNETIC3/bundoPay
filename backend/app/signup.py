"""Optional instant sign-up for testing. Supabase's built-in email sender allows only a few emails an hour, so a
confirmation-email sign-up soon fails with "email rate limit exceeded". With AUTO_CONFIRM_SIGNUPS=true the server creates
the account already confirmed (no email), and the browser then signs in normally. Off by default: it skips proving
the address is the person's own, so it is for sandbox and demo use only."""

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.config import get_settings

router = APIRouter(prefix="/auth")


class SignupBody(BaseModel):
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=254)
    password: str = Field(min_length=8, max_length=128)


@router.get("/config")
async def config() -> dict[str, bool]:
    return {"auto_confirm_signups": get_settings().auto_confirm_signups}


@router.post("/signup")
async def signup(body: SignupBody) -> dict[str, str]:
    s = get_settings()
    if not s.auto_confirm_signups or not s.supabase_service_role_key:
        raise HTTPException(404, "Instant sign-up is off")
    key = s.supabase_service_role_key
    async with httpx.AsyncClient(base_url=f"{s.supabase_url}/auth/v1", timeout=20,
                                 headers={"apikey": key, "Authorization": f"Bearer {key}"}) as client:
        r = await client.post("/admin/users", json={"email": body.email, "password": body.password, "email_confirm": True})
    if r.status_code in (409, 422) and "already" in r.text.lower():
        raise HTTPException(409, "That email already has an account. Sign in instead.")
    if r.status_code >= 400:
        try:
            msg = r.json().get("msg") or r.json().get("message") or "Couldn't create the account"
        except ValueError:
            msg = "Couldn't create the account"
        raise HTTPException(400, msg)
    return {"status": "created"}
