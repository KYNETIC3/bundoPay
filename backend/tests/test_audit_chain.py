from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.audit import GENESIS, _canonical, audit, entry_hash, verify_rows

KEY = "test-chain-key-0123456789abcdef0123"
T0 = datetime(2026, 10, 30, 9, 0, tzinfo=timezone.utc)


def chain(n: int) -> list[dict]:
    rows, prev = [], GENESIS
    for i in range(n):
        row = {
            "id": i + 1,
            "merchant_id": "m-1",
            "dispute_id": None,
            "flow_id": "f-1",
            "event": f"step.{i}",
            "label": "system_generated",
            "actor": "safety_engine",
            "data_json": _canonical({"amount": Decimal("12.50"), "i": i}),
            "created_at": T0 + timedelta(seconds=i),
        }
        row["prev_hash"] = prev
        row["row_hash"] = prev = entry_hash(KEY, prev, row)
        rows.append(row)
    return rows


def test_intact_chain_verifies():
    report = verify_rows(KEY, chain(14))
    assert report.ok and report.entries == 14


def test_changed_entry_is_detected():
    rows = chain(5)
    rows[2]["data_json"] = {"amount": "1250.00", "i": 2}
    report = verify_rows(KEY, rows)
    assert not report.ok and report.broken_at == 3 and "changed" in report.reason


def test_changed_label_is_detected():
    rows = chain(3)
    rows[1]["label"] = "provider_verified"
    assert not verify_rows(KEY, rows).ok


def test_removed_entry_is_detected():
    rows = chain(5)
    del rows[2]
    report = verify_rows(KEY, rows)
    assert not report.ok and "removed or inserted" in report.reason


def test_reordered_entries_are_detected():
    rows = chain(4)
    rows[1], rows[2] = rows[2], rows[1]
    assert not verify_rows(KEY, rows).ok


def test_rehash_without_the_key_is_detected():
    rows = chain(3)
    rows[1]["data_json"] = {"amount": "999.00", "i": 1}
    rows[1]["row_hash"] = entry_hash("attacker-guessed-key-000000000000000", rows[1]["prev_hash"], rows[1])
    assert not verify_rows(KEY, rows).ok


def test_unchained_entry_inside_chain_is_detected():
    rows = chain(3)
    rows.insert(2, {"id": 99, "row_hash": None, "prev_hash": None})
    report = verify_rows(KEY, rows)
    assert not report.ok and report.broken_at == 99


def test_legacy_entries_before_the_chain_are_skipped():
    legacy = [{"id": 0, "row_hash": None, "prev_hash": None}]
    assert verify_rows(KEY, legacy + chain(2)).ok


def test_timestamp_timezone_does_not_change_the_hash():
    rows = chain(1)
    lagos = timezone(timedelta(hours=1))
    rows[0]["created_at"] = rows[0]["created_at"].astimezone(lagos)
    assert verify_rows(KEY, rows).ok


class FakeConn:
    """Records statements; returns the last row_hash written, like the real chain lookup."""

    def __init__(self):
        self.rows: list[tuple] = []

    async def execute(self, sql, params=()):
        last = self

        class Cur:
            async def fetchone(self):
                return {"row_hash": last.rows[-1][-1]} if last.rows else None

        if sql.startswith("insert into audit_log"):
            self.rows.append(params)
        return Cur()


async def test_audit_writes_linked_entries(monkeypatch):
    monkeypatch.setattr("app.audit.chain_key", lambda: KEY)
    conn = FakeConn()
    await audit(conn, "safety.block", merchant_id="m-1", data={"amount": Decimal("15000.00")}, actor="safety_engine")
    await audit(conn, "safety.allow", merchant_id="m-1", label="provider_verified")
    (first, second) = conn.rows
    assert first[8] == GENESIS and second[8] == first[9]
    rows = [
        {"id": i + 1, "merchant_id": p[0], "dispute_id": p[1], "flow_id": p[2], "event": p[3], "label": p[4],
         "actor": p[5], "data_json": p[6].obj, "created_at": p[7], "prev_hash": p[8], "row_hash": p[9]}
        for i, p in enumerate(conn.rows)
    ]
    assert verify_rows(KEY, rows).ok


async def test_audit_rejects_unknown_label(monkeypatch):
    monkeypatch.setattr("app.audit.chain_key", lambda: KEY)
    with pytest.raises(ValueError):
        await audit(FakeConn(), "x", label="verified_by_ai")
