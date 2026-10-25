"""Treasury API. Every write here is an authenticated owner action; approvals exist only as these calls."""

from __future__ import annotations

import hashlib
from decimal import Decimal
from typing import Annotated, Any, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, model_validator

from app.audit import audit, verify_chain
from app.auth import CurrentMerchant, current_merchant
from app.deps import llm_rate_limit
from app.db import connection
from app.executor.service import positions
from app.agent.orchestrator import default_llm
from app.safety.engine import Movement, Trigger
from app.safety.service import guard_plan, load_limits

from . import service
from .copilot import interpret
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


class CopilotBody(BaseModel):
    text: Annotated[str, Field(min_length=1, max_length=2000)]


class AcceptBody(BaseModel):
    drafts: Annotated[list[PolicyDoc], Field(min_length=1, max_length=4)]


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
FEED_PREFIXES = ("trigger.", "plan.", "safety.", "approval.", "execution.", "capture.", "policy.", "account.", "limits.", "copilot.")


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


# --------------------------------------------------------------------------------------- copilot


@router.post("/copilot")
async def copilot(body: CopilotBody, merchant: CurrentMerchant = Depends(llm_rate_limit)) -> dict[str, Any]:
    """Drafts only. A request to move money now goes to the safety engine as untrusted chat with no
    authority, so it's blocked and recorded; there's no path from here to the executor."""
    result = await interpret(body.text, default_llm())
    out: dict[str, Any] = result.to_json()
    async with connection() as conn:
        async with conn.transaction():
            flow_id = str(uuid4())
            await audit(conn, "copilot.interpreted", merchant_id=merchant.id, flow_id=flow_id, label="ai_assessment",
                        actor=f"copilot:{result.source}", data={"intent": result.intent, "drafts": len(result.drafts),
                                                                "summary": result.summary})
            if result.intent == "move_now":
                limits = await load_limits(conn, merchant.id)
                book = await service.load_book(conn, merchant.id)
                accounts = await service.accounts_by_role(conn, merchant.id)
                amount = Decimal(result.move["amount"]) if result.move else Decimal("0")
                if amount <= 0 and book.operating is not None:
                    amount = book.operating  # "sweep it all"
                refund = "refund" in body.text.lower()
                movement = Movement(
                    kind="refund" if refund else "sweep", amount=amount, currency=limits["currency"],
                    idempotency_key=f"chat:{flow_id}",
                    to_account=None if refund else accounts.get(result.move["role"] if result.move else "ad_spend"),
                )
                guarded = await guard_plan(conn, merchant.id, [movement], trigger=Trigger("chat", verified=False),
                                           authority=False, available=book.operating, flow_id=flow_id)
                v = guarded.verdict
                out["verdict"] = {"decision": v.decision, "check": v.check, "reason": v.reason,
                                  "source": "Chat text is not an approval", "money_moved": "0.00", "amount": f"{amount:.2f}"}
    return out


@router.post("/copilot/accept")
async def copilot_accept(body: AcceptBody, merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, Any]:
    """The owner keeps the copilot's drafts: each becomes a new draft version marked as copilot-written.
    Nothing is simulated or approved here; that stays with the owner in the editor."""
    created = []
    async with connection() as conn:
        async with conn.transaction():
            for doc in body.drafts:
                cur = await conn.execute(
                    "select id from treasury_policies where merchant_id = %s and kind = %s and status <> 'retired'",
                    (merchant.id, doc.spec.kind),
                )
                existing = await cur.fetchone()
                if existing:
                    created.append(await service.new_version(conn, merchant.id, existing["id"], doc, created_by="copilot"))
                else:
                    created.append(await service.create_policy(conn, merchant.id, doc, created_by="copilot"))
    return {"created": created}


# --------------------------------------------------------------------------------------- history

FLOW_OUTCOMES = {  # the last decisive event in a flow, in plain words
    "execution.confirmed": "Confirmed by PayPal", "execution.accepted": "Sent to PayPal", "execution.failed": "PayPal rejected it",
    "execution.unconfirmed": "Waiting on PayPal", "approval.declined": "Declined by you", "approval.granted": "Approved by you",
    "safety.block": "Blocked by the safety engine", "safety.ask": "Waiting for your approval", "safety.allow": "Allowed",
    "plan.skipped": "Nothing to move", "copilot.interpreted": "Copilot drafted",
}


def _outcome(events: list[str]) -> str:
    for e in reversed(events):
        if e in FLOW_OUTCOMES:
            return FLOW_OUTCOMES[e]
    return events[-1] if events else ""


@router.get("/history")
async def history(merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, Any]:
    """One row per flow: what started it, what it ended as, and how many History entries it has."""
    async with connection() as conn:
        cur = await conn.execute(
            """
            select flow_id, min(created_at) as started, max(created_at) as ended, count(*) as entries,
                   array_agg(event order by id) as events,
                   (array_agg(data_json->>'policy' order by id) filter (where data_json ? 'policy'))[1] as policy,
                   (array_agg(actor order by id) filter (where event like 'trigger.%%' or event like 'copilot.%%'))[1] as started_by,
                   -- the amount of the flow's last safety decision (after any re-plan), never a text comparison
                   (array_agg((data_json->>'total')::numeric order by id desc) filter (where event like 'safety.%%' and data_json ? 'total'))[1] as total
            from audit_log where merchant_id = %s and flow_id is not null
            group by flow_id order by min(created_at) desc limit 100
            """,
            (merchant.id,),
        )
        flows = await cur.fetchall()
    return {"flows": [{**f, "outcome": _outcome(f["events"])} for f in flows]}


@router.get("/history/{flow_id}")
async def flow_timeline(flow_id: UUID, merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, Any]:
    async with connection() as conn:
        cur = await conn.execute(
            "select id, event, label, actor, data_json, created_at, prev_hash, row_hash from audit_log "
            "where merchant_id = %s and flow_id = %s order by id",
            (merchant.id, flow_id),
        )
        entries = await cur.fetchall()
    if not entries:
        raise TreasuryError("not_found", "No History for that flow", 404)
    return {"flow_id": str(flow_id), "outcome": _outcome([e["event"] for e in entries]), "entries": entries}


@router.post("/history/verify")
async def verify_history(merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, Any]:
    """Recompute every HMAC link in this account's History. Detects edits, removals, insertions and reordering
    after the fact; it can't prove an entry was true when it was written."""
    async with connection() as conn:
        report = await verify_chain(conn, merchant.id)
        await audit(conn, "history.verified", merchant_id=merchant.id, actor="owner",
                    data={"ok": report.ok, "entries": report.entries, "broken_at": report.broken_at})
    return {"ok": report.ok, "entries": report.entries, "broken_at": report.broken_at, "reason": report.reason}
