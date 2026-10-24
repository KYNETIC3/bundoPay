"""Dispute sync: pulls disputes from PayPal (polling or webhook-triggered) and keeps local rows current."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection

from app.audit import audit
from app.db import connection, jsonb
from app.events import notify_dispute_changed
from app.deps import get_gateway, revocation_guard
from app.jobs.queue import enqueue

from .model import parse_dispute, work_item_key

SYNC_OVERLAP = timedelta(hours=6)
FETCH_CONCURRENCY = 5


async def upsert_dispute(conn: AsyncConnection, merchant_id: UUID, raw: dict[str, Any]) -> dict[str, Any]:
    """Store PayPal's view of a dispute. Returns the row plus whether this is a new work item.

    One round trip in the common case (nothing changed): the previous state is read and the row
    upserted in a single statement, because each trip to the hosted database costs ~0.5s."""
    facts = parse_dispute(raw)
    key = work_item_key(raw)
    cur = await conn.execute(
        """
        with prev as (
          select status, work_item_key from disputes where merchant_id = %(m)s and paypal_dispute_id = %(pid)s
        ), up as (
          insert into disputes (merchant_id, paypal_dispute_id, status, reason, lifecycle_stage, amount, currency,
                                due_date, work_item_key, raw_json, updated_at)
          values (%(m)s, %(pid)s, %(status)s, %(reason)s, %(stage)s, %(amount)s, %(currency)s, %(due)s, %(key)s, %(raw)s, now())
          on conflict (merchant_id, paypal_dispute_id) do update set
            status = excluded.status, reason = excluded.reason, lifecycle_stage = excluded.lifecycle_stage,
            amount = excluded.amount, currency = excluded.currency, due_date = excluded.due_date,
            work_item_key = excluded.work_item_key, raw_json = excluded.raw_json, updated_at = now()
          returning *
        )
        select up.*, prev.status as prev_status, prev.work_item_key as prev_key, (prev.status is null) as is_new
        from up left join prev on true
        """,
        {
            "m": merchant_id,
            "pid": facts.dispute_id,
            "status": facts.status,
            "reason": facts.reason,
            "stage": facts.lifecycle_stage,
            "amount": facts.amount,
            "currency": facts.currency,
            "due": facts.due_date,
            "key": key,
            "raw": jsonb(raw),
        },
    )
    row = await cur.fetchone()
    prev_status = None if row["is_new"] else row["prev_status"]
    new_work_item = facts.status == "WAITING_FOR_SELLER_RESPONSE" and (row["is_new"] or row["prev_key"] != key)
    if row["is_new"] or prev_status != facts.status:
        await audit(
            conn,
            "dispute.status_changed",
            merchant_id=merchant_id,
            dispute_id=row["id"],
            data={"from": prev_status, "to": facts.status},
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
    if facts.status == "RESOLVED" and prev_status != "RESOLVED":  # outcome is recorded once, when it closes
        await record_outcome(conn, row, facts.outcome_code)
    await notify_dispute_changed(conn, merchant_id, row["id"])
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
        from app.agent.messages import compose_outcome, money
        from app.agent.messages import post as post_message
        from app.disputes.model import REASON_LABELS

        await post_message(
            conn,
            dispute["merchant_id"],
            compose_outcome(REASON_LABELS.get(dispute["reason"] or "", dispute["reason"]), money(dispute["amount"], dispute["currency"]), outcome_code),
            kind="outcome",
            dispute_id=dispute["id"],
        )
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


def disputes_to_fetch(
    summaries: list[dict[str, Any]], seen: dict[str, str | None], open_ids: list[str], *, thorough: bool
) -> list[str]:
    """New disputes and ones whose update_time moved; plus every open dispute on a thorough pass.

    PayPal's list truncates update_time to whole seconds while the full dispute keeps milliseconds,
    so both are compared at second precision."""

    def second(ts: str | None) -> str | None:
        return ts[:19] if ts else None  # "2026-10-21T22:07:03"

    changed = {s["dispute_id"] for s in summaries if second(seen.get(s["dispute_id"])) != second(s.get("update_time"))}
    return sorted(changed | set(open_ids)) if thorough else sorted(changed)


_paypal_ids: dict[UUID, str] = {}  # merchant -> PayPal merchant ID, so Sync can call PayPal without waiting on the DB


async def sync_merchant(merchant_id: UUID, *, thorough: bool = True) -> int:
    """Bring local disputes up to date with PayPal. Returns how many disputes were fetched in full."""
    return (await _sync(merchant_id, thorough=thorough))["updated"]


async def sync_quick(merchant_id: UUID) -> dict[str, int]:
    """The Sync button: only what changed, as fast as possible. Returns {"updated", "total"}."""
    return await _sync(merchant_id, thorough=False)


async def _sync(merchant_id: UUID, *, thorough: bool) -> dict[str, int]:
    """The list call already gives each dispute's update_time, so only disputes that changed are fetched
    in full. `thorough` (the background poll) also re-fetches every open dispute as a safety net; the Sync
    button skips that, and runs its PayPal list in parallel with the database read, because each trip to
    PayPal or the hosted database costs roughly a second."""

    async def load_local() -> dict[str, Any] | None:
        async with connection() as conn:
            cur = await conn.execute(
                """
                select m.paypal_merchant_id, m.last_synced_at, m.grant_status,
                       coalesce(array_agg(d.paypal_dispute_id) filter (where d.status <> 'RESOLVED'), '{}') as open_ids,
                       coalesce(jsonb_object_agg(d.paypal_dispute_id, d.raw_json->>'update_time')
                                filter (where d.id is not null), '{}') as seen
                from merchants m left join disputes d on d.merchant_id = m.id
                where m.id = %s group by m.id
                """,
                (merchant_id,),
            )
            return await cur.fetchone()

    gw = get_gateway()
    started = datetime.now(timezone.utc)
    async with revocation_guard(merchant_id):
        known = _paypal_ids.get(merchant_id)
        if not thorough and known:
            # Sync button: everything PayPal has (no time window), fetched while we read our own copy.
            merchant, summaries = await asyncio.gather(load_local(), gw.list_disputes(known))
        else:
            merchant = await load_local()
            summaries = None
        if not merchant or merchant["grant_status"] != "granted" or not merchant["paypal_merchant_id"]:
            _paypal_ids.pop(merchant_id, None)
            return {"updated": 0, "total": 0}
        pp_merchant = merchant["paypal_merchant_id"]
        _paypal_ids[merchant_id] = pp_merchant
        if summaries is None or known != pp_merchant:
            since = merchant["last_synced_at"] - SYNC_OVERLAP if merchant["last_synced_at"] and thorough else None
            summaries = await gw.list_disputes(pp_merchant, update_time_after=since)

        ids = disputes_to_fetch(summaries, merchant["seen"], merchant["open_ids"], thorough=thorough)
        limit = asyncio.Semaphore(FETCH_CONCURRENCY)

        async def fetch(dispute_id: str) -> dict[str, Any]:
            async with limit:
                return await gw.get_dispute(pp_merchant, dispute_id)

        raws = await asyncio.gather(*(fetch(i) for i in ids))  # in parallel, not one after another

    async with connection() as conn:
        for raw in raws:
            await upsert_dispute(conn, merchant_id, raw)
        # Record the sync and count the merchant's disputes in one round trip; the log entry joins the chain.
        cur = await conn.execute(
            """
            with u as (update merchants set last_synced_at = %(t)s where id = %(m)s)
            select count(*) as n from disputes where merchant_id = %(m)s and archived_at is null
            """,
            {"t": started, "m": merchant_id},
        )
        total = (await cur.fetchone())["n"]
        await audit(conn, "sync.completed", merchant_id=merchant_id, label="provider_verified",
                    data={"listed": len(summaries), "fetched": len(ids)})
    return {"updated": len(ids), "total": total}
