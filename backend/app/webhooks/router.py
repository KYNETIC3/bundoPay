"""PayPal dispute webhooks: verify the signature with PayPal, then enqueue a re-fetch. Nothing in the
event body is trusted beyond identifying which dispute to re-fetch."""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, HTTPException, Request

from app.audit import audit
from app.db import connection
from app.deps import get_gateway
from app.jobs.queue import enqueue
from app.paypal_gateway import TransientPayPalError

log = logging.getLogger(__name__)
router = APIRouter()

DISPUTE_EVENTS = {"CUSTOMER.DISPUTE.CREATED", "CUSTOMER.DISPUTE.UPDATED", "CUSTOMER.DISPUTE.RESOLVED"}


@router.post("/webhooks/paypal")
async def paypal_webhook(request: Request) -> dict[str, str]:
    try:
        event = json.loads(await request.body())
    except ValueError as exc:
        raise HTTPException(400, "Invalid JSON") from exc

    try:
        verified = await get_gateway().verify_webhook_signature(dict(request.headers), event)
    except TransientPayPalError as exc:
        raise HTTPException(503, "Verification unavailable; retry") from exc  # PayPal will redeliver
    if not verified:
        log.warning("Rejected webhook with invalid signature: %s", event.get("id"))
        raise HTTPException(400, "Signature verification failed")

    if event.get("event_type") not in DISPUTE_EVENTS:
        return {"status": "ignored"}

    resource = event.get("resource") or {}
    dispute_id = resource.get("dispute_id")
    seller_ids = {
        (t.get("seller") or {}).get("merchant_id") for t in resource.get("disputed_transactions") or []
    } - {None}
    if not dispute_id or not seller_ids:
        return {"status": "ignored"}

    async with connection() as conn:
        cur = await conn.execute(
            "select id, paypal_merchant_id from merchants where paypal_merchant_id = any(%s) and grant_status = 'granted'",
            (list(seller_ids),),
        )
        merchants = await cur.fetchall()
        for m in merchants:
            await enqueue(
                conn,
                "sync_dispute",
                {"merchant_id": str(m["id"]), "paypal_merchant_id": m["paypal_merchant_id"], "paypal_dispute_id": dispute_id},
                dedupe_key=f"dispute:{m['id']}:{dispute_id}",
            )
            await audit(
                conn,
                "webhook.received",
                merchant_id=m["id"],
                data={"event_id": event.get("id"), "event_type": event["event_type"], "dispute_id": dispute_id},
            )
    return {"status": "queued"}
