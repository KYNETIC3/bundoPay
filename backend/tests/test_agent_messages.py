from datetime import datetime, timedelta, timezone
from decimal import Decimal

from app.agent.messages import compose_auto_refund, compose_decision, compose_outcome, compose_submitted, money
from app.disputes.model import parse_dispute
from app.disputes.router import _clearable


def facts(amount="45.00"):
    due = (datetime.now(timezone.utc) + timedelta(days=10)).isoformat().replace("+00:00", "Z")
    return parse_dispute({
        "dispute_id": "PP-D-9",
        "status": "WAITING_FOR_SELLER_RESPONSE",
        "reason": "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        "dispute_amount": {"currency_code": "USD", "value": amount},
        "seller_response_due_date": due,
        "links": [{"rel": "accept_claim"}, {"rel": "make_offer"}, {"rel": "provide_evidence"}],
    })


def test_money():
    assert money(Decimal("1234.5"), "USD") == "$1,234.50"
    assert money("12", "NGN") == "NGN 12.00"
    assert money(None, "USD") == "an unknown amount"


def test_auto_refund_message_says_what_happened_and_why():
    msg = compose_auto_refund(facts("12.00"), Decimal("20"), "RESOLVED")
    assert "I refunded $12.00" in msg and "$20.00 automatic refund limit" in msg and "closed" in msg


def test_decision_above_limit_asks_for_ok():
    msg = compose_decision(facts("45.00"), "accept_claim", ["No tracking shows delivery."], True, Decimal("20"), None)
    assert "I recommend refunding the buyer $45.00" in msg
    assert "above your $20.00 automatic limit" in msg
    assert "No tracking shows delivery." in msg


def test_decision_without_rule_never_claims_a_limit():
    msg = compose_decision(facts("45.00"), "provide_evidence", ["Tracking shows delivery."], False, Decimal("20"), None)
    assert "sending PayPal your proof" in msg and "Nothing is sent until you approve." in msg
    assert "limit" not in msg


def test_submitted_and_outcome_messages():
    assert compose_submitted("“X”", "accept_claim", "$45.00", "RESOLVED").startswith("Refund of $45.00 sent")
    assert "in your favour" in compose_outcome("Buyer says the order never arrived", "$45.00", "RESOLVED_SELLER_FAVOUR")


def test_only_finished_disputes_can_be_cleared():
    assert _clearable("RESOLVED", None)
    assert _clearable("UNDER_REVIEW", "submitted")  # refund sent, PayPal still closing it
    assert not _clearable("WAITING_FOR_SELLER_RESPONSE", "awaiting_approval")
    assert not _clearable("WAITING_FOR_SELLER_RESPONSE", None)
