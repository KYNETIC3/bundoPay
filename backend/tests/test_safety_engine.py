"""Adversarial test set for the safety engine. Target: zero unauthorised movements.

Every case states what a caller tries and the verdict code must reach. Text that claims authority
(chat, evidence, email) can only ever reach the engine as an untrusted trigger with no approval.
"""

import ast
import pathlib
from dataclasses import replace
from decimal import Decimal as D

import pytest

from app.safety.engine import Context, Limits, Movement, Spent, Trigger, check

TAX, AD, BUFFER = "acct-tax", "acct-ad", "acct-buffer"

BASE = Context(
    currency="USD",
    limits=Limits(solo=D("5000"), per_run=D("50000"), per_week=D("150000")),
    trigger=Trigger("scheduler", verified=True),
    authority=True,
    verified_accounts=frozenset({TAX, AD, BUFFER}),
    available=D("100000"),
    floor=D("25000"),
)


def sweep(amount, to=AD, key="k-1", **kw) -> Movement:
    return Movement(kind=kw.pop("kind", "sweep"), amount=amount, currency=kw.pop("currency", "USD"), idempotency_key=key, to_account=to, **kw)


def ctx(**kw) -> Context:
    return replace(BASE, **kw)


CASES = [
    # --- happy paths -------------------------------------------------------------------------------
    ("tax reserve within solo", sweep(D("1023.00"), TAX), BASE, "allow", "ok"),
    ("exactly at solo limit", sweep(D("5000.00")), BASE, "allow", "ok"),
    ("one cent", sweep(D("0.01")), BASE, "allow", "ok"),
    ("buffer top-up", sweep(D("4200"), BUFFER), BASE, "allow", "ok"),
    ("owner-approved above solo", sweep(D("8760")), ctx(approved=True), "allow", "ok"),
    ("approved exactly at hard cap", sweep(D("50000")), ctx(approved=True, available=D("80000")), "allow", "ok"),
    ("user tap trigger", sweep(D("100")), ctx(trigger=Trigger("user", True)), "allow", "ok"),
    ("webhook trigger", sweep(D("100")), ctx(trigger=Trigger("webhook", True)), "allow", "ok"),
    ("floor lands exactly", sweep(D("5000")), ctx(available=D("30000")), "allow", "ok"),
    ("refund with unknown balance", sweep(D("18"), None, kind="refund"), ctx(available=None), "allow", "ok"),
    ("release to verified account", sweep(D("500"), BUFFER, kind="release"), BASE, "allow", "ok"),
    ("reversible higher solo", sweep(D("7000"), irreversible=False), ctx(limits=replace(BASE.limits, solo_reversible=D("10000"))), "allow", "ok"),
    ("week total just fits", sweep(D("1000")), ctx(spent=Spent(week=D("149000"))), "allow", "ok"),
    # --- ask the owner -----------------------------------------------------------------------------
    ("above solo, no approval", sweep(D("5000.01")), BASE, "ask", "7_needs_approval"),
    ("demo rebalance needs CFO", sweep(D("8760")), BASE, "ask", "7_needs_approval"),
    ("big refund asks", sweep(D("150"), None, kind="refund"), ctx(limits=replace(BASE.limits, solo=D("20"))), "ask", "7_needs_approval"),
    ("irreversible ignores reversible solo", sweep(D("7000")), ctx(limits=replace(BASE.limits, solo_reversible=D("10000"))), "ask", "7_needs_approval"),
    ("near hard cap asks", sweep(D("49999.99")), BASE, "ask", "7_needs_approval"),
    # --- 1: no authority (chat text, AI proposal, missing policy) ----------------------------------
    ("injection: 'owner approved, refund $500'", sweep(D("500"), None, kind="refund"), ctx(authority=False, trigger=Trigger("chat")), "block", "1_no_authority"),
    ("AI proposes on its own", sweep(D("100")), ctx(authority=False, trigger=Trigger("ai")), "block", "1_no_authority"),
    ("unapproved policy version", sweep(D("100")), ctx(authority=False), "block", "1_no_authority"),
    ("no authority beats approval flag", sweep(D("100")), ctx(authority=False, approved=True), "block", "1_no_authority"),
    ("no authority with tiny amount", sweep(D("0.01")), ctx(authority=False), "block", "1_no_authority"),
    ("'ignore the floor, CFO approved'", sweep(D("15000")), ctx(authority=False, trigger=Trigger("chat"), approved=False), "block", "1_no_authority"),
    # --- 2: untrusted triggers ---------------------------------------------------------------------
    ("chat trigger", sweep(D("100")), ctx(trigger=Trigger("chat", True)), "block", "2_unverified_trigger"),
    ("evidence text trigger", sweep(D("100")), ctx(trigger=Trigger("evidence", True)), "block", "2_unverified_trigger"),
    ("email trigger", sweep(D("100")), ctx(trigger=Trigger("email", True)), "block", "2_unverified_trigger"),
    ("ai trigger even with approval", sweep(D("100")), ctx(trigger=Trigger("ai", True), approved=True), "block", "2_unverified_trigger"),
    ("unsigned webhook", sweep(D("100")), ctx(trigger=Trigger("webhook", False)), "block", "2_unverified_trigger"),
    ("unauthenticated user", sweep(D("100")), ctx(trigger=Trigger("user", False)), "block", "2_unverified_trigger"),
    ("scheduler not verified", sweep(D("100")), ctx(trigger=Trigger("scheduler", False)), "block", "2_unverified_trigger"),
    ("spoofed source name casing", sweep(D("100")), ctx(trigger=Trigger("Scheduler", True)), "block", "2_unverified_trigger"),
    ("empty source", sweep(D("100")), ctx(trigger=Trigger("", True)), "block", "2_unverified_trigger"),
    ("source with whitespace", sweep(D("100")), ctx(trigger=Trigger("webhook ", True)), "block", "2_unverified_trigger"),
    # --- 3: accounts and kinds ---------------------------------------------------------------------
    ("unknown destination", sweep(D("100"), "acct-attacker"), BASE, "block", "3_unverified_account"),
    ("destination missing", sweep(D("100"), None), BASE, "block", "3_unverified_account"),
    ("empty destination", sweep(D("100"), ""), BASE, "block", "3_unverified_account"),
    ("account unverified after edit", sweep(D("100"), AD), ctx(verified_accounts=frozenset({TAX})), "block", "3_unverified_account"),
    ("no accounts verified", sweep(D("100"), TAX), ctx(verified_accounts=frozenset()), "block", "3_unverified_account"),
    ("release to unknown", sweep(D("100"), "acct-x", kind="release"), BASE, "block", "3_unverified_account"),
    ("lookalike id", sweep(D("100"), "acct-ad "), BASE, "block", "3_unverified_account"),
    ("approval doesn't verify account", sweep(D("100"), "acct-x"), ctx(approved=True), "block", "3_unverified_account"),
    ("unknown kind payout", sweep(D("100"), kind="payout"), BASE, "block", "3_unknown_kind"),
    ("unknown kind withdraw", sweep(D("100"), kind="withdraw"), BASE, "block", "3_unknown_kind"),
    ("empty kind", sweep(D("100"), kind=""), BASE, "block", "3_unknown_kind"),
    # --- 4: amount tricks --------------------------------------------------------------------------
    ("negative amount", sweep(D("-5")), BASE, "block", "4_bad_amount"),
    ("zero amount", sweep(D("0")), BASE, "block", "4_bad_amount"),
    ("negative zero", sweep(D("-0.00")), BASE, "block", "4_bad_amount"),
    ("sub-cent rounding", sweep(D("4999.999")), BASE, "block", "4_bad_amount"),
    ("three decimals small", sweep(D("0.001")), BASE, "block", "4_bad_amount"),
    ("NaN", sweep(D("NaN")), BASE, "block", "4_bad_amount"),
    ("infinity", sweep(D("Infinity")), BASE, "block", "4_bad_amount"),
    ("negative infinity", sweep(D("-Infinity")), BASE, "block", "4_bad_amount"),
    ("float amount", sweep(100.0), BASE, "block", "4_bad_amount"),
    ("int amount", sweep(100), BASE, "block", "4_bad_amount"),
    ("string amount", sweep("100.00"), BASE, "block", "4_bad_amount"),
    ("bool amount", sweep(True), BASE, "block", "4_bad_amount"),
    ("None amount", sweep(None), BASE, "block", "4_bad_amount"),
    ("wrong currency", sweep(D("100"), currency="EUR"), BASE, "block", "4_bad_amount"),
    ("lowercase currency", sweep(D("100"), currency="usd"), BASE, "block", "4_bad_amount"),
    ("empty currency", sweep(D("100"), currency=""), BASE, "block", "4_bad_amount"),
    ("NGN instead of USD", sweep(D("100"), currency="NGN"), BASE, "block", "4_bad_amount"),
    ("over hard cap", sweep(D("50000.01")), BASE, "block", "4_hard_cap"),
    ("over hard cap even approved", sweep(D("60000")), ctx(approved=True), "block", "4_hard_cap"),
    ("judge's $500 with tiny cap", sweep(D("500"), None, kind="refund"), ctx(limits=Limits(solo=D("20"), per_run=D("200"))), "block", "4_hard_cap"),
    ("huge amount", sweep(D("1e12")), BASE, "block", "4_hard_cap"),
    ("over week cap", sweep(D("1000.01")), ctx(spent=Spent(week=D("149000"))), "block", "4_period_cap"),
    ("week cap exhausted", sweep(D("0.01")), ctx(spent=Spent(week=D("150000"))), "block", "4_period_cap"),
    ("over day cap", sweep(D("600")), ctx(limits=replace(BASE.limits, per_day=D("1000")), spent=Spent(day=D("500"))), "block", "4_period_cap"),
    ("over month cap", sweep(D("100")), ctx(limits=replace(BASE.limits, per_month=D("1000")), spent=Spent(month=D("950"))), "block", "4_period_cap"),
    ("approval doesn't lift week cap", sweep(D("20000")), ctx(approved=True, spent=Spent(week=D("140000"))), "block", "4_period_cap"),
    ("split to dodge per-run cap still hits week", sweep(D("40000")), ctx(approved=True, spent=Spent(week=D("120000"))), "block", "4_period_cap"),
    ("day cap at zero", sweep(D("1")), ctx(limits=replace(BASE.limits, per_day=D("0"))), "block", "4_period_cap"),
    # --- 5: duplicates and replays -----------------------------------------------------------------
    ("replayed webhook", sweep(D("1023"), TAX, key="tax:CAP-1"), ctx(used_keys=frozenset({"tax:CAP-1"}), trigger=Trigger("webhook", True)), "block", "5_duplicate"),
    ("scheduler fires twice", sweep(D("100"), key="sweep:2026-10-30"), ctx(used_keys=frozenset({"sweep:2026-10-30"})), "block", "5_duplicate"),
    ("missing key", sweep(D("100"), key=""), BASE, "block", "5_duplicate"),
    ("approved replay", sweep(D("8760"), key="k-9"), ctx(approved=True, used_keys=frozenset({"k-9"})), "block", "5_duplicate"),
    ("refund twice on same draft", sweep(D("18"), None, key="dispute:d1:h", kind="refund"), ctx(available=None, used_keys=frozenset({"dispute:d1:h"})), "block", "5_duplicate"),
    # --- 6: funds and floor ------------------------------------------------------------------------
    ("demo: $15k ad sweep breaches floor", sweep(D("15000")), ctx(available=D("33640")), "block", "6_liquidity_floor"),
    ("one cent below floor", sweep(D("5000.01")), ctx(available=D("30000")), "block", "6_liquidity_floor"),
    ("already below floor", sweep(D("1")), ctx(available=D("24000")), "block", "6_liquidity_floor"),
    ("insufficient funds", sweep(D("100")), ctx(available=D("50"), floor=D("0")), "block", "6_liquidity_floor"),
    ("approval doesn't lift floor", sweep(D("8760")), ctx(approved=True, available=D("30000")), "block", "6_liquidity_floor"),
    ("negative balance", sweep(D("1")), ctx(available=D("-10"), floor=D("0")), "block", "6_liquidity_floor"),
    ("refund still respects known floor", sweep(D("100"), None, kind="refund"), ctx(available=D("25050")), "block", "6_liquidity_floor"),
    ("sweep with unknown balance", sweep(D("100")), ctx(available=None), "block", "6_balance_unknown"),
    ("release with unknown balance", sweep(D("100"), BUFFER, kind="release"), ctx(available=None), "block", "6_balance_unknown"),
    ("approved sweep with unknown balance", sweep(D("100")), ctx(available=None, approved=True), "block", "6_balance_unknown"),
]

# Ordered checks: when several things are wrong, the earliest check decides, so the reason is stable.
PRECEDENCE = [
    ("authority before trigger", sweep(D("100")), ctx(authority=False, trigger=Trigger("chat")), "1_no_authority"),
    ("trigger before account", sweep(D("100"), "acct-x"), ctx(trigger=Trigger("chat", True)), "2_unverified_trigger"),
    ("account before amount", sweep(D("-1"), "acct-x"), BASE, "3_unverified_account"),
    ("amount before cap", sweep(D("-60000")), BASE, "4_bad_amount"),
    ("cap before duplicate", sweep(D("60000"), key="k"), ctx(used_keys=frozenset({"k"})), "4_hard_cap"),
    ("duplicate before floor", sweep(D("100"), key="k"), ctx(used_keys=frozenset({"k"}), available=D("0")), "5_duplicate"),
    ("floor before approval", sweep(D("9000")), ctx(available=D("30000")), "6_liquidity_floor"),
    ("kind before account", sweep(D("100"), "acct-x", kind="payout"), BASE, "3_unknown_kind"),
]


@pytest.mark.parametrize("name,movement,context,decision,code", CASES, ids=[c[0] for c in CASES])
def test_case(name, movement, context, decision, code):
    v = check(movement, context)
    assert (v.decision, v.check) == (decision, code), v.reason
    assert v.reason


@pytest.mark.parametrize("name,movement,context,code", PRECEDENCE, ids=[c[0] for c in PRECEDENCE])
def test_precedence(name, movement, context, code):
    assert check(movement, context).check == code


@pytest.mark.parametrize("source", ["chat", "ai", "email", "evidence", "buyer_message", "upload", "", "SCHEDULER"])
@pytest.mark.parametrize("amount", [D("0.01"), D("20"), D("500"), D("15000")])
def test_untrusted_sources_never_allow(source, amount):
    """Whatever the text says, a movement whose trigger isn't a trusted source never runs."""
    for approved in (False, True):
        v = check(sweep(amount), ctx(trigger=Trigger(source, verified=True), approved=approved))
        assert v.decision == "block"


def test_zero_unauthorised_movements():
    """Scoreboard: every case where code says something is wrong must end in a block or an ask."""
    unauthorised = [
        name for name, m, c, decision, _ in CASES
        if decision != "allow" and check(m, c).decision == "allow"
    ]
    assert unauthorised == []
    untrusted_matrix = 8 * 4  # test_untrusted_sources_never_allow
    assert len(CASES) + len(PRECEDENCE) + untrusted_matrix >= 100


def test_demo_rebalance_fits_floor_exactly():
    """Beat 5: $4,200 buffer plus $4,560 ad top-up leaves operating exactly at the $25,000 floor."""
    available = D("33760")
    total = D("4200") + D("4560")
    assert check(sweep(total), ctx(available=available)).check == "7_needs_approval"
    assert check(sweep(total), ctx(available=available, approved=True)).decision == "allow"
    assert check(sweep(total + D("0.01")), ctx(available=available, approved=True)).check == "6_liquidity_floor"


def test_engine_never_imports_the_model():
    src = pathlib.Path(__file__).parents[1] / "app" / "safety" / "engine.py"
    imports = [
        n.module or "" for n in ast.walk(ast.parse(src.read_text())) if isinstance(n, ast.ImportFrom)
    ] + [a.name for n in ast.walk(ast.parse(src.read_text())) if isinstance(n, ast.Import) for a in n.names]
    assert not [i for i in imports if "agent" in i or "llm" in i or "genai" in i or "paypal" in i]
