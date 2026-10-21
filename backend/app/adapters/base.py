"""Merchant data sources sit behind one interface. CSV upload first; Shopify etc. implement the same Protocol."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass
class OrderRef:
    """What we know from PayPal that can identify the merchant's order."""

    paypal_transaction_id: str | None = None
    invoice_id: str | None = None
    buyer_email: str | None = None


@dataclass
class Record:
    source_system: str
    kind: str
    key: str
    data: dict[str, Any]


class MerchantDataAdapter(Protocol):
    source_system: str

    async def find_order(self, ref: OrderRef) -> Record | None: ...

    async def find_shipment(self, order_id: str) -> list[Record]: ...

    async def find_refund(self, order_id: str) -> list[Record]: ...

    async def find_support_tickets(self, order_id: str) -> list[Record]: ...
