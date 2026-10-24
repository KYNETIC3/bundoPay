"""Pre-flight simulator: replays a policy over its next runs on projected balances, through the real
safety engine, and tries the failure cases. It never sends money and says so: real balances and
PayPal's behaviour can differ from the projection.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from app.safety.engine import Context, Movement, PlanVerdict, Trigger, check_plan

from .policy import AdSweep, Book, DisputeBuffer, Proposal, TaxReserve, cents, next_fires, plan, rebalance

DISCLAIMER = (
    "This is a preview on projected balances, not a guarantee. Real balances, captures, disputes and "
    "PayPal's behaviour can differ. No money moves in a simulation."
)


@dataclass(frozen=True)
class SimRow:
    at: str
    operating_before: str | None
    outcome: str  # allow | ask | block | skip
    check: str
    reason: str
    items: list[dict[str, str]]
    operating_after: str | None
    fallback: list[dict[str, str]] | None = None  # the re-plan BundoPay would propose after a block


@dataclass(frozen=True)
class Simulation:
    rows: list[SimRow]
    failure_cases: list[dict[str, str]]
    summary: str
    disclaimer: str = DISCLAIMER

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


def movements(proposals: list[Proposal], accounts: dict[str, str], currency: str, key_prefix: str) -> list[Movement]:
    return [
        Movement(kind="sweep", amount=p.amount, currency=currency, idempotency_key=f"{key_prefix}:{p.key_part}",
                 to_account=accounts.get(p.role))
        for p in proposals
    ]


def _items(proposals: list[Proposal]) -> list[dict[str, str]]:
    return [{"to": p.role, "amount": f"{p.amount:.2f}", "policy": p.policy} for p in proposals]


def simulate(
    spec: TaxReserve | DisputeBuffer | AdSweep | Any,
    book: Book,
    ctx: Context,
    accounts: dict[str, str],
    *,
    now: datetime | None = None,
    runs: int = 4,
    weekly_inflow: Decimal | None = None,
    buffer: DisputeBuffer | None = None,
    tax: TaxReserve | None = None,
) -> Simulation:
    """`accounts` maps role -> verified account id. `weekly_inflow` defaults to the 30-day capture average."""
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    inflow_per_day = (weekly_inflow / 7) if weekly_inflow is not None else book.captures_30d / 30
    rows: list[SimRow] = []
    operating = book.operating
    reserves = dict(book.reserves)
    unreserved = book.unreserved_captures
    used: set[str] = set(ctx.used_keys)
    last = now
    for at in next_fires(spec, now, runs):
        days = Decimal((at - last).total_seconds()) / Decimal(86400)
        gained = cents(inflow_per_day * days)
        if operating is not None:
            operating += gained
        unreserved += gained
        last = at
        b = replace(book, operating=operating, reserves=dict(reserves), unreserved_captures=unreserved)
        key = f"sim:{at.isoformat()}"
        proposals = plan(spec, b, buffer=buffer, tax=tax)
        if not proposals:
            rows.append(SimRow(at.isoformat(), _s(operating), "skip", "nothing_to_do", "Nothing to move: every target is met", [], _s(operating)))
            continue
        run_ctx = replace(ctx, available=operating, used_keys=frozenset(used))
        verdict = check_plan(movements(proposals, accounts, ctx.currency, key), run_ctx)
        fallback = None
        moved = proposals if verdict.decision != "block" else []
        if verdict.decision == "block" and isinstance(spec, AdSweep):
            alt = rebalance(b, ad_amount=spec.amount, buffer=buffer, tax=tax)
            alt_verdict = check_plan(movements(alt, accounts, ctx.currency, f"{key}:rebalance"), run_ctx) if alt else None
            fallback = _items(alt) if alt and alt_verdict and alt_verdict.decision != "block" else []
            if fallback:
                moved = alt
        for p in moved:
            used.add(f"{key}:{p.key_part}")
            if operating is not None:
                operating -= p.amount
            reserves[p.role] = reserves.get(p.role, Decimal("0")) + p.amount
            if p.role == "tax_reserve":
                unreserved = Decimal("0")
        rows.append(SimRow(at.isoformat(), _s(b.operating), verdict.decision, verdict.check, verdict.reason,
                           _items(proposals), _s(operating), fallback))
    return Simulation(rows, failure_cases(spec, book, ctx, accounts, buffer=buffer, tax=tax), summarise(rows))


def _s(v: Decimal | None) -> str | None:
    return None if v is None else f"{v:.2f}"


def failure_cases(spec: Any, book: Book, ctx: Context, accounts: dict[str, str], *, buffer=None, tax=None) -> list[dict[str, str]]:
    """What the engine and executor do when things go wrong, using this policy's own first proposal."""
    proposals = plan(spec, book, buffer=buffer, tax=tax) or [Proposal("ad_spend", Decimal("100.00"), "probe", "probe")]
    ms = movements(proposals, accounts, ctx.currency, "probe")

    def run(c: Context, ms_: list[Movement] = ms) -> PlanVerdict:
        return check_plan(ms_, c)

    base = replace(ctx, available=book.operating, approved=True)
    cases = [
        ("Duplicate trigger (scheduler fires twice or a webhook repeats)",
         run(replace(base, used_keys=frozenset(m.idempotency_key for m in ms)))),
        ("Destination account not verified", run(replace(base, verified_accounts=frozenset()))),
        ("Not enough cash above the floor", run(replace(base, available=book.floor))),
        ("Trigger is a chat message, not a verified source", run(replace(base, trigger=Trigger("chat", True)))),
        ("Policy version not approved", run(replace(base, authority=False))),
    ]
    out = [{"case": name, "result": v.decision, "check": v.check, "reason": v.reason} for name, v in cases]
    out += [
        {"case": "PayPal rejects the payout", "result": "failed", "check": "executor",
         "reason": "Marked failed. Nothing was paid, and the next scheduled run tries again."},
        {"case": "PayPal times out", "result": "unconfirmed", "check": "executor",
         "reason": "Marked unconfirmed and resent later with the same request id, so it can never pay twice."},
    ]
    return out


def summarise(rows: list[SimRow]) -> str:
    ran = [r for r in rows if r.outcome == "allow"]
    asked = [r for r in rows if r.outcome == "ask"]
    blocked = [r for r in rows if r.outcome == "block"]
    replanned = [r for r in blocked if r.fallback]
    skipped = [r for r in rows if r.outcome == "skip"]
    total = sum((Decimal(i["amount"]) for r in ran + asked for i in r.items), Decimal("0"))
    total += sum((Decimal(i["amount"]) for r in replanned for i in r.fallback or []), Decimal("0"))
    parts = [f"Over the next {len(rows)} runs this policy would move ${total:,.2f} in total"]
    if ran:
        parts.append(f"{len(ran)} on its own")
    if asked:
        parts.append(f"{len(asked)} after asking you")
    if blocked:
        parts.append(f"{len(blocked)} blocked by the safety engine" + (f" ({len(replanned)} re-planned to fit)" if replanned else ""))
    if skipped:
        parts.append(f"{len(skipped)} skipped with nothing to do")
    return parts[0] + (": " + ", ".join(parts[1:]) if len(parts) > 1 else "") + "."
