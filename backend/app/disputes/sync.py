"""Dispute sync: pulls disputes from PayPal (polling or webhook-triggered) and keeps local rows current."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection

from app.audit import audit
from app.db import connection, jsonb
from app.deps import get_gateway, revocation_guard
from app.jobs.queue import enqueue

from .model import parse_dispute, work_item_key

SYNC_OVERLAP = timedelta(hours=6)


async def upsert_dispute(conn: AsyncConnection, merchant_id: UUID, raw: dict[str, Any]) -> dict[str, Any]:
    """Store PayPal's view of a dispute. Returns the row plus whether this is a new work item."""
    facts = parse_dispute(raw)
    key = work_item_key(raw)
    cur = await conn.execute(
        "select id, status, work_item_key from disputes where merchant_id = %s and paypal_dispute_id = %s",
        (merchant_id, facts.dispute_id),
    )
    prev = await cur.fetchone()
    cur = await conn.execute(
        """
        insert into disputes (merchant_id, paypal_dispute_id, status, reason, lifecycle_stage, amount, currency,
                              due_date, work_item_key, raw_json, updated_at)
        values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
        on conflict (merchant_id, paypal_dispute_id) do update set
          status = excluded.status, reason = excluded.reason, lifecycle_stage = excluded.lifecycle_stage,
          amount = excluded.amount, currency = excluded.currency, due_date = excluded.due_date,
          work_item_key = excluded.work_item_key, raw_json = excluded.raw_json, updated_at = now()
        returning *
        """,
        (
            merchant_id,
            facts.dispute_id,
            facts.status,
            facts.reason,
            facts.lifecycle_stage,
            facts.amount,
            facts.currency,
            facts.due_date,
            key,
            jsonb(raw),
        ),
    )
    row = await cur.fetchone()
    new_work_item = facts.status == "WAITING_FOR_SELLER_RESPONSE" and (prev is None or prev["work_item_key"] != key)
    if prev is None or prev["status"] != facts.status:
        await audit(
            conn,
            "dispute.status_changed",
            merchant_id=merchant_id,
            dispute_id=row["id"],
            data={"from": prev["status"] if prev else None, "to": facts.status},
        )
    if new_work_item:
        # Drafts for an older evidence request no longer answer what PayPal is asking.
        await conn.execute(
            "update drafts set status = 'superseded', updated_at = now() "
            "where dispute_id = %s and status = 'awaiting_approval'",
            (row["id"],),
        )
        await conn.execute(
            "update approvals set revoked_at = now() where consumed_at is null and revoked_at is null "
            "and draft_id in (select id from drafts where dispute_id = %s)",
            (row["id"],),
        )
        await enqueue(conn, "run_agent", {"dispute_id": str(row["id"])}, dedupe_key=f"agent:{row['id']}:{key}")
        await audit(conn, "dispute.new_work_item", merchant_id=merchant_id, dispute_id=row["id"], data={"key": key})
    if facts.status == "RESOLVED":
        await record_outcome(conn, row, facts.outcome_code)
    return row


async def record_outcome(conn: AsyncConnection, dispute: dict[str, Any], outcome_code: str | None) -> None:
    """Tie the final result to the evidence map we submitted, so later recommendations can learn from it."""
    cur = await conn.execute(
        """
        select d.evidence_map_id, d.action from drafts d
        where d.dispute_id = %s and d.status = 'submitted' order by d.updated_at desc limit 1
        """,
        (dispute["id"],),
    )
    last = await cur.fetchone()
    cur = await conn.execute(
        """
        insert into outcomes (dispute_id, final_status, resolved_at, evidence_map_id, action_taken, reason)
        values (%s, %s, now(), %s, %s, %s)
        on conflict (dispute_id) do nothing
        returning dispute_id
        """,
        (
            dispute["id"],
            outcome_code or "RESOLVED",
            last["evidence_map_id"] if last else None,
            last["action"] if last else None,
            dispute["reason"],
        ),
    )
    if await cur.fetchone():
        await audit(
            conn,
            "dispute.outcome_recorded",
            merchant_id=dispute["merchant_id"],
            dispute_id=dispute["id"],
            data={"outcome": outcome_code, "evidence_map_id": str(last["evidence_map_id"]) if last else None},
        )


async def sync_dispute(merchant_id: UUID, paypal_merchant_id: str, paypal_dispute_id: str) -> dict[str, Any]:
    async with revocation_guard(merchant_id):
        raw = await get_gateway().get_dispute(paypal_merchant_id, paypal_dispute_id)
    async with connection() as conn:
        return await upsert_dispute(conn, merchant_id, raw)


async def sync_merchant(merchant_id: UUID) -> int:
    async with connection() as conn:
        cur = await conn.execute(
            "select paypal_merchant_id, last_synced_at, grant_status from merchants where id = %s", (merchant_id,)
        )
        merchant = await cur.fetchone()
        cur = await conn.execute(
            "select paypal_dispute_id from disputes where merchant_id = %s and status <> 'RESOLVED'", (merchant_id,)
        )
        open_ids = {r["paypal_dispute_id"] for r in await cur.fetchall()}
    if not merchant or merchant["grant_status"] != "granted":
        return 0

    started = datetime.now(timezone.utc)
    since = merchant["last_synced_at"] - SYNC_OVERLAP if merchant["last_synced_at"] else None
    gw = get_gateway()
    async with revocation_guard(merchant_id):
        summaries = await gw.list_disputes(merchant["paypal_merchant_id"], update_time_after=since)
        # Always re-fetch disputes we believe are open, in case an update fell outside the window.
        ids = {s["dispute_id"] for s in summaries} | open_ids
        for dispute_id in sorted(ids):
            raw = await gw.get_dispute(merchant["paypal_merchant_id"], dispute_id)
            async with connection() as conn:
                await upsert_dispute(conn, merchant_id, raw)
    async with connection() as conn:
        await conn.execute("update merchants set last_synced_at = %s where id = %s", (started, merchant_id))
        await audit(conn, "sync.completed", merchant_id=merchant_id, data={"disputes": len(ids)})
    return len(ids)
