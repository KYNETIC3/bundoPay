"""Append-only audit trail: every agent step, tool call, approval, submission and outcome.

Each merchant's entries form an HMAC chain: row_hash = HMAC(key, prev_hash || canonical entry), so a
changed, inserted or removed entry breaks every hash after it. This detects tampering after the fact;
it can't prove the facts were true when written.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection

from app.config import get_settings
from app.db import jsonb

log = logging.getLogger("audit")

GENESIS = "genesis"
LABELS = ("provider_verified", "user_uploaded", "system_generated", "ai_assessment")


def _canonical(value: Any) -> Any:
    """What jsonb gives back, so the hash computed at insert matches the one recomputed on read."""
    return json.loads(json.dumps(value, default=str))


def _ts(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds")


def _id(value: Any) -> str | None:
    return None if value is None else str(value)


def entry_hash(key: str, prev_hash: str, entry: dict[str, Any]) -> str:
    body = json.dumps(
        {
            "merchant_id": _id(entry.get("merchant_id")),
            "dispute_id": _id(entry.get("dispute_id")),
            "flow_id": _id(entry.get("flow_id")),
            "event": entry["event"],
            "label": entry["label"],
            "actor": entry.get("actor"),
            "data": entry["data_json"],
            "created_at": _ts(entry["created_at"]),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hmac.new(key.encode(), f"{prev_hash}|{body}".encode(), hashlib.sha256).hexdigest()


def chain_key() -> str:
    s = get_settings()
    key = s.audit_chain_key or s.approval_signing_key
    if len(key) < 32:
        raise RuntimeError("AUDIT_CHAIN_KEY (or APPROVAL_SIGNING_KEY) must be at least 32 characters")
    return key


async def audit(
    conn: AsyncConnection,
    event: str,
    *,
    merchant_id: UUID | str | None = None,
    dispute_id: UUID | str | None = None,
    data: dict[str, Any] | None = None,
    flow_id: UUID | str | None = None,
    label: str = "system_generated",
    actor: str | None = None,
) -> None:
    if label not in LABELS:
        raise ValueError(f"Unknown history label {label!r}")
    log.info("%s merchant=%s dispute=%s", event, merchant_id, dispute_id)
    entry = {
        "merchant_id": merchant_id,
        "dispute_id": dispute_id,
        "flow_id": flow_id,
        "event": event,
        "label": label,
        "actor": actor,
        "data_json": _canonical(data or {}),
        "created_at": datetime.now(timezone.utc),
    }
    # One writer at a time per chain; the lock lasts until this transaction commits.
    await conn.execute("select pg_advisory_xact_lock(hashtext('audit_chain:' || %s))", (_id(merchant_id) or "-",))
    cur = await conn.execute(
        "select row_hash from audit_log where merchant_id is not distinct from %s and row_hash is not null "
        "order by id desc limit 1",
        (merchant_id,),
    )
    last = await cur.fetchone()
    prev = last["row_hash"] if last else GENESIS
    await conn.execute(
        "insert into audit_log (merchant_id, dispute_id, flow_id, event, label, actor, data_json, created_at, prev_hash, row_hash) "
        "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (
            merchant_id, dispute_id, flow_id, event, label, actor, jsonb(entry["data_json"]), entry["created_at"],
            prev, entry_hash(chain_key(), prev, entry),
        ),
    )


@dataclass(frozen=True)
class ChainReport:
    ok: bool
    entries: int
    broken_at: int | None = None
    reason: str | None = None


def verify_rows(key: str, rows: list[dict[str, Any]]) -> ChainReport:
    """Rows in id order. Entries written before the chain existed (no row_hash) come first and are skipped."""
    prev = GENESIS
    count = 0
    started = False
    for row in rows:
        if row.get("row_hash") is None:
            if started:
                return ChainReport(False, count, row["id"], "Unchained entry inside the chain")
            continue
        started = True
        if row["prev_hash"] != prev:
            return ChainReport(False, count, row["id"], "Link to the previous entry is broken (an entry was removed or inserted)")
        if not hmac.compare_digest(entry_hash(key, prev, row), row["row_hash"]):
            return ChainReport(False, count, row["id"], "Entry was changed after it was written")
        prev = row["row_hash"]
        count += 1
    return ChainReport(True, count)


async def verify_chain(conn: AsyncConnection, merchant_id: UUID | str) -> ChainReport:
    cur = await conn.execute(
        "select id, merchant_id, dispute_id, flow_id, event, label, actor, data_json, created_at, prev_hash, row_hash "
        "from audit_log where merchant_id = %s order by id",
        (merchant_id,),
    )
    return verify_rows(chain_key(), await cur.fetchall())
