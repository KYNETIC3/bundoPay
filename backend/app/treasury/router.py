"""Treasury API. Every write here is an authenticated owner action; approvals exist only as these calls."""

from __future__ import annotations

import hashlib
from decimal import Decimal
from typing import Annotated, Any, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, model_validator

from app.audit import audit
from app.auth import CurrentMerchant, current_merchant
from app.db import connection
from app.executor.service import positions
from app.safety.engine import Trigger
from app.safety.service import load_limits

from . import service
from .policy import PolicyDoc
from .runner import approve_plan, reject_plan, run_policy
from .service import TreasuryError

router = APIRouter(prefix="/treasury")
Money = Annotated[Decimal, Field(ge=0, le=Decimal("10000000"), decimal_places=2)]
Email = Annotated[str, Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=254)]


def _details_hash(name: str, email: str) -> str:
    return hashlib.sha256(f"{name.strip()}|{email.strip().lower()}".encode()).hexdigest()


class AccountBody(BaseModel):
    role: Literal["operating", "tax_reserve", "dispute_buffer", "ad_spend", "other"]
    name: Annotated[str, Field(min_length=1, max_length=80)]
    paypal_email: Email
    opening_balance: Money = Decimal("0.00")


class AccountEdit(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=80)]
    paypal_email: Email
    opening_balance: Money


class LimitsBody(BaseModel):
    solo_limit: Money
    hard_cap_per_run: Money
    hard_cap_per_day: Money | None = None
    hard_cap_per_week: Money
    hard_cap_per_month: Money | None = None
    liquidity_floor: Money

    @model_validator(mode="after")
    def solo_within_cap(self):
        if self.solo_limit > self.hard_cap_per_run:
            raise ValueError("The solo limit can't be above the per-run hard cap")
        return self


class DocBody(BaseModel):
    doc: PolicyDoc


class HashBody(BaseModel):
    spec_hash: str


class PlanHashBody(BaseModel):
    plan_hash: str


class SimulateBody(BaseModel):
    weekly_inflow: Money | None = None


@router.get("/overview")
async def overview(merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, Any]:
    async with connection() as conn:
        limits = await load_limits(conn, merchant.id)
        pos = await positions(conn, merchant.id)
        accounts = await (await conn.execute(
            "select id, role, name, paypal_email, opening_balance, verified_at from treasury_accounts where merchant_id = %s order by role, name",
            (merchant.id,),
        )).fetchall()
        policies = await (await conn.execute(
            """
            select p.id, p.kind, p.status, p.next_run_at, p.failures, p.active_version_id,
                   coalesce(json_agg(json_build_object('version', v.version, 'id', v.id, 'doc', v.doc_json, 'spec_hash', v.spec_hash,
                     'simulated', v.simulated_hash = v.spec_hash, 'approved', v.approved_hash = v.spec_hash,
                     'created_by', v.created_by, 'created_at', v.created_at) order by v.version) filter (where v.id is not null), '[]') as versions
            from treasury_policies p left join treasury_policy_versions v on v.policy_id = p.id
            where p.merchant_id = %s and p.status <> 'retired' group by p.id order by p.created_at
            """,
            (merchant.id,),
        )).fetchall()
        plans = await (await conn.execute(
            "select id, flow_id, items_json, plan_hash, total, status, reason, expires_at, created_at from treasury_plans "
            "where merchant_id = %s order by created_at desc limit 20",
            (merchant.id,),
        )).fetchall()
        movements = await (await conn.execute(
            "select m.id, m.flow_id, m.kind, m.amount, m.currency, m.status, m.verdict, m.check_code, m.reason, m.paypal_ref, "
            "m.created_at, a.name as account_name, a.role from movements m left join treasury_accounts a on a.id = m.to_account_id "
            "where m.merchant_id = %s order by m.created_at desc limit 50",
            (merchant.id,),
        )).fetchall()
    return {
        "limits": {k: v for k, v in limits.items() if k != "merchant_id"},
        "positions": [p.__dict__ for p in pos],
        "accounts": accounts,
        "policies": policies,
        "plans": plans,
        "movements": movements,
    }


# The live console log: what the engine, planner and executor wrote to History.
FEED_PREFIXES = ("trigger.", "plan.", "safety.", "approval.", "execution.", "capture.", "policy.", "account.", "limits.")


@router.get("/feed")
async def feed(after: int = 0, merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, Any]:
    async with connection() as conn:
        cur = await conn.execute(
            "select id, flow_id, event, label, actor, data_json, created_at, prev_hash, row_hash from audit_log "
            "where merchant_id = %s and id > %s and split_part(event, '.', 1) || '.' = any(%s) order by id desc limit 100",
            (merchant.id, after, list(FEED_PREFIXES)),
        )
        rows = await cur.fetchall()
    return {"entries": [
        {**r, "chain": f"{(r['prev_hash'] or '')[:4]}…→{(r['row_hash'] or '')[:4]}…" if r["row_hash"] else None}
        for r in reversed(rows)
    ]}


# -------------------------------------------------------------------------------------- accounts


@router.post("/accounts")
async def add_account(body: AccountBody, merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, Any]:
    async with connection() as conn:
        cur = await conn.execute(
            "insert into treasury_accounts (merchant_id, role, name, paypal_email, opening_balance, details_hash) "
            "values (%s, %s, %s, %s, %s, %s) on conflict do nothing returning id",
            (merchant.id, body.role, body.name, str(body.paypal_email), body.opening_balance, _details_hash(body.name, body.paypal_email)),
        )
        row = await cur.fetchone()
        if not row:
            raise TreasuryError("exists", "An account with that name or role already exists", 409)
        await audit(conn, "account.added", merchant_id=merchant.id, actor="owner",
                    data={"account_id": str(row["id"]), "role": body.role, "name": body.name, "opening_balance": f"{body.opening_balance:.2f}"})
    return {"id": str(row["id"]), "verified": False}


@router.put("/accounts/{account_id}")
async def edit_account(account_id: UUID, body: AccountEdit, merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, Any]:
    """Changing where money goes clears verification: the owner must confirm the new details."""
    h = _details_hash(body.name, body.paypal_email)
    async with connection() as conn:
        cur = await conn.execute(
            "update treasury_accounts set name = %s, paypal_email = %s, opening_balance = %s, "
            "verified_at = case when details_hash = %s then verified_at end, details_hash = %s "
            "where id = %s and merchant_id = %s returning verified_at",
            (body.name, str(body.paypal_email), body.opening_balance, h, h, account_id, merchant.id),
        )
        row = await cur.fetchone()
        if not row:
            raise TreasuryError("not_found", "Account not found", 404)
        await audit(conn, "account.edited", merchant_id=merchant.id, actor="owner",
                    data={"account_id": str(account_id), "verified": row["verified_at"] is not None})
    return {"id": str(account_id), "verified": row["verified_at"] is not None}


@router.post("/accounts/{account_id}/verify")
async def verify_account(account_id: UUID, merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, Any]:
    async with connection() as conn:
        cur = await conn.execute(
            "update treasury_accounts set verified_at = now() where id = %s and merchant_id = %s returning paypal_email, details_hash",
            (account_id, merchant.id),
        )
        row = await cur.fetchone()
        if not row:
            raise TreasuryError("not_found", "Account not found", 404)
        await audit(conn, "account.verified", merchant_id=merchant.id, actor="owner",
                    data={"account_id": str(account_id), "details_hash": row["details_hash"]})
    return {"id": str(account_id), "verified": True}


@router.put("/limits")
async def put_limits(body: LimitsBody, merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, Any]:
    async with connection() as conn:
        await load_limits(conn, merchant.id)
        await conn.execute(
            "update treasury_limits set solo_limit = %s, hard_cap_per_run = %s, hard_cap_per_day = %s, hard_cap_per_week = %s, "
            "hard_cap_per_month = %s, liquidity_floor = %s, updated_at = now() where merchant_id = %s",
            (body.solo_limit, body.hard_cap_per_run, body.hard_cap_per_day, body.hard_cap_per_week, body.hard_cap_per_month,
             body.liquidity_floor, merchant.id),
        )
        await audit(conn, "limits.updated", merchant_id=merchant.id, actor="owner", data=body.model_dump(mode="json"))
    return body.model_dump(mode="json")


# -------------------------------------------------------------------------------------- policies


@router.post("/policies")
async def create_policy(body: DocBody, merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, Any]:
    async with connection() as conn:
        async with conn.transaction():
            return await service.create_policy(conn, merchant.id, body.doc, created_by="owner")


@router.put("/policies/{policy_id}")
async def edit_policy(policy_id: UUID, body: DocBody, merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, Any]:
    async with connection() as conn:
        async with conn.transaction():
            return await service.new_version(conn, merchant.id, policy_id, body.doc, created_by="owner")


@router.post("/policies/{policy_id}/versions/{version}/simulate")
async def simulate(policy_id: UUID, version: int, body: SimulateBody | None = None,
                   merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, Any]:
    async with connection() as conn:
        async with conn.transaction():
            sim = await service.simulate_version(conn, merchant.id, policy_id, version,
                                                 weekly_inflow=body.weekly_inflow if body else None)
    return sim.to_json()


@router.post("/policies/{policy_id}/versions/{version}/approve")
async def approve(policy_id: UUID, version: int, body: HashBody, merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, Any]:
    async with connection() as conn:
        async with conn.transaction():
            return await service.approve_version(conn, merchant.id, policy_id, version, spec_hash_seen=body.spec_hash,
                                                 approver=merchant.email)


@router.post("/policies/{policy_id}/{action}")
async def policy_action(policy_id: UUID, action: Literal["pause", "resume", "retire", "run"],
                        merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, Any]:
    if action == "run":
        # "Run now": the owner's authenticated tap is the trigger; the slot is unique to this tap.
        return await run_policy(merchant.id, policy_id, trigger=Trigger("user", verified=True), slot=f"manual:{uuid4()}")
    status = {"pause": "paused", "resume": "active", "retire": "retired"}[action]
    async with connection() as conn:
        async with conn.transaction():
            await service.set_policy_status(conn, merchant.id, policy_id, status, actor=merchant.email)
    return {"policy_id": str(policy_id), "status": status}


# ----------------------------------------------------------------------------------------- plans


@router.post("/plans/{plan_id}/approve")
async def approve_plan_route(plan_id: UUID, body: PlanHashBody, merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, Any]:
    return await approve_plan(merchant.id, plan_id, plan_hash_seen=body.plan_hash, approver=merchant.email)


@router.post("/plans/{plan_id}/reject")
async def reject_plan_route(plan_id: UUID, merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, str]:
    await reject_plan(merchant.id, plan_id, approver=merchant.email)
    return {"status": "rejected"}
