"""Pure helpers for reading PayPal dispute JSON. PayPal's payload is the source of truth."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

ACTION_LINK_RELS = {
    "provide_evidence": "provide_evidence",
    "make_offer": "make_offer",
    "accept_claim": "accept_claim",
}

REASON_LABELS = {
    "MERCHANDISE_OR_SERVICE_NOT_RECEIVED": "Buyer says the order never arrived",
    "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED": "Buyer says the item isn't as described",
    "UNAUTHORISED": "Buyer says they didn't authorize the payment",
    "CREDIT_NOT_PROCESSED": "Buyer says a promised refund wasn't processed",
    "DUPLICATE_TRANSACTION": "Buyer says they were charged twice",
    "INCORRECT_AMOUNT": "Buyer says they were charged the wrong amount",
    "PAYMENT_BY_OTHER_MEANS": "Buyer says they paid another way",
    "CANCELED_RECURRING_BILLING": "Buyer says they cancelled a subscription",
    "PROBLEM_WITH_REMITTANCE": "Problem with the payment transfer",
    "OTHER": "Other reason",
}


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


@dataclass
class DisputeFacts:
    dispute_id: str
    status: str
    reason: str | None
    lifecycle_stage: str | None
    amount: Decimal | None
    currency: str | None
    due_date: datetime | None
    create_time: datetime | None
    disputed_transactions: list[dict[str, Any]]
    requested_evidences: list[dict[str, Any]]
    allowed_actions: list[str]
    seller_merchant_ids: list[str]
    outcome_code: str | None

    @property
    def reason_label(self) -> str:
        return REASON_LABELS.get(self.reason or "", (self.reason or "Unknown").replace("_", " ").capitalize())

    def is_past_due(self, now: datetime | None = None) -> bool:
        return self.due_date is not None and self.due_date < (now or datetime.now(timezone.utc))


def link_rels(raw: dict[str, Any]) -> set[str]:
    return {link.get("rel") for link in raw.get("links", []) if link.get("rel")}


def allowed_actions(raw: dict[str, Any]) -> list[str]:
    """The only actions that may ever be proposed: those whose HATEOAS link PayPal returned."""
    rels = link_rels(raw)
    return [action for action, rel in ACTION_LINK_RELS.items() if rel in rels]


def parse_dispute(raw: dict[str, Any]) -> DisputeFacts:
    amount = raw.get("dispute_amount") or {}
    txns = raw.get("disputed_transactions") or []
    requested = [e for e in raw.get("evidences") or [] if e.get("source") == "REQUESTED_FROM_SELLER"]
    outcome = raw.get("dispute_outcome") or {}
    return DisputeFacts(
        dispute_id=raw["dispute_id"],
        status=raw.get("status", "OTHER"),
        reason=raw.get("reason"),
        lifecycle_stage=raw.get("dispute_life_cycle_stage"),
        amount=Decimal(amount["value"]) if amount.get("value") else None,
        currency=amount.get("currency_code"),
        due_date=parse_dt(raw.get("seller_response_due_date")),
        create_time=parse_dt(raw.get("create_time")),
        disputed_transactions=txns,
        requested_evidences=requested,
        allowed_actions=allowed_actions(raw),
        seller_merchant_ids=[t["seller"]["merchant_id"] for t in txns if (t.get("seller") or {}).get("merchant_id")],
        outcome_code=outcome.get("outcome_code"),
    )


def work_item_key(raw: dict[str, Any]) -> str:
    """Identifies one round of seller action. PayPal may request evidence several times; each new
    request (or new deadline) is a distinct work item."""
    facts = parse_dispute(raw)
    requests = sorted(
        (e.get("evidence_type") or "", e.get("date") or "", json.dumps(e.get("notes") or "")) for e in facts.requested_evidences
    )
    material = json.dumps(
        {"status": facts.status, "due": raw.get("seller_response_due_date"), "requests": requests}, sort_keys=True
    )
    return hashlib.sha256(material.encode()).hexdigest()[:32]
