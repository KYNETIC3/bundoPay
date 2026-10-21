import itertools
from datetime import datetime, timedelta, timezone

import pytest

from app.adapters.base import Record
from app.adapters.csv_adapter import CsvAdapter, CsvValidationError, InMemoryRecordStore, parse_csv
from app.agent.assemble import FileValidationError, assemble, validate_file
from app.agent.evidence import Context, build_evidence_map
from app.agent.orchestrator import note_is_grounded, refine_with_model
from app.agent.recommend import DisallowedActionError, History, enforce_allowed, recommend
from app.agent.tools import READ_ONLY_TOOLS, TOOL_SPECS, WRITE_TOOLS, ToolBox
from app.disputes.model import parse_dispute, work_item_key

NOW = datetime(2026, 10, 21, 12, 0, tzinfo=timezone.utc)
ACTIONS = ["provide_evidence", "make_offer", "accept_claim"]


def dispute(links=ACTIONS, *, amount="120.00", due=NOW + timedelta(days=5), reason="MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
            requested=("PROOF_OF_FULFILLMENT",)):
    return {
        "dispute_id": "PP-D-1",
        "create_time": "2026-10-10T00:00:00Z",
        "status": "WAITING_FOR_SELLER_RESPONSE",
        "reason": reason,
        "dispute_life_cycle_stage": "INQUIRY",
        "dispute_amount": {"currency_code": "USD", "value": amount},
        "seller_response_due_date": due.isoformat().replace("+00:00", "Z"),
        "disputed_transactions": [{"seller_transaction_id": "TXN1", "seller": {"merchant_id": "PAYERID"}}],
        "evidences": [{"evidence_type": t, "source": "REQUESTED_FROM_SELLER", "date": "2026-10-11T00:00:00Z"} for t in requested],
        "links": [{"rel": "self"}] + [{"rel": rel} for rel in links],
    }


def txn(amount="120.00", postal="94107"):
    return {
        "transaction_info": {
            "transaction_id": "TXN1",
            "transaction_amount": {"currency_code": "USD", "value": amount},
            "transaction_initiation_date": "2026-10-01T10:00:00+0000".replace("+0000", "+00:00"),
        },
        "shipping_info": {"address": {"line1": "1 Main St", "postal_code": postal, "country_code": "US"}},
    }


def rec(kind, key, **data):
    return {"source_system": "csv", "kind": kind, "key": key, "data": data}


def strong_ctx():
    return Context(
        transaction_id="TXN1",
        transaction=txn(),
        trackers=[{"tracking_number": "1Z999", "carrier": "UPS", "status": "DELIVERED"}],
        order=rec("orders", "A100", order_id="A100", total="120.00", currency="USD", order_date="2026-10-01",
                  ship_to_postal_code="94107"),
        shipments=[rec("shipments", "1Z999", order_id="A100", tracking_number="1Z999", carrier="UPS", status="delivered")],
    )


# ------------------------------------------------------------- HATEOAS gate


def test_registry_has_exactly_one_write_tool_and_model_never_sees_it():
    assert WRITE_TOOLS == ("submit_dispute_response",)
    assert {s["name"] for s in TOOL_SPECS} == set(READ_ONLY_TOOLS)
    assert "submit_dispute_response" not in READ_ONLY_TOOLS


async def test_toolbox_refuses_write_tool():
    calls = []

    async def audit(name, args, result):
        calls.append((name, result))

    tb = ToolBox(gateway=None, paypal_merchant_id="P", dispute_id="D", adapters=[], audit=audit)
    with pytest.raises(PermissionError):
        await tb.call("submit_dispute_response", {})
    assert calls[0][1] == {"rejected": "not a read-only tool"}


def test_allowed_actions_come_only_from_links():
    assert parse_dispute(dispute(links=["accept_claim"])).allowed_actions == ["accept_claim"]
    assert parse_dispute(dispute(links=[])).allowed_actions == []
    with pytest.raises(DisallowedActionError):
        enforce_allowed("provide_evidence", parse_dispute(dispute(links=["make_offer"])))


@pytest.mark.parametrize("links", [list(c) for n in range(4) for c in itertools.combinations(ACTIONS, n)])
@pytest.mark.parametrize("ctx_factory", [strong_ctx, lambda: Context(transaction_id="TXN1")])
@pytest.mark.parametrize("amount", ["20.00", "500.00"])
def test_rules_never_propose_a_missing_link(links, ctx_factory, amount):
    facts = parse_dispute(dispute(links=links, amount=amount))
    rec_ = recommend(facts, build_evidence_map(facts, ctx_factory()), History(), now=NOW)
    assert rec_.action is None or rec_.action in links
    if not links:
        assert rec_.action is None


class FakeLLM:
    name = "fake"

    def __init__(self, response):
        self.response = response

    async def run(self, system, user, tools, call_tool):
        assert all(t["name"] in READ_ONLY_TOOLS for t in tools)
        return self.response


async def _refine(links, response):
    facts = parse_dispute(dispute(links=links))
    emap = build_evidence_map(facts, strong_ctx())
    baseline = recommend(facts, emap, History(), now=NOW)
    events = []

    async def on_event(name, data):
        events.append(name)

    async def no_audit(*_):
        return None

    tools = ToolBox(gateway=None, paypal_merchant_id="P", dispute_id="D", adapters=[], audit=no_audit)
    out = await refine_with_model(facts, emap, baseline, FakeLLM(response), tools, "1Z999 UPS A100", on_event)
    return baseline, out, events


async def test_model_proposing_absent_action_is_overruled():
    baseline, out, events = await _refine(["provide_evidence"], '{"action": "accept_claim", "reasons": ["x"], "notes": {}}')
    assert out.action == "provide_evidence" == baseline.action
    assert "agent.disallowed_action_rejected" in events


async def test_model_choice_within_links_is_kept_and_ungrounded_notes_dropped():
    _, out, events = await _refine(
        ACTIONS,
        '{"action": "provide_evidence", "reasons": ["Delivered per UPS."], '
        '"notes": {"PROOF_OF_FULFILLMENT": "Delivered via UPS, tracking 1Z999.", "OTHER": "Tracking 9Z12345 shows delivery."}}',
    )
    assert out.action == "provide_evidence" and out.source == "model:fake"
    assert out.notes == {"PROOF_OF_FULFILLMENT": "Delivered via UPS, tracking 1Z999."}
    assert "agent.note_rejected" in events


def test_note_grounding():
    assert note_is_grounded("Shipped with UPS tracking 1Z999.", "... 1Z999 ...")
    assert not note_is_grounded("Shipped with tracking 1Z000.", "... 1Z999 ...")


# -------------------------------------------------------- evidence/integrity


def test_strong_case_maps_cleanly():
    facts = parse_dispute(dispute())
    emap = build_evidence_map(facts, strong_ctx())
    row = emap.rows[0]
    assert row.source_system == "paypal" and row.match_confidence >= 0.9 and row.gap_or_conflict is None
    assert row.evidence_info["tracking_info"][0]["tracking_number"] == "1Z999"
    assert not [f for f in emap.flags if f.severity == "high"]
    assert recommend(facts, emap, History(), now=NOW).action == "provide_evidence"


def test_integrity_flags_are_raised_not_resolved():
    ctx = strong_ctx()
    ctx.transaction = txn(amount="99.00", postal="10001")
    ctx.trackers = [{"tracking_number": "1Z000", "carrier": "UPS", "status": "SHIPPED"}]
    ctx.shipments = [rec("shipments", "1Z999", order_id="A100", tracking_number="1Z999", carrier="UPS", status="in_transit")]
    ctx.merchant_refunds = [rec("refunds", "R1", order_id="A100", refund_id="R1", amount="10", currency="USD")]
    facts = parse_dispute(dispute())
    kinds = {f.kind for f in build_evidence_map(facts, ctx).flags}
    assert {"amount_mismatch", "tracking_mismatch", "non_delivery", "address_mismatch", "refund_absent_in_paypal"} <= kinds


def test_missing_records_are_gaps():
    facts = parse_dispute(dispute(requested=("PROOF_OF_FULFILLMENT", "POLICE_REPORT")))
    emap = build_evidence_map(facts, Context(transaction_id="TXN1"))
    assert all(r.satisfying_record is None and r.gap_or_conflict for r in emap.rows)
    assert emap.coverage_score == 0
    assert "missing_record" in {f.kind for f in emap.flags}


def test_assembled_payload_only_uses_existing_records():
    facts = parse_dispute(dispute(requested=("PROOF_OF_FULFILLMENT", "POLICE_REPORT")))
    emap = build_evidence_map(facts, strong_ctx())
    spec = assemble(facts, emap, recommend(facts, emap, History(), now=NOW))
    assert [e["evidence_type"] for e in spec.payload["evidences"]] == ["PROOF_OF_FULFILLMENT"]
    assert all(len(e["notes"]) < 500 for e in spec.payload["evidences"])
    assert any(m["evidence_type"] == "POLICE_REPORT" for m in spec.missing_items)


def test_weak_small_case_recommends_concession():
    facts = parse_dispute(dispute(amount="20.00"))
    rec_ = recommend(facts, build_evidence_map(facts, Context(transaction_id="TXN1")), History(), now=NOW)
    assert rec_.action == "accept_claim"


def test_past_due_recommends_nothing():
    facts = parse_dispute(dispute(due=NOW - timedelta(hours=1)))
    rec_ = recommend(facts, build_evidence_map(facts, strong_ctx()), History(), now=NOW)
    assert rec_.past_due and rec_.action is None


def test_new_evidence_request_is_a_new_work_item():
    first = dispute(requested=("PROOF_OF_FULFILLMENT",))
    again = dispute(requested=("PROOF_OF_FULFILLMENT", "PROOF_OF_DELIVERY_SIGNATURE"))
    assert work_item_key(first) != work_item_key(again)
    assert work_item_key(first) == work_item_key(dispute(requested=("PROOF_OF_FULFILLMENT",)))


@pytest.mark.parametrize(
    "name,ctype,size,total,ok",
    [
        ("label.pdf", "application/pdf", 1000, 0, True),
        ("photo.jpeg", "image/jpeg", 1000, 0, True),
        ("doc.docx", "application/msword", 1000, 0, False),
        ("big.pdf", "application/pdf", 10 * 1024 * 1024 + 1, 0, False),
        ("late.png", "image/png", 5 * 1024 * 1024, 46 * 1024 * 1024, False),
    ],
)
def test_file_validation(name, ctype, size, total, ok):
    if ok:
        validate_file(name, ctype, size, total)
    else:
        with pytest.raises(FileValidationError):
            validate_file(name, ctype, size, total)


# ------------------------------------------------------------- CSV adapter


async def test_csv_adapter_matches_on_strong_identifiers_only():
    orders = parse_csv("orders", "order_id,order_date,total,currency,paypal_transaction_id,customer_email\n"
                                 "A100,2026-10-01,120.00,USD,TXN1,b@example.com\n")
    shipments = parse_csv("shipments", "order_id,carrier,tracking_number,status\nA100,UPS,1Z999,delivered\n")
    adapter = CsvAdapter(InMemoryRecordStore({"orders": orders, "shipments": shipments}))
    from app.adapters.base import OrderRef

    found = await adapter.find_order(OrderRef(paypal_transaction_id="TXN1"))
    assert isinstance(found, Record) and found.key == "A100"
    assert await adapter.find_order(OrderRef(buyer_email="b@example.com")) is None
    assert [s.key for s in await adapter.find_shipment("A100")] == ["1Z999"]


def test_csv_validation():
    with pytest.raises(CsvValidationError, match="Missing required columns"):
        parse_csv("orders", "order_id,total\nA1,10\n")
    with pytest.raises(CsvValidationError, match="Row 2"):
        parse_csv("refunds", "order_id,refund_id,amount,currency\nA1,,10,USD\n")
