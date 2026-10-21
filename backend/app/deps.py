from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from uuid import UUID

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
