"""The agent's side of the conversation: what it did and what it needs from the merchant.

Messages are composed from PayPal facts and the agent's own reasons (no model call), so they are
instant and never state anything the records don't show.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection

from app.db import jsonb
from app.disputes.model import DisputeFacts

OUTCOMES = {
    "RESOLVED_BUYER_FAVOUR": "closed in the buyer's favour",
    "RESOLVED_SELLER_FAVOUR": "closed in your favour",
    "RESOLVED_WITH_PAYOUT": "closed with a payout",
    "CANCELED_BY_BUYER": "cancelled by the buyer",
    "ACCEPTED": "closed after you accepted the claim",
    "DENIED": "closed: PayPal denied the claim",
}
STATUS_WORDS = {
    "WAITING_FOR_SELLER_RESPONSE": "waiting for your response",
    "WAITING_FOR_BUYER_RESPONSE": "waiting for the buyer",
    "UNDER_REVIEW": "being reviewed by PayPal",
    "RESOLVED": "closed",
}


def money(amount: Decimal | str | None, currency: str | None) -> str:
    if amount is None:
        return "an unknown amount"
    value = Decimal(str(amount))
    symbol = {"USD": "$", "EUR": "€", "GBP": "£"}.get(currency or "", "")
    return f"{symbol}{value:,.2f}" if symbol else f"{currency} {value:,.2f}"


def _about(facts: DisputeFacts) -> str:
    return f"“{facts.reason_label}” ({money(facts.amount, facts.currency)}, case {facts.dispute_id})"


def _reasons(reasons: list[str], limit: int = 3) -> str:
    picked = [r.rstrip(".") + "." for r in reasons[:limit]]
    return " ".join(picked)


def compose_auto_refund(facts: DisputeFacts, limit: Decimal, status_after: str) -> str:
    return (
        f"I refunded {money(facts.amount, facts.currency)} to the buyer for {_about(facts)}. "
        f"It was within your {money(limit, facts.currency)} automatic refund limit. "
        f"PayPal now shows it as {STATUS_WORDS.get(status_after, status_after.lower())}."
    )


def compose_decision(
    facts: DisputeFacts, action: str, reasons: list[str], policy_enabled: bool, limit: Decimal, offer: str | None
) -> str:
    what = {
        "accept_claim": f"refunding the buyer {money(facts.amount, facts.currency)}",
        "make_offer": f"offering the buyer a partial refund of {money(offer, facts.currency)}",
        "provide_evidence": "sending PayPal your proof",
    }[action]
    why_asking = (
        f"It's above your {money(limit, facts.currency)} automatic limit, so I need your OK."
        if policy_enabled and action == "accept_claim" and facts.amount is not None and facts.amount > limit
        else "Nothing is sent until you approve."
    )
    deadline = f" PayPal needs a response by {facts.due_date:%b %d}." if facts.due_date else ""
    return f"New dispute: {_about(facts)}. I recommend {what}. {_reasons(reasons)} {why_asking}{deadline}"


def compose_no_action(facts: DisputeFacts, reasons: list[str]) -> str:
    return f"I reviewed {_about(facts)}. I don't recommend a response right now. {_reasons(reasons, 2)}"


def compose_past_due(facts: DisputeFacts) -> str:
    return (
        f"The deadline for {_about(facts)} has passed, so I haven't prepared anything. "
        "PayPal may not accept a response. Open the dispute if you still want me to try."
    )


def compose_submitted(facts_label: str, action: str, amount: str, status_after: str) -> str:
    done = {"accept_claim": f"Refund of {amount} sent", "make_offer": "Offer sent", "provide_evidence": "Your proof was sent"}[action]
    return f"{done} for {facts_label}. PayPal now shows it as {STATUS_WORDS.get(status_after, status_after.lower())}."


def compose_failed(facts_label: str, reason: str) -> str:
    return f"I couldn't send the response for {facts_label}: {reason} Nothing was sent. You can review it and try again."


def compose_outcome(reason_label: str | None, amount: str, outcome_code: str | None) -> str:
    return f"Dispute “{reason_label or 'dispute'}” ({amount}) is {OUTCOMES.get(outcome_code or '', 'closed')}. You can clear it from your list."


async def post(
    conn: AsyncConnection,
    merchant_id: UUID | str,
    content: str,
    *,
    kind: str,
    role: str = "agent",
    dispute_id: UUID | str | None = None,
    draft_id: UUID | str | None = None,
    meta: dict[str, Any] | None = None,
) -> None:
    await conn.execute(
        "insert into agent_messages (merchant_id, role, kind, content, dispute_id, draft_id, meta, read_at) "
        "values (%s, %s, %s, %s, %s, %s, %s, case when %s = 'owner' then now() end)",
        (merchant_id, role, kind, content, dispute_id, draft_id, jsonb(meta or {}), role),
    )
