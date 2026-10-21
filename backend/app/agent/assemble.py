"""Assemble the exact PayPal request for a draft and hash it. The hash is what an approval binds to."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from app.disputes.model import DisputeFacts

from .evidence import EvidenceMap
from .recommend import Recommendation

NOTE_LIMIT = 500
# PayPal provide-evidence limits.
ALLOWED_CONTENT_TYPES = {"application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif"}
ALLOWED_EXTENSIONS = {".pdf", ".jpg", ".jpeg", ".png", ".gif"}
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_BYTES = 50 * 1024 * 1024


class FileValidationError(ValueError):
    pass


def validate_file(filename: str, content_type: str, size: int, existing_total: int) -> None:
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if content_type not in ALLOWED_CONTENT_TYPES or ext not in ALLOWED_EXTENSIONS:
        raise FileValidationError("PayPal accepts PDF, JPG, PNG or GIF files only.")
    if size > MAX_FILE_BYTES:
        raise FileValidationError("Each file must be 10 MB or smaller.")
    if existing_total + size > MAX_TOTAL_BYTES:
        raise FileValidationError("All files together must be 50 MB or smaller.")


def sniff_content_type(content: bytes) -> str | None:
    if content.startswith(b"%PDF"):
        return "application/pdf"
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


def canonical_payload(dispute_id: str, action: str, payload: dict[str, Any], files: list[dict[str, Any]]) -> bytes:
    file_set = sorted(
        ({k: f[k] for k in ("filename", "content_type", "size", "sha256", "evidence_type") if k in f} for f in files),
        key=lambda f: (f["sha256"], f["filename"]),
    )
    doc = {"dispute_id": dispute_id, "action": action, "payload": payload, "files": file_set}
    return json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def payload_hash(dispute_id: str, action: str, payload: dict[str, Any], files: list[dict[str, Any]]) -> str:
    return hashlib.sha256(canonical_payload(dispute_id, action, payload, files)).hexdigest()


def factual_note(row: dict[str, Any]) -> str:
    """Plain statement of what the record is. No argument, no adjectives."""
    if not row.get("satisfying_record"):
        return ""
    return f"{row['satisfying_record']}. Source: {row['source_system']}."[:NOTE_LIMIT - 1]


def clean_note(note: str | None, fallback: str) -> str:
    note = (note or "").strip()
    return note if 0 < len(note) < NOTE_LIMIT else fallback


@dataclass
class DraftSpec:
    action: str
    payload: dict[str, Any]
    missing_items: list[dict[str, Any]]


def assemble(facts: DisputeFacts, emap: EvidenceMap, rec: Recommendation) -> DraftSpec | None:
    if rec.action is None:
        return None
    rows = [r for r in emap.to_json()["rows"]]
    missing = [
        {"evidence_type": r["requested_evidence_type"], "detail": r["gap_or_conflict"] or "Not found"}
        for r in rows
        if not r["satisfying_record"] or r["gap_or_conflict"]
    ]
    missing += [{"evidence_type": None, "detail": f["detail"]} for f in emap.to_json()["flags"] if f["severity"] == "high"]

    if rec.action == "provide_evidence":
        evidences = []
        for r in rows:
            if not r["satisfying_record"]:
                continue  # never submit a placeholder for something we don't have
            item: dict[str, Any] = {
                "evidence_type": r["requested_evidence_type"],
                "notes": clean_note(rec.notes.get(r["requested_evidence_type"]), factual_note(r)),
            }
            if r["evidence_info"]:
                item["evidence_info"] = r["evidence_info"]
            evidences.append(item)
        return DraftSpec("provide_evidence", {"evidences": evidences}, missing)

    summary = clean_note(rec.notes.get("_summary"), "Resolving this dispute per the merchant's decision.")
    if rec.action == "make_offer":
        return DraftSpec(
            "make_offer",
            {
                "note": summary,
                "offer_amount": {"currency_code": facts.currency, "value": rec.offer_amount or str(facts.amount)},
                "offer_type": "REFUND",
            },
            missing,
        )
    return DraftSpec("accept_claim", {"note": summary, "accept_claim_type": "REFUND"}, missing)
