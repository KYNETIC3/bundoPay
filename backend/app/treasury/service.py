"""Treasury data access and the policy lifecycle: draft, simulate, approve, pause.

A policy version can become active only when the merchant approves the exact spec hash that was
simulated. Editing creates a new draft version; the active one keeps running until the new one is
approved.
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection

from app.audit import audit
from app.db import jsonb
from app.executor.service import positions
from app.safety.engine import Context, Limits, Trigger
from app.safety.service import load_limits, spent, verified_accounts

from .policy import Book, DisputeBuffer, PolicyDoc, TaxReserve, next_fire, spec_hash
from .simulator import Simulation, simulate


class TreasuryError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.status = code, status


async def load_book(conn: AsyncConnection, merchant_id: UUID | str, *, gateway=None) -> Book:
    limits = await load_limits(conn, merchant_id)
    currency = limits["currency"]
    pos = await positions(conn, merchant_id, gateway=gateway)
    operating = next((p.balance for p in pos if p.role == "operating"), None)
    reserves = {p.role: p.balance for p in pos if p.role != "operating"}
    cur = await conn.execute(
        """
        select
          (select coalesce(sum(amount), 0) from disputes
            where merchant_id = %(m)s and status <> 'RESOLVED' and archived_at is null and currency = %(c)s) as open_disputes,
          (select coalesce(sum(amount), 0) from treasury_captures
            where merchant_id = %(m)s and currency = %(c)s and captured_at >= now() - interval '30 days') as captures_30d,
          (select coalesce(sum(c.amount), 0) from treasury_captures c left join movements mv on mv.id = c.reserved_by
            where c.merchant_id = %(m)s and c.currency = %(c)s and (c.reserved_by is null or mv.status in ('failed', 'blocked'))) as unreserved
        """,
        {"m": merchant_id, "c": currency},
    )
    r = await cur.fetchone()
    return Book(
        operating=operating,
        reserves=reserves,
        open_disputes=Decimal(r["open_disputes"]),
        captures_30d=Decimal(r["captures_30d"]),
        unreserved_captures=Decimal(r["unreserved"]),
        floor=Decimal(limits["liquidity_floor"]),
    )


async def accounts_by_role(conn: AsyncConnection, merchant_id: UUID | str) -> dict[str, str]:
    """Verified accounts only: an unverified reserve is simply absent, and the engine blocks a sweep to it."""
    cur = await conn.execute(
        "select id, role from treasury_accounts where merchant_id = %s and verified_at is not null and role <> 'other'",
        (merchant_id,),
    )
    return {r["role"]: str(r["id"]) for r in await cur.fetchall()}


async def base_context(conn: AsyncConnection, merchant_id: UUID | str, trigger: Trigger, *, authority: bool) -> Context:
    row = await load_limits(conn, merchant_id)
    return Context(
        currency=row["currency"],
        limits=Limits(
            solo=Decimal(row["solo_limit"]), per_run=Decimal(row["hard_cap_per_run"]), per_day=row["hard_cap_per_day"],
            per_week=row["hard_cap_per_week"], per_month=row["hard_cap_per_month"],
        ),
        trigger=trigger,
        authority=authority,
        verified_accounts=await verified_accounts(conn, merchant_id),
        spent=await spent(conn, merchant_id),
        floor=Decimal(row["liquidity_floor"]),
    )


async def companion_specs(conn: AsyncConnection, merchant_id: UUID | str) -> tuple[DisputeBuffer | None, TaxReserve | None]:
    """The active buffer and tax policies, which a rebalance or ad-sweep fallback funds first."""
    cur = await conn.execute(
        "select v.doc_json from treasury_policies p join treasury_policy_versions v on v.id = p.active_version_id "
        "where p.merchant_id = %s and p.status = 'active' and p.kind in ('dispute_buffer', 'tax_reserve') "
        "and v.approved_hash = v.spec_hash",
        (merchant_id,),
    )
    buffer = tax = None
    for r in await cur.fetchall():
        spec = PolicyDoc.model_validate(r["doc_json"]).spec
        if isinstance(spec, DisputeBuffer):
            buffer = spec
        elif isinstance(spec, TaxReserve):
            tax = spec
    return buffer, tax


# ------------------------------------------------------------------------------------- lifecycle


async def _version(conn: AsyncConnection, merchant_id: UUID | str, policy_id: UUID | str, version: int) -> dict[str, Any]:
    cur = await conn.execute(
        "select v.*, p.merchant_id, p.status as policy_status, p.active_version_id, p.kind from treasury_policy_versions v "
        "join treasury_policies p on p.id = v.policy_id where p.id = %s and p.merchant_id = %s and v.version = %s",
        (policy_id, merchant_id, version),
    )
    row = await cur.fetchone()
    if not row:
        raise TreasuryError("not_found", "Policy version not found", 404)
    return row


async def create_policy(conn: AsyncConnection, merchant_id: UUID | str, doc: PolicyDoc, *, created_by: str) -> dict[str, Any]:
    cur = await conn.execute(
        "select id from treasury_policies where merchant_id = %s and kind = %s and status <> 'retired'",
        (merchant_id, doc.spec.kind),
    )
    if await cur.fetchone():
        raise TreasuryError("exists", f"You already have a {doc.spec.kind.replace('_', ' ')} policy. Edit it instead.", 409)
    cur = await conn.execute(
        "insert into treasury_policies (merchant_id, kind) values (%s, %s) returning id", (merchant_id, doc.spec.kind)
    )
    policy_id = (await cur.fetchone())["id"]
    return await _insert_version(conn, merchant_id, policy_id, 1, doc, created_by)


async def _insert_version(conn, merchant_id, policy_id, version: int, doc: PolicyDoc, created_by: str) -> dict[str, Any]:
    h = spec_hash(doc)
    await conn.execute(
        "insert into treasury_policy_versions (policy_id, version, doc_json, spec_hash, created_by) values (%s, %s, %s, %s, %s)",
        (policy_id, version, jsonb(doc.model_dump(mode="json")), h, created_by),
    )
    await audit(conn, "policy.version_drafted", merchant_id=merchant_id, actor=created_by,
                label="ai_assessment" if created_by == "copilot" else "system_generated",
                data={"policy_id": str(policy_id), "version": version, "spec_hash": h, "doc": doc.model_dump(mode="json")})
    return {"policy_id": str(policy_id), "version": version, "spec_hash": h}


async def new_version(conn: AsyncConnection, merchant_id: UUID | str, policy_id: UUID | str, doc: PolicyDoc, *, created_by: str) -> dict[str, Any]:
    cur = await conn.execute(
        "select p.kind, coalesce(max(v.version), 0) as last from treasury_policies p "
        "left join treasury_policy_versions v on v.policy_id = p.id where p.id = %s and p.merchant_id = %s "
        "and p.status <> 'retired' group by p.kind",
        (policy_id, merchant_id),
    )
    row = await cur.fetchone()
    if not row:
        raise TreasuryError("not_found", "Policy not found", 404)
    if row["kind"] != doc.spec.kind:
        raise TreasuryError("kind_change", "A policy can't change kind; create a new one", 409)
    return await _insert_version(conn, merchant_id, policy_id, row["last"] + 1, doc, created_by)


async def simulate_version(
    conn: AsyncConnection, merchant_id: UUID | str, policy_id: UUID | str, version: int, *, now: datetime | None = None,
    gateway=None, weekly_inflow: Decimal | None = None,
) -> Simulation:
    v = await _version(conn, merchant_id, policy_id, version)
    doc = PolicyDoc.model_validate(v["doc_json"])
    book = await load_book(conn, merchant_id, gateway=gateway)
    ctx = await base_context(conn, merchant_id, Trigger("scheduler", verified=True), authority=True)
    buffer, tax = await companion_specs(conn, merchant_id)
    if isinstance(doc.spec, DisputeBuffer):
        buffer = doc.spec
    if isinstance(doc.spec, TaxReserve):
        tax = doc.spec
    sim = simulate(doc.spec, book, ctx, await accounts_by_role(conn, merchant_id), now=now,
                   weekly_inflow=weekly_inflow, buffer=buffer, tax=tax)
    await conn.execute(
        "update treasury_policy_versions set simulated_hash = spec_hash, simulated_at = now() where id = %s", (v["id"],)
    )
    await audit(conn, "policy.simulated", merchant_id=merchant_id, actor="simulator",
                data={"policy_id": str(policy_id), "version": version, "spec_hash": v["spec_hash"], "summary": sim.summary})
    return sim


async def approve_version(
    conn: AsyncConnection, merchant_id: UUID | str, policy_id: UUID | str, version: int, *, spec_hash_seen: str,
    approver: str, now: datetime | None = None,
) -> dict[str, Any]:
    """Only an authenticated owner request reaches this; nothing the copilot writes can call it."""
    v = await _version(conn, merchant_id, policy_id, version)
    if v["spec_hash"] != spec_hash_seen:
        raise TreasuryError("stale_view", "This version changed since you opened it. Review it again.", 409)
    if v["simulated_hash"] != v["spec_hash"]:
        raise TreasuryError("not_simulated", "Run the simulator on this exact version before approving it.", 409)
    if v["policy_status"] == "retired":
        raise TreasuryError("retired", "This policy is retired", 409)
    doc = PolicyDoc.model_validate(v["doc_json"])
    now = now or datetime.now(timezone.utc)
    await conn.execute(
        "update treasury_policy_versions set approved_hash = spec_hash, approved_at = now() where id = %s", (v["id"],)
    )
    await conn.execute(
        "update treasury_policies set status = 'active', active_version_id = %s, next_run_at = %s, failures = 0, "
        "updated_at = now() where id = %s",
        (v["id"], next_fire(doc.spec, now), policy_id),
    )
    await audit(conn, "policy.approved", merchant_id=merchant_id, actor=approver,
                data={"policy_id": str(policy_id), "version": version, "spec_hash": v["spec_hash"]})
    return {"policy_id": str(policy_id), "version": version, "status": "active"}


async def set_policy_status(conn: AsyncConnection, merchant_id: UUID | str, policy_id: UUID | str, status: str, *, actor: str) -> None:
    allowed_from = {"paused": ("active",), "active": ("paused",), "retired": ("draft", "active", "paused")}[status]
    cur = await conn.execute(
        "update treasury_policies set status = %s, updated_at = now() where id = %s and merchant_id = %s "
        "and status = any(%s) and (%s <> 'active' or active_version_id is not null) returning kind",
        (status, policy_id, merchant_id, list(allowed_from), status),
    )
    if not await cur.fetchone():
        raise TreasuryError("bad_transition", f"Can't move this policy to {status}", 409)
    await audit(conn, f"policy.{status}", merchant_id=merchant_id, actor=actor, data={"policy_id": str(policy_id)})

