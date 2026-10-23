"""Agent pipeline: TRIGGER -> READ -> EVIDENCE MAP -> INTEGRITY -> RECOMMEND -> ASSEMBLE -> STOP.

The pipeline stops at a draft awaiting approval. Nothing here can submit to PayPal.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import replace
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from app.adapters.csv_adapter import CsvAdapter, PgRecordStore
from app.audit import audit
from app.config import get_settings
from app.db import connection, jsonb
from app.deps import get_gateway, revocation_guard
from app.disputes.model import DisputeFacts, parse_dispute
from app.disputes.sync import upsert_dispute
from app.events import notify_dispute_changed

from .assemble import assemble, payload_hash
from .evidence import EvidenceMap, build_evidence_map, gather
from .llm import LLM, GeminiLLM, parse_json_object
from .messages import (
    compose_auto_refund,
    compose_decision,
    compose_no_action,
    compose_past_due,
)
from .messages import post as post_message
from .prompts import SYSTEM_PROMPT
from .recommend import (
    DisallowedActionError,
    History,
    Recommendation,
    RefundPolicy,
    enforce_allowed,
    policy_allows_auto_refund,
    recommend,
)
from .tools import READ_ONLY_TOOLS, TOOL_SPECS, ToolBox

log = logging.getLogger(__name__)

SELLER_WINS = {"RESOLVED_SELLER_FAVOUR", "CANCELED_BY_BUYER", "DENIED"}
# Tokens that look like identifiers or figures (contain a digit, 4+ chars) must be present in the records.
_ID_LIKE = re.compile(r"\b(?=[A-Za-z0-9\-_.]*\d)[A-Za-z0-9\-_.]{4,}\b")


def default_llm() -> LLM | None:
    s = get_settings()
    return GeminiLLM(s.gemini_api_key, s.gemini_model, s.gemini_fallback_model) if s.gemini_api_key else None


def note_is_grounded(note: str, corpus: str) -> bool:
    return all(tok in corpus for tok in _ID_LIKE.findall(note))


async def refine_with_model(
    facts: DisputeFacts,
    emap: EvidenceMap,
    baseline: Recommendation,
    llm: LLM,
    tools: ToolBox,
    corpus: str,
    on_event,
) -> Recommendation:
    """Ask the model for reasoning and notes. Code, not the prompt, enforces the HATEOAS gate,
    the note limits and grounding; anything that fails falls back to the rules baseline."""
    user = json.dumps(
        {
            "dispute": {
                "id": facts.dispute_id,
                "reason": facts.reason,
                "lifecycle_stage": facts.lifecycle_stage,
                "amount": str(facts.amount),
                "currency": facts.currency,
                "seller_response_due_date": facts.due_date.isoformat() if facts.due_date else None,
                "hours_remaining": baseline.hours_remaining,
            },
            "allowed_actions": facts.allowed_actions,
            "evidence_map": emap.to_json(),
            "baseline_recommendation": {"action": baseline.action, "reasons": baseline.reasons},
        },
        default=str,
    )
    specs = [s for s in TOOL_SPECS if s["name"] in READ_ONLY_TOOLS]
    try:
        text = await llm.run(SYSTEM_PROMPT, user, specs, tools.call)
        out = parse_json_object(text)
    except Exception as exc:
        await on_event("agent.model_failed", {"error": str(exc)})
        return baseline

    action = out.get("action")
    try:
        action = enforce_allowed(action, facts)
    except DisallowedActionError as exc:
        await on_event("agent.disallowed_action_rejected", {"proposed": action, "allowed": facts.allowed_actions, "error": str(exc)})
        return baseline

    notes: dict[str, str] = {}
    for key, note in (out.get("notes") or {}).items():
        if not isinstance(note, str) or len(note) >= 500 or not note_is_grounded(note, corpus):
            await on_event("agent.note_rejected", {"evidence_type": key, "length": len(str(note))})
            continue
        notes[key] = note.strip()

    reasons = [str(r) for r in out.get("reasons") or []][:8] or baseline.reasons
    offer = baseline.offer_amount if action == "make_offer" else None
    if action == "make_offer" and offer is None and facts.amount is not None:
        offer = str(facts.amount)
    return replace(baseline, action=action, reasons=reasons, notes=notes, source=f"model:{llm.name}", offer_amount=offer)


async def _history(conn, merchant_id: UUID, reason: str | None) -> History:
    cur = await conn.execute(
        """
        select count(*) filter (where o.action_taken = 'provide_evidence') as subs,
               count(*) filter (where o.action_taken = 'provide_evidence' and o.final_status = any(%s)) as wins
        from outcomes o join disputes d on d.id = o.dispute_id
        where d.merchant_id = %s and o.reason is not distinct from %s
        """,
        (list(SELLER_WINS), merchant_id, reason),
    )
    row = await cur.fetchone()
    return History(evidence_submissions=row["subs"] or 0, evidence_wins=row["wins"] or 0)


async def run_agent(dispute_id: UUID, *, acknowledge_past_due: bool = False, llm: LLM | None = None) -> dict[str, Any]:
    async with connection() as conn:
        cur = await conn.execute(
            "select d.*, m.paypal_merchant_id, m.grant_status, m.auto_refund_enabled, m.auto_refund_limit from disputes d join merchants m on m.id = d.merchant_id "
            "where d.id = %s",
            (dispute_id,),
        )
        row = await cur.fetchone()
    if not row:
        raise LookupError("Dispute not found")
    merchant_id = row["merchant_id"]

    async def event(name: str, data: dict[str, Any]) -> None:
        async with connection() as c:
            await audit(c, name, merchant_id=merchant_id, dispute_id=dispute_id, data=data)

    async def tell(content: str, *, kind: str, draft_id: Any = None) -> None:
        async with connection() as c:
            await post_message(c, merchant_id, content, kind=kind, dispute_id=dispute_id, draft_id=draft_id)

    if row["grant_status"] != "granted":
        await event("agent.skipped", {"why": "paypal_not_connected"})
        return {"status": "reconnect_required"}

    # READ: PayPal overrides memory; always re-fetch before acting.
    async with revocation_guard(merchant_id):
        raw = await get_gateway().get_dispute(row["paypal_merchant_id"], row["paypal_dispute_id"])
    async with connection() as conn:
        await upsert_dispute(conn, merchant_id, raw)
    facts = parse_dispute(raw)
    await event("agent.started", {"status": facts.status, "allowed_actions": facts.allowed_actions})

    if facts.status != "WAITING_FOR_SELLER_RESPONSE":
        await event("agent.skipped", {"why": "not_waiting_for_seller", "status": facts.status})
        return {"status": "not_actionable", "paypal_status": facts.status}
    if facts.is_past_due() and not acknowledge_past_due:
        await event("agent.past_due_blocked", {"due": facts.due_date.isoformat()})
        async with connection() as conn:
            cur = await conn.execute(
                "select 1 from agent_messages where dispute_id = %s and kind = 'past_due' limit 1", (dispute_id,)
            )
            if not await cur.fetchone():
                await post_message(conn, merchant_id, compose_past_due(facts), kind="past_due", dispute_id=dispute_id)
        return {"status": "past_due", "due_date": facts.due_date.isoformat()}

    async def tool_audit(name: str, args: dict[str, Any], result: dict[str, Any]) -> None:
        await event("agent.tool_call", {"tool": name, "args": args, **result})

    adapters = [CsvAdapter(PgRecordStore(merchant_id))]
    tools = ToolBox(get_gateway(), row["paypal_merchant_id"], facts.dispute_id, adapters, tool_audit)

    async with revocation_guard(merchant_id):
        ctx = await gather(facts, tools)
    emap = build_evidence_map(facts, ctx)
    await event("agent.evidence_map", {"coverage": emap.coverage_score, "flags": [f.kind for f in emap.flags]})

    async with connection() as conn:
        history = await _history(conn, merchant_id, facts.reason)
    policy = RefundPolicy(enabled=row["auto_refund_enabled"], limit=row["auto_refund_limit"])
    rec = recommend(facts, emap, history, policy=policy)
    llm = llm if llm is not None else default_llm()
    if llm is not None:
        corpus = json.dumps({"raw": raw, "ctx": ctx.__dict__}, default=str)
        async with revocation_guard(merchant_id):
            rec = await refine_with_model(facts, emap, rec, llm, tools, corpus, event)
    await event("agent.recommendation", {"action": rec.action, "source": rec.source, "reasons": rec.reasons})

    spec = assemble(facts, emap, rec)
    async with connection() as conn:
        async with conn.transaction():
            cur = await conn.execute(
                "insert into evidence_maps (dispute_id, work_item_key, rows_json, integrity_flags, coverage_score, recommendation) "
                "values (%s, %s, %s, %s, %s, %s) returning id",
                (
                    dispute_id,
                    row["work_item_key"],
                    jsonb(emap.to_json()["rows"]),
                    jsonb(emap.to_json()["flags"]),
                    emap.coverage_score,
                    jsonb(rec.to_json()),
                ),
            )
            map_id = (await cur.fetchone())["id"]
            draft_id = None
            if spec:
                await conn.execute(
                    "update drafts set status = 'superseded', updated_at = now() "
                    "where dispute_id = %s and status = 'awaiting_approval'",
                    (dispute_id,),
                )
                cur = await conn.execute(
                    "insert into drafts (dispute_id, evidence_map_id, action, payload_json, files, missing_items, payload_hash) "
                    "values (%s, %s, %s, %s, '[]', %s, %s) returning id",
                    (
                        dispute_id,
                        map_id,
                        spec.action,
                        jsonb(spec.payload),
                        jsonb(spec.missing_items),
                        payload_hash(facts.dispute_id, spec.action, spec.payload, []),
                    ),
                )
                draft_id = (await cur.fetchone())["id"]
                await notify_dispute_changed(conn, merchant_id, dispute_id)
            await audit(
                conn,
                "agent.draft_ready" if spec else "agent.no_draft",
                merchant_id=merchant_id,
                dispute_id=dispute_id,
                data={"evidence_map_id": str(map_id), "draft_id": str(draft_id) if draft_id else None, "at": datetime.now(timezone.utc).isoformat()},
            )
    result = {"status": "draft_ready" if spec else "no_action", "evidence_map_id": str(map_id), "draft_id": str(draft_id) if draft_id else None}
    if spec and policy_allows_auto_refund(policy, facts, spec.action):
        # The merchant's own standing rule approves this refund; it goes through the same
        # token-and-hash-checked submit path as a manual click.
        from app.approvals.service import approve_by_policy

        await event("agent.auto_refund_started", {"draft_id": str(draft_id), "amount": str(facts.amount), "limit": str(policy.limit)})
        try:
            submitted = await approve_by_policy(merchant_id, draft_id, policy)
        except Exception as exc:
            await event("agent.auto_refund_failed", {"draft_id": str(draft_id), "error": f"{type(exc).__name__}: {exc}"})
        else:
            await tell(compose_auto_refund(facts, policy.limit, submitted.status_after), kind="auto_refund", draft_id=draft_id)
            return {**result, "status": "auto_refunded", "paypal_status": submitted.status_after}

    # STOP: anything outside the merchant's rule waits for their approval. The agent cannot submit,
    # so it tells the merchant what it found and what it recommends.
    if spec:
        offer = spec.payload.get("offer_amount", {}).get("value") if spec.action == "make_offer" else None
        await tell(
            compose_decision(facts, spec.action, rec.reasons, policy.enabled, policy.limit, offer),
            kind="decision",
            draft_id=draft_id,
        )
    else:
        await tell(compose_no_action(facts, rec.reasons), kind="info")
    return result
