"""What starts a policy run: the scheduler, a verified capture webhook, or a dispute change.

Only backend code writes jobs, so a `run_policy` job's trigger is as trustworthy as the code path that
queued it: the webhook router queues one only after PayPal verified the signature, and only after
re-fetching the capture from PayPal.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection

from app.audit import audit
from app.db import connection
from app.jobs.queue import enqueue

from .policy import PolicyDoc, next_fire

log = logging.getLogger("treasury")
TRIGGERS = ("scheduler", "webhook", "user")


async def enqueue_run(conn: AsyncConnection, merchant_id: UUID | str, policy_id: UUID | str, *, trigger: str, slot: str) -> None:
    if trigger not in TRIGGERS:
        raise ValueError(f"Untrusted trigger {trigger!r}")
    await enqueue(
        conn, "run_policy",
        {"merchant_id": str(merchant_id), "policy_id": str(policy_id), "trigger": trigger, "slot": slot},
        dedupe_key=f"policy:{policy_id}:{slot}",
    )


async def enqueue_kind(conn: AsyncConnection, merchant_id: UUID | str, kind: str, *, trigger: str, slot: str) -> bool:
    cur = await conn.execute(
        "select id from treasury_policies where merchant_id = %s and kind = %s and status = 'active'", (merchant_id, kind)
    )
    row = await cur.fetchone()
    if row:
        await enqueue_run(conn, merchant_id, row["id"], trigger=trigger, slot=slot)
    return row is not None


async def enqueue_due_policies(now: datetime | None = None) -> int:
    """Scheduler tick: queue every active policy whose next run has come, keyed by that scheduled time."""
    now = now or datetime.now(timezone.utc)
    async with connection() as conn:
        async with conn.transaction():
            cur = await conn.execute(
                "select p.id, p.merchant_id, p.next_run_at, v.doc_json from treasury_policies p "
                "join treasury_policy_versions v on v.id = p.active_version_id "
                "where p.status = 'active' and p.next_run_at <= %s for update of p skip locked",
                (now,),
            )
            due = await cur.fetchall()
            for p in due:
                await enqueue_run(conn, p["merchant_id"], p["id"], trigger="scheduler", slot=p["next_run_at"].isoformat())
                spec = PolicyDoc.model_validate(p["doc_json"]).spec
                await conn.execute("update treasury_policies set next_run_at = %s where id = %s", (next_fire(spec, now), p["id"]))
    return len(due)


def capture_from_paypal(body: dict[str, Any]) -> dict[str, Any] | None:
    """A COMPLETED capture as PayPal returned it on re-fetch; anything else is ignored."""
    if body.get("status") != "COMPLETED":
        return None
    amount = body.get("amount") or {}
    try:
        value = Decimal(str(amount.get("value")))
    except Exception:
        return None
    if value <= 0 or not amount.get("currency_code") or not body.get("id"):
        return None
    when = body.get("create_time") or body.get("update_time")
    captured_at = datetime.fromisoformat(when.replace("Z", "+00:00")) if when else datetime.now(timezone.utc)
    return {"id": body["id"], "amount": value, "currency": amount["currency_code"], "captured_at": captured_at}


async def record_capture(conn: AsyncConnection, merchant_id: UUID | str, capture: dict[str, Any]) -> bool:
    cur = await conn.execute(
        "insert into treasury_captures (merchant_id, paypal_capture_id, amount, currency, captured_at) values (%s, %s, %s, %s, %s) "
        "on conflict (merchant_id, paypal_capture_id) do nothing returning id",
        (merchant_id, capture["id"], capture["amount"], capture["currency"], capture["captured_at"]),
    )
    new = await cur.fetchone() is not None
    await audit(conn, "capture.recorded" if new else "capture.duplicate", merchant_id=merchant_id, label="provider_verified",
                data={"capture_id": capture["id"], "amount": f"{capture['amount']:.2f}", "currency": capture["currency"]})
    if new:
        await enqueue_kind(conn, merchant_id, "tax_reserve", trigger="webhook", slot=f"capture:{capture['id']}")
    return new


async def on_dispute_synced(conn: AsyncConnection, merchant_id: UUID | str, paypal_dispute_id: str, *, trigger: str) -> None:
    """A dispute appeared or changed: the buffer target may have moved."""
    cur = await conn.execute(
        "select status, amount, raw_json->>'update_time' as updated from disputes where merchant_id = %s and paypal_dispute_id = %s",
        (merchant_id, paypal_dispute_id),
    )
    d = await cur.fetchone()
    if not d:
        return
    version = hashlib.sha256(f"{d['status']}|{d['amount']}|{d['updated']}".encode()).hexdigest()[:12]
    await enqueue_kind(conn, merchant_id, "dispute_buffer", trigger=trigger, slot=f"dispute:{paypal_dispute_id}:{version}")
