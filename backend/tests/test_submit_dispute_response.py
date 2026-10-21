"""submit_dispute_response must refuse anything the merchant did not approve, exactly."""

import copy
import hashlib
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from app.agent.assemble import payload_hash
from app.approvals.submit import ApprovalRecord, DraftRecord, submit_dispute_response
from app.approvals.tokens import ApprovalError, issue, token_hash

KEY = "test-signing-key-0123456789abcdef"
NOW = datetime(2026, 10, 21, 12, 0, tzinfo=timezone.utc)
PDF = b"%PDF-1.4 shipping label"

DISPUTE = {
    "dispute_id": "PP-D-1",
    "status": "WAITING_FOR_SELLER_RESPONSE",
    "links": [{"rel": "self"}, {"rel": "provide_evidence"}, {"rel": "accept_claim"}],
}


class FakeStore:
    def __init__(self, draft: DraftRecord, files: dict[str, bytes]):
        self.draft = draft
        self.files = files
        self.approvals: dict[str, ApprovalRecord] = {}
        self.events: list[tuple[str, dict]] = []
        self.statuses: list[str] = []
        self.saved: list[dict] = []

    async def load_draft(self, draft_id):
        return self.draft if draft_id == self.draft.id else None

    async def load_approval(self, th):
        return self.approvals.get(th)

    async def consume_approval(self, approval_id):
        for a in self.approvals.values():
            if a.id == approval_id and a.consumed_at is None:
                a.consumed_at = NOW
                return True
        return False

    async def read_file(self, path):
        return self.files[path]

    async def set_draft_status(self, draft_id, status):
        self.statuses.append(status)

    async def save_dispute(self, merchant_id, raw):
        self.saved.append(raw)

    async def log(self, draft, event, data):
        self.events.append((event, data))


def make_draft() -> DraftRecord:
    payload = {
        "evidences": [
            {
                "evidence_type": "PROOF_OF_FULFILLMENT",
                "evidence_info": {"tracking_info": [{"carrier_name": "UPS", "tracking_number": "1Z999"}]},
                "notes": "Order shipped via UPS.",
            }
        ]
    }
    files = [
        {
            "filename": "label.pdf",
            "content_type": "application/pdf",
            "size": len(PDF),
            "sha256": hashlib.sha256(PDF).hexdigest(),
            "storage_path": "m/d/label.pdf",
            "evidence_type": "PROOF_OF_FULFILLMENT",
        }
    ]
    return DraftRecord(
        id="draft-1",
        merchant_id="merchant-1",
        dispute_row_id="row-1",
        paypal_dispute_id="PP-D-1",
        paypal_merchant_id="PAYERID",
        action="provide_evidence",
        payload=payload,
        files=files,
        stored_hash=payload_hash("PP-D-1", "provide_evidence", payload, files),
        status="approved",
    )


def approve(store: FakeStore, *, ttl: int = 600, now: datetime = NOW) -> str:
    """Mimic the Approve click: mint a token over the current hash and record it."""
    d = store.draft
    h = payload_hash(d.paypal_dispute_id, d.action, d.payload, d.files)
    token, _ = issue(KEY, draft_id=d.id, merchant_id=d.merchant_id, payload_hash=h, ttl_seconds=ttl, now=now)
    store.approvals[token_hash(token)] = ApprovalRecord(f"appr-{len(store.approvals)}", d.id, h, None, None)
    return token


@pytest.fixture
def store():
    return FakeStore(make_draft(), {"m/d/label.pdf": PDF})


@pytest.fixture
def evidence_route(paypal):
    paypal.get("/v1/customer/disputes/PP-D-1").mock(
        side_effect=[httpx.Response(200, json=DISPUTE), httpx.Response(200, json={**DISPUTE, "status": "UNDER_REVIEW"})]
    )
    return paypal.post("/v1/customer/disputes/PP-D-1/provide-evidence").mock(return_value=httpx.Response(200, json={}))


async def submit(store, gateway, token, now=NOW):
    return await submit_dispute_response("draft-1", token, store=store, gateway=gateway, signing_key=KEY, now=now)


async def test_valid_approval_submits_once_with_idempotency_key(store, gateway, evidence_route):
    token = approve(store)
    result = await submit(store, gateway, token)
    assert (result.status_before, result.status_after) == ("WAITING_FOR_SELLER_RESPONSE", "UNDER_REVIEW")
    req = evidence_route.calls.last.request
    assert req.headers["PayPal-Request-Id"] == "submit-appr-0"
    assert store.statuses == ["submitting", "submitted"]
    assert store.saved and store.saved[-1]["status"] == "UNDER_REVIEW"  # confirmed from a PayPal re-fetch

    with pytest.raises(ApprovalError) as exc:  # single use
        await submit(store, gateway, token)
    assert exc.value.code == "used_approval"
    assert evidence_route.call_count == 1


@pytest.mark.parametrize("token", [None, ""])
async def test_rejects_missing_token(store, gateway, evidence_route, token):
    with pytest.raises(ApprovalError) as exc:
        await submit(store, gateway, token)
    assert exc.value.code == "missing_token"
    assert evidence_route.call_count == 0
    assert store.events[-1][0] == "submit.rejected"


async def test_rejects_expired_token(store, gateway, evidence_route):
    token = approve(store, ttl=600, now=NOW)
    with pytest.raises(ApprovalError) as exc:
        await submit(store, gateway, token, now=NOW + timedelta(seconds=601))
    assert exc.value.code == "expired_token"
    assert evidence_route.call_count == 0


async def test_rejects_tampered_payload(store, gateway, evidence_route):
    token = approve(store)
    store.draft.payload = copy.deepcopy(store.draft.payload)
    store.draft.payload["evidences"][0]["notes"] = "Buyer is lying."  # changed after approval
    with pytest.raises(ApprovalError) as exc:
        await submit(store, gateway, token)
    assert exc.value.code == "tampered_payload"
    assert evidence_route.call_count == 0


async def test_rejects_added_file_after_approval(store, gateway, evidence_route):
    token = approve(store)
    extra = b"\x89PNG\r\n\x1a\nphoto"
    store.files["m/d/photo.png"] = extra
    store.draft.files = store.draft.files + [
        {"filename": "photo.png", "content_type": "image/png", "size": len(extra),
         "sha256": hashlib.sha256(extra).hexdigest(), "storage_path": "m/d/photo.png", "evidence_type": "PROOF_OF_FULFILLMENT"}
    ]
    with pytest.raises(ApprovalError) as exc:
        await submit(store, gateway, token)
    assert exc.value.code == "tampered_payload"


async def test_rejects_file_bytes_swapped_in_storage(store, gateway, evidence_route):
    token = approve(store)
    store.files["m/d/label.pdf"] = b"%PDF-1.4 a different document"
    with pytest.raises(ApprovalError) as exc:
        await submit(store, gateway, token)
    assert exc.value.code == "tampered_payload"
    assert evidence_route.call_count == 0


async def test_rejects_forged_signature(store, gateway, evidence_route):
    token = approve(store)
    head, body, _sig = token.split(".")
    forged, _ = issue("another-key-that-is-long-enough-000", draft_id="draft-1", merchant_id="merchant-1",
                      payload_hash="x" * 64, ttl_seconds=600, now=NOW)
    with pytest.raises(ApprovalError) as exc:
        await submit(store, gateway, f"{head}.{forged.split('.')[1]}.{_sig}")
    assert exc.value.code == "bad_signature"


async def test_rejects_signed_token_that_was_never_recorded(store, gateway, evidence_route):
    d = store.draft
    token, _ = issue(KEY, draft_id=d.id, merchant_id=d.merchant_id, payload_hash=d.stored_hash, ttl_seconds=600, now=NOW)
    with pytest.raises(ApprovalError) as exc:
        await submit(store, gateway, token)
    assert exc.value.code == "unknown_approval"


async def test_rejects_revoked_approval(store, gateway, evidence_route):
    token = approve(store)
    store.approvals[token_hash(token)].revoked_at = NOW  # an edit happened
    with pytest.raises(ApprovalError) as exc:
        await submit(store, gateway, token)
    assert exc.value.code == "revoked_approval"


async def test_rejects_when_paypal_link_disappeared(store, gateway, paypal):
    paypal.get("/v1/customer/disputes/PP-D-1").mock(
        return_value=httpx.Response(200, json={**DISPUTE, "links": [{"rel": "self"}, {"rel": "accept_claim"}]})
    )
    route = paypal.post("/v1/customer/disputes/PP-D-1/provide-evidence")
    with pytest.raises(ApprovalError) as exc:
        await submit(store, gateway, approve(store))
    assert exc.value.code == "action_unavailable"
    assert route.call_count == 0
