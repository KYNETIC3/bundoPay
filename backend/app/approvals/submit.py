"""submit_dispute_response: the agent system's one write tool, and the only path to a PayPal write.

Every guarantee is enforced here in code:
  * a valid, unexpired, HMAC-signed approval token is required;
  * the token must belong to this draft and merchant, be recorded, unconsumed and unrevoked;
  * the hash of the payload and file bytes as they are *now* must equal the hash the merchant approved;
  * the dispute is re-fetched and the action's HATEOAS link must still be present;
  * the approval is consumed atomically before PayPal is called (single use), and the call carries a
    PayPal-Request-Id derived from the approval so retries cannot double-submit.
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol

from app.agent.assemble import payload_hash
from app.disputes.model import parse_dispute
from app.paypal_gateway import EvidenceFile, PayPalError, PayPalGateway

from .tokens import ApprovalError, token_hash, verify


@dataclass
class DraftRecord:
    id: str
    merchant_id: str
    dispute_row_id: str
    paypal_dispute_id: str
    paypal_merchant_id: str
    action: str
    payload: dict[str, Any]
    files: list[dict[str, Any]]
    stored_hash: str
    status: str


@dataclass
class ApprovalRecord:
    id: str
    draft_id: str
    payload_hash: str
    consumed_at: datetime | None
    revoked_at: datetime | None


class SubmissionStore(Protocol):
    async def load_draft(self, draft_id: str) -> DraftRecord | None: ...
    async def load_approval(self, token_hash: str) -> ApprovalRecord | None: ...
    async def consume_approval(self, approval_id: str) -> bool: ...
    async def read_file(self, storage_path: str) -> bytes: ...
    async def set_draft_status(self, draft_id: str, status: str) -> None: ...
    async def save_dispute(self, merchant_id: str, raw: dict[str, Any]) -> None: ...
    async def log(self, draft: DraftRecord, event: str, data: dict[str, Any]) -> None: ...


@dataclass
class SubmissionResult:
    status_before: str
    status_after: str
    paypal_response: dict[str, Any]


async def submit_dispute_response(
    draft_id: str,
    approval_token: str | None,
    *,
    store: SubmissionStore,
    gateway: PayPalGateway,
    signing_key: str,
    now: datetime | None = None,
) -> SubmissionResult:
    now = now or datetime.now(timezone.utc)
    draft = await store.load_draft(draft_id)
    if draft is None:
        raise ApprovalError("unknown_draft", "Draft not found")

    async def reject(err: ApprovalError) -> ApprovalError:
        await store.log(draft, "submit.rejected", {"code": err.code, "message": str(err)})
        return err

    try:
        claims = verify(signing_key, approval_token, now)
    except ApprovalError as err:
        raise await reject(err)

    if claims.draft_id != draft.id or claims.merchant_id != draft.merchant_id:
        raise await reject(ApprovalError("wrong_draft", "Approval token was issued for a different draft"))

    approval = await store.load_approval(token_hash(approval_token))
    if approval is None or approval.draft_id != draft.id:
        raise await reject(ApprovalError("unknown_approval", "No approval is recorded for this token"))
    if approval.revoked_at is not None:
        raise await reject(ApprovalError("revoked_approval", "This approval was invalidated by an edit"))
    if approval.consumed_at is not None:
        raise await reject(ApprovalError("used_approval", "This approval was already used"))
    if not hmac.compare_digest(approval.payload_hash, claims.payload_hash):
        raise await reject(ApprovalError("hash_mismatch", "Recorded approval doesn't match the token"))

    # Recompute from the bytes we would actually send.
    files: list[EvidenceFile] = []
    for f in draft.files:
        content = await store.read_file(f["storage_path"])
        if hashlib.sha256(content).hexdigest() != f["sha256"]:
            raise await reject(ApprovalError("tampered_payload", f"File {f['filename']} changed after approval"))
        files.append(EvidenceFile(f["filename"], content, f["content_type"]))
    current = payload_hash(draft.paypal_dispute_id, draft.action, draft.payload, draft.files)
    if not hmac.compare_digest(current, claims.payload_hash):
        raise await reject(ApprovalError("tampered_payload", "Payload changed after approval; review and approve again"))

    # Re-fetch: PayPal is the source of truth for what is allowed right now.
    before = await gateway.get_dispute(draft.paypal_merchant_id, draft.paypal_dispute_id)
    facts = parse_dispute(before)
    if facts.status != "WAITING_FOR_SELLER_RESPONSE" and draft.action == "provide_evidence":
        raise await reject(ApprovalError("not_actionable", f"PayPal shows the dispute as {facts.status}"))
    if draft.action not in facts.allowed_actions:
        raise await reject(ApprovalError("action_unavailable", f"PayPal no longer offers '{draft.action}' on this dispute"))

    if not await store.consume_approval(approval.id):
        raise await reject(ApprovalError("used_approval", "This approval was already used"))
    await store.set_draft_status(draft.id, "submitting")
    request_id = f"submit-{approval.id}"
    await store.log(draft, "submit.sent", {"action": draft.action, "request_id": request_id, "payload_hash": current})

    try:
        if draft.action == "provide_evidence":
            resp = await gateway.provide_evidence(
                draft.paypal_merchant_id, draft.paypal_dispute_id, draft.payload, files, request_id=request_id
            )
        elif draft.action == "make_offer":
            resp = await gateway.make_offer(draft.paypal_merchant_id, draft.paypal_dispute_id, draft.payload, request_id=request_id)
        else:
            resp = await gateway.accept_claim(draft.paypal_merchant_id, draft.paypal_dispute_id, draft.payload, request_id=request_id)
    except PayPalError as exc:
        await store.set_draft_status(draft.id, "failed")
        await store.log(draft, "submit.failed", {"status": exc.status, "name": exc.name, "message": exc.message, "debug_id": exc.debug_id})
        raise

    after = await gateway.get_dispute(draft.paypal_merchant_id, draft.paypal_dispute_id)
    await store.save_dispute(draft.merchant_id, after)
    await store.set_draft_status(draft.id, "submitted")
    result = SubmissionResult(facts.status, after.get("status", "UNKNOWN"), resp)
    await store.log(draft, "submit.confirmed", {"status_before": result.status_before, "status_after": result.status_after})
    return result
