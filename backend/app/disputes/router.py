from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app.adapters.csv_adapter import CsvValidationError, import_csv
from app.agent.orchestrator import run_agent
from app.approvals import service as approvals
from app.approvals.tokens import ApprovalError
from app.audit import audit
from app.auth import CurrentMerchant, current_merchant
from app.db import connection
from app.paypal_gateway import PayPalError

from .model import REASON_LABELS, parse_dispute
from .sync import sync_merchant

router = APIRouter()

TIMELINE_EVENTS = (
    "dispute.status_changed", "dispute.new_work_item", "agent.evidence_map", "agent.recommendation",
    "agent.draft_ready", "agent.no_draft", "agent.past_due_blocked", "draft.edited", "draft.file_attached",
    "draft.file_removed", "draft.approved", "draft.rejected", "submit.sent", "submit.confirmed", "submit.failed",
    "submit.rejected", "dispute.outcome_recorded",
)


def _summary(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "paypal_dispute_id": row["paypal_dispute_id"],
        "status": row["status"],
        "reason": row["reason"],
        "reason_label": REASON_LABELS.get(row["reason"] or "", row["reason"]),
        "lifecycle_stage": row["lifecycle_stage"],
        "amount": str(row["amount"]) if row["amount"] is not None else None,
        "currency": row["currency"],
        "due_date": row["due_date"],
        "opened_at": (row["raw_json"] or {}).get("create_time"),
        "updated_at": row["updated_at"],
    }


async def _owned_dispute(conn, merchant_id: UUID, dispute_id: UUID) -> dict[str, Any]:
    cur = await conn.execute("select * from disputes where id = %s and merchant_id = %s", (dispute_id, merchant_id))
    row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Dispute not found")
    return row


@router.get("/disputes")
async def inbox(merchant: CurrentMerchant = Depends(current_merchant)) -> list[dict[str, Any]]:
    async with connection() as conn:
        cur = await conn.execute(
            """
            select d.*, dr.id as draft_id, dr.action as draft_action, dr.status as draft_status
            from disputes d
            left join lateral (select id, action, status from drafts where dispute_id = d.id
                               order by created_at desc limit 1) dr on true
            where d.merchant_id = %s
            order by (d.status = 'RESOLVED'), d.due_date asc nulls last, d.updated_at desc
            """,
            (merchant.id,),
        )
        return [
            {**_summary(r), "draft_id": r["draft_id"], "draft_action": r["draft_action"], "draft_status": r["draft_status"]}
            for r in await cur.fetchall()
        ]


@router.post("/disputes/sync")
async def sync_now(merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, int]:
    return {"synced": await sync_merchant(merchant.id)}


@router.get("/disputes/{dispute_id}")
async def detail(dispute_id: UUID, merchant: CurrentMerchant = Depends(current_merchant)) -> dict[str, Any]:
    async with connection() as conn:
        row = await _owned_dispute(conn, merchant.id, dispute_id)
        cur = await conn.execute(
            "select * from evidence_maps where dispute_id = %s order by created_at desc limit 1", (dispute_id,)
        )
        emap = await cur.fetchone()
        cur = await conn.execute(
            "select id, action, payload_json, files, missing_items, payload_hash, status, created_at, updated_at "
            "from drafts where dispute_id = %s order by created_at desc limit 1",
            (dispute_id,),
        )
        draft = await cur.fetchone()
        cur = await conn.execute(
            "select event, data_json, created_at from audit_log where dispute_id = %s and event = any(%s) order by created_at",
            (dispute_id, list(TIMELINE_EVENTS)),
        )
        events = await cur.fetchall()
        cur = await conn.execute("select * from outcomes where dispute_id = %s", (dispute_id,))
        outcome = await cur.fetchone()

    facts = parse_dispute(row["raw_json"])
    raw = row["raw_json"]
    paypal_timeline = [{"at": raw.get("create_time"), "label": "Dispute opened on PayPal"}]
    for m in raw.get("messages") or []:
        paypal_timeline.append({"at": m.get("time_posted"), "label": f"Message from {str(m.get('posted_by', '')).lower()}"})
    for e in raw.get("evidences") or []:
        label = "PayPal requested " if e.get("source") == "REQUESTED_FROM_SELLER" else "Evidence: "
        paypal_timeline.append({"at": e.get("date"), "label": label + str(e.get("evidence_type", "")).replace("_", " ").lower()})
    if facts.due_date:
        paypal_timeline.append({"at": facts.due_date.isoformat(), "label": "Seller response due", "kind": "deadline"})
    paypal_timeline = sorted((t for t in paypal_timeline if t["at"]), key=lambda t: t["at"])

    return {
        **_summary(row),
        "past_due": facts.is_past_due(),
        "allowed_actions": facts.allowed_actions,
        "requested_evidences": facts.requested_evidences,
        "disputed_transactions": facts.disputed_transactions,
        "outcome_code": facts.outcome_code,
        "paypal_timeline": paypal_timeline,
        "activity": events,
        "evidence_map": emap,
        "draft": draft,
        "outcome": outcome,
    }


class RunAgentBody(BaseModel):
    acknowledge_past_due: bool = False


@router.post("/disputes/{dispute_id}/analyze")
async def analyze(dispute_id: UUID, body: RunAgentBody, merchant: CurrentMerchant = Depends(current_merchant)) -> dict:
    async with connection() as conn:
        await _owned_dispute(conn, merchant.id, dispute_id)
        if body.acknowledge_past_due:
            await audit(conn, "merchant.acknowledged_past_due", merchant_id=merchant.id, dispute_id=dispute_id)
    return await run_agent(dispute_id, acknowledge_past_due=body.acknowledge_past_due)


# ------------------------------------------------------------------ drafts


class ApproveBody(BaseModel):
    payload_hash: str
    acknowledge_past_due: bool = False


class EditBody(BaseModel):
    payload: dict[str, Any]


def _draft_error(exc: approvals.DraftError) -> HTTPException:
    return HTTPException(exc.status, {"code": exc.code, "message": str(exc)})


@router.post("/drafts/{draft_id}/approve")
async def approve(draft_id: UUID, body: ApproveBody, merchant: CurrentMerchant = Depends(current_merchant)) -> dict:
    try:
        result = await approvals.approve_and_submit(
            merchant.id, draft_id, payload_hash_seen=body.payload_hash, acknowledge_past_due=body.acknowledge_past_due
        )
    except approvals.DraftError as exc:
        raise _draft_error(exc) from exc
    except ApprovalError as exc:
        raise HTTPException(409, {"code": exc.code, "message": str(exc)}) from exc
    except PayPalError as exc:
        raise HTTPException(502, {"code": "paypal_error", "message": exc.message or exc.name, "debug_id": exc.debug_id}) from exc
    return {"status_before": result.status_before, "status_after": result.status_after, "confirmed_at": datetime.now(timezone.utc)}


@router.put("/drafts/{draft_id}")
async def edit(draft_id: UUID, body: EditBody, merchant: CurrentMerchant = Depends(current_merchant)) -> dict:
    try:
        return {"payload_hash": await approvals.edit_draft(merchant.id, draft_id, body.payload)}
    except approvals.DraftError as exc:
        raise _draft_error(exc) from exc


@router.post("/drafts/{draft_id}/files")
async def attach(
    draft_id: UUID,
    evidence_type: str = Form(...),
    file: UploadFile = File(...),
    merchant: CurrentMerchant = Depends(current_merchant),
) -> dict:
    content = await file.read(10 * 1024 * 1024 + 1)
    try:
        return {"payload_hash": await approvals.attach_file(merchant.id, draft_id, evidence_type, file.filename or "file", content)}
    except approvals.DraftError as exc:
        raise _draft_error(exc) from exc


@router.delete("/drafts/{draft_id}/files/{sha256}")
async def detach(draft_id: UUID, sha256: str, merchant: CurrentMerchant = Depends(current_merchant)) -> dict:
    try:
        return {"payload_hash": await approvals.remove_file(merchant.id, draft_id, sha256)}
    except approvals.DraftError as exc:
        raise _draft_error(exc) from exc


@router.post("/drafts/{draft_id}/reject")
async def reject(draft_id: UUID, merchant: CurrentMerchant = Depends(current_merchant)) -> dict:
    try:
        await approvals.reject_draft(merchant.id, draft_id)
    except approvals.DraftError as exc:
        raise _draft_error(exc) from exc
    return {"status": "rejected"}


# --------------------------------------------------------- merchant data


@router.post("/data/csv")
async def upload_csv(
    kind: str = Form(...), file: UploadFile = File(...), merchant: CurrentMerchant = Depends(current_merchant)
) -> dict:
    raw = await file.read(20 * 1024 * 1024 + 1)
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(413, "CSV must be 20 MB or smaller")
    try:
        count = await import_csv(merchant.id, kind, raw.decode("utf-8-sig"))
    except (CsvValidationError, UnicodeDecodeError) as exc:
        raise HTTPException(400, str(exc)) from exc
    async with connection() as conn:
        await audit(conn, "data.csv_imported", merchant_id=merchant.id, data={"kind": kind, "rows": count})
    return {"kind": kind, "rows": count}


@router.get("/data/summary")
async def data_summary(merchant: CurrentMerchant = Depends(current_merchant)) -> list[dict]:
    async with connection() as conn:
        cur = await conn.execute(
            "select kind, count(*) as rows, max(imported_at) as last_import from merchant_records "
            "where merchant_id = %s group by kind",
            (merchant.id,),
        )
        return await cur.fetchall()
