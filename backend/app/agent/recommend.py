"""Recommendation: provide evidence, make an offer, or accept the claim, limited to what PayPal's links allow."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from app.disputes.model import DisputeFacts

from .evidence import EvidenceMap

STRONG_COVERAGE = 0.7
WEAK_COVERAGE = 0.4
SMALL_AMOUNT = Decimal("50")


@dataclass
class History:
    """Past outcomes for this merchant and reason, from the outcomes table."""

    evidence_submissions: int = 0
    evidence_wins: int = 0

    @property
    def win_rate(self) -> float | None:
        return self.evidence_wins / self.evidence_submissions if self.evidence_submissions >= 5 else None


@dataclass
class Recommendation:
    action: str | None
    reasons: list[str]
    allowed_actions: list[str]
    hours_remaining: float | None
    past_due: bool
    source: str = "rules"  # "rules" or "model"
    offer_amount: str | None = None
    notes: dict[str, str] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


class DisallowedActionError(ValueError):
    pass


def enforce_allowed(action: str | None, facts: DisputeFacts) -> str | None:
    """Hard gate: an action whose HATEOAS link PayPal didn't return can never be proposed."""
    if action is not None and action not in facts.allowed_actions:
        raise DisallowedActionError(f"'{action}' is not offered by PayPal for this dispute ({facts.allowed_actions})")
    return action


@dataclass
class RefundPolicy:
    """The merchant's standing instruction: refund disputes up to `limit` without asking."""

    enabled: bool = False
    limit: Decimal = Decimal("0")

    def covers(self, facts: DisputeFacts) -> bool:
        return self.enabled and facts.amount is not None and facts.amount <= self.limit


def policy_allows_auto_refund(policy: RefundPolicy, facts: DisputeFacts, action: str | None, now: datetime | None = None) -> bool:
    """Code-level gate for refunds sent without a click: only a full refund (accept_claim) that PayPal
    currently offers, at or under the merchant's limit, before the deadline."""
    return (
        action == "accept_claim"
        and "accept_claim" in facts.allowed_actions
        and policy.covers(facts)
        and not facts.is_past_due(now)
    )


def recommend(
    facts: DisputeFacts,
    emap: EvidenceMap,
    history: History,
    now: datetime | None = None,
    policy: RefundPolicy | None = None,
) -> Recommendation:
    now = now or datetime.now(timezone.utc)
    allowed = facts.allowed_actions
    hours = (facts.due_date - now).total_seconds() / 3600 if facts.due_date else None
    past_due = facts.is_past_due(now)
    high_flags = [f for f in emap.flags if f.severity == "high"]
    cov = emap.coverage_score
    reasons: list[str] = [f"Evidence coverage is {cov:.0%} across {len(emap.rows)} requested item(s)."]

    def done(action: str | None, *why: str, offer: str | None = None) -> Recommendation:
        return Recommendation(
            enforce_allowed(action, facts), reasons + list(why), allowed, hours, past_due, offer_amount=offer
        )

    if past_due:
        return done(None, "The seller response deadline has passed. PayPal may no longer accept a response.")
    if not allowed:
        return done(None, "PayPal currently offers no seller action on this dispute.")

    if facts.amount is not None:
        reasons.append(f"Disputed amount: {facts.currency} {facts.amount}.")
    if facts.lifecycle_stage:
        reasons.append(f"Stage: {facts.lifecycle_stage.replace('_', ' ').lower()}.")
    if hours is not None and hours < 48:
        reasons.append(f"About {max(hours, 0):.0f} hours remain to respond.")
    if high_flags:
        reasons.append(f"{len(high_flags)} integrity issue(s) would undermine the evidence: " + "; ".join(f.detail for f in high_flags))
    if history.win_rate is not None:
        reasons.append(
            f"Your past evidence submissions for this reason won {history.evidence_wins} of {history.evidence_submissions}."
        )

    historically_weak = history.win_rate is not None and history.win_rate < 0.25
    strong = cov >= STRONG_COVERAGE and not high_flags and not historically_weak
    weak = cov < WEAK_COVERAGE or bool(high_flags)

    if strong and "provide_evidence" in allowed:
        return done("provide_evidence", "Records cover what PayPal asked for without conflicts.")

    if policy is not None and policy.covers(facts) and "accept_claim" in allowed:
        return done(
            "accept_claim",
            f"The amount is within your automatic refund limit ({facts.currency} {policy.limit}) and the case isn't clearly winnable.",
        )

    if weak:
        small = facts.amount is not None and facts.amount <= SMALL_AMOUNT
        if small and "accept_claim" in allowed:
            return done("accept_claim", "The case is weak and the amount is small; conceding avoids further cost.")
        if "make_offer" in allowed and facts.amount is not None:
            half = (facts.amount / 2).quantize(Decimal("0.01"))
            return done(
                "make_offer",
                "The case is weak; a partial refund may resolve it for less than losing in full. Set the amount you're willing to offer.",
                offer=str(half),
            )
        if "accept_claim" in allowed:
            return done("accept_claim", "The case is weak and no offer option is available.")

    if "provide_evidence" in allowed:
        return done("provide_evidence", "Evidence is partial; submitting what exists, with gaps listed for you to fill first.")
    fallback = next(a for a in ("make_offer", "accept_claim") if a in allowed)
    return done(fallback, "Providing evidence isn't offered by PayPal at this stage.")
