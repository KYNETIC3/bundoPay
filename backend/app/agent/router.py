from __future__ import annotations

from decimal import Decimal
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.audit import audit
from app.auth import CurrentMerchant, current_merchant
from app.db import connection
from app.disputes.model import REASON_LABELS

from .chat import chat
from .llm import ModelUnavailableError
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
            where a.merchant_id = %s and a.event = any(%s) order by a.id desc limit 12
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


class ChatMessage(BaseModel):
    role: Literal["owner", "agent"]
    content: str = Field(max_length=4000)


class ChatBody(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=40)


@router.post("/agent/chat")
async def agent_chat(body: ChatBody, merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, Any]:
    llm = default_llm()
    if llm is None:
        raise HTTPException(503, {"code": "no_model", "message": "Agent chat needs GEMINI_API_KEY in backend/.env."})
    async with connection() as conn:
        await audit(conn, "agent.chat", merchant_id=merchant.id, data={"question": body.messages[-1].content[:500]})
    try:
        return await chat(merchant.id, [m.model_dump() for m in body.messages], llm)
    except ModelUnavailableError as exc:
        raise HTTPException(503, {"code": "model_busy", "message": str(exc)}) from exc
    except RuntimeError as exc:
        raise HTTPException(502, {"code": "agent_error", "message": str(exc)}) from exc
