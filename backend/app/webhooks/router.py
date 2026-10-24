"""PayPal webhooks: verify the signature with PayPal, then enqueue a re-fetch. Nothing in the event body
is trusted beyond identifying which dispute or payout batch to re-fetch."""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, HTTPException, Request

from app.audit import audit
from app.db import connection
from app.deps import get_gateway
from app.jobs.queue import enqueue
from app.paypal_gateway import PayPalError, TransientPayPalError
from app.treasury.triggers import capture_from_paypal, record_capture

log = logging.getLogger(__name__)
router = APIRouter()

DISPUTE_EVENTS = {"CUSTOMER.DISPUTE.CREATED", "CUSTOMER.DISPUTE.UPDATED", "CUSTOMER.DISPUTE.RESOLVED"}
PAYOUT_PREFIXES = ("PAYMENT.PAYOUTSBATCH.", "PAYMENT.PAYOUTS-ITEM.")
CAPTURE_EVENTS = {"PAYMENT.CAPTURE.COMPLETED"}


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

    if str(event.get("event_type") or "").startswith(PAYOUT_PREFIXES):
        return await _payout_event(event)
    if event.get("event_type") in CAPTURE_EVENTS:
        return await _capture_event(event)
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
                {"merchant_id": str(m["id"]), "paypal_merchant_id": m["paypal_merchant_id"], "paypal_dispute_id": dispute_id,
                 "trigger": "webhook"},
                dedupe_key=f"dispute:{m['id']}:{dispute_id}",
            )
            await audit(
                conn,
                "webhook.received",
                merchant_id=m["id"],
                data={"event_id": event.get("id"), "event_type": event["event_type"], "dispute_id": dispute_id},
            )
    return {"status": "queued"}


async def _payout_event(event: dict) -> dict[str, str]:
    resource = event.get("resource") or {}
    batch = (resource.get("batch_header") or {}).get("payout_batch_id") or resource.get("payout_batch_id")
    if not batch:
        return {"status": "ignored"}
    async with connection() as conn:
        cur = await conn.execute("select distinct merchant_id from movements where paypal_ref = %s", (batch,))
        merchants = await cur.fetchall()
        for m in merchants:
            await enqueue(conn, "confirm_payouts", {"merchant_id": str(m["merchant_id"])}, dedupe_key=f"payouts:{m['merchant_id']}")
            await audit(
                conn,
                "webhook.received",
                merchant_id=m["merchant_id"],
                label="provider_verified",
                data={"event_id": event.get("id"), "event_type": event["event_type"], "payout_batch": batch},
            )
    return {"status": "queued" if merchants else "ignored"}


async def _capture_event(event: dict) -> dict[str, str]:
    """Only the capture id is read from the event; the amount comes from PayPal on re-fetch."""
    resource = event.get("resource") or {}
    capture_id = resource.get("id")
    payee = (resource.get("payee") or {}).get("merchant_id")
    if not capture_id or not payee:
        return {"status": "ignored"}
    async with connection() as conn:
        cur = await conn.execute(
            "select id from merchants where paypal_merchant_id = %s and grant_status = 'granted'", (payee,)
        )
        merchants = await cur.fetchall()
    if not merchants:
        return {"status": "ignored"}
    try:
        capture = capture_from_paypal(await get_gateway().get_capture(capture_id))
    except TransientPayPalError as exc:
        raise HTTPException(503, "Capture lookup unavailable; retry") from exc
    except PayPalError:
        log.warning("Capture %s could not be fetched; ignoring the event", capture_id)
        return {"status": "ignored"}
    if capture is None:
        return {"status": "ignored"}
    async with connection() as conn:
        for m in merchants:
            await record_capture(conn, m["id"], capture)
    return {"status": "queued"}
