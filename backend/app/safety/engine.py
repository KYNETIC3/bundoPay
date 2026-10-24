"""The safety engine: plain code that decides allow, ask the owner, or block for every proposed movement.

It never imports the model. Whatever proposes a movement (a policy, the AI, a user tap), the same ordered
checks run, and the first failing check decides. Text in chat, emails or evidence can't set any field
of the context: `authority`, `trigger.verified` and `approved` are filled only by code from the scheduler,
a signature-verified webhook, an authenticated request or a verified approval token.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from decimal import Decimal, InvalidOperation
from typing import Literal

Decision = Literal["allow", "ask", "block"]
Kind = Literal["sweep", "refund", "release"]

TRUSTED_TRIGGERS = frozenset({"scheduler", "webhook", "user"})
# Money that leaves for a reserve account must land on an allow-listed, verified account. A refund goes
# back to the buyer through PayPal's own capture or dispute, so it names no account.
NEEDS_ACCOUNT: frozenset[str] = frozenset({"sweep", "release"})
CENT = Decimal("0.01")


@dataclass(frozen=True)
class Movement:
    kind: Kind
    amount: Decimal
    currency: str
    idempotency_key: str
    to_account: str | None = None
    irreversible: bool = True


@dataclass(frozen=True)
class Trigger:
    source: str  # scheduler | webhook | user; anything else (chat, ai, email, evidence) is untrusted
    verified: bool = False


@dataclass(frozen=True)
class Limits:
    solo: Decimal
    per_run: Decimal
    per_day: Decimal | None = None
    per_week: Decimal | None = None
    per_month: Decimal | None = None
    # Reversible movements (between the merchant's own reserves) may run alone up to this, if set.
    solo_reversible: Decimal | None = None


@dataclass(frozen=True)
class Spent:
    day: Decimal = Decimal("0")
    week: Decimal = Decimal("0")
    month: Decimal = Decimal("0")


@dataclass(frozen=True)
class Context:
    currency: str
    limits: Limits
    trigger: Trigger
    # An active, approved policy version covers this movement, or the owner asked for it directly.
    authority: bool = False
    approved: bool = False  # a verified, single-use approval token for this exact movement
    verified_accounts: frozenset[str] = frozenset()
    spent: Spent = field(default_factory=Spent)
    used_keys: frozenset[str] = frozenset()
    # Operating balance before the movement. None means unknown, which only a PayPal-mediated refund tolerates.
    available: Decimal | None = None
    floor: Decimal = Decimal("0")


@dataclass(frozen=True)
class Verdict:
    decision: Decision
    check: str
    reason: str

    @property
    def allowed(self) -> bool:
        return self.decision == "allow"


def _money(amount: Decimal) -> str:
    return f"${amount:,.2f}"


def _block(check: str, reason: str) -> Verdict:
    return Verdict("block", check, reason)


def _valid_amount(m: Movement, ctx: Context) -> str | None:
    amount = m.amount
    if isinstance(amount, bool) or not isinstance(amount, Decimal):
        return "Amounts must be exact decimals, not floats or text"
    try:
        if not amount.is_finite():
            return "Amount is not a finite number"
        if amount <= 0:
            return "Amount must be greater than zero"
        if amount != amount.quantize(CENT):
            return "Amount has more than two decimal places"
    except InvalidOperation:
        return "Amount is not a valid number"
    if m.currency != ctx.currency:
        return f"Currency {m.currency or '(none)'} does not match the account currency {ctx.currency}"
    return None


def check(m: Movement, ctx: Context) -> Verdict:
    # 1. Authority: an approved policy version or an explicit owner action.
    if not ctx.authority:
        return _block("1_no_authority", "No active, approved policy version or owner action covers this movement")
    # 2. The trigger is real.
    if ctx.trigger.source not in TRUSTED_TRIGGERS or not ctx.trigger.verified:
        return _block("2_unverified_trigger", f"Trigger '{ctx.trigger.source}' is not a verified source; text is never a trigger")
    # 3. The destination is a saved, verified reserve account.
    if m.kind not in NEEDS_ACCOUNT and m.kind != "refund":
        return _block("3_unknown_kind", f"Unknown movement kind '{m.kind}'")
    if m.kind in NEEDS_ACCOUNT and (not m.to_account or m.to_account not in ctx.verified_accounts):
        return _block("3_unverified_account", "The destination is not a saved, verified treasury account")
    # 4. The amount is well-formed and inside every cap.
    if problem := _valid_amount(m, ctx):
        return _block("4_bad_amount", problem)
    lim = ctx.limits
    if m.amount > lim.per_run:
        return _block("4_hard_cap", f"{_money(m.amount)} is above the {_money(lim.per_run)} per-run hard cap")
    for label, cap, spent in (
        ("daily", lim.per_day, ctx.spent.day),
        ("weekly", lim.per_week, ctx.spent.week),
        ("monthly", lim.per_month, ctx.spent.month),
    ):
        if cap is not None and spent + m.amount > cap:
            return _block("4_period_cap", f"{_money(spent + m.amount)} would exceed the {label} cap of {_money(cap)}")
    # 5. Not a duplicate.
    if not m.idempotency_key or m.idempotency_key in ctx.used_keys:
        return _block("5_duplicate", "This movement's idempotency key was already used")
    # 6. The money is there, and the liquidity floor holds afterwards.
    if ctx.available is None:
        if m.kind != "refund":
            return _block("6_balance_unknown", "The operating balance is unknown, so the floor can't be checked")
    else:
        after = ctx.available - m.amount
        if after < ctx.floor:
            return _block(
                "6_liquidity_floor",
                f"Operating would fall to {_money(after)}, below the {_money(ctx.floor)} floor",
            )
    # 7. Irreversible movements above the solo limit need the owner.
    solo = lim.solo if m.irreversible or lim.solo_reversible is None else max(lim.solo, lim.solo_reversible)
    if m.amount > solo and not ctx.approved:
        return Verdict("ask", "7_needs_approval", f"{_money(m.amount)} exceeds the solo limit of {_money(solo)}")
    return Verdict("allow", "ok", "Within the approved policy and every limit" if not ctx.approved else "Approved by the owner, within every limit")


@dataclass(frozen=True)
class PlanVerdict:
    decision: Decision
    check: str
    reason: str
    items: tuple[Verdict, ...]
    total: Decimal

    @property
    def allowed(self) -> bool:
        return self.decision == "allow"


def check_plan(movements: list[Movement], ctx: Context) -> PlanVerdict:
    """A plan is one run: every item is checked against the balance and totals the earlier items leave,
    then the run as a whole must fit the per-run cap and the solo limit. Splitting a sweep into small
    items can't dodge either."""
    if not movements:
        return PlanVerdict("block", "0_empty_plan", "The plan has nothing to move", (), Decimal("0"))
    verdicts: list[Verdict] = []
    available, spent, keys = ctx.available, ctx.spent, set(ctx.used_keys)
    total = Decimal("0")
    for m in movements:
        # Items are checked as if approved; the approval question is asked once, for the whole run.
        v = check(m, replace(ctx, available=available, spent=spent, used_keys=frozenset(keys), approved=True))
        verdicts.append(v)
        if v.decision == "block":
            return PlanVerdict("block", v.check, v.reason, tuple(verdicts), total + m.amount)
        total += m.amount
        keys.add(m.idempotency_key)
        spent = Spent(day=spent.day + m.amount, week=spent.week + m.amount, month=spent.month + m.amount)
        if available is not None:
            available -= m.amount
    if total > ctx.limits.per_run:
        return PlanVerdict("block", "4_hard_cap", f"The run totals {_money(total)}, above the {_money(ctx.limits.per_run)} per-run hard cap", tuple(verdicts), total)
    irreversible = any(m.irreversible for m in movements)
    lim = ctx.limits
    solo = lim.solo if irreversible or lim.solo_reversible is None else max(lim.solo, lim.solo_reversible)
    if total > solo and not ctx.approved:
        return PlanVerdict("ask", "7_needs_approval", f"{_money(total)} exceeds the solo limit of {_money(solo)}", tuple(verdicts), total)
    return PlanVerdict("allow", "ok", "Within the approved policy and every limit" if not ctx.approved else "Approved by the owner, within every limit", tuple(verdicts), total)
