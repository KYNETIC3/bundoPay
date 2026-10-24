"""Database side of the safety engine: loads limits, totals and accounts, records every verdict.

Every proposed movement gets a `movements` row keyed by its idempotency key (which later becomes the
PayPal-Request-Id), so the unique constraint is the last line against a duplicate that slips past the
engine's own check in a race.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection

from app.audit import audit

from .engine import Context, Limits, Movement, PlanVerdict, Spent, Trigger, Verdict, check, check_plan

STATUS_FOR = {"allow": "allowed", "ask": "needs_approval", "block": "blocked"}
COUNTED = ("allowed", "executing", "unconfirmed", "succeeded")  # spend that counts against the caps
# Blocks the engine raises before a valid row could be stored (bad amount, unknown kind, repeated key).
UNRECORDABLE = ("3_unknown_kind", "4_bad_amount", "5_duplicate")


@dataclass(frozen=True)
class Guarded:
    verdict: Verdict
    movement_id: UUID | None


async def load_limits(conn: AsyncConnection, merchant_id: UUID | str) -> dict[str, Any]:
    await conn.execute("insert into treasury_limits (merchant_id) values (%s) on conflict do nothing", (merchant_id,))
    cur = await conn.execute("select * from treasury_limits where merchant_id = %s", (merchant_id,))
    return await cur.fetchone()


async def spent(conn: AsyncConnection, merchant_id: UUID | str, now: datetime | None = None) -> Spent:
    """Rolling windows, which are never looser than calendar ones."""
    now = now or datetime.now(timezone.utc)
    cur = await conn.execute(
        """
        select coalesce(sum(amount) filter (where created_at >= %(d)s), 0) as day,
               coalesce(sum(amount) filter (where created_at >= %(w)s), 0) as week,
               coalesce(sum(amount), 0) as month
        from movements where merchant_id = %(m)s and status = any(%(s)s) and created_at >= %(mo)s
        """,
        {"m": merchant_id, "s": list(COUNTED), "d": now - timedelta(days=1), "w": now - timedelta(days=7), "mo": now - timedelta(days=30)},
    )
    r = await cur.fetchone()
    return Spent(day=Decimal(r["day"]), week=Decimal(r["week"]), month=Decimal(r["month"]))


async def verified_accounts(conn: AsyncConnection, merchant_id: UUID | str) -> frozenset[str]:
    cur = await conn.execute(
        "select id from treasury_accounts where merchant_id = %s and verified_at is not null", (merchant_id,)
    )
    return frozenset(str(r["id"]) for r in await cur.fetchall())


async def key_used(conn: AsyncConnection, merchant_id: UUID | str, key: str) -> bool:
    """A failed attempt moved no money, so its key may be tried again."""
    cur = await conn.execute(
        "select 1 from movements where merchant_id = %s and idempotency_key = %s and status <> 'failed'", (merchant_id, key)
    )
    return await cur.fetchone() is not None


def _limits(row: dict[str, Any], solo: Decimal | None) -> Limits:
    cap = Decimal(row["hard_cap_per_run"])
    return Limits(
        # A tighter solo limit (such as the dispute auto-refund limit) may be passed; it can never exceed the cap.
        solo=min(solo, cap) if solo is not None else Decimal(row["solo_limit"]),
        per_run=cap,
        per_day=row["hard_cap_per_day"],
        per_week=row["hard_cap_per_week"],
        per_month=row["hard_cap_per_month"],
    )


async def guard(
    conn: AsyncConnection,
    merchant_id: UUID | str,
    movement: Movement,
    *,
    trigger: Trigger,
    authority: bool,
    approved: bool = False,
    available: Decimal | None = None,
    floor: Decimal | None = None,
    solo: Decimal | None = None,
    flow_id: UUID | str | None = None,
    policy_version: str | None = None,
) -> Guarded:
    row = await load_limits(conn, merchant_id)
    accounts = await verified_accounts(conn, merchant_id)
    used = await key_used(conn, merchant_id, movement.idempotency_key) if movement.idempotency_key else False
    ctx = Context(
        currency=row["currency"],
        limits=_limits(row, solo),
        trigger=trigger,
        authority=authority,
        approved=approved,
        verified_accounts=accounts,
        spent=await spent(conn, merchant_id),
        used_keys=frozenset({movement.idempotency_key}) if used else frozenset(),
        available=available,
        floor=Decimal(row["liquidity_floor"]) if floor is None else floor,
    )
    verdict = check(movement, ctx)
    movement_id = None
    if verdict.check not in UNRECORDABLE:
        cur = await conn.execute(
            """
            insert into movements (merchant_id, flow_id, kind, to_account_id, amount, currency, idempotency_key,
                                   policy_version, trigger_source, verdict, check_code, reason, status)
            values (%(m)s, %(f)s, %(k)s, %(a)s, %(amt)s, %(c)s, %(key)s, %(pv)s, %(t)s, %(v)s, %(cc)s, %(r)s, %(s)s)
            on conflict (merchant_id, idempotency_key) do update set
              verdict = excluded.verdict, check_code = excluded.check_code, reason = excluded.reason,
              status = excluded.status, amount = excluded.amount, updated_at = now()
              where movements.status = 'failed'
            returning id
            """,
            {
                "m": merchant_id, "f": flow_id, "k": movement.kind,
                "a": movement.to_account if movement.to_account in accounts else None,
                "amt": movement.amount, "c": movement.currency, "key": movement.idempotency_key, "pv": policy_version,
                "t": trigger.source, "v": verdict.decision, "cc": verdict.check, "r": verdict.reason,
                "s": STATUS_FOR[verdict.decision],
            },
        )
        inserted = await cur.fetchone()
        if inserted is None:  # another writer took the key between the check and the insert
            verdict = Verdict("block", "5_duplicate", "This movement's idempotency key was already used")
        else:
            movement_id = inserted["id"]
    await audit(
        conn,
        f"safety.{verdict.decision}",
        merchant_id=merchant_id,
        flow_id=flow_id,
        actor="safety_engine",
        data={
            "check": verdict.check,
            "reason": verdict.reason,
            "kind": movement.kind,
            "amount": str(movement.amount),
            "currency": movement.currency,
            "idempotency_key": movement.idempotency_key,
            "trigger": trigger.source,
            "movement_id": str(movement_id) if movement_id else None,
            "money_moved": "0.00",
        },
    )
    return Guarded(verdict, movement_id)


async def set_movement_status(
    conn: AsyncConnection, movement_id: UUID | str, status: str, *, paypal_ref: str | None = None
) -> None:
    await conn.execute(
        "update movements set status = %s, paypal_ref = coalesce(%s, paypal_ref), updated_at = now() where id = %s",
        (status, paypal_ref, movement_id),
    )


@dataclass(frozen=True)
class GuardedPlan:
    verdict: PlanVerdict
    movement_ids: tuple[UUID, ...]


async def guard_plan(
    conn: AsyncConnection,
    merchant_id: UUID | str,
    movements: list[Movement],
    *,
    trigger: Trigger,
    authority: bool,
    approved: bool = False,
    available: Decimal | None = None,
    flow_id: UUID | str | None = None,
    policy_version: str | None = None,
    plan_id: UUID | str | None = None,
) -> GuardedPlan:
    """One run through the engine as a whole. With `plan_id`, this re-checks a plan waiting for approval:
    its own rows don't count as already used, and they're updated in place."""
    row = await load_limits(conn, merchant_id)
    accounts = await verified_accounts(conn, merchant_id)
    keys = [m.idempotency_key for m in movements if m.idempotency_key]
    cur = await conn.execute(
        "select idempotency_key from movements where merchant_id = %s and idempotency_key = any(%s) "
        "and status <> 'failed' and plan_id is distinct from %s",
        (merchant_id, keys, plan_id),
    )
    used = frozenset(r["idempotency_key"] for r in await cur.fetchall())
    ctx = Context(
        currency=row["currency"], limits=_limits(row, None), trigger=trigger, authority=authority, approved=approved,
        verified_accounts=accounts, spent=await spent(conn, merchant_id), used_keys=used, available=available,
        floor=Decimal(row["liquidity_floor"]),
    )
    verdict = check_plan(movements, ctx)
    status = STATUS_FOR[verdict.decision]
    ids: list[UUID] = []
    for m, item in zip(movements, list(verdict.items) + [None] * (len(movements) - len(verdict.items))):
        if (item and item.check in UNRECORDABLE) or (item is None and verdict.check in UNRECORDABLE):
            continue
        reason = item.reason if item and item.decision == "block" else verdict.reason
        check_code = item.check if item and item.decision == "block" else verdict.check
        params = {
            "m": merchant_id, "f": flow_id, "k": m.kind, "a": m.to_account if m.to_account in accounts else None,
            "amt": m.amount, "c": m.currency, "key": m.idempotency_key, "pv": policy_version, "t": trigger.source,
            "v": verdict.decision, "cc": check_code, "r": reason, "s": status, "p": plan_id,
        }
        if plan_id is not None:
            cur = await conn.execute(
                "update movements set verdict = %(v)s, check_code = %(cc)s, reason = %(r)s, status = %(s)s, updated_at = now() "
                "where merchant_id = %(m)s and plan_id = %(p)s and idempotency_key = %(key)s returning id",
                params,
            )
            hit = await cur.fetchone()
            if hit:
                ids.append(hit["id"])
                continue
        if m.amount is None or not isinstance(m.amount, Decimal) or m.amount <= 0:
            continue
        cur = await conn.execute(
            """
            insert into movements (merchant_id, flow_id, kind, to_account_id, amount, currency, idempotency_key,
                                   policy_version, trigger_source, verdict, check_code, reason, status, plan_id)
            values (%(m)s, %(f)s, %(k)s, %(a)s, %(amt)s, %(c)s, %(key)s, %(pv)s, %(t)s, %(v)s, %(cc)s, %(r)s, %(s)s, %(p)s)
            on conflict (merchant_id, idempotency_key) do update set
              verdict = excluded.verdict, check_code = excluded.check_code, reason = excluded.reason,
              status = excluded.status, amount = excluded.amount, flow_id = excluded.flow_id, updated_at = now()
              where movements.status = 'failed'
            returning id
            """,
            params,
        )
        inserted = await cur.fetchone()
        if inserted is None:
            verdict = PlanVerdict("block", "5_duplicate", "This movement's idempotency key was already used", verdict.items, verdict.total)
            break
        ids.append(inserted["id"])
    if verdict.check == "5_duplicate" and ids:
        # Lost a race part-way through: the items already written must not go out on their own.
        await conn.execute(
            "update movements set status = 'blocked', verdict = 'block', check_code = '5_duplicate', "
            "reason = 'Another run took one of this plan''s keys', updated_at = now() where id = any(%s)",
            (ids,),
        )
    await audit(
        conn, f"safety.{verdict.decision}", merchant_id=merchant_id, flow_id=flow_id, actor="safety_engine",
        data={
            "check": verdict.check, "reason": verdict.reason, "total": f"{verdict.total:.2f}", "items": len(movements),
            "trigger": trigger.source, "approved": approved, "plan_id": str(plan_id) if plan_id else None,
            "money_moved": "0.00",
        },
    )
    return GuardedPlan(verdict, tuple(ids))
