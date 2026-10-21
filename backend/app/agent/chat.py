"""Plain-language chat with the agent. The chat model can read the merchant's disputes and ask the
pipeline to prepare a response; it has no tool that submits anything to PayPal."""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from app.db import connection
from app.disputes.model import REASON_LABELS

from .llm import LLM
from .orchestrator import run_agent

CHAT_PROMPT = """You are BundoPay's dispute assistant, talking to a busy small-business owner.
Answer in plain, friendly language: short sentences, no jargon (say "refund" not "accept_claim",
"proof" not "evidence map"). Keep replies under 120 words unless asked for detail.

Use tools for every fact about disputes; never guess amounts, deadlines or outcomes.
You cannot send anything to PayPal yourself. When the owner wants to refund or respond, call
prepare_response; then tell them a draft is ready and that they can approve it with the button
shown under your message. Only say money was refunded if a tool result says status "auto_refunded"
(their automatic refund limit covered it) or the dispute shows as submitted/resolved.
If PayPal doesn't offer an action for a dispute, say so plainly.

Earlier AGENT lines in the conversation include updates you posted yourself (refunds you made within
the owner's limit, decisions you are waiting on). When the owner says yes to one of those, tell them to
press Approve on that dispute's card; you cannot approve on their behalf."""

TOOLS: list[dict[str, Any]] = [
    {
        "name": "list_disputes",
        "description": "All of the merchant's disputes with amount, reason, status, deadline and draft state.",
        "parameters": {"type": "OBJECT", "properties": {}, "required": []},
    },
    {
        "name": "get_dispute",
        "description": "Details for one dispute: what PayPal allows, the agent's recommendation and reasons, any gaps.",
        "parameters": {"type": "OBJECT", "properties": {"dispute_id": {"type": "STRING"}}, "required": ["dispute_id"]},
    },
    {
        "name": "prepare_response",
        "description": "Re-check the dispute with PayPal and prepare a response draft (refund, offer, or proof). "
        "Does not send anything unless the merchant's own automatic refund limit covers it.",
        "parameters": {
            "type": "OBJECT",
            "properties": {"dispute_id": {"type": "STRING"}, "acknowledge_past_due": {"type": "BOOLEAN"}},
            "required": ["dispute_id"],
        },
    },
    {
        "name": "get_refund_settings",
        "description": "The merchant's automatic refund rule (on/off and limit).",
        "parameters": {"type": "OBJECT", "properties": {}, "required": []},
    },
]


class ChatTools:
    def __init__(self, merchant_id: UUID):
        self.merchant_id = merchant_id
        self.touched: dict[str, None] = {}  # dispute ids the reply should offer buttons for

    async def call(self, name: str, args: dict[str, Any]) -> Any:
        fn = {
            "list_disputes": self.list_disputes,
            "get_dispute": self.get_dispute,
            "prepare_response": self.prepare_response,
            "get_refund_settings": self.get_refund_settings,
        }.get(name)
        if fn is None:
            raise PermissionError(f"Unknown tool {name}")
        return json.loads(json.dumps(await fn(**args), default=str))

    async def _owned(self, conn, dispute_id: str) -> dict[str, Any]:
        try:
            uid = UUID(dispute_id)
        except ValueError as exc:
            raise LookupError("Unknown dispute id; call list_disputes first") from exc
        cur = await conn.execute("select * from disputes where id = %s and merchant_id = %s", (uid, self.merchant_id))
        row = await cur.fetchone()
        if not row:
            raise LookupError("Dispute not found")
        return row

    async def list_disputes(self) -> list[dict[str, Any]]:
        async with connection() as conn:
            cur = await conn.execute(
                """
                select d.id, d.paypal_dispute_id, d.reason, d.amount, d.currency, d.status, d.due_date,
                       (select dr.status from drafts dr where dr.dispute_id = d.id order by dr.created_at desc limit 1) as draft_status
                from disputes d where d.merchant_id = %s order by d.due_date nulls last
                """,
                (self.merchant_id,),
            )
            rows = await cur.fetchall()
        return [{**r, "reason": REASON_LABELS.get(r["reason"] or "", r["reason"])} for r in rows]

    async def get_dispute(self, dispute_id: str) -> dict[str, Any]:
        async with connection() as conn:
            d = await self._owned(conn, dispute_id)
            cur = await conn.execute(
                "select recommendation, integrity_flags, coverage_score from evidence_maps where dispute_id = %s "
                "order by created_at desc limit 1",
                (d["id"],),
            )
            emap = await cur.fetchone()
            cur = await conn.execute(
                "select action, status, missing_items from drafts where dispute_id = %s order by created_at desc limit 1", (d["id"],)
            )
            draft = await cur.fetchone()
        self.touched[str(d["id"])] = None
        from app.disputes.model import parse_dispute

        facts = parse_dispute(d["raw_json"])
        return {
            "id": d["id"],
            "reason": facts.reason_label,
            "amount": d["amount"],
            "currency": d["currency"],
            "status": d["status"],
            "due_date": d["due_date"],
            "past_due": facts.is_past_due(),
            "paypal_allows": facts.allowed_actions,
            "recommendation": (emap or {}).get("recommendation"),
            "warnings": [f["detail"] for f in (emap or {}).get("integrity_flags") or []],
            "draft": draft,
        }

    async def prepare_response(self, dispute_id: str, acknowledge_past_due: bool = False) -> dict[str, Any]:
        async with connection() as conn:
            d = await self._owned(conn, dispute_id)
        self.touched[str(d["id"])] = None
        return await run_agent(d["id"], acknowledge_past_due=acknowledge_past_due)

    async def get_refund_settings(self) -> dict[str, Any]:
        async with connection() as conn:
            cur = await conn.execute(
                "select auto_refund_enabled, auto_refund_limit from merchants where id = %s", (self.merchant_id,)
            )
            return await cur.fetchone()


async def chat(merchant_id: UUID, messages: list[dict[str, str]], llm: LLM) -> dict[str, Any]:
    tools = ChatTools(merchant_id)
    transcript = "\n".join(f"{m['role'].upper()}: {m['content']}" for m in messages[-12:])
    reply = await llm.run(CHAT_PROMPT, f"Conversation so far:\n{transcript}\n\nReply to the last OWNER message.", TOOLS, tools.call)

    # Buttons for every dispute the agent looked at or acted on, from the database (never from model text).
    cards: list[dict[str, Any]] = []
    if tools.touched:
        async with connection() as conn:
            cur = await conn.execute(
                """
                select d.id as dispute_id, d.paypal_dispute_id, d.amount, d.currency, d.reason, d.status,
                       dr.id as draft_id, dr.action, dr.status as draft_status
                from disputes d
                left join lateral (select * from drafts where dispute_id = d.id order by created_at desc limit 1) dr on true
                where d.merchant_id = %s and d.id = any(%s)
                """,
                (merchant_id, [UUID(x) for x in tools.touched]),
            )
            for r in await cur.fetchall():
                cards.append({**r, "reason": REASON_LABELS.get(r["reason"] or "", r["reason"])})
    return {"reply": reply.strip(), "cards": cards}
