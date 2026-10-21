from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import CurrentMerchant, current_merchant
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
    return {"features": THIRD_PARTY_FEATURES}


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
        return await cur.fetchone()


@router.post("/disconnect")
async def disconnect(merchant: CurrentMerchant = Depends(current_merchant)) -> dict:
    await service.disconnect(merchant.id)
    return {"status": "not_connected"}
