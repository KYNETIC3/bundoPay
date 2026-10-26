"""Executor against respx-mocked PayPal and an in-memory stand-in for the movements tables."""

from contextlib import asynccontextmanager
from datetime import datetime, timezone
from decimal import Decimal as D

import httpx
import pytest

from app.executor import service as ex

M = "m-1"
NOW = datetime(2026, 10, 30, 9, tzinfo=timezone.utc)


class DB:
    def __init__(self):
        self.accounts = {
            "op": {"id": "op", "role": "operating", "name": "Operating", "paypal_email": "op@biz.example", "verified_at": NOW, "opening_balance": D("33760")},
            "buf": {"id": "buf", "role": "dispute_buffer", "name": "Dispute Margin Buffer", "paypal_email": "buffer@biz.example", "verified_at": NOW, "opening_balance": D("5110")},
            "ad": {"id": "ad", "role": "ad_spend", "name": "Ad-Spend Wallet", "paypal_email": "ads@biz.example", "verified_at": NOW, "opening_balance": D("0")},
        }
        self.movements = {}
        self.ledger = []
        self.events = []
        self.movable = None

    def add(self, mid, to, amount, key, status="allowed", kind="sweep"):
        self.movements[mid] = {
            "id": mid, "merchant_id": M, "flow_id": "fl-1", "kind": kind, "to_account_id": to, "amount": D(amount),
            "currency": "USD", "idempotency_key": key, "status": status, "batch_id": None, "paypal_ref": None,
        }


class Conn:
    def __init__(self, db: DB):
        self.db = db

    @asynccontextmanager
    async def transaction(self):
        yield

    async def execute(self, sql, params=()):
        db, s = self.db, " ".join(sql.split())
        rows: list = []
        if s.startswith("with claimed as"):
            _, ids, kinds = params
            for i in ids:
                m = db.movements.get(i)
                if m and m["status"] == "allowed" and m["kind"] in kinds:
                    m["status"] = "executing"
                    a = db.accounts.get(m["to_account_id"]) or {}
                    rows.append({**m, "paypal_email": a.get("paypal_email"), "account_name": a.get("name"), "verified_at": a.get("verified_at")})
        elif s.startswith("update movements set status = 'failed'") and "any(" in s:
            for i in params[0]:
                db.movements[i]["status"] = "failed"
        elif s.startswith("update movements set status = 'failed'"):
            db.movements[params[0]]["status"] = "failed"
        elif s.startswith("update movements set status = 'unconfirmed'"):
            for i in params[0]:
                db.movements[i]["status"] = "unconfirmed"
        elif s.startswith("update movements set batch_id"):
            for i in params[1]:
                db.movements[i]["batch_id"] = params[0]
        elif s.startswith("update movements set paypal_ref"):
            for i in params[1]:
                db.movements[i]["paypal_ref"] = params[0]
        elif s.startswith("update movements set status = 'succeeded'"):
            db.movements[params[1]]["status"] = "succeeded"
        elif s.startswith("select m.*, a.role from movements"):
            rows = [m for m in db.movements.values() if m["paypal_ref"] == params[1] and m["status"] in ("executing", "unconfirmed")]
        elif s.startswith("select m.*, a.paypal_email"):
            rows = [
                {**m, "paypal_email": db.accounts[m["to_account_id"]]["paypal_email"], "account_name": db.accounts[m["to_account_id"]]["name"]}
                for m in db.movements.values() if m["batch_id"] == params[1] and m["status"] == "unconfirmed"
            ]
        elif s.startswith("select distinct paypal_ref"):
            seen = {}
            for m in db.movements.values():
                if m["status"] in ("executing", "unconfirmed") and m["batch_id"]:
                    seen[(m["paypal_ref"], m["batch_id"], m["status"])] = {"paypal_ref": m["paypal_ref"], "batch_id": m["batch_id"], "status": m["status"]}
            rows = list(seen.values())
        elif s.startswith("select id from treasury_accounts"):
            rows = [{"id": a["id"]} for a in db.accounts.values() if a["role"] == params[1]]
        elif s.startswith("insert into treasury_ledger"):
            if not any(e[2] == params[2] and e[1] == params[1] for e in db.ledger):
                db.ledger.append(params)
        elif s.startswith("insert into audit_log"):
            db.events.append(params[3])
        elif s.startswith("select a.id, a.role"):
            for a in db.accounts.values():
                moved = sum((e[3] for e in db.ledger if e[1] == a["id"]), D("0"))
                rows.append({"id": a["id"], "role": a["role"], "name": a["name"], "moved": moved})
        elif s.startswith("select currency, movable_when_unknown from treasury_limits"):
            rows = [{"currency": "USD", "movable_when_unknown": db.movable}]
        elif s.startswith("select to_account_id"):
            out: dict = {}
            for m in db.movements.values():
                if m["kind"] in params[1] and m["status"] in ("allowed", "executing", "unconfirmed"):
                    out[m["to_account_id"]] = out.get(m["to_account_id"], D("0")) + D(m["amount"])
            rows = [{"to_account_id": k, "out": v} for k, v in out.items()]

        class Cur:
            async def fetchone(self):
                return rows[0] if rows else None

            async def fetchall(self):
                return rows

        return Cur()


@pytest.fixture
def db(monkeypatch):
    db = DB()

    @asynccontextmanager
    async def connection():
        yield Conn(db)

    async def no_notify(*_a, **_k):
        return None

    monkeypatch.setattr(ex, "connection", connection)
    monkeypatch.setattr(ex, "notify_treasury_changed", no_notify)
    monkeypatch.setattr("app.audit.chain_key", lambda: "k" * 32)
    ex._balance_cache.clear()
    return db


def batch_response(batch_id="7HJ2", status="PENDING"):
    return httpx.Response(201, json={"batch_header": {"payout_batch_id": batch_id, "batch_status": status}})


def batch_detail(items, batch_id="7HJ2", status="SUCCESS"):
    return httpx.Response(200, json={
        "batch_header": {"payout_batch_id": batch_id, "batch_status": status},
        "items": [{"payout_item_id": f"ITEM-{sid}", "transaction_status": st, "payout_item": {"sender_item_id": sid}} for sid, st in items],
    })


def test_batch_key_is_stable_and_order_free():
    assert ex.batch_key(["a", "b"]) == ex.batch_key(["b", "a"])
    assert ex.batch_key(["a"]) != ex.batch_key(["a", "b"])
    assert len(ex.batch_key(["x" * 500])) < 64


async def test_demo_rebalance_sends_one_batch_and_settles_ledger(db, gateway, paypal):
    db.add("mv-buf", "buf", "4200.00", "sweep:fl_9a1d:buffer")
    db.add("mv-ad", "ad", "4560.00", "sweep:fl_9a1d:ad")
    post = paypal.post("/v1/payments/payouts").mock(return_value=batch_response())
    paypal.get("/v1/payments/payouts/7HJ2").mock(return_value=batch_detail([("mv-buf", "SUCCESS"), ("mv-ad", "SUCCESS")]))

    result = await ex.execute(M, ["mv-buf", "mv-ad"], gateway=gateway)

    assert result.status == "succeeded"
    req = post.calls.last.request
    body = __import__("json").loads(req.content)
    assert req.headers["PayPal-Request-Id"] == body["sender_batch_header"]["sender_batch_id"] == ex.batch_key(
        ["sweep:fl_9a1d:buffer", "sweep:fl_9a1d:ad"]
    )
    assert {i["receiver"] for i in body["items"]} == {"buffer@biz.example", "ads@biz.example"}
    assert {i["amount"]["value"] for i in body["items"]} == {"4200.00", "4560.00"}
    assert "PayPal-Auth-Assertion" not in req.headers  # the app's own account
    assert {m["status"] for m in db.movements.values()} == {"succeeded"}
    paypal.get("/v1/reporting/balances").mock(return_value=httpx.Response(200, json={"balances": []}))
    positions = {p.role: p for p in await ex.positions(Conn(db), M, gateway=gateway)}
    assert positions["operating"].balance is None and positions["operating"].source == "unavailable"
    assert positions["dispute_buffer"].balance == D("4200.00")  # only what PayPal confirmed, no opening balance
    assert positions["ad_spend"].balance == D("4560.00") and positions["ad_spend"].source == "confirmed"
    assert "execution.confirmed" in db.events


async def test_pending_batch_stays_executing_without_ledger(db, gateway, paypal):
    db.add("mv-1", "ad", "100.00", "k-1")
    paypal.post("/v1/payments/payouts").mock(return_value=batch_response())
    paypal.get("/v1/payments/payouts/7HJ2").mock(return_value=batch_detail([("mv-1", "PENDING")], status="PROCESSING"))
    result = await ex.execute(M, ["mv-1"], gateway=gateway)
    assert result.status == "executing" and db.movements["mv-1"]["status"] == "executing" and db.ledger == []


async def test_timeout_marks_unconfirmed_and_keeps_the_key(db, gateway, paypal):
    db.add("mv-1", "ad", "100.00", "k-1")
    paypal.post("/v1/payments/payouts").mock(return_value=httpx.Response(503, json={"name": "SERVICE_UNAVAILABLE"}))
    result = await ex.execute(M, ["mv-1"], gateway=gateway)
    assert result.status == "unconfirmed"
    assert db.movements["mv-1"]["status"] == "unconfirmed"  # never 'failed': that would free the key
    assert db.ledger == []


async def test_unconfirmed_resend_uses_the_same_request_id(db, gateway, paypal):
    db.add("mv-1", "ad", "100.00", "k-1")
    route = paypal.post("/v1/payments/payouts")
    route.side_effect = [httpx.Response(503, json={}), httpx.Response(503, json={}), httpx.Response(503, json={}),
                         httpx.Response(503, json={}), batch_response()]
    paypal.get("/v1/payments/payouts/7HJ2").mock(return_value=batch_detail([("mv-1", "SUCCESS")]))
    await ex.execute(M, ["mv-1"], gateway=gateway)
    first_ids = {c.request.headers["PayPal-Request-Id"] for c in route.calls}
    done = await ex.confirm_pending(M, gateway=gateway)
    assert done == {"checked": 0, "resent": 1}
    assert {c.request.headers["PayPal-Request-Id"] for c in route.calls} == first_ids  # one id across every attempt
    assert db.movements["mv-1"]["status"] == "succeeded"


async def test_definite_rejection_fails_without_ledger(db, gateway, paypal):
    db.add("mv-1", "ad", "100.00", "k-1")
    paypal.post("/v1/payments/payouts").mock(
        return_value=httpx.Response(422, json={"name": "INSUFFICIENT_FUNDS", "message": "Sender does not have sufficient funds"})
    )
    result = await ex.execute(M, ["mv-1"], gateway=gateway)
    assert result.status == "failed" and db.movements["mv-1"]["status"] == "failed" and db.ledger == []
    assert "execution.failed" in db.events


async def test_only_allowed_movements_are_sent(db, gateway, paypal):
    db.add("mv-ask", "ad", "8760.00", "k-ask", status="needs_approval")
    db.add("mv-block", "ad", "15000.00", "k-block", status="blocked")
    db.add("mv-done", "ad", "10.00", "k-done", status="succeeded")
    db.add("mv-refund", None, "18.00", "k-r", kind="refund")
    post = paypal.post("/v1/payments/payouts").mock(return_value=batch_response())
    result = await ex.execute(M, ["mv-ask", "mv-block", "mv-done", "mv-refund"], gateway=gateway)
    assert result.status == "nothing" and not post.called


async def test_second_execute_of_same_movement_sends_nothing(db, gateway, paypal):
    db.add("mv-1", "ad", "100.00", "k-1")
    post = paypal.post("/v1/payments/payouts").mock(return_value=batch_response())
    paypal.get("/v1/payments/payouts/7HJ2").mock(return_value=batch_detail([("mv-1", "SUCCESS")]))
    await ex.execute(M, ["mv-1"], gateway=gateway)
    again = await ex.execute(M, ["mv-1"], gateway=gateway)
    assert again.status == "nothing" and post.call_count == 1
    assert len(db.ledger) == 2  # one credit, one operating debit


async def test_account_unverified_after_check_gets_nothing(db, gateway, paypal):
    db.add("mv-1", "ad", "100.00", "k-1")
    db.accounts["ad"]["verified_at"] = None
    post = paypal.post("/v1/payments/payouts").mock(return_value=batch_response())
    result = await ex.execute(M, ["mv-1"], gateway=gateway)
    assert result.status == "nothing" and not post.called
    assert db.movements["mv-1"]["status"] == "failed" and "execution.refused" in db.events


async def test_failed_item_is_settled_as_failed(db, gateway, paypal):
    db.add("mv-1", "ad", "100.00", "k-1")
    db.add("mv-2", "buf", "50.00", "k-2")
    paypal.post("/v1/payments/payouts").mock(return_value=batch_response())
    paypal.get("/v1/payments/payouts/7HJ2").mock(return_value=batch_detail([("mv-1", "SUCCESS"), ("mv-2", "RETURNED")]))
    await ex.execute(M, ["mv-1", "mv-2"], gateway=gateway)
    assert db.movements["mv-1"]["status"] == "succeeded" and db.movements["mv-2"]["status"] == "failed"
    assert {e[2] for e in db.ledger} == {"mv-1"}


async def test_operating_is_paypals_own_balance(db, gateway, paypal):
    paypal.get("/v1/reporting/balances").mock(return_value=httpx.Response(200, json={
        "balances": [{"currency": "USD", "available_balance": {"currency_code": "USD", "value": "41000.00"}}]
    }))
    positions = {p.role: p for p in await ex.positions(Conn(db), M, gateway=gateway)}
    assert positions["operating"].balance == D("41000.00") and positions["operating"].source == "paypal"
    assert positions["ad_spend"].source == "confirmed"


async def test_balance_error_leaves_operating_unknown(db, gateway, paypal):
    """No typed-in opening balance stands in for PayPal's figure."""
    paypal.get("/v1/reporting/balances").mock(return_value=httpx.Response(403, json={"name": "NOT_AUTHORIZED"}))
    positions = {p.role: p for p in await ex.positions(Conn(db), M, gateway=gateway)}
    assert positions["operating"].source == "unavailable" and positions["operating"].balance is None


async def test_payout_webhook_only_queues_a_refetch(monkeypatch):
    from app.webhooks import router

    queued, audited = [], []

    class C:
        async def execute(self, sql, params=()):
            class Cur:
                async def fetchall(self):
                    return [{"merchant_id": M}] if params == ("7HJ2",) else []
            return Cur()

    @asynccontextmanager
    async def connection():
        yield C()

    async def enqueue(_conn, kind, payload, dedupe_key=None):
        queued.append((kind, payload, dedupe_key))

    async def audit(_conn, event, **kw):
        audited.append((event, kw["label"]))

    monkeypatch.setattr(router, "connection", connection)
    monkeypatch.setattr(router, "enqueue", enqueue)
    monkeypatch.setattr(router, "audit", audit)
    event = {"id": "WH-1", "event_type": "PAYMENT.PAYOUTSBATCH.SUCCESS",
             "resource": {"batch_header": {"payout_batch_id": "7HJ2", "batch_status": "SUCCESS"}}}
    assert await router._payout_event(event) == {"status": "queued"}
    assert queued == [("confirm_payouts", {"merchant_id": M}, f"payouts:{M}")]
    assert audited == [("webhook.received", "provider_verified")]
    unknown = {**event, "resource": {"batch_header": {"payout_batch_id": "OTHER"}}}
    assert await router._payout_event(unknown) == {"status": "ignored"}


async def test_unavailable_balance_is_not_asked_for_on_every_load(db, gateway, paypal):
    route = paypal.get("/v1/reporting/balances").mock(return_value=httpx.Response(403, json={"name": "NOT_AUTHORIZED"}))
    for _ in range(3):
        await ex.positions(Conn(db), M, gateway=gateway)
    assert route.call_count == 1


async def test_payout_in_flight_is_pending_not_arrived(db, gateway, paypal):
    """An UNCLAIMED or pending payout shows as pending on both ends, and never as money in the reserve."""
    db.add("mv-1", "ad", "8760.00", "k-1")
    paypal.post("/v1/payments/payouts").mock(return_value=batch_response())
    paypal.get("/v1/payments/payouts/7HJ2").mock(return_value=batch_detail([("mv-1", "UNCLAIMED")]))
    paypal.get("/v1/reporting/balances").mock(return_value=httpx.Response(403, json={"name": "NOT_AUTHORIZED"}))
    result = await ex.execute(M, ["mv-1"], gateway=gateway)
    assert result.status == "executing" and db.ledger == []
    positions = {p.role: p for p in await ex.positions(Conn(db), M, gateway=gateway)}
    assert positions["operating"].balance is None and positions["operating"].pending == D("8760.00")
    assert positions["ad_spend"].balance == D("0") and positions["ad_spend"].pending == D("8760.00")  # credited only once PayPal says SUCCESS


async def test_declared_cap_stands_in_only_when_paypal_gives_no_balance(db, gateway, paypal):
    paypal.get("/v1/reporting/balances").mock(return_value=httpx.Response(403, json={"name": "NOT_AUTHORIZED"}))
    db.movable = D("2000")
    db.ledger.append((M, "op", "mv", D("-300")))  # 300 already confirmed as sent
    op = {p.role: p for p in await ex.positions(Conn(db), M, gateway=gateway)}["operating"]
    assert op.balance == D("1700.00") and op.source == "declared"


async def test_declared_cap_is_ignored_when_paypal_returns_a_balance(db, gateway, paypal):
    paypal.get("/v1/reporting/balances").mock(return_value=httpx.Response(200, json={
        "balances": [{"currency": "USD", "available_balance": {"currency": "USD", "value": "41000.00"}}]}))
    db.movable = D("2000")
    op = {p.role: p for p in await ex.positions(Conn(db), M, gateway=gateway)}["operating"]
    assert op.balance == D("41000.00") and op.source == "paypal"
