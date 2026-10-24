"""Runner routing on the demo: the Friday sweep is blocked by the floor, re-planned, sent to the owner,
approved with a bound token, re-checked and executed. Data access is stubbed; the engine is real."""

from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal as D

import pytest

from app.executor.service import Execution
from app.safety.engine import Context, Limits, Trigger, check_plan
from app.safety.service import GuardedPlan
from app.treasury import runner
from app.treasury.policy import AdSweep, Book, DisputeBuffer, PolicyDoc, TaxReserve
from app.treasury.service import TreasuryError

M, P = "m-1", "pol-1"
ACCOUNTS = {"tax_reserve": "acct-tax", "dispute_buffer": "acct-buf", "ad_spend": "acct-ad"}
BOOK = Book(D("33760.00"), {"dispute_buffer": D("5110.00")}, D("6850.00"), D("123000.00"), D("0"), D("25000"))
CTX = Context(currency="USD", limits=Limits(solo=D("5000"), per_run=D("50000"), per_week=D("150000")),
              trigger=Trigger("scheduler", True), verified_accounts=frozenset(ACCOUNTS.values()), floor=D("25000"))


class State:
    def __init__(self, doc: PolicyDoc, *, status="active", approved=True):
        self.policy = {"id": P, "kind": doc.spec.kind, "status": status, "version_id": "ver-1", "version": 1,
                       "doc_json": doc.model_dump(mode="json"), "spec_hash": "h", "approved_hash": "h" if approved else None}
        self.events, self.messages, self.executed, self.guards, self.plans = [], [], [], [], {}
        self.used: set[str] = set()


@pytest.fixture
def make(monkeypatch, settings):
    def build(doc: PolicyDoc, **kw) -> State:
        st = State(doc, **kw)

        class Conn:
            @asynccontextmanager
            async def transaction(self):
                yield

            async def execute(self, sql, params=()):
                s = " ".join(sql.split())
                rows = []
                if s.startswith("select p.*, v.id as version_id"):
                    rows = [st.policy]
                elif s.startswith("select currency from treasury_limits"):
                    rows = [{"currency": "USD"}]
                elif s.startswith("insert into treasury_plans"):
                    pid = f"plan-{len(st.plans) + 1}"
                    st.plans[pid] = {"id": pid, "flow_id": params[1], "items_json": params[3].obj, "plan_hash": params[4],
                                     "total": params[5], "status": "needs_approval", "expires_at": params[7]}
                    rows = [{"id": pid}]
                elif s.startswith("update treasury_plans set status = 'approved'"):
                    p = st.plans.get(params[0])
                    if p and p["status"] == "needs_approval" and p["plan_hash"] == params[2] and p["expires_at"] > datetime.now(timezone.utc):
                        p["status"] = "approved"
                        rows = [p]
                elif s.startswith("update treasury_plans set status = %s"):
                    st.plans[params[1]]["status"] = params[0]

                class Cur:
                    async def fetchone(self):
                        return rows[0] if rows else None

                return Cur()

        @asynccontextmanager
        async def connection():
            yield Conn()

        async def guard_plan(_conn, _m, movements, *, trigger, authority, approved=False, available=None, plan_id=None, **_):
            used = frozenset(k for k in st.used if not (plan_id and k in {m.idempotency_key for m in movements}))
            v = check_plan(movements, replace(CTX, trigger=trigger, authority=authority, approved=approved, available=available, used_keys=used))
            st.guards.append((v.decision, v.check, [str(m.amount) for m in movements]))
            if v.decision != "block":
                st.used |= {m.idempotency_key for m in movements}
            return GuardedPlan(v, tuple(f"mv-{m.idempotency_key}" for m in movements))

        async def execute(_m, ids, *, flow_id=None, gateway=None):
            st.executed.append(ids)
            return Execution("bp-x", "succeeded")

        async def audit(_conn, event, **kw):
            st.events.append((event, kw.get("data", {})))

        async def post_message(_conn, _m, content, *, kind, meta=None, **_):
            st.messages.append((kind, meta))

        async def nothing(*_a, **_k):
            return None

        async def book(*_a, **_k):
            return BOOK

        async def accounts(*_a, **_k):
            return ACCOUNTS

        async def companions(*_a, **_k):
            return DisputeBuffer(), None

        for name, fn in {
            "connection": connection, "guard_plan": guard_plan, "execute": execute, "audit": audit,
            "post_message": post_message, "notify_treasury_changed": nothing, "load_book": book,
            "accounts_by_role": accounts, "companion_specs": companions, "_record_failure": nothing,
            "_mark_reserved": nothing, "_advance": nothing,
        }.items():
            monkeypatch.setattr(runner, name, fn)
        monkeypatch.setattr(runner, "get_settings", lambda: settings)
        return st

    return build


SWEEP = PolicyDoc(name="Friday ads", spec=AdSweep())


async def test_demo_floor_block_replans_and_asks(make):
    st = make(SWEEP)
    out = await runner.run_policy(M, P, trigger=Trigger("scheduler", True), slot="2026-10-30T09:00:00+00:00")
    assert out["status"] == "needs_approval" and out["check"] == "7_needs_approval"
    assert st.guards[0] == ("block", "6_liquidity_floor", ["15000.00"])
    assert st.guards[1] == ("ask", "7_needs_approval", ["4200.00", "4560.00"])
    assert st.executed == []  # nothing moves without the owner
    (kind, meta), = st.messages
    assert kind == "treasury_approval" and meta["total"] == "8760.00"
    assert [e for e, _ in st.events][:4] == ["trigger.verified", "plan.proposed", "plan.rebalanced", "plan.proposed"]


async def test_approval_rechecks_and_executes_once(make):
    st = make(SWEEP)
    out = await runner.run_policy(M, P, trigger=Trigger("scheduler", True), slot="s1")
    plan = st.plans[out["plan_id"]]
    done = await runner.approve_plan(M, out["plan_id"], plan_hash_seen=plan["plan_hash"], approver="cfo@northwind")
    assert done["status"] == "allowed" and done["execution"] == "succeeded"
    assert st.guards[-1][0] == "allow" and len(st.executed) == 1
    granted = [d for e, d in st.events if e == "approval.granted"]
    assert granted and granted[0]["token"].startswith("hmac:sha256:")
    with pytest.raises(TreasuryError):  # single use
        await runner.approve_plan(M, out["plan_id"], plan_hash_seen=plan["plan_hash"], approver="cfo@northwind")
    assert len(st.executed) == 1


async def test_approval_with_a_stale_hash_is_refused(make):
    st = make(SWEEP)
    out = await runner.run_policy(M, P, trigger=Trigger("scheduler", True), slot="s1")
    with pytest.raises(TreasuryError):
        await runner.approve_plan(M, out["plan_id"], plan_hash_seen="0" * 64, approver="cfo")
    assert st.executed == []


async def test_expired_plan_cannot_be_approved(make):
    st = make(SWEEP)
    out = await runner.run_policy(M, P, trigger=Trigger("scheduler", True), slot="s1")
    st.plans[out["plan_id"]]["expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    with pytest.raises(TreasuryError):
        await runner.approve_plan(M, out["plan_id"], plan_hash_seen=st.plans[out["plan_id"]]["plan_hash"], approver="cfo")


async def test_replayed_slot_is_a_duplicate(make):
    st = make(PolicyDoc(name="Buffer", spec=DisputeBuffer()))
    first = await runner.run_policy(M, P, trigger=Trigger("webhook", True), slot="dispute:PP-D-1:abc")
    again = await runner.run_policy(M, P, trigger=Trigger("webhook", True), slot="dispute:PP-D-1:abc")
    assert first["status"] == "allowed" and again["check"] == "5_duplicate"
    assert len(st.executed) == 1


async def test_within_solo_runs_alone(make):
    st = make(PolicyDoc(name="Buffer", spec=DisputeBuffer()))
    out = await runner.run_policy(M, P, trigger=Trigger("webhook", True), slot="x")
    assert out["status"] == "allowed" and out["execution"] == "succeeded" and st.guards == [("allow", "ok", ["4200.00"])]


@pytest.mark.parametrize("kw", [{"status": "paused"}, {"status": "draft"}, {"approved": False}])
async def test_unapproved_or_inactive_policy_never_plans(make, kw):
    st = make(SWEEP, **kw)
    out = await runner.run_policy(M, P, trigger=Trigger("user", True), slot="manual")
    assert out["check"] == "1_no_authority" and st.guards == [] and st.executed == []


async def test_chat_trigger_is_blocked_by_the_engine(make):
    st = make(PolicyDoc(name="Buffer", spec=DisputeBuffer()))
    out = await runner.run_policy(M, P, trigger=Trigger("chat", True), slot="x")
    assert out["check"] == "2_unverified_trigger" and st.executed == []


async def test_rejected_plan_never_executes(make, monkeypatch):
    st = make(SWEEP)
    out = await runner.run_policy(M, P, trigger=Trigger("scheduler", True), slot="s1")
    st.plans[out["plan_id"]]["status"] = "rejected"
    with pytest.raises(TreasuryError):
        await runner.approve_plan(M, out["plan_id"], plan_hash_seen=st.plans[out["plan_id"]]["plan_hash"], approver="cfo")
    assert st.executed == []


async def test_tax_reserve_on_a_capture(make, monkeypatch):
    st = make(PolicyDoc(name="Tax", spec=TaxReserve()))

    async def book(*_a, **_k):
        return replace(BOOK, unreserved_captures=D("12400.00"))

    monkeypatch.setattr(runner, "load_book", book)
    out = await runner.run_policy(M, P, trigger=Trigger("webhook", True), slot="capture:5TY0")
    assert out["status"] == "allowed" and st.guards == [("allow", "ok", ["1023.00"])]
