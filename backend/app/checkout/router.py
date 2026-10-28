"""The test store: PayPal Checkout (JS SDK v6 in the browser, Orders v2 here), paid to the app's own sandbox
business account. A captured sale is a real sandbox capture, so it feeds the Tax Reserve the same way any
other sale does: the verified PAYMENT.CAPTURE.COMPLETED webhook re-fetches it and runs the tax reserve rule.

The buyer isn't signed in to BundoPay, so these routes are public. They take only a product id (the price
comes from the catalog), are rate-limited per IP, and never touch another merchant's account.
"""

from __future__ import annotations

import logging
import re
import time
import uuid
from collections import defaultdict, deque
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.config import get_settings
from app.db import connection
from app.deps import get_gateway
from app.treasury.triggers import capture_from_paypal, record_capture

from .catalog import CATALOG

log = logging.getLogger("checkout")
router = APIRouter(prefix="/checkout")

ORDER_ID = re.compile(r"^[A-Z0-9]{5,40}$")
WINDOW_SECONDS, MAX_CALLS = 600, 30
_calls: dict[str, deque[float]] = defaultdict(deque)


def store_rate_limit(request: Request) -> None:
    """Per-IP cap, so the public store can't be used to flood the sandbox account."""
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    calls = _calls[ip]
    while calls and now - calls[0] > WINDOW_SECONDS:
        calls.popleft()
    if len(calls) >= MAX_CALLS:
        raise HTTPException(429, "Too many test payments at once. Try again in a few minutes.")
    calls.append(now)


def _require_configured() -> None:
    s = get_settings()
    if not (s.paypal_partner_client_id and s.paypal_partner_client_secret and s.paypal_partner_merchant_id):
        raise HTTPException(503, {"code": "store_off", "message": "The test store needs the PayPal sandbox keys in backend/.env."})


@router.get("/config")
async def config() -> dict[str, Any]:
    s = get_settings()
    # The client id is public by design: PayPal's JS SDK needs it in the browser. The secret never leaves here.
    return {
        "enabled": bool(s.paypal_partner_client_id and s.paypal_partner_merchant_id),
        "client_id": s.paypal_partner_client_id,
        "products": [p.to_json() for p in CATALOG.values()],
    }


class OrderBody(BaseModel):
    product_id: str = Field(min_length=1, max_length=40)


@router.post("/orders", dependencies=[Depends(store_rate_limit)])
async def create_order(body: OrderBody) -> dict[str, str]:
    _require_configured()
    product = CATALOG.get(body.product_id)
    if product is None:
        raise HTTPException(404, "That product isn't in the store.")
    order = await get_gateway().create_order(
        amount=product.price,
        currency=product.currency,
        description=product.name,
        reference_id=product.id,
        request_id=f"store-{uuid.uuid4()}",
    )
    return {"orderId": order["id"]}


@router.post("/orders/{order_id}/capture", dependencies=[Depends(store_rate_limit)])
async def capture_order(order_id: str) -> dict[str, Any]:
    _require_configured()
    if not ORDER_ID.match(order_id):
        raise HTTPException(400, "That isn't a PayPal order id.")
    result = await get_gateway().capture_order(order_id, request_id=f"capture-{order_id}")
    captures = [c for pu in result.get("purchase_units", []) for c in (pu.get("payments") or {}).get("captures", [])]
    capture = captures[0] if captures else {}
    recorded = await _record_for_self(capture)
    amount = capture.get("amount") or {}
    return {
        "status": result.get("status"),
        "capture_id": capture.get("id"),
        "amount": amount.get("value"),
        "currency": amount.get("currency_code"),
        "recorded": recorded,
    }


async def _record_for_self(capture: dict[str, Any]) -> bool:
    """Record the sale for the merchant(s) using the app's own account, so the tax reserve runs even where
    webhooks aren't set up (a local machine). The webhook does the same later; the capture id keeps it to once."""
    parsed = capture_from_paypal(capture)
    if parsed is None:
        return False
    async with connection() as conn:
        cur = await conn.execute(
            "select id from merchants where paypal_merchant_id = %s and grant_status = 'granted'",
            (get_settings().paypal_partner_merchant_id,),
        )
        merchants = await cur.fetchall()
        for m in merchants:
            await record_capture(conn, m["id"], parsed)
    return bool(merchants)
