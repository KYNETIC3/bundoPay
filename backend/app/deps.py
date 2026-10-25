from __future__ import annotations

import time
from collections import defaultdict, deque
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import Depends, HTTPException

from app.auth import CurrentMerchant, current_merchant
from app.config import get_settings
from app.db import connection
from app.paypal_gateway import PayPalGateway, PermissionRevokedError

_gateway: PayPalGateway | None = None


def get_gateway() -> PayPalGateway:
    global _gateway
    if _gateway is None:
        _gateway = PayPalGateway(get_settings())
    return _gateway


async def close_gateway() -> None:
    global _gateway
    if _gateway is not None:
        await _gateway.aclose()
        _gateway = None


@asynccontextmanager
async def revocation_guard(merchant_id: UUID | str) -> AsyncIterator[None]:
    """Record a revoked grant when PayPal rejects a merchant-scoped call, then re-raise."""
    try:
        yield
    except PermissionRevokedError as exc:
        from app.audit import audit

        async with connection() as conn:
            await conn.execute("update merchants set grant_status = 'revoked' where id = %s", (merchant_id,))
            await audit(
                conn,
                "paypal.permission_revoked",
                merchant_id=merchant_id,
                data={"status": exc.status, "name": exc.name, "debug_id": exc.debug_id},
            )
        raise


_llm_calls: dict[UUID, deque[float]] = defaultdict(deque)
LLM_WINDOW_SECONDS = 600


def llm_rate_limit(merchant: CurrentMerchant = Depends(current_merchant)) -> CurrentMerchant:
    """Per-user cap on Gemini-backed requests, so one busy demo user can't use up the shared quota."""
    now = time.monotonic()
    calls = _llm_calls[merchant.id]
    while calls and now - calls[0] > LLM_WINDOW_SECONDS:
        calls.popleft()
    if len(calls) >= get_settings().llm_requests_per_10_minutes:
        wait = int(LLM_WINDOW_SECONDS - (now - calls[0])) + 1
        raise HTTPException(429, f"That's a lot of questions at once. Try again in {wait} seconds.")
    calls.append(now)
    return merchant
