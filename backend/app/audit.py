"""Append-only audit trail: every agent step, tool call, approval, submission and outcome."""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection

from app.db import jsonb

log = logging.getLogger("audit")


async def audit(
    conn: AsyncConnection,
    event: str,
    *,
    merchant_id: UUID | str | None = None,
    dispute_id: UUID | str | None = None,
    data: dict[str, Any] | None = None,
) -> None:
    log.info("%s merchant=%s dispute=%s", event, merchant_id, dispute_id)
    await conn.execute(
        "insert into audit_log (merchant_id, dispute_id, event, data_json) values (%s, %s, %s, %s)",
        (merchant_id, dispute_id, event, jsonb(data or {})),
    )
