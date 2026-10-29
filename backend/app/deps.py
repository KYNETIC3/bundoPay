from __future__ import annotations

import time
from collections import defaultdict, deque
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import Depends, Header, HTTPException

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


def _count_llm_request(merchant_id: UUID, now: float) -> None:
    calls = _llm_calls[merchant_id]
    while calls and now - calls[0] > LLM_WINDOW_SECONDS:
        calls.popleft()
    if len(calls) >= get_settings().llm_requests_per_10_minutes:
        wait = int(LLM_WINDOW_SECONDS - (now - calls[0])) + 1
        raise HTTPException(429, f"That's a lot of questions at once. Try again in {wait} seconds.")
    calls.append(now)


def llm_rate_limit(merchant: CurrentMerchant = Depends(current_merchant)) -> CurrentMerchant:
    """Per-user cap on Gemini-backed requests, so one busy demo user can't use up the shared quota."""
    _count_llm_request(merchant.id, time.monotonic())
    return merchant


# (merchant, chart id) -> [first seen, turns so far]. A chart is one request however many turns it takes.
_chart_turns: dict[tuple[UUID, str], list[float]] = {}
# A dashboard's sub-agents share its chart id (one live dashboard took 29 turns), so this covers a whole dashboard.
MAX_TURNS_PER_CHART = 120


def chart_rate_limit(
    merchant: CurrentMerchant = Depends(current_merchant),
    chart_id: str | None = Header(default=None, alias="X-Bundo-Chart-Id", max_length=64),
) -> CurrentMerchant:
    """llm_rate_limit for AG Studio turns: the first turn of a chart counts as one request, later turns of the
    same chart (same merchant, within the window) are free up to MAX_TURNS_PER_CHART. No header counts every turn."""
    now = time.monotonic()
    if not chart_id:
        _count_llm_request(merchant.id, now)
        return merchant
    for key in [k for k, (seen, _) in _chart_turns.items() if now - seen > LLM_WINDOW_SECONDS]:
        del _chart_turns[key]
    entry = _chart_turns.get((merchant.id, chart_id))
    if entry is None:
        _count_llm_request(merchant.id, now)
        _chart_turns[(merchant.id, chart_id)] = [now, 1]
    elif entry[1] >= MAX_TURNS_PER_CHART:
        raise HTTPException(429, "That chart is taking too many steps. Try asking for something simpler.")
    else:
        entry[1] += 1
    return merchant
