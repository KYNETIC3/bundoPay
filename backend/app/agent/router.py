from __future__ import annotations

from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.audit import audit
from app.auth import CurrentMerchant, current_merchant
from app.deps import llm_rate_limit
from app.db import connection
from app.disputes.model import REASON_LABELS

from .chat import chat
from .llm import ModelUnavailableError
from .messages import post as post_message
from .orchestrator import default_llm

router = APIRouter()

# Plain-language labels for the activity feed.
ACTIVITY = {
    "dispute.new_work_item": "PayPal asked for a response",
    "dispute.status_changed": "Dispute status changed",
    "agent.recommendation": "Agent reviewed the case",
    "agent.draft_ready": "Response ready for your approval",
    "agent.auto_refund_started": "Agent refunded within your limit",
    "agent.auto_refund_failed": "Automatic refund didn't go through",
    "draft.approved": "Response approved",
    "draft.rejected": "Draft rejected",
    "submit.confirmed": "PayPal confirmed the response",
    "submit.failed": "PayPal rejected the response",
    "dispute.outcome_recorded": "Dispute closed",
    "agent_settings.updated": "Refund limit changed",
}


class AgentSettings(BaseModel):
    auto_refund_enabled: bool
    auto_refund_limit: Decimal = Field(ge=0, le=10000, decimal_places=2)


@router.get("/agent/settings")
async def get_agent_settings(merchant: CurrentMerchant = Depends(current_merchant)) -> dict:
    async with connection() as conn:
        cur = await conn.execute("select auto_refund_enabled, auto_refund_limit from merchants where id = %s", (merchant.id,))
        return await cur.fetchone()


@router.put("/agent/settings")
async def put_agent_settings(body: AgentSettings, merchant: CurrentMerchant = Depends(current_merchant)) -> dict:
    async with connection() as conn:
        await conn.execute(
            "update merchants set auto_refund_enabled = %s, auto_refund_limit = %s where id = %s",
            (body.auto_refund_enabled, body.auto_refund_limit, merchant.id),
        )
        await audit(conn, "agent_settings.updated", merchant_id=merchant.id,
                    data={"auto_refund_enabled": body.auto_refund_enabled, "auto_refund_limit": str(body.auto_refund_limit)})
    return body.model_dump(mode="json")


@router.get("/overview")
async def overview(merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, Any]:
    async with connection() as conn:
        cur = await conn.execute(
            """
            select
              count(*) filter (where status = 'WAITING_FOR_SELLER_RESPONSE') as needs_response,
              coalesce(sum(amount) filter (where status <> 'RESOLVED'), 0) as at_stake,
              count(*) filter (where status = 'WAITING_FOR_SELLER_RESPONSE' and due_date < now() + interval '48 hours') as due_soon,
              count(*) filter (where status = 'RESOLVED') as resolved,
              max(currency) as currency
            from disputes where merchant_id = %s
            """,
            (merchant.id,),
        )
        kpis = await cur.fetchone()
        cur = await conn.execute(
            """
            select coalesce(sum(d.amount), 0) as refunded, count(*) as refund_count,
                   count(*) filter (where a.source = 'policy') as auto_count
            from drafts dr join disputes d on d.id = dr.dispute_id
            left join approvals a on a.draft_id = dr.id and a.consumed_at is not null
            where d.merchant_id = %s and dr.status = 'submitted' and dr.action = 'accept_claim'
            """,
            (merchant.id,),
        )
        refunds = await cur.fetchone()
        cur = await conn.execute(
            """
            select a.event, a.created_at, a.data_json, d.id as dispute_id, d.reason, d.amount, d.currency
            from audit_log a left join disputes d on d.id = a.dispute_id
            where a.merchant_id = %s and a.event = any(%s) and a.created_at > coalesce((select activity_cleared_at from merchants where id = a.merchant_id), '-infinity') order by a.id desc limit 12
            """,
            (merchant.id, list(ACTIVITY)),
        )
        activity = [
            {
                "label": ACTIVITY[r["event"]],
                "event": r["event"],
                "at": r["created_at"],
                "dispute_id": r["dispute_id"],
                "reason": REASON_LABELS.get(r["reason"] or "", r["reason"]),
                "amount": r["amount"],
                "currency": r["currency"],
            }
            for r in await cur.fetchall()
        ]
    return {**kpis, **refunds, "activity": activity}


class ChatBody(BaseModel):
    content: str = Field(min_length=1, max_length=4000)


def _card(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "dispute_id": r["d_id"],
        "paypal_dispute_id": r["paypal_dispute_id"],
        "reason": REASON_LABELS.get(r["d_reason"] or "", r["d_reason"]),
        "amount": r["d_amount"],
        "currency": r["d_currency"],
        "status": r["d_status"],
        "archived": r["archived_at"] is not None,
        "draft_id": r["dr_id"],
        "action": r["dr_action"],
        "draft_status": r["dr_status"],
        "payload_hash": r["dr_hash"],
        "offer_amount": r["dr_offer"],
    }


CARD_SQL = """
    select d.id as d_id, d.paypal_dispute_id, d.reason as d_reason, d.amount as d_amount, d.currency as d_currency,
           d.status as d_status, d.archived_at,
           dr.id as dr_id, dr.action as dr_action, dr.status as dr_status, dr.payload_hash as dr_hash,
           dr.payload_json->'offer_amount'->>'value' as dr_offer
    from disputes d
    left join drafts dr on dr.id = coalesce(%(draft_id)s,
        (select id from drafts where dispute_id = d.id order by created_at desc limit 1))
    where d.id = any(%(ids)s) and d.merchant_id = %(merchant)s
"""


@router.get("/agent/messages")
async def agent_messages(merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, Any]:
    """The conversation: the agent's own updates plus chat, oldest first, with live dispute/draft state."""
    async with connection() as conn:
        cur = await conn.execute(
            "select * from (select * from agent_messages where merchant_id = %s and created_at > coalesce((select conversation_cleared_at from merchants where id = %s), '-infinity') "
            "order by id desc limit 150) m order by id",
            (merchant.id, merchant.id),
        )
        rows = await cur.fetchall()
        out = []
        for m in rows:
            ids = [m["dispute_id"]] if m["dispute_id"] else [UUID(x) for x in (m["meta"] or {}).get("dispute_ids", [])]
            cards = []
            if ids:
                c2 = await conn.execute(CARD_SQL, {"draft_id": m["draft_id"], "ids": ids, "merchant": merchant.id})
                cards = [_card(r) for r in await c2.fetchall()]
            plan = None
            if m["kind"] == "treasury_approval" and (meta := m["meta"] or {}).get("plan_id"):
                c3 = await conn.execute(
                    "select status, expires_at from treasury_plans where id = %s and merchant_id = %s", (meta["plan_id"], merchant.id)
                )
                live = await c3.fetchone()
                plan = {**meta, "status": live["status"] if live else "missing", "expires_at": live["expires_at"] if live else None}
            out.append({"id": m["id"], "role": m["role"], "kind": m["kind"], "content": m["content"],
                        "created_at": m["created_at"], "unread": m["read_at"] is None, "cards": cards, "plan": plan})
    return {"messages": out, "unread": sum(1 for m in out if m["unread"])}


@router.get("/agent/unread")
async def agent_unread(merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, int]:
    async with connection() as conn:
        cur = await conn.execute(
            "select count(*) as n from agent_messages where merchant_id = %s and read_at is null", (merchant.id,)
        )
        return {"count": (await cur.fetchone())["n"]}


@router.post("/overview/activity/clear")
async def clear_activity(merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, str]:
    """Hide older entries from the Overview's activity card. The audit log itself is never deleted."""
    async with connection() as conn:
        await conn.execute("update merchants set activity_cleared_at = now() where id = %s", (merchant.id,))
    return {"status": "cleared"}


@router.post("/agent/messages/clear")
async def clear_conversation(merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, str]:
    """Start a fresh conversation view. Earlier messages stay stored; they're just no longer shown."""
    async with connection() as conn:
        await conn.execute("update merchants set conversation_cleared_at = now() where id = %s", (merchant.id,))
        await conn.execute("update agent_messages set read_at = now() where merchant_id = %s and read_at is null", (merchant.id,))
    return {"status": "cleared"}


@router.post("/agent/messages/read")
async def mark_read(merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, str]:
    async with connection() as conn:
        await conn.execute("update agent_messages set read_at = now() where merchant_id = %s and read_at is null", (merchant.id,))
    return {"status": "ok"}


@router.post("/agent/chat")
async def agent_chat(body: ChatBody, merchant: CurrentMerchant = Depends(llm_rate_limit)) -> dict[str, Any]:
    llm = default_llm()
    if llm is None:
        raise HTTPException(503, {"code": "no_model", "message": "Agent chat needs GEMINI_API_KEY in backend/.env."})
    async with connection() as conn:
        await post_message(conn, merchant.id, body.content, kind="chat", role="owner")
        await audit(conn, "agent.chat", merchant_id=merchant.id, data={"question": body.content[:500]})
        # The agent sees its own recent updates too, so "approve the one you just told me about" works.
        cur = await conn.execute(
            "select role, content from (select * from agent_messages where merchant_id = %s and created_at > coalesce((select conversation_cleared_at from merchants where id = %s), '-infinity') "
            "order by id desc limit 12) m order by id",
            (merchant.id, merchant.id),
        )
        history = [{"role": r["role"], "content": r["content"]} for r in await cur.fetchall()]
    try:
        reply = await chat(merchant.id, history, llm)
    except ModelUnavailableError as exc:
        reply = {"reply": str(exc), "cards": []}
    except RuntimeError as exc:
        reply = {"reply": f"Sorry, I couldn't finish that: {exc}", "cards": []}
    async with connection() as conn:
        await post_message(
            conn, merchant.id, reply["reply"] or "Done.", kind="chat",
            meta={"dispute_ids": [str(c["dispute_id"]) for c in reply["cards"]]},
        )
        await conn.execute("update agent_messages set read_at = now() where merchant_id = %s and read_at is null", (merchant.id,))
    return {"status": "ok"}
