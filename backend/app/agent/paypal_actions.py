"""The owner's decision on a PayPal change Ask Bundo proposed through the Agent Toolkit.

Approve runs only the stored proposal, only if its hash matches what the owner was shown, and only once:
the status moves from awaiting_approval to submitting in one conditional update before PayPal is called.
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from fastapi import HTTPException
from pydantic import BaseModel, Field

from app.audit import audit
from app.db import connection, jsonb

from . import paypal_toolkit as toolkit

log = logging.getLogger("paypal_actions")

COLUMNS = "id, tool, args_json, args_hash, status, error, created_at, decided_at"


class ActionDecision(BaseModel):
    args_hash: str = Field(min_length=64, max_length=64)


def _public(r: dict[str, Any]) -> dict[str, Any]:
    return {k: r[k] for k in ("id", "tool", "args_json", "args_hash", "status", "error", "created_at", "decided_at")}


async def load_actions(conn, merchant_id: UUID, ids: list[str]) -> list[dict[str, Any]]:
    try:
        uids = [UUID(x) for x in ids]
    except ValueError:
        return []
    if not uids:
        return []
    cur = await conn.execute(
        f"select {COLUMNS} from paypal_actions where merchant_id = %s and id = any(%s) order by created_at",
        (merchant_id, uids),
    )
    return [_public(r) for r in await cur.fetchall()]


async def approve_action(merchant_id: UUID, paypal_merchant_id: str | None, action_id: UUID, seen_hash: str, runner: Any = None) -> dict[str, Any]:
    if not toolkit.toolkit_enabled_for(paypal_merchant_id):
        raise HTTPException(409, "This PayPal account can't be changed from Ask Bundo.")
    async with connection() as conn:
        cur = await conn.execute(
            f"update paypal_actions set status = 'submitting', decided_at = now() "
            f"where id = %s and merchant_id = %s and status = 'awaiting_approval' and args_hash = %s returning {COLUMNS}",
            (action_id, merchant_id, seen_hash),
        )
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(409, "This change was already decided, or it changed since you saw it.")
        if toolkit.args_hash(row["tool"], row["args_json"]) != row["args_hash"]:
            await conn.execute("update paypal_actions set status = 'failed', error = 'hash mismatch' where id = %s", (action_id,))
            raise HTTPException(409, "This change doesn't match what was proposed.")
        await audit(conn, "paypal_action.approved", merchant_id=merchant_id, label="user_uploaded", actor="owner",
                    data={"action_id": str(action_id), "tool": row["tool"], "args_hash": row["args_hash"]})

    try:
        result = await (runner or toolkit.get_runner()).run(row["tool"], row["args_json"])
    except Exception as exc:  # the toolkit raises requests errors; keep PayPal's words, not a stack trace
        message = str(exc)[:300] or exc.__class__.__name__
        log.warning("Toolkit %s failed: %s", row["tool"], message)
        async with connection() as conn:
            await conn.execute("update paypal_actions set status = 'failed', error = %s where id = %s", (message, action_id))
            await audit(conn, "paypal_action.failed", merchant_id=merchant_id, data={"action_id": str(action_id), "error": message})
        raise HTTPException(502, f"PayPal didn't accept the change: {message}") from exc

    async with connection() as conn:
        cur = await conn.execute(
            f"update paypal_actions set status = 'done', result_json = %s where id = %s returning {COLUMNS}",
            (jsonb(result), action_id),
        )
        done = await cur.fetchone()
        await audit(conn, "paypal_action.done", merchant_id=merchant_id, label="provider_verified", actor="paypal",
                    data={"action_id": str(action_id), "tool": row["tool"], "via": "paypal-agent-toolkit"})
    return _public(done)


async def decline_action(merchant_id: UUID, action_id: UUID) -> dict[str, Any]:
    async with connection() as conn:
        cur = await conn.execute(
            f"update paypal_actions set status = 'declined', decided_at = now() "
            f"where id = %s and merchant_id = %s and status = 'awaiting_approval' returning {COLUMNS}",
            (action_id, merchant_id),
        )
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(409, "This change was already decided.")
        await audit(conn, "paypal_action.declined", merchant_id=merchant_id, actor="owner", data={"action_id": str(action_id)})
    return _public(row)
