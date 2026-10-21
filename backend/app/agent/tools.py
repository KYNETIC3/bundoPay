"""Agent tool registry. Every read-only tool goes through paypal_gateway or a merchant adapter and is
audited. There is exactly one write tool, submit_dispute_response, and it lives in app.approvals.submit
where it demands a valid approval token; it is never offered to the model."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from typing import Any

from app.adapters.base import MerchantDataAdapter, OrderRef
from app.paypal_gateway import PayPalGateway

from app.disputes.model import parse_dt

AuditFn = Callable[[str, dict[str, Any], dict[str, Any]], Awaitable[None]]

READ_ONLY_TOOLS = (
    "get_dispute",
    "search_transactions",
    "get_tracking",
    "get_refunds",
    "find_order",
    "find_shipment",
    "find_refund",
    "find_support_tickets",
)
WRITE_TOOLS = ("submit_dispute_response",)

SEARCH_WINDOW = timedelta(days=31)  # PayPal Transaction Search maximum range

TOOL_SPECS: list[dict[str, Any]] = [
    {
        "name": "get_dispute",
        "description": "Re-fetch the dispute from PayPal. PayPal data overrides anything remembered.",
        "parameters": {"type": "OBJECT", "properties": {}, "required": []},
    },
    {
        "name": "search_transactions",
        "description": "PayPal Transaction Search for one transaction ID around a date.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "transaction_id": {"type": "STRING"},
                "around_date": {"type": "STRING", "description": "ISO-8601 date near the transaction"},
            },
            "required": ["transaction_id"],
        },
    },
    {
        "name": "get_tracking",
        "description": "Shipment tracking registered with PayPal for a transaction.",
        "parameters": {"type": "OBJECT", "properties": {"transaction_id": {"type": "STRING"}}, "required": ["transaction_id"]},
    },
    {
        "name": "get_refunds",
        "description": "Refunds recorded in PayPal against a capture/transaction ID.",
        "parameters": {
            "type": "OBJECT",
            "properties": {"transaction_id": {"type": "STRING"}, "around_date": {"type": "STRING"}},
            "required": ["transaction_id"],
        },
    },
    {
        "name": "find_order",
        "description": "Look up the merchant's own order record by PayPal transaction ID or invoice ID.",
        "parameters": {
            "type": "OBJECT",
            "properties": {"paypal_transaction_id": {"type": "STRING"}, "invoice_id": {"type": "STRING"}},
            "required": [],
        },
    },
    {
        "name": "find_shipment",
        "description": "Merchant shipment records for an order ID.",
        "parameters": {"type": "OBJECT", "properties": {"order_id": {"type": "STRING"}}, "required": ["order_id"]},
    },
    {
        "name": "find_refund",
        "description": "Merchant refund records for an order ID.",
        "parameters": {"type": "OBJECT", "properties": {"order_id": {"type": "STRING"}}, "required": ["order_id"]},
    },
    {
        "name": "find_support_tickets",
        "description": "Merchant support tickets for an order ID.",
        "parameters": {"type": "OBJECT", "properties": {"order_id": {"type": "STRING"}}, "required": ["order_id"]},
    },
]


def _jsonable(value: Any) -> Any:
    return json.loads(json.dumps(value, default=str))


class ToolBox:
    def __init__(
        self,
        gateway: PayPalGateway,
        paypal_merchant_id: str,
        dispute_id: str,
        adapters: list[MerchantDataAdapter],
        audit: AuditFn,
    ):
        self.gw = gateway
        self.merchant = paypal_merchant_id
        self.dispute_id = dispute_id
        self.adapters = adapters
        self._audit = audit

    async def call(self, name: str, args: dict[str, Any]) -> Any:
        if name not in READ_ONLY_TOOLS:
            await self._audit(name, args, {"rejected": "not a read-only tool"})
            raise PermissionError(f"Tool '{name}' is not available to the agent")
        try:
            result = _jsonable(await getattr(self, name)(**args))
        except Exception as exc:  # surfaced to the model as data; never silently swallowed in the log
            await self._audit(name, args, {"error": f"{type(exc).__name__}: {exc}"})
            raise
        await self._audit(name, args, {"ok": True, "size": len(json.dumps(result))})
        return result

    # PayPal ---------------------------------------------------------------

    async def get_dispute(self) -> dict[str, Any]:
        return await self.gw.get_dispute(self.merchant, self.dispute_id)

    async def search_transactions(self, transaction_id: str, around_date: str | None = None) -> list[dict[str, Any]]:
        center = parse_dt(around_date) if around_date else datetime.now(timezone.utc)
        start = center - timedelta(days=15)
        end = min(start + SEARCH_WINDOW - timedelta(seconds=1), datetime.now(timezone.utc))
        return await self.gw.search_transactions(self.merchant, start=start, end=end, transaction_id=transaction_id)

    async def get_tracking(self, transaction_id: str) -> list[dict[str, Any]]:
        return await self.gw.get_trackers(self.merchant, transaction_id)

    async def get_refunds(self, transaction_id: str, around_date: str | None = None) -> list[dict[str, Any]]:
        """Refund events (T11xx) whose paypal_reference_id is the disputed capture, from the transaction
        date up to today in 31-day windows."""
        start = parse_dt(around_date) if around_date else datetime.now(timezone.utc) - timedelta(days=180)
        now = datetime.now(timezone.utc)
        refunds: list[dict[str, Any]] = []
        windows = 0
        while start < now and windows < 12:
            end = min(start + SEARCH_WINDOW - timedelta(seconds=1), now)
            for txn in await self.gw.search_transactions(self.merchant, start=start, end=end):
                info = txn.get("transaction_info", {})
                if info.get("paypal_reference_id") == transaction_id and str(info.get("transaction_event_code", "")).startswith("T11"):
                    refunds.append(txn)
            start, windows = end, windows + 1
        return refunds

    # Merchant adapters -----------------------------------------------------

    async def find_order(self, paypal_transaction_id: str | None = None, invoice_id: str | None = None) -> dict | None:
        ref = OrderRef(paypal_transaction_id=paypal_transaction_id, invoice_id=invoice_id)
        for adapter in self.adapters:
            if rec := await adapter.find_order(ref):
                return asdict(rec)
        return None

    async def _collect(self, method: str, order_id: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for adapter in self.adapters:
            out.extend(asdict(r) for r in await getattr(adapter, method)(order_id))
        return out

    async def find_shipment(self, order_id: str) -> list[dict[str, Any]]:
        return await self._collect("find_shipment", order_id)

    async def find_refund(self, order_id: str) -> list[dict[str, Any]]:
        return await self._collect("find_refund", order_id)

    async def find_support_tickets(self, order_id: str) -> list[dict[str, Any]]:
        return await self._collect("find_support_tickets", order_id)
