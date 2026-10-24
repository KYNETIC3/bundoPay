"""Policy runs: trigger → plan → safety engine → executor, approval card, or block (and a re-plan).

Every run gets a flow id, and every step is written to History under it. Runs are keyed by a slot (the
scheduled time, the capture id, the dispute update, or the owner's tap), so the same trigger arriving
twice is rejected by the engine as a duplicate.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

from app.agent.messages import post as post_message
from app.audit import audit
from app.config import get_settings
from app.db import connection, jsonb
from app.events import notify_treasury_changed
from app.executor.service import execute
from app.approvals.tokens import ApprovalError, issue, token_hash, verify
from app.safety.engine import Movement, Trigger
from app.safety.service import guard_plan

from .policy import AdSweep, Book, PolicyDoc, Proposal, TaxReserve, next_fire, plan, rebalance
from .service import TreasuryError, accounts_by_role, companion_specs, load_book

log = logging.getLogger("treasury")

PLAN_TTL = timedelta(hours=24)
MAX_FAILURES = 3  # pause a policy after this many runs in a row that PayPal rejected


def _movements(proposals: list[Proposal], accounts: dict[str, str], currency: str, key: str) -> list[Movement]:
    return [
        Movement(kind="sweep", amount=p.amount, currency=currency, idempotency_key=f"{key}:{p.key_part}", to_account=accounts.get(p.role))
        for p in proposals
    ]


def plan_hash(flow_id: str, items: list[dict[str, str]]) -> str:
    body = json.dumps({"flow": flow_id, "items": items}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(body.encode()).hexdigest()


def _items(proposals: list[Proposal], accounts: dict[str, str], key: str) -> list[dict[str, str]]:
    return [
        {"role": p.role, "account_id": accounts.get(p.role) or "", "amount": f"{p.amount:.2f}", "policy": p.policy,
         "idempotency_key": f"{key}:{p.key_part}"}
        for p in proposals
    ]


async def run_policy(
    merchant_id: UUID | str, policy_id: UUID | str, *, trigger: Trigger, slot: str, gateway=None
) -> dict[str, Any]:
    flow_id = str(uuid4())
    async with connection() as conn:
        cur = await conn.execute(
            "select p.*, v.id as version_id, v.version, v.doc_json, v.spec_hash, v.approved_hash "
            "from treasury_policies p left join treasury_policy_versions v on v.id = p.active_version_id "
            "where p.id = %s and p.merchant_id = %s",
            (policy_id, merchant_id),
        )
        policy = await cur.fetchone()
    if not policy:
        raise TreasuryError("not_found", "Policy not found", 404)
    # Authority comes from the database, never from whoever asked: an active policy whose live version
    # was approved exactly as stored.
    authority = (
        policy["status"] == "active" and policy["version_id"] is not None and policy["approved_hash"] == policy["spec_hash"]
    )
    doc = PolicyDoc.model_validate(policy["doc_json"]) if policy["doc_json"] else None
    version_ref = f"{policy['kind']}@v{policy['version']}" if doc else None
    key = f"{policy['kind']}:{policy['version_id']}:{slot}"

    async with connection() as conn:
        async with conn.transaction():
            book = await load_book(conn, merchant_id, gateway=gateway)
            accounts = await accounts_by_role(conn, merchant_id)
            buffer, tax = await companion_specs(conn, merchant_id)
            currency = (await (await conn.execute("select currency from treasury_limits where merchant_id = %s", (merchant_id,))).fetchone())["currency"]
            await audit(conn, "trigger.verified" if trigger.verified else "trigger.unverified", merchant_id=merchant_id, flow_id=flow_id,
                        label="provider_verified" if trigger.source == "webhook" else "system_generated", actor=trigger.source,
                        data={"policy": version_ref, "slot": slot})
            if not authority or doc is None:
                # Check 1 of the engine, recorded without a movement row: there is nothing approved to plan from.
                await audit(conn, "safety.block", merchant_id=merchant_id, flow_id=flow_id, actor="safety_engine",
                            data={"check": "1_no_authority", "reason": "No active, approved policy version covers this run",
                                  "policy_id": str(policy_id), "trigger": trigger.source, "money_moved": "0.00"})
                return {"flow_id": flow_id, "status": "blocked", "check": "1_no_authority",
                        "reason": "No active, approved policy version covers this run"}
            proposals = plan(doc.spec, book, buffer=buffer, tax=tax)
            if not proposals:
                await audit(conn, "plan.skipped", merchant_id=merchant_id, flow_id=flow_id, actor="planner",
                            data={"policy": version_ref, "reason": "Nothing to move: every target is met"})
                await _advance(conn, policy, doc)
                return {"flow_id": flow_id, "status": "skipped"}
            result = await _guard_and_route(conn, merchant_id, flow_id, proposals, accounts, currency, key, trigger, authority,
                                            book, version_ref, policy)
            if result["status"] == "blocked" and isinstance(doc.spec, AdSweep) and result["check"] == "6_liquidity_floor":
                # The sweep doesn't fit. Fund the reserves first, then whatever is still above the floor.
                alt = rebalance(book, ad_amount=doc.spec.amount, buffer=buffer, tax=tax)
                if alt:
                    await audit(conn, "plan.rebalanced", merchant_id=merchant_id, flow_id=flow_id, actor="planner",
                                data={"items": _items(alt, accounts, f"{key}:rebalance"),
                                      "operating_after": f"{book.operating - sum((p.amount for p in alt), Decimal('0')):.2f}" if book.operating is not None else None})
                    result = await _guard_and_route(conn, merchant_id, flow_id, alt, accounts, currency, f"{key}:rebalance",
                                                    trigger, authority, book, version_ref, policy, replan=True)
            if result["status"] in ("allowed", "needs_approval") and isinstance(doc.spec, TaxReserve):
                await _mark_reserved(conn, merchant_id, result["movement_ids"])
            await _advance(conn, policy, doc)
            await notify_treasury_changed(conn, merchant_id)
    if result["status"] == "allowed":
        execution = await execute(merchant_id, list(result["movement_ids"]), flow_id=flow_id, gateway=gateway)
        await _record_failure(merchant_id, policy_id, execution.status)
        result = {**result, "execution": execution.status}
    return {k: v for k, v in result.items() if k != "movement_ids"} | {"flow_id": flow_id}


async def _guard_and_route(conn, merchant_id, flow_id, proposals, accounts, currency, key, trigger, authority, book: Book,
                           version_ref, policy, *, replan: bool = False) -> dict[str, Any]:
    items = _items(proposals, accounts, key)
    await audit(conn, "plan.proposed", merchant_id=merchant_id, flow_id=flow_id, actor="planner",
                data={"policy": version_ref, "items": items, "replan": replan})
    guarded = await guard_plan(
        conn, merchant_id, _movements(proposals, accounts, currency, key), trigger=trigger, authority=authority,
        available=book.operating, flow_id=flow_id, policy_version=version_ref,
    )
    v = guarded.verdict
    if v.decision == "block":
        return {"status": "blocked", "check": v.check, "reason": v.reason, "movement_ids": guarded.movement_ids}
    if v.decision == "allow":
        return {"status": "allowed", "check": v.check, "reason": v.reason, "movement_ids": guarded.movement_ids}
    h = plan_hash(flow_id, items)
    cur = await conn.execute(
        "insert into treasury_plans (merchant_id, flow_id, policy_version_id, items_json, plan_hash, total, status, reason, expires_at) "
        "values (%s, %s, %s, %s, %s, %s, 'needs_approval', %s, %s) returning id",
        (merchant_id, flow_id, policy["version_id"], jsonb(items), h, v.total, v.reason, datetime.now(timezone.utc) + PLAN_TTL),
    )
    plan_id = (await cur.fetchone())["id"]
    await conn.execute("update movements set plan_id = %s where id = any(%s)", (plan_id, list(guarded.movement_ids)))
    await post_message(
        conn, merchant_id,
        f"I need your approval to move ${v.total:,.2f}: {v.reason}. Review the plan and approve or decline.",
        kind="treasury_approval",
        meta={"plan_id": str(plan_id), "plan_hash": h, "flow_id": flow_id, "total": f"{v.total:.2f}", "items": items},
    )
    return {"status": "needs_approval", "check": v.check, "reason": v.reason, "plan_id": str(plan_id), "movement_ids": guarded.movement_ids}


async def _mark_reserved(conn, merchant_id, movement_ids) -> None:
    if movement_ids:
        await conn.execute(
            "update treasury_captures c set reserved_by = %s where c.merchant_id = %s and (c.reserved_by is null or exists "
            "(select 1 from movements mv where mv.id = c.reserved_by and mv.status in ('failed', 'blocked')))",
            (movement_ids[0], merchant_id),
        )


async def _advance(conn, policy: dict[str, Any], doc: PolicyDoc | None) -> None:
    if doc and policy["status"] == "active":
        await conn.execute(
            "update treasury_policies set next_run_at = %s, updated_at = now() where id = %s",
            (next_fire(doc.spec, datetime.now(timezone.utc)), policy["id"]),
        )


async def _record_failure(merchant_id, policy_id, status: str) -> None:
    async with connection() as conn:
        if status == "failed":
            cur = await conn.execute(
                "update treasury_policies set failures = failures + 1, "
                "status = case when failures + 1 >= %s then 'paused' else status end, updated_at = now() "
                "where id = %s returning status, failures",
                (MAX_FAILURES, policy_id),
            )
            row = await cur.fetchone()
            if row and row["status"] == "paused":
                await audit(conn, "policy.paused", merchant_id=merchant_id, actor="executor",
                            data={"policy_id": str(policy_id), "reason": f"PayPal rejected {row['failures']} runs in a row"})
                await post_message(conn, merchant_id, f"I paused a policy after {row['failures']} payouts in a row were rejected by PayPal.",
                                   kind="info")
        elif status in ("succeeded", "executing"):
            await conn.execute("update treasury_policies set failures = 0 where id = %s", (policy_id,))


# ------------------------------------------------------------------------------------ approvals


async def approve_plan(merchant_id: UUID | str, plan_id: UUID | str, *, plan_hash_seen: str, approver: str, gateway=None) -> dict[str, Any]:
    """The owner's authenticated tap. Mints a single-use approval token bound to the plan hash, re-runs
    the engine with that approval, and sends only if it now allows."""
    settings = get_settings()
    async with connection() as conn:
        async with conn.transaction():
            cur = await conn.execute(
                "update treasury_plans set status = 'approved', decided_at = now() where id = %s and merchant_id = %s "
                "and status = 'needs_approval' and expires_at > now() and plan_hash = %s returning *",
                (plan_id, merchant_id, plan_hash_seen),
            )
            p = await cur.fetchone()
            if not p:
                raise TreasuryError("not_approvable", "This plan changed, expired or was already decided.", 409)
            token, claims = issue(settings.approval_signing_key, draft_id=f"plan:{plan_id}", merchant_id=str(merchant_id),
                                  payload_hash=p["plan_hash"], ttl_seconds=settings.approval_token_ttl_seconds)
            await audit(conn, "approval.granted", merchant_id=merchant_id, flow_id=p["flow_id"], actor=approver,
                        data={"plan_id": str(plan_id), "payload_hash": p["plan_hash"], "token": f"hmac:sha256:{token_hash(token)[:16]}",
                              "total": f"{p['total']:.2f}"})
    return await _execute_approved(merchant_id, p, token, gateway=gateway)


async def _execute_approved(merchant_id, p: dict[str, Any], token: str, *, gateway=None) -> dict[str, Any]:
    settings = get_settings()
    try:
        claims = verify(settings.approval_signing_key, token)
    except ApprovalError as exc:
        raise TreasuryError(exc.code, str(exc), 409) from exc
    if claims.draft_id != f"plan:{p['id']}" or claims.payload_hash != p["plan_hash"] or claims.merchant_id != str(merchant_id):
        raise TreasuryError("token_mismatch", "The approval doesn't match this plan", 409)
    items = p["items_json"]
    async with connection() as conn:
        async with conn.transaction():
            book = await load_book(conn, merchant_id, gateway=gateway)
            currency = (await (await conn.execute("select currency from treasury_limits where merchant_id = %s", (merchant_id,))).fetchone())["currency"]
            movements = [
                Movement(kind="sweep", amount=Decimal(i["amount"]), currency=currency, idempotency_key=i["idempotency_key"],
                         to_account=i["account_id"] or None)
                for i in items
            ]
            guarded = await guard_plan(
                conn, merchant_id, movements, trigger=Trigger("user", verified=True), authority=True, approved=True,
                available=book.operating, flow_id=p["flow_id"], plan_id=p["id"],
            )
            status = "executed" if guarded.verdict.allowed else "blocked"
            await conn.execute("update treasury_plans set status = %s where id = %s", (status, p["id"]))
            await notify_treasury_changed(conn, merchant_id)
    if not guarded.verdict.allowed:
        return {"status": "blocked", "check": guarded.verdict.check, "reason": guarded.verdict.reason, "flow_id": str(p["flow_id"])}
    execution = await execute(merchant_id, list(guarded.movement_ids), flow_id=p["flow_id"], gateway=gateway)
    return {"status": "allowed", "execution": execution.status, "flow_id": str(p["flow_id"])}


async def reject_plan(merchant_id: UUID | str, plan_id: UUID | str, *, approver: str) -> None:
    async with connection() as conn:
        async with conn.transaction():
            cur = await conn.execute(
                "update treasury_plans set status = 'rejected', decided_at = now() where id = %s and merchant_id = %s "
                "and status = 'needs_approval' returning flow_id",
                (plan_id, merchant_id),
            )
            p = await cur.fetchone()
            if not p:
                raise TreasuryError("not_rejectable", "This plan was already decided", 409)
            # Keys stay taken: the same trigger arriving again doesn't re-ask.
            await conn.execute(
                "update movements set status = 'blocked', verdict = 'block', check_code = 'owner_declined', "
                "reason = 'Declined by the owner', updated_at = now() where plan_id = %s and status = 'needs_approval'",
                (plan_id,),
            )
            await audit(conn, "approval.declined", merchant_id=merchant_id, flow_id=p["flow_id"], actor=approver,
                        data={"plan_id": str(plan_id), "money_moved": "0.00"})
            await notify_treasury_changed(conn, merchant_id)
