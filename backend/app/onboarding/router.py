from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import CurrentMerchant, current_merchant
from app.config import get_settings
from app.demo.service import is_demo
from app.db import connection
from app.paypal_gateway import THIRD_PARTY_FEATURES

from . import service

router = APIRouter(prefix="/onboarding")


class CompleteBody(BaseModel):
    tracking_id: str
    merchant_id_in_paypal: str
    permissions_granted: bool


@router.get("/permissions")
async def requested_permissions() -> dict:
    return {"features": THIRD_PARTY_FEATURES, "dev_test_mode": get_settings().paypal_dev_self_merchant}


@router.post("/dev-connect")
async def dev_connect(merchant: CurrentMerchant = Depends(current_merchant)) -> dict:
    """Developer-only: use the app's own sandbox business account (see PAYPAL_DEV_SELF_MERCHANT)."""
    if not get_settings().paypal_dev_self_merchant:
        raise HTTPException(404, "Not found")
    try:
        return await service.dev_connect_self(merchant.id)
    except service.OnboardingError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/start")
async def start(merchant: CurrentMerchant = Depends(current_merchant)) -> dict:
    try:
        return {"action_url": await service.start(merchant.id)}
    except service.OnboardingError as exc:
        raise HTTPException(502, str(exc)) from exc


@router.post("/complete")
async def complete(body: CompleteBody, merchant: CurrentMerchant = Depends(current_merchant)) -> dict:
    try:
        return await service.complete(
            merchant.id,
            tracking_id=body.tracking_id,
            paypal_merchant_id=body.merchant_id_in_paypal,
            permissions_granted=body.permissions_granted,
        )
    except service.OnboardingError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/status")
async def status(merchant: CurrentMerchant = Depends(current_merchant)) -> dict:
    async with connection() as conn:
        cur = await conn.execute(
            "select email, paypal_merchant_id, grant_status, granted_scopes, connected_at, last_synced_at "
            "from merchants where id = %s",
            (merchant.id,),
        )
        row = await cur.fetchone()
    own_id = get_settings().paypal_partner_merchant_id
    return {**row, "test_mode": bool(own_id) and row["paypal_merchant_id"] == own_id, "is_demo": is_demo(merchant.email)}


@router.post("/disconnect")
async def disconnect(merchant: CurrentMerchant = Depends(current_merchant)) -> dict:
    await service.disconnect(merchant.id)
    return {"status": "not_connected"}
