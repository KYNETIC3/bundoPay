"""Approve / edit / reject drafts, and the Postgres-backed SubmissionStore."""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID

from app import storage
from app.agent.messages import compose_failed, compose_submitted, money
from app.agent.messages import post as post_message
from app.agent.recommend import RefundPolicy
from app.agent.assemble import (
    NOTE_LIMIT,
    FileValidationError,
    payload_hash,
    sniff_content_type,
    validate_file,
)
from app.audit import audit
from app.config import get_settings
from app.db import connection, jsonb
from app.deps import get_gateway, revocation_guard
from app.disputes.model import REASON_LABELS
from app.disputes.sync import upsert_dispute
from app.events import notify_dispute_changed
from app.paypal_gateway import PayPalError

from .submit import ApprovalRecord, DraftRecord, SubmissionResult, submit_dispute_response
from .tokens import ApprovalError, issue, token_hash


class DraftError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.status = code, status


class PgSubmissionStore:
    async def load_draft(self, draft_id: str) -> DraftRecord | None:
        async with connection() as conn:
            cur = await conn.execute(
                """
                select dr.*, d.merchant_id, d.paypal_dispute_id, m.paypal_merchant_id
                from drafts dr join disputes d on d.id = dr.dispute_id join merchants m on m.id = d.merchant_id
                where dr.id = %s
                """,
                (draft_id,),
            )
            r = await cur.fetchone()
        if not r:
            return None
        return DraftRecord(
            id=str(r["id"]),
            merchant_id=str(r["merchant_id"]),
            dispute_row_id=str(r["dispute_id"]),
            paypal_dispute_id=r["paypal_dispute_id"],
            paypal_merchant_id=r["paypal_merchant_id"],
            action=r["action"],
            payload=r["payload_json"],
            files=r["files"],
            stored_hash=r["payload_hash"],
            status=r["status"],
        )

    async def load_approval(self, token_hash: str) -> ApprovalRecord | None:
        async with connection() as conn:
            cur = await conn.execute("select * from approvals where token_hash = %s", (token_hash,))
            r = await cur.fetchone()
        if not r:
            return None
        return ApprovalRecord(str(r["id"]), str(r["draft_id"]), r["payload_hash"], r["consumed_at"], r["revoked_at"])

    async def consume_approval(self, approval_id: str) -> bool:
        async with connection() as conn:
            cur = await conn.execute(
                "update approvals set consumed_at = now() where id = %s and consumed_at is null and revoked_at is null "
                "returning id",
                (approval_id,),
            )
            return await cur.fetchone() is not None

    async def read_file(self, storage_path: str) -> bytes:
        return await storage.get_object(storage_path)

    async def set_draft_status(self, draft_id: str, status: str) -> None:
        async with connection() as conn:
            cur = await conn.execute(
                "update drafts dr set status = %s, updated_at = now() from disputes d "
                "where dr.id = %s and d.id = dr.dispute_id returning d.id, d.merchant_id",
                (status, draft_id),
            )
            if row := await cur.fetchone():
                await notify_dispute_changed(conn, row["merchant_id"], row["id"])

    async def save_dispute(self, merchant_id: str, raw: dict[str, Any]) -> None:
        async with connection() as conn:
            await upsert_dispute(conn, UUID(merchant_id), raw)

    async def log(self, draft: DraftRecord, event: str, data: dict[str, Any]) -> None:
        async with connection() as conn:
            await audit(conn, event, merchant_id=draft.merchant_id, dispute_id=draft.dispute_row_id, data={"draft_id": draft.id, **data})


async def _owned_draft(conn, merchant_id: UUID, draft_id: UUID) -> dict[str, Any]:
    cur = await conn.execute(
        "select dr.*, d.paypal_dispute_id, d.due_date, d.merchant_id, d.amount from drafts dr join disputes d on d.id = dr.dispute_id "
        "where dr.id = %s and d.merchant_id = %s",
        (draft_id, merchant_id),
    )
    draft = await cur.fetchone()
    if not draft:
        raise DraftError("not_found", "Draft not found", 404)
    return draft


async def _save_revision(conn, draft: dict[str, Any], payload: dict[str, Any], files: list[dict[str, Any]], event: str, data: dict) -> str:
    """Any change re-hashes the draft and invalidates outstanding approvals; the merchant must re-confirm."""
    new_hash = payload_hash(draft["paypal_dispute_id"], draft["action"], payload, files)
    await conn.execute(
        "update drafts set payload_json = %s, files = %s, payload_hash = %s, status = 'awaiting_approval', updated_at = now() "
        "where id = %s",
        (jsonb(payload), jsonb(files), new_hash, draft["id"]),
    )
    await conn.execute(
        "update approvals set revoked_at = now() where draft_id = %s and consumed_at is null and revoked_at is null",
        (draft["id"],),
    )
    await audit(conn, event, merchant_id=draft["merchant_id"], dispute_id=draft["dispute_id"],
                data={"draft_id": str(draft["id"]), "old_hash": draft["payload_hash"], "new_hash": new_hash, **data})
    await notify_dispute_changed(conn, draft["merchant_id"], draft["dispute_id"])
    return new_hash


def _validate_edit(action: str, original: dict[str, Any], edited: dict[str, Any]) -> dict[str, Any]:
    """Merchants may rewrite notes, drop items and set the offer amount. Evidence details (tracking,
    refund IDs) can only be kept or removed, never introduced, so the payload stays tied to real records."""
    if action == "provide_evidence":
        originals = {e["evidence_type"]: e for e in original.get("evidences", [])}
        out = []
        for item in edited.get("evidences", []):
            etype = item.get("evidence_type")
            if etype not in originals:
                raise DraftError("invalid_edit", f"Evidence type {etype} isn't part of this draft")
            note = str(item.get("notes", "")).strip()
            if len(note) >= NOTE_LIMIT:
                raise DraftError("invalid_edit", f"Note for {etype} must be under {NOTE_LIMIT} characters")
            clean = {"evidence_type": etype, "notes": note}
            if item.get("evidence_info"):
                if item["evidence_info"] != originals[etype].get("evidence_info"):
                    raise DraftError("invalid_edit", "Tracking and refund details come from records and can't be edited here")
                clean["evidence_info"] = item["evidence_info"]
            out.append(clean)
        if not out:
            raise DraftError("invalid_edit", "Keep at least one evidence item, or reject the draft")
        return {"evidences": out}

    note = str(edited.get("note", "")).strip()
    if not note or len(note) >= NOTE_LIMIT:
        raise DraftError("invalid_edit", f"Note is required and must be under {NOTE_LIMIT} characters")
    if action == "make_offer":
        value = str((edited.get("offer_amount") or {}).get("value", ""))
        if not re.fullmatch(r"\d+(\.\d{1,2})?", value) or float(value) <= 0:
            raise DraftError("invalid_edit", "Offer amount must be a positive amount")
        return {**original, "note": note, "offer_amount": {**original["offer_amount"], "value": value}}
    return {**original, "note": note}


async def edit_draft(merchant_id: UUID, draft_id: UUID, payload: dict[str, Any]) -> str:
    async with connection() as conn:
        async with conn.transaction():
            draft = await _owned_draft(conn, merchant_id, draft_id)
            if draft["status"] not in ("awaiting_approval", "failed"):
                raise DraftError("not_editable", f"Draft is {draft['status']}", 409)
            clean = _validate_edit(draft["action"], draft["payload_json"], payload)
            return await _save_revision(conn, draft, clean, draft["files"], "draft.edited", {})


async def attach_file(merchant_id: UUID, draft_id: UUID, evidence_type: str, filename: str, content: bytes) -> str:
    content_type = sniff_content_type(content)
    async with connection() as conn:
        draft = await _owned_draft(conn, merchant_id, draft_id)
    if draft["action"] != "provide_evidence" or draft["status"] not in ("awaiting_approval", "failed"):
        raise DraftError("not_editable", "Files can only be attached to an evidence draft awaiting approval", 409)
    try:
        validate_file(filename, content_type or "", len(content), sum(f["size"] for f in draft["files"]))
    except FileValidationError as exc:
        raise DraftError("invalid_file", str(exc)) from exc

    sha = hashlib.sha256(content).hexdigest()
    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", filename)[-120:]
    path = f"{merchant_id}/{draft_id}/{sha[:16]}-{safe_name}"
    await storage.put_object(path, content, content_type)
    entry = {"filename": safe_name, "content_type": content_type, "size": len(content), "sha256": sha,
             "storage_path": path, "evidence_type": evidence_type}
    async with connection() as conn:
        async with conn.transaction():
            draft = await _owned_draft(conn, merchant_id, draft_id)
            files = [f for f in draft["files"] if f["sha256"] != sha] + [entry]
            return await _save_revision(conn, draft, draft["payload_json"], files, "draft.file_attached",
                                        {"filename": safe_name, "sha256": sha})


async def remove_file(merchant_id: UUID, draft_id: UUID, sha256: str) -> str:
    async with connection() as conn:
        async with conn.transaction():
            draft = await _owned_draft(conn, merchant_id, draft_id)
            files = [f for f in draft["files"] if f["sha256"] != sha256]
            return await _save_revision(conn, draft, draft["payload_json"], files, "draft.file_removed", {"sha256": sha256})


async def reject_draft(merchant_id: UUID, draft_id: UUID) -> None:
    async with connection() as conn:
        draft = await _owned_draft(conn, merchant_id, draft_id)
        await conn.execute("update drafts set status = 'rejected', updated_at = now() where id = %s", (draft_id,))
        await conn.execute("update approvals set revoked_at = now() where draft_id = %s and consumed_at is null", (draft_id,))
        await audit(conn, "draft.rejected", merchant_id=merchant_id, dispute_id=draft["dispute_id"], data={"draft_id": str(draft_id)})
        await post_message(
            conn, merchant_id, "Understood. I won't send anything for this dispute. Ask me if you want a different response.",
            kind="declined", dispute_id=draft["dispute_id"], draft_id=draft_id,
        )
        await notify_dispute_changed(conn, merchant_id, draft["dispute_id"])


async def _approve_and_submit(
    merchant_id: UUID,
    draft_id: UUID,
    *,
    source: str,
    payload_hash_seen: str | None,
    acknowledge_past_due: bool,
    allowed_actions: tuple[str, ...] | None = None,
    max_amount: Decimal | None = None,
) -> SubmissionResult:
    settings = get_settings()
    async with connection() as conn:
        async with conn.transaction():
            draft = await _owned_draft(conn, merchant_id, draft_id)
            if draft["status"] not in ("awaiting_approval", "failed"):
                raise DraftError("not_approvable", f"Draft is {draft['status']}", 409)
            if draft["due_date"] and draft["due_date"] < datetime.now(timezone.utc) and not acknowledge_past_due:
                raise DraftError("past_due", "The response deadline has passed. Confirm you want to submit anyway.", 409)
            if allowed_actions is not None and draft["action"] not in allowed_actions:
                raise DraftError("not_covered", f"Your rule doesn't cover '{draft['action']}'", 409)
            if max_amount is not None and (draft["amount"] is None or draft["amount"] > max_amount):
                raise DraftError("not_covered", "The amount is above your automatic refund limit", 409)
            current = payload_hash(draft["paypal_dispute_id"], draft["action"], draft["payload_json"], draft["files"])
            if current != draft["payload_hash"] or (payload_hash_seen is not None and current != payload_hash_seen):
                raise DraftError("stale_view", "This draft changed since you opened it. Review it again before approving.", 409)
            token, claims = issue(
                settings.approval_signing_key,
                draft_id=str(draft_id),
                merchant_id=str(merchant_id),
                payload_hash=current,
                ttl_seconds=settings.approval_token_ttl_seconds,
            )
            await conn.execute(
                "insert into approvals (draft_id, merchant_id, token_hash, payload_hash, expires_at, source) "
                "values (%s, %s, %s, %s, %s, %s)",
                (draft_id, merchant_id, token_hash(token), current, datetime.fromtimestamp(claims.expires_at, timezone.utc), source),
            )
            await conn.execute("update drafts set status = 'approved', updated_at = now() where id = %s", (draft_id,))
            await audit(conn, "draft.approved", merchant_id=merchant_id, dispute_id=draft["dispute_id"],
                        data={"draft_id": str(draft_id), "payload_hash": current, "expires_at": claims.expires_at, "source": source})
            await notify_dispute_changed(conn, merchant_id, draft["dispute_id"])

    store = PgSubmissionStore()
    try:
        async with revocation_guard(merchant_id):
            return await submit_dispute_response(
                str(draft_id), token, store=store, gateway=get_gateway(), signing_key=settings.approval_signing_key
            )
    except ApprovalError:
        # Nothing reached PayPal; let the merchant review and approve again.
        await store.set_draft_status(str(draft_id), "failed")
        raise


async def approve_and_submit(
    merchant_id: UUID, draft_id: UUID, *, payload_hash_seen: str, acknowledge_past_due: bool
) -> SubmissionResult:
    """The merchant's click. Mints a token only if what they saw is exactly what is stored."""
    try:
        result = await _approve_and_submit(
            merchant_id, draft_id, source="merchant", payload_hash_seen=payload_hash_seen, acknowledge_past_due=acknowledge_past_due
        )
    except (ApprovalError, PayPalError) as exc:
        reason = str(exc) if isinstance(exc, ApprovalError) else (exc.message or exc.name)
        await _tell_about_draft(merchant_id, draft_id, "failed", lambda label, _a, _m: compose_failed(label, reason.rstrip(".") + "."))
        raise
    await _tell_about_draft(
        merchant_id, draft_id, "submitted", lambda label, action, amount: compose_submitted(label, action, amount, result.status_after)
    )
    return result


async def _tell_about_draft(merchant_id: UUID, draft_id: UUID, kind: str, compose) -> None:
    async with connection() as conn:
        cur = await conn.execute(
            "select dr.action, d.id as dispute_id, d.reason, d.amount, d.currency from drafts dr "
            "join disputes d on d.id = dr.dispute_id where dr.id = %s",
            (draft_id,),
        )
        r = await cur.fetchone()
        if not r:
            return
        label = f"“{REASON_LABELS.get(r['reason'] or '', r['reason'] or 'dispute')}”"
        content = compose(label, r["action"], money(r["amount"], r["currency"]))
        await post_message(conn, merchant_id, content, kind=kind, dispute_id=r["dispute_id"], draft_id=draft_id)


async def approve_by_policy(merchant_id: UUID, draft_id: UUID, policy: RefundPolicy) -> SubmissionResult:
    """The merchant's standing auto-refund rule approves a full refund within their limit. Re-checks the
    rule against the stored draft, never past the deadline, and uses the same token/hash-checked submit."""
    if not policy.enabled:
        raise DraftError("not_covered", "Automatic refunds are off", 409)
    return await _approve_and_submit(
        merchant_id,
        draft_id,
        source="policy",
        payload_hash_seen=None,
        acknowledge_past_due=False,
        allowed_actions=("accept_claim",),
        max_amount=policy.limit,
    )
