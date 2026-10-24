import json
from datetime import datetime, timezone

from app.audit import GENESIS, _canonical, entry_hash, verify_rows
from app.treasury.router import _outcome

KEY = "history-key-0123456789abcdef0123456"


def test_flow_outcome_is_the_last_decisive_event():
    demo = ["trigger.verified", "plan.proposed", "safety.block", "plan.rebalanced", "plan.proposed", "safety.ask",
            "approval.granted", "safety.allow", "execution.submitted", "execution.accepted"]
    assert _outcome(demo) == "Sent to PayPal"
    assert _outcome(demo[:6]) == "Waiting for your approval"
    assert _outcome(["trigger.verified", "plan.proposed", "safety.block"]) == "Blocked by the safety engine"
    assert _outcome(["copilot.interpreted", "safety.block"]) == "Blocked by the safety engine"
    assert _outcome(["something.custom"]) == "something.custom"


def test_chain_survives_a_jsonb_round_trip_of_real_payloads():
    """What the planner, engine and executor actually write: nested lists, decimals as strings, nulls, unicode."""
    payloads = [
        {"policy": "ad_sweep@v1", "items": [{"role": "ad_spend", "amount": "15000.00", "account_id": "0c5a"}], "replan": False},
        {"check": "6_liquidity_floor", "reason": "Operating would fall to $18,760.00, below the $25,000.00 floor",
         "total": "15000.00", "approved": False, "plan_id": None, "money_moved": "0.00"},
        {"summary": "I drafted 3 policies — nothing is active", "drafts": 3, "ratio": 0.0825},
    ]
    rows, prev = [], GENESIS
    for i, data in enumerate(payloads):
        row = {"id": i + 1, "merchant_id": "m", "dispute_id": None, "flow_id": "f", "event": "x", "label": "system_generated",
               "actor": None, "data_json": _canonical(data), "created_at": datetime(2026, 10, 24, 17, 30, i, 123456, tzinfo=timezone.utc)}
        row["prev_hash"], row["row_hash"] = prev, entry_hash(KEY, prev, row)
        prev = row["row_hash"]
        rows.append(row)
    # Postgres jsonb hands keys back in its own order; the hash must not depend on it.
    for r in rows:
        r["data_json"] = json.loads(json.dumps(dict(reversed(list(r["data_json"].items())))))
    assert verify_rows(KEY, rows).ok
