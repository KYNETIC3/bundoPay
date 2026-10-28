import time

from fastapi import APIRouter, Depends, HTTPException

from app.auth import CurrentMerchant, current_merchant
from app.config import get_settings

from . import service

router = APIRouter(prefix="/demo")
RESET_COOLDOWN_SECONDS = 60
_last_reset = 0.0


@router.get("/info")
async def info() -> dict:
    """Public: lets the login page say a demo login exists, and whether Gemini is on. The password is never served."""
    settings = get_settings()
    return {"enabled": bool(settings.demo_email), "email": settings.demo_email or None, "ai": bool(settings.gemini_api_key)}


@router.get("/progress")
async def progress(merchant: CurrentMerchant = Depends(current_merchant)) -> dict:
    if not service.is_demo(merchant.email):
        raise HTTPException(403, "The guide is only for the demo account.")
    return {"steps": await service.progress(merchant.id)}


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
