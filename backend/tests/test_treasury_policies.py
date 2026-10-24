"""Policies, the planner, the simulator and plan-level engine checks, on the demo's numbers."""

from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal as D

import pytest
from pydantic import ValidationError

from app.safety.engine import Context, Limits, Movement, Trigger, check_plan
from app.treasury.policy import (
    AdSweep, Book, DisputeBuffer, PolicyDoc, Rebalance, TaxReserve, buffer_gap, buffer_target, next_fire, next_fires,
    plan, rebalance, spec_hash, tax_owed,
)
from app.treasury.simulator import simulate
from app.treasury.triggers import capture_from_paypal

ACCOUNTS = {"tax_reserve": "acct-tax", "dispute_buffer": "acct-buf", "ad_spend": "acct-ad"}
CTX = Context(
    currency="USD",
    limits=Limits(solo=D("5000"), per_run=D("50000"), per_week=D("150000")),
    trigger=Trigger("scheduler", True),
    authority=True,
    verified_accounts=frozenset(ACCOUNTS.values()),
    floor=D("25000"),
)
# Beat 3: a $4,200 dispute lands; open disputes now $6,850, buffer holds $5,110.
DEMO = Book(
    operating=D("33760.00"),
    reserves={"dispute_buffer": D("5110.00"), "tax_reserve": D("1023.00"), "ad_spend": D("0")},
    open_disputes=D("6850.00"),
    captures_30d=D("123000.00"),
    unreserved_captures=D("0"),
    floor=D("25000"),
)
BUFFER = DisputeBuffer()
FRI = datetime(2026, 10, 30, 9, 0, tzinfo=timezone.utc)  # a Friday


def mv(amount, key, to="acct-ad"):
    return Movement(kind="sweep", amount=D(amount), currency="USD", idempotency_key=key, to_account=to)


# ------------------------------------------------------------------------------------- plan check


def test_splitting_a_run_still_asks_above_solo():
    v = check_plan([mv("4200", "a", "acct-buf"), mv("4560", "b")], replace(CTX, available=D("33760")))
    assert (v.decision, v.check, v.total) == ("ask", "7_needs_approval", D("8760"))


def test_approved_split_run_lands_exactly_on_the_floor():
    v = check_plan([mv("4200", "a", "acct-buf"), mv("4560", "b")], replace(CTX, available=D("33760"), approved=True))
    assert v.allowed


def test_floor_is_checked_cumulatively_across_items():
    v = check_plan([mv("5000", "a"), mv("4000", "b")], replace(CTX, available=D("33760"), approved=True))
    assert v.check == "6_liquidity_floor" and len(v.items) == 2


def test_run_total_cannot_exceed_per_run_cap_by_splitting():
    items = [mv("30000", "a"), mv("30000", "b")]
    v = check_plan(items, replace(CTX, available=D("1000000"), approved=True))
    assert v.check == "4_hard_cap"


def test_week_cap_is_cumulative_inside_a_run():
    v = check_plan([mv("40000", "a"), mv("40000", "b")],
                   replace(CTX, available=D("1000000"), approved=True, limits=replace(CTX.limits, per_run=D("100000"), per_week=D("50000"))))
    assert v.check == "4_period_cap"


def test_same_key_twice_in_one_run_is_a_duplicate():
    v = check_plan([mv("10", "same"), mv("10", "same")], replace(CTX, available=D("100000")))
    assert v.check == "5_duplicate"


def test_empty_plan_is_blocked():
    assert check_plan([], CTX).check == "0_empty_plan"


def test_one_bad_item_blocks_the_whole_run():
    v = check_plan([mv("10", "a"), mv("10", "b", to="acct-attacker")], replace(CTX, available=D("100000")))
    assert v.decision == "block" and v.check == "3_unverified_account"


def test_untrusted_trigger_blocks_plan_even_when_approved():
    v = check_plan([mv("10", "a")], replace(CTX, available=D("100000"), approved=True, trigger=Trigger("chat", True)))
    assert v.check == "2_unverified_trigger"


# ---------------------------------------------------------------------------------------- planner


def test_buffer_target_and_gap_match_the_demo():
    assert buffer_target(DEMO, BUFFER) == D("9310.00")
    assert buffer_gap(DEMO, BUFFER) == D("4200.00")


def test_tax_reserve_rounds_down_to_the_cent():
    book = replace(DEMO, unreserved_captures=D("12400.00"))
    assert tax_owed(book, TaxReserve()) == D("1023.00")
    assert tax_owed(replace(DEMO, unreserved_captures=D("10.01")), TaxReserve()) == D("0.82")


def test_ad_sweep_proposes_its_stated_amount_and_leaves_the_floor_to_the_engine():
    (p,) = plan(AdSweep(), DEMO)
    assert (p.role, p.amount) == ("ad_spend", D("15000.00"))


def test_rebalance_funds_reserves_first_then_fits_the_floor():
    items = rebalance(DEMO, ad_amount=D("15000"), buffer=BUFFER, tax=TaxReserve())
    assert [(p.role, p.amount) for p in items] == [("dispute_buffer", D("4200.00")), ("ad_spend", D("4560.00"))]


def test_rebalance_with_no_room_moves_nothing():
    assert rebalance(replace(DEMO, operating=D("25000")), ad_amount=D("15000"), buffer=BUFFER, tax=None) == []


def test_rebalance_with_unknown_balance_moves_nothing():
    assert rebalance(replace(DEMO, operating=None), ad_amount=D("1"), buffer=None, tax=None) == []


def test_met_targets_plan_nothing():
    assert plan(BUFFER, replace(DEMO, open_disputes=D("0"), captures_30d=D("0"))) == []
    assert plan(TaxReserve(), DEMO) == []


def test_next_fire_for_friday_sweep():
    assert next_fire(AdSweep(), datetime(2026, 10, 28, 12, tzinfo=timezone.utc)) == FRI
    assert next_fire(AdSweep(), FRI) == datetime(2026, 11, 6, 9, tzinfo=timezone.utc)
    assert [d.day for d in next_fires(AdSweep(), FRI, 3)] == [6, 13, 20]


def test_next_fire_hourly_and_daily():
    t = datetime(2026, 10, 30, 9, 15, tzinfo=timezone.utc)
    assert next_fire(TaxReserve(), t) == datetime(2026, 10, 30, 10, tzinfo=timezone.utc)
    assert next_fire(Rebalance(hour=6), t) == datetime(2026, 10, 31, 6, tzinfo=timezone.utc)


def test_spec_hash_changes_with_any_edit():
    a = PolicyDoc(name="Friday ads", spec=AdSweep())
    b = PolicyDoc(name="Friday ads", spec=AdSweep(amount=D("15000.01")))
    assert spec_hash(a) != spec_hash(b) and spec_hash(a) == spec_hash(PolicyDoc(name="Friday ads", spec=AdSweep()))


@pytest.mark.parametrize("spec", [
    {"kind": "tax_reserve", "rate": "0.9"},
    {"kind": "tax_reserve", "rate": "-0.1"},
    {"kind": "ad_sweep", "amount": "-5"},
    {"kind": "ad_sweep", "amount": "1.001"},
    {"kind": "ad_sweep", "weekday": 7},
    {"kind": "dispute_buffer", "coverage": "5"},
    {"kind": "withdraw_everything"},
])
def test_invalid_specs_are_rejected(spec):
    with pytest.raises(ValidationError):
        PolicyDoc.model_validate({"name": "x", "spec": spec})


# -------------------------------------------------------------------------------------- simulator


def test_simulating_the_friday_sweep_shows_the_block_and_the_replan():
    sim = simulate(AdSweep(), DEMO, CTX, ACCOUNTS, now=datetime(2026, 10, 29, tzinfo=timezone.utc), runs=1,
                   weekly_inflow=D("0"), buffer=BUFFER)
    (row,) = sim.rows
    assert (row.outcome, row.check) == ("block", "6_liquidity_floor")
    assert row.fallback == [
        {"to": "dispute_buffer", "amount": "4200.00", "policy": "rebalance:dispute_buffer"},
        {"to": "ad_spend", "amount": "4560.00", "policy": "rebalance:ad_spend"},
    ]
    assert row.operating_after == "25000.00"
    assert "not a guarantee" in sim.disclaimer
    assert "blocked by the safety engine (1 re-planned to fit)" in sim.summary


def test_simulation_includes_a_skipped_week_and_never_double_counts():
    # With strong inflow the first Friday fits; the second has only just recovered.
    book = replace(DEMO, operating=D("41000"), open_disputes=D("0"), captures_30d=D("0"))
    sim = simulate(AdSweep(amount=D("15000")), book, CTX, ACCOUNTS, now=datetime(2026, 10, 29, tzinfo=timezone.utc),
                   runs=3, weekly_inflow=D("12000"), buffer=BUFFER)
    outcomes = [r.outcome for r in sim.rows]
    assert outcomes[0] == "ask"  # $15k is above the $5k solo limit
    assert "block" in outcomes  # a week where the floor wouldn't hold
    assert all(r.operating_after is None or D(r.operating_after) >= D("25000") for r in sim.rows)


def test_simulator_failure_cases_hit_the_right_checks():
    sim = simulate(BUFFER, DEMO, CTX, ACCOUNTS, now=FRI, runs=1, buffer=BUFFER)
    checks = {c["case"]: c["check"] for c in sim.failure_cases}
    assert checks["Duplicate trigger (scheduler fires twice or a webhook repeats)"] == "5_duplicate"
    assert checks["Destination account not verified"] == "3_unverified_account"
    assert checks["Not enough cash above the floor"] == "6_liquidity_floor"
    assert checks["Trigger is a chat message, not a verified source"] == "2_unverified_trigger"
    assert checks["Policy version not approved"] == "1_no_authority"
    assert {c["result"] for c in sim.failure_cases} >= {"block", "failed", "unconfirmed"}


def test_simulating_never_touches_paypal():
    import ast
    import pathlib

    src = (pathlib.Path(__file__).parents[1] / "app" / "treasury" / "simulator.py").read_text()
    mods = [n.module or "" for n in ast.walk(ast.parse(src)) if isinstance(n, ast.ImportFrom)]
    assert not [m for m in mods if "paypal" in m or "executor" in m or "deps" in m]


# --------------------------------------------------------------------------------------- triggers


def test_capture_parsing_trusts_only_completed_refetches():
    good = {"id": "5TY0", "status": "COMPLETED", "amount": {"value": "12400.00", "currency_code": "USD"},
            "create_time": "2026-10-30T14:02:11Z"}
    c = capture_from_paypal(good)
    assert c["amount"] == D("12400.00") and c["captured_at"].tzinfo is not None
    assert capture_from_paypal({**good, "status": "PENDING"}) is None
    assert capture_from_paypal({**good, "amount": {"value": "-5", "currency_code": "USD"}}) is None
    assert capture_from_paypal({**good, "amount": {"value": "abc", "currency_code": "USD"}}) is None
    assert capture_from_paypal({**good, "amount": {"value": "5"}}) is None


async def test_untrusted_trigger_names_cannot_be_queued():
    from app.treasury.triggers import enqueue_run

    with pytest.raises(ValueError):
        await enqueue_run(None, "m", "p", trigger="chat", slot="x")
