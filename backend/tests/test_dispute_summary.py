from app.disputes.router import _result, _summary


def _row(status: str, outcome: str | None = None) -> dict:
    raw = {"create_time": "2026-10-01T00:00:00Z"}
    if outcome:
        raw["dispute_outcome"] = {"outcome_code": outcome}
    return {"id": "d1", "paypal_dispute_id": "PP-D-1", "status": status, "reason": "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
            "lifecycle_stage": "INQUIRY", "amount": None, "currency": "USD", "due_date": None, "raw_json": raw,
            "updated_at": "2026-10-02T00:00:00Z"}


def test_open_dispute_has_no_result():
    assert _result(_row("OPEN")) is None


def test_seller_favour_and_buyer_cancel_count_as_won():
    assert _result(_row("RESOLVED", "RESOLVED_SELLER_FAVOUR")) == "won"
    assert _result(_row("RESOLVED", "CANCELED_BY_BUYER")) == "won"


def test_buyer_favour_counts_as_lost():
    assert _result(_row("RESOLVED", "RESOLVED_BUYER_FAVOUR")) == "lost"


def test_resolved_without_outcome_is_unknown():
    assert _result(_row("RESOLVED")) is None


def test_summary_carries_result():
    assert _summary(_row("RESOLVED", "RESOLVED_BUYER_FAVOUR"))["result"] == "lost"
