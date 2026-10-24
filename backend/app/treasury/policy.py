"""Treasury policies and the plain-code planner that turns one into proposed movements.

A policy only proposes. The safety engine decides, and nothing here touches PayPal. All maths is in
Decimal and rounds to the cent toward the merchant (reserves round down, so a sweep never asks for
a fraction more than the numbers support).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import ROUND_DOWN, Decimal
from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field

CENT = Decimal("0.01")
Money = Annotated[Decimal, Field(ge=0, le=Decimal("10000000"), decimal_places=2)]


def cents(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_DOWN)


class TaxReserve(BaseModel):
    """When a capture completes, set aside `rate` of it. Batched into one sweep per hour."""

    kind: Literal["tax_reserve"] = "tax_reserve"
    rate: Annotated[Decimal, Field(gt=0, le=Decimal("0.5"), decimal_places=4)] = Decimal("0.0825")


class DisputeBuffer(BaseModel):
    """Keep the buffer at coverage × open disputes + volume_pct × the last 30 days of captures."""

    kind: Literal["dispute_buffer"] = "dispute_buffer"
    coverage: Annotated[Decimal, Field(ge=0, le=Decimal("2"), decimal_places=2)] = Decimal("1.00")
    volume_pct: Annotated[Decimal, Field(ge=0, le=Decimal("0.2"), decimal_places=4)] = Decimal("0.02")


class AdSweep(BaseModel):
    """Every `weekday` at `hour` (UTC), sweep `amount` to ad spend if the floor holds afterwards.
    When it wouldn't, BundoPay re-plans: reserves first, then whatever still fits above the floor."""

    kind: Literal["ad_sweep"] = "ad_sweep"
    weekday: Annotated[int, Field(ge=0, le=6)] = 4  # Friday
    hour: Annotated[int, Field(ge=0, le=23)] = 9
    amount: Money = Decimal("15000.00")


class Rebalance(BaseModel):
    """Bring every reserve to its target in one batch, in priority order, never breaching the floor."""

    kind: Literal["rebalance"] = "rebalance"
    hour: Annotated[int, Field(ge=0, le=23)] = 6
    ad_amount: Money = Decimal("0.00")


PolicySpec = Annotated[Union[TaxReserve, DisputeBuffer, AdSweep, Rebalance], Field(discriminator="kind")]


class PolicyDoc(BaseModel):
    """What the merchant approves. The hash of this, not the row id, is what an approval binds to."""

    name: Annotated[str, Field(min_length=1, max_length=80)]
    spec: PolicySpec


def spec_hash(doc: PolicyDoc) -> str:
    body = json.dumps(doc.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(body.encode()).hexdigest()


# ---------------------------------------------------------------------------------------- exposure


@dataclass(frozen=True)
class Book:
    """Everything the planner reads, already loaded. Positions are by account role."""

    operating: Decimal | None
    reserves: dict[str, Decimal]  # role -> balance
    open_disputes: Decimal
    captures_30d: Decimal
    unreserved_captures: Decimal  # captures with no tax reserve yet
    floor: Decimal


def buffer_target(book: Book, p: DisputeBuffer) -> Decimal:
    return cents(book.open_disputes * p.coverage + book.captures_30d * p.volume_pct)


def buffer_gap(book: Book, p: DisputeBuffer) -> Decimal:
    return max(buffer_target(book, p) - book.reserves.get("dispute_buffer", Decimal("0")), Decimal("0"))


def tax_owed(book: Book, p: TaxReserve) -> Decimal:
    return cents(book.unreserved_captures * p.rate)


@dataclass(frozen=True)
class Proposal:
    role: str  # destination account role
    amount: Decimal
    policy: str  # which part of which policy asked for it
    key_part: str  # stable part of the idempotency key


def plan(spec: TaxReserve | DisputeBuffer | AdSweep | Rebalance, book: Book, *, buffer: DisputeBuffer | None = None,
         tax: TaxReserve | None = None) -> list[Proposal]:
    """What the policy asks for. Nothing here checks the floor or caps: that's the engine's job, so a
    bad policy shows up as a visible block, not a silent skip."""
    if isinstance(spec, TaxReserve):
        owed = tax_owed(book, spec)
        return [Proposal("tax_reserve", owed, "tax_reserve", "tax")] if owed > 0 else []
    if isinstance(spec, DisputeBuffer):
        gap = buffer_gap(book, spec)
        return [Proposal("dispute_buffer", gap, "dispute_buffer", "buffer")] if gap > 0 else []
    if isinstance(spec, AdSweep):
        return [Proposal("ad_spend", spec.amount, "ad_sweep", "ad")] if spec.amount > 0 else []
    return rebalance(book, ad_amount=spec.ad_amount, buffer=buffer, tax=tax)


def rebalance(book: Book, *, ad_amount: Decimal, buffer: DisputeBuffer | None, tax: TaxReserve | None) -> list[Proposal]:
    """Tax first, then the dispute buffer, then ad spend with whatever is left above the floor."""
    if book.operating is None:
        return []
    room = max(book.operating - book.floor, Decimal("0"))
    out: list[Proposal] = []
    wants = [
        ("tax_reserve", tax_owed(book, tax) if tax else Decimal("0"), "tax"),
        ("dispute_buffer", buffer_gap(book, buffer) if buffer else Decimal("0"), "buffer"),
        ("ad_spend", ad_amount, "ad"),
    ]
    for role, want, part in wants:
        amount = cents(min(want, room))
        if amount > 0:
            out.append(Proposal(role, amount, f"rebalance:{role}", part))
            room -= amount
    return out


# --------------------------------------------------------------------------------------- schedule


def next_fire(spec: TaxReserve | DisputeBuffer | AdSweep | Rebalance, after: datetime) -> datetime:
    """The next run strictly after `after`, in UTC. Tax and buffer policies run hourly."""
    after = after.astimezone(timezone.utc)
    if isinstance(spec, (TaxReserve, DisputeBuffer)):
        return after.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    if isinstance(spec, Rebalance):
        t = after.replace(hour=spec.hour, minute=0, second=0, microsecond=0)
        return t if t > after else t + timedelta(days=1)
    t = after.replace(hour=spec.hour, minute=0, second=0, microsecond=0)
    t += timedelta(days=(spec.weekday - t.weekday()) % 7)
    return t if t > after else t + timedelta(days=7)


def next_fires(spec: TaxReserve | DisputeBuffer | AdSweep | Rebalance, after: datetime, n: int) -> list[datetime]:
    out, t = [], after
    for _ in range(n):
        t = next_fire(spec, t)
        out.append(t)
    return out
