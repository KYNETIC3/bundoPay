"""CSV-upload adapter. Merchants upload orders/shipments/refunds/tickets exports; rows are stored as-is
(after column validation) and queried at evidence time. Values are never rewritten or inferred."""

from __future__ import annotations

import csv
import io
from typing import Any, Protocol
from uuid import UUID

from app.db import connection, jsonb

from .base import OrderRef, Record

SCHEMAS: dict[str, dict[str, list[str]]] = {
    "orders": {
        "required": ["order_id", "order_date", "total", "currency"],
        "optional": [
            "paypal_transaction_id", "invoice_id", "customer_email", "items",
            "ship_to_name", "ship_to_line1", "ship_to_city", "ship_to_postal_code", "ship_to_country",
        ],
    },
    "shipments": {
        "required": ["order_id", "carrier", "tracking_number"],
        "optional": ["shipped_at", "delivered_at", "status", "ship_to_line1", "ship_to_postal_code", "ship_to_country"],
    },
    "refunds": {
        "required": ["order_id", "refund_id", "amount", "currency"],
        "optional": ["paypal_refund_id", "refunded_at", "reason"],
    },
    "tickets": {
        "required": ["order_id", "ticket_id", "created_at"],
        "optional": ["subject", "summary", "status"],
    },
}
RECORD_KEY = {"orders": "order_id", "shipments": "tracking_number", "refunds": "refund_id", "tickets": "ticket_id"}
MAX_ROWS = 50_000


class CsvValidationError(ValueError):
    pass


def parse_csv(kind: str, text: str) -> list[dict[str, str]]:
    if kind not in SCHEMAS:
        raise CsvValidationError(f"Unknown file kind '{kind}'")
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    headers = [h.strip().lower() for h in reader.fieldnames or []]
    missing = [c for c in SCHEMAS[kind]["required"] if c not in headers]
    if missing:
        raise CsvValidationError(f"Missing required columns: {', '.join(missing)}")
    allowed = set(SCHEMAS[kind]["required"]) | set(SCHEMAS[kind]["optional"])
    rows: list[dict[str, str]] = []
    for line_no, raw in enumerate(reader, start=2):
        row = {k.strip().lower(): (v or "").strip() for k, v in raw.items() if k and k.strip().lower() in allowed}
        empty = [c for c in SCHEMAS[kind]["required"] if not row.get(c)]
        if empty:
            raise CsvValidationError(f"Row {line_no}: empty required value(s): {', '.join(empty)}")
        rows.append(row)
        if len(rows) > MAX_ROWS:
            raise CsvValidationError(f"Too many rows (max {MAX_ROWS})")
    return rows


async def import_csv(merchant_id: UUID, kind: str, text: str) -> int:
    rows = parse_csv(kind, text)
    async with connection() as conn:
        async with conn.transaction():
            for row in rows:
                await conn.execute(
                    """
                    insert into merchant_records (merchant_id, kind, source_system, record_key, order_id, data)
                    values (%s, %s, 'csv', %s, %s, %s)
                    on conflict (merchant_id, kind, record_key)
                    do update set data = excluded.data, order_id = excluded.order_id, imported_at = now()
                    """,
                    (merchant_id, kind, row[RECORD_KEY[kind]], row.get("order_id"), jsonb(row)),
                )
    return len(rows)


class RecordStore(Protocol):
    async def rows(self, kind: str) -> list[dict[str, Any]]: ...


class PgRecordStore:
    def __init__(self, merchant_id: UUID):
        self.merchant_id = merchant_id
        self._cache: dict[str, list[dict[str, Any]]] = {}

    async def rows(self, kind: str) -> list[dict[str, Any]]:
        if kind not in self._cache:
            async with connection() as conn:
                cur = await conn.execute(
                    "select data from merchant_records where merchant_id = %s and kind = %s and source_system = 'csv'",
                    (self.merchant_id, kind),
                )
                self._cache[kind] = [r["data"] for r in await cur.fetchall()]
        return self._cache[kind]


class InMemoryRecordStore:
    def __init__(self, data: dict[str, list[dict[str, Any]]]):
        self.data = data

    async def rows(self, kind: str) -> list[dict[str, Any]]:
        return self.data.get(kind, [])


class CsvAdapter:
    source_system = "csv"

    def __init__(self, store: RecordStore):
        self.store = store

    def _rec(self, kind: str, row: dict[str, Any]) -> Record:
        return Record(source_system=self.source_system, kind=kind, key=row[RECORD_KEY[kind]], data=row)

    async def find_order(self, ref: OrderRef) -> Record | None:
        orders = await self.store.rows("orders")
        # Strongest identifier first; email alone is too weak to claim a match.
        for field, value in (("paypal_transaction_id", ref.paypal_transaction_id), ("invoice_id", ref.invoice_id)):
            if value:
                for row in orders:
                    if row.get(field) == value:
                        return self._rec("orders", row)
        return None

    async def _by_order(self, kind: str, order_id: str) -> list[Record]:
        return [self._rec(kind, r) for r in await self.store.rows(kind) if r.get("order_id") == order_id]

    async def find_shipment(self, order_id: str) -> list[Record]:
        return await self._by_order("shipments", order_id)

    async def find_refund(self, order_id: str) -> list[Record]:
        return await self._by_order("refunds", order_id)

    async def find_support_tickets(self, order_id: str) -> list[Record]:
        return await self._by_order("tickets", order_id)
