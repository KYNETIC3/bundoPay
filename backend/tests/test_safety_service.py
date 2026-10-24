from decimal import Decimal as D

from app.safety import service
from app.safety.engine import Movement, Trigger

LIMITS = {
    "currency": "USD", "solo_limit": D("5000"), "hard_cap_per_run": D("50000"), "hard_cap_per_day": None,
    "hard_cap_per_week": D("150000"), "hard_cap_per_month": None, "liquidity_floor": D("25000"),
}


class FakeConn:
    """Answers the guard's queries by their first words; `insert_returns` simulates the unique-key race."""

    def __init__(self, *, used=False, insert_returns=True, accounts=("acct-ad",)):
        self.used, self.insert_returns, self.accounts = used, insert_returns, accounts
        self.inserted, self.audits = [], []

    async def execute(self, sql, params=()):
        conn, s = self, " ".join(sql.split())
        rows = []
        if s.startswith("select * from treasury_limits"):
            rows = [LIMITS]
        elif s.startswith("select id from treasury_accounts"):
            rows = [{"id": a} for a in conn.accounts]
        elif s.startswith("select 1 from movements"):
            rows = [{"?": 1}] if conn.used else []
        elif s.startswith("select coalesce(sum(amount)"):
            rows = [{"day": 0, "week": 0, "month": 0}]
        elif s.startswith("insert into movements"):
            conn.inserted.append(params)
            rows = [{"id": "mv-1"}] if conn.insert_returns else []
        elif s.startswith("insert into audit_log"):
            conn.audits.append(params)
        elif s.startswith("select row_hash"):
            rows = [{"row_hash": conn.audits[-1][-1]}] if conn.audits else []

        class Cur:
            async def fetchone(self):
                return rows[0] if rows else None

            async def fetchall(self):
                return rows

        return Cur()


def mv(amount=D("100"), key="k-1"):
    return Movement(kind="sweep", amount=amount, currency="USD", idempotency_key=key, to_account="acct-ad")


async def guard(conn, m, **kw):
    kw.setdefault("trigger", Trigger("scheduler", True))
    kw.setdefault("authority", True)
    kw.setdefault("available", D("100000"))
    return await service.guard(conn, "m-1", m, **kw)


async def test_allowed_movement_is_recorded_and_audited(monkeypatch):
    monkeypatch.setattr("app.audit.chain_key", lambda: "k" * 32)
    conn = FakeConn()
    g = await guard(conn, mv())
    assert g.verdict.decision == "allow" and g.movement_id == "mv-1"
    assert conn.inserted[0]["s"] == "allowed" and conn.inserted[0]["a"] == "acct-ad"
    assert conn.audits[0][3] == "safety.allow"


async def test_floor_block_is_recorded(monkeypatch):
    monkeypatch.setattr("app.audit.chain_key", lambda: "k" * 32)
    conn = FakeConn()
    g = await guard(conn, mv(D("15000")), available=D("33640"))
    assert g.verdict.check == "6_liquidity_floor"
    assert conn.inserted[0]["s"] == "blocked"
    assert conn.audits[0][6].obj["money_moved"] == "0.00"


async def test_race_on_the_key_becomes_a_duplicate_block(monkeypatch):
    monkeypatch.setattr("app.audit.chain_key", lambda: "k" * 32)
    g = await guard(FakeConn(insert_returns=False), mv())
    assert g.verdict.check == "5_duplicate" and g.movement_id is None


async def test_used_key_is_blocked_without_a_new_row(monkeypatch):
    monkeypatch.setattr("app.audit.chain_key", lambda: "k" * 32)
    conn = FakeConn(used=True)
    g = await guard(conn, mv())
    assert g.verdict.check == "5_duplicate" and conn.inserted == [] and conn.audits


async def test_bad_amount_is_audited_but_not_stored(monkeypatch):
    monkeypatch.setattr("app.audit.chain_key", lambda: "k" * 32)
    conn = FakeConn()
    g = await guard(conn, mv(D("-5")))
    assert g.verdict.check == "4_bad_amount" and conn.inserted == [] and conn.audits


async def test_solo_override_cannot_exceed_hard_cap(monkeypatch):
    monkeypatch.setattr("app.audit.chain_key", lambda: "k" * 32)
    g = await guard(FakeConn(), mv(D("50000.01")), solo=D("1000000"))
    assert g.verdict.check == "4_hard_cap"


async def test_unverified_destination_stores_no_account(monkeypatch):
    monkeypatch.setattr("app.audit.chain_key", lambda: "k" * 32)
    conn = FakeConn(accounts=())
    g = await guard(conn, mv())
    assert g.verdict.check == "3_unverified_account" and conn.inserted[0]["a"] is None
