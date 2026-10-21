"""Evidence map + integrity checks.

PayPal data is consulted first, then merchant adapters. The map only *points at* records that exist;
it never creates, alters, back-dates or infers evidence. Gaps and conflicts are flagged, not resolved.
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from app.disputes.model import DisputeFacts, parse_dt

from .tools import ToolBox

log = logging.getLogger(__name__)

SHIPPING_TYPES = {
    "PROOF_OF_FULFILLMENT", "PROOF_OF_SHIPMENT_POSTAGE", "ONLINE_TRACKING_INFORMATION",
    "ADDITIONAL_TRACKING_INFORMATION", "ADDITIONAL_PROOF_OF_SHIPMENT", "PROOF_OF_DELIVERY_SIGNATURE",
    "DELIVERY_RECEIPT", "PROOF_OF_RESHIPMENT", "COPY_OF_SHIPPING_MANIFEST", "COPY_OF_THE_EPARCEL_MANIFEST",
}
REFUND_TYPES = {"PROOF_OF_REFUND", "PROOF_OF_REFUND_OUTSIDE_PAYPAL", "PROOF_OF_INSTORE_REFUND"}
PURCHASE_TYPES = {
    "PROOF_OF_RECEIPT_COPY", "DETAILS_OF_PURCHASE", "ITEM_DESCRIPTION", "ADDITIONAL_INFORMATION_OF_ITEM",
    "BILLING_AGREEMENT", "COPY_OF_CONTRACT", "PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED",
}
COMMUNICATION_TYPES = {"MERCHANT_RESPONSE", "INFORMATION_ON_RESOLUTION", "CONFIRMATION_OF_RESOLUTION", "OTHER"}

# When PayPal hasn't listed specific requests, these are what a seller response for the reason
# normally contains. They are marked as such in the map.
DEFAULT_REQUESTS = {
    "MERCHANDISE_OR_SERVICE_NOT_RECEIVED": ["PROOF_OF_FULFILLMENT"],
    "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED": ["ITEM_DESCRIPTION", "MERCHANT_RESPONSE"],
    "UNAUTHORISED": ["PROOF_OF_FULFILLMENT", "DETAILS_OF_PURCHASE"],
    "CREDIT_NOT_PROCESSED": ["PROOF_OF_REFUND"],
    "DUPLICATE_TRANSACTION": ["DETAILS_OF_PURCHASE"],
    "INCORRECT_AMOUNT": ["DETAILS_OF_PURCHASE"],
    "CANCELED_RECURRING_BILLING": ["BILLING_AGREEMENT"],
}

DELIVERED_STATUSES = {"DELIVERED"}
AMOUNT_TOLERANCE = Decimal("0.01")
DATE_TOLERANCE = timedelta(days=2)


@dataclass
class Context:
    """Everything gathered for one dispute, PayPal first."""

    transaction_id: str | None
    transaction: dict[str, Any] | None = None
    trackers: list[dict[str, Any]] = field(default_factory=list)
    paypal_refunds: list[dict[str, Any]] = field(default_factory=list)
    order: dict[str, Any] | None = None
    shipments: list[dict[str, Any]] = field(default_factory=list)
    merchant_refunds: list[dict[str, Any]] = field(default_factory=list)
    tickets: list[dict[str, Any]] = field(default_factory=list)
    lookup_errors: list[str] = field(default_factory=list)


@dataclass
class EvidenceRow:
    requested_evidence_type: str
    satisfying_record: str | None
    source_system: str | None
    match_confidence: float
    gap_or_conflict: str | None
    requested_by: str = "PAYPAL"  # PAYPAL or REASON_DEFAULT
    record_refs: list[dict[str, Any]] = field(default_factory=list)
    evidence_info: dict[str, Any] = field(default_factory=dict)


@dataclass
class IntegrityFlag:
    kind: str
    detail: str
    severity: str  # "high" blocks a confident provide-evidence recommendation


@dataclass
class EvidenceMap:
    rows: list[EvidenceRow]
    flags: list[IntegrityFlag]
    coverage_score: float

    def to_json(self) -> dict[str, Any]:
        return {
            "rows": [asdict(r) for r in self.rows],
            "flags": [asdict(f) for f in self.flags],
            "coverage_score": self.coverage_score,
        }


# ------------------------------------------------------------------ gathering


async def gather(facts: DisputeFacts, tools: ToolBox) -> Context:
    txn_ref = facts.disputed_transactions[0] if facts.disputed_transactions else {}
    txn_id = txn_ref.get("seller_transaction_id")
    ctx = Context(transaction_id=txn_id)
    if not txn_id:
        ctx.lookup_errors.append("PayPal lists no seller transaction for this dispute")
        return ctx
    around = txn_ref.get("create_time") or (facts.create_time.isoformat() if facts.create_time else None)

    async def attempt(label: str, coro):
        try:
            return await coro
        except Exception as exc:
            ctx.lookup_errors.append(f"{label}: {exc}")
            return None

    found = await attempt("Transaction Search", tools.call("search_transactions", {"transaction_id": txn_id, "around_date": around}))
    ctx.transaction = found[0] if found else None
    ctx.trackers = await attempt("PayPal tracking", tools.call("get_tracking", {"transaction_id": txn_id})) or []
    ctx.paypal_refunds = await attempt("PayPal refunds", tools.call("get_refunds", {"transaction_id": txn_id, "around_date": around})) or []

    invoice_id = txn_ref.get("invoice_number") or ((ctx.transaction or {}).get("transaction_info") or {}).get("invoice_id")
    ctx.order = await attempt("Merchant orders", tools.call("find_order", {"paypal_transaction_id": txn_id, "invoice_id": invoice_id}))
    if ctx.order:
        order_id = ctx.order["key"]
        ctx.shipments = await attempt("Merchant shipments", tools.call("find_shipment", {"order_id": order_id})) or []
        ctx.merchant_refunds = await attempt("Merchant refunds", tools.call("find_refund", {"order_id": order_id})) or []
        ctx.tickets = await attempt("Support tickets", tools.call("find_support_tickets", {"order_id": order_id})) or []
    return ctx


# ------------------------------------------------------------------- building


def _dec(value: Any) -> Decimal | None:
    try:
        return Decimal(str(value)) if value not in (None, "") else None
    except InvalidOperation:
        return None


def _postal(value: str | None) -> str:
    return (value or "").replace(" ", "").replace("-", "").upper()


def _paypal_refund_ids(ctx: Context) -> list[str]:
    return [r["transaction_info"]["transaction_id"] for r in ctx.paypal_refunds if r.get("transaction_info", {}).get("transaction_id")]


def integrity_checks(facts: DisputeFacts, ctx: Context) -> list[IntegrityFlag]:
    flags: list[IntegrityFlag] = []
    info = (ctx.transaction or {}).get("transaction_info", {})
    order = (ctx.order or {}).get("data", {})

    if ctx.transaction is None:
        flags.append(IntegrityFlag("missing_record", "The disputed transaction wasn't found in PayPal Transaction Search.", "medium"))
    if ctx.order is None:
        flags.append(IntegrityFlag("missing_record", "No merchant order record matches this PayPal transaction.", "medium"))

    if info and order:
        pp_amt = _dec((info.get("transaction_amount") or {}).get("value"))
        pp_cur = (info.get("transaction_amount") or {}).get("currency_code")
        m_amt = _dec(order.get("total"))
        if pp_amt is not None and m_amt is not None and (abs(abs(pp_amt) - m_amt) > AMOUNT_TOLERANCE or (pp_cur and pp_cur != order.get("currency"))):
            flags.append(IntegrityFlag(
                "amount_mismatch",
                f"PayPal shows {pp_cur} {abs(pp_amt)}; merchant order {order.get('order_id')} shows {order.get('currency')} {m_amt}.",
                "high",
            ))
        pp_date, m_date = parse_dt(info.get("transaction_initiation_date")), parse_dt(order.get("order_date"))
        if pp_date and m_date:
            if m_date.tzinfo is None:
                m_date = m_date.replace(tzinfo=pp_date.tzinfo)
            if abs(pp_date - m_date) > DATE_TOLERANCE:
                flags.append(IntegrityFlag(
                    "date_mismatch",
                    f"PayPal transaction date {pp_date.date()} differs from merchant order date {m_date.date()}.",
                    "medium",
                ))

    # Tracking: non-delivery and tracking numbers that disagree between PayPal and merchant records.
    pp_numbers = {t.get("tracking_number") for t in ctx.trackers if t.get("tracking_number")}
    m_numbers = {s["data"].get("tracking_number") for s in ctx.shipments}
    if pp_numbers and m_numbers and not pp_numbers & m_numbers:
        flags.append(IntegrityFlag(
            "tracking_mismatch",
            f"Tracking registered with PayPal ({', '.join(sorted(pp_numbers))}) doesn't match merchant shipments ({', '.join(sorted(m_numbers))}).",
            "high",
        ))
    statuses = [str(t.get("status", "")).upper() for t in ctx.trackers] + [str(s["data"].get("status", "")).upper() for s in ctx.shipments if s["data"].get("status")]
    if (ctx.trackers or ctx.shipments) and not any(s in DELIVERED_STATUSES for s in statuses) and not any(s["data"].get("delivered_at") for s in ctx.shipments):
        flags.append(IntegrityFlag("non_delivery", "No tracking record shows the package as delivered.", "high"))

    pp_addr = ((ctx.transaction or {}).get("shipping_info") or {}).get("address") or {}
    for label, rec in [("order", order)] + [("shipment " + s["key"], s["data"]) for s in ctx.shipments]:
        if pp_addr.get("postal_code") and rec.get("ship_to_postal_code") and _postal(pp_addr["postal_code"]) != _postal(rec["ship_to_postal_code"]):
            flags.append(IntegrityFlag(
                "address_mismatch",
                f"Merchant {label} ships to postal code {rec['ship_to_postal_code']}; PayPal shipping address has {pp_addr['postal_code']}.",
                "high",
            ))

    pp_refunds = set(_paypal_refund_ids(ctx))
    for r in ctx.merchant_refunds:
        ppid = r["data"].get("paypal_refund_id")
        if not ppid or ppid not in pp_refunds:
            flags.append(IntegrityFlag(
                "refund_absent_in_paypal",
                f"Merchant records refund {r['key']} ({r['data'].get('currency')} {r['data'].get('amount')}) but PayPal has no matching refund on this capture.",
                "high",
            ))
    return flags


def _carrier(name: str) -> dict[str, str]:
    known = {"UPS", "USPS", "FEDEX", "DHL", "DHL_API", "ROYAL_MAIL", "CANADA_POST", "AUSTRALIA_POST", "LASERSHIP", "ONTRAC"}
    upper = (name or "").strip().upper().replace(" ", "_")
    return {"carrier_name": upper} if upper in known else {"carrier_name": "OTHER", "carrier_name_other": name}


def _shipping_row(etype: str, ctx: Context, flags: list[IntegrityFlag]) -> EvidenceRow:
    conflicts = [f.detail for f in flags if f.kind in ("tracking_mismatch", "non_delivery", "address_mismatch")]
    if ctx.trackers:
        t = ctx.trackers[0]
        delivered = str(t.get("status", "")).upper() in DELIVERED_STATUSES
        return EvidenceRow(
            etype,
            f"Tracking {t.get('tracking_number')} ({t.get('carrier')}), status {t.get('status')}",
            "paypal",
            0.95 if delivered and not conflicts else 0.55 if not conflicts else 0.3,
            "; ".join(conflicts) or None,
            record_refs=[{"system": "paypal", "kind": "tracker", "id": t.get("tracking_number")}],
            evidence_info={"tracking_info": [{**_carrier(t.get("carrier", "")), "tracking_number": t.get("tracking_number")}]},
        )
    if ctx.shipments:
        s = ctx.shipments[0]["data"]
        delivered = str(s.get("status", "")).upper() in DELIVERED_STATUSES or bool(s.get("delivered_at"))
        gap = "Tracking isn't registered with PayPal; only the merchant's shipment record has it."
        return EvidenceRow(
            etype,
            f"Shipment {s.get('tracking_number')} via {s.get('carrier')}" + (f", delivered {s.get('delivered_at')}" if s.get("delivered_at") else ""),
            ctx.shipments[0]["source_system"],
            0.75 if delivered and not conflicts else 0.45 if not conflicts else 0.25,
            "; ".join([gap, *conflicts]),
            record_refs=[{"system": ctx.shipments[0]["source_system"], "kind": "shipment", "id": s.get("tracking_number")}],
            evidence_info={"tracking_info": [{**_carrier(s.get("carrier", "")), "tracking_number": s.get("tracking_number")}]},
        )
    return EvidenceRow(etype, None, None, 0.0, "No tracking in PayPal or merchant records.")


def _refund_row(etype: str, ctx: Context, flags: list[IntegrityFlag]) -> EvidenceRow:
    ids = _paypal_refund_ids(ctx)
    absent = [f.detail for f in flags if f.kind == "refund_absent_in_paypal"]
    if ids:
        return EvidenceRow(
            etype, f"PayPal refund(s) {', '.join(ids)}", "paypal", 0.95 if not absent else 0.6, "; ".join(absent) or None,
            record_refs=[{"system": "paypal", "kind": "refund", "id": i} for i in ids],
            evidence_info={"refund_ids": ids},
        )
    if ctx.merchant_refunds:
        return EvidenceRow(
            etype,
            f"Merchant refund record {ctx.merchant_refunds[0]['key']}",
            ctx.merchant_refunds[0]["source_system"],
            0.2,
            "; ".join(absent) or "Refund exists only in merchant records.",
            record_refs=[{"system": r["source_system"], "kind": "refund", "id": r["key"]} for r in ctx.merchant_refunds],
        )
    return EvidenceRow(etype, None, None, 0.0, "No refund found in PayPal or merchant records.")


def _purchase_row(etype: str, ctx: Context, flags: list[IntegrityFlag]) -> EvidenceRow:
    conflicts = [f.detail for f in flags if f.kind in ("amount_mismatch", "date_mismatch")]
    refs, parts = [], []
    if ctx.transaction:
        tid = ctx.transaction["transaction_info"].get("transaction_id")
        refs.append({"system": "paypal", "kind": "transaction", "id": tid})
        parts.append(f"PayPal transaction {tid}")
    if ctx.order:
        refs.append({"system": ctx.order["source_system"], "kind": "order", "id": ctx.order["key"]})
        parts.append(f"merchant order {ctx.order['key']}")
    if not refs:
        return EvidenceRow(etype, None, None, 0.0, "No transaction or order record found.")
    confidence = 0.9 if len(refs) == 2 else 0.6
    gap = None if etype not in ("ITEM_DESCRIPTION", "ADDITIONAL_INFORMATION_OF_ITEM", "COPY_OF_CONTRACT", "BILLING_AGREEMENT") else (
        "A document (listing, contract or agreement) needs to be attached."
    )
    if conflicts:
        confidence = 0.3
    return EvidenceRow(
        etype, " + ".join(parts), refs[0]["system"] if len(refs) == 1 else "paypal+" + refs[1]["system"],
        confidence if not gap else min(confidence, 0.4), "; ".join([g for g in [gap, *conflicts] if g]) or None,
        record_refs=refs,
    )


def _communication_row(etype: str, ctx: Context) -> EvidenceRow:
    if ctx.tickets:
        return EvidenceRow(
            etype,
            f"{len(ctx.tickets)} support ticket(s): " + ", ".join(t["key"] for t in ctx.tickets),
            ctx.tickets[0]["source_system"],
            0.6,
            None,
            record_refs=[{"system": t["source_system"], "kind": "ticket", "id": t["key"]} for t in ctx.tickets],
        )
    return EvidenceRow(etype, None, None, 0.0, "No support conversation found for this order.")


def build_evidence_map(facts: DisputeFacts, ctx: Context) -> EvidenceMap:
    flags = integrity_checks(facts, ctx)
    requested = [(e.get("evidence_type") or "OTHER", "PAYPAL") for e in facts.requested_evidences]
    if not requested:
        requested = [(t, "REASON_DEFAULT") for t in DEFAULT_REQUESTS.get(facts.reason or "", ["OTHER"])]

    rows: list[EvidenceRow] = []
    for etype, requested_by in requested:
        if etype in SHIPPING_TYPES:
            row = _shipping_row(etype, ctx, flags)
        elif etype in REFUND_TYPES:
            row = _refund_row(etype, ctx, flags)
        elif etype in PURCHASE_TYPES:
            row = _purchase_row(etype, ctx, flags)
        elif etype in COMMUNICATION_TYPES:
            row = _communication_row(etype, ctx)
        else:
            row = EvidenceRow(etype, None, None, 0.0, "Needs a document from you; no connected source holds this type.")
        row.requested_by = requested_by
        rows.append(row)

    for err in ctx.lookup_errors:
        flags.append(IntegrityFlag("lookup_failed", err, "medium"))

    def effective(r: EvidenceRow) -> float:
        return r.match_confidence * (0.5 if r.gap_or_conflict and r.satisfying_record else 1.0)

    coverage = round(sum(effective(r) for r in rows) / len(rows), 3) if rows else 0.0
    return EvidenceMap(rows=rows, flags=flags, coverage_score=coverage)
