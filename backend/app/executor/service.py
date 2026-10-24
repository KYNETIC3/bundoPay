"""The executor: the only code that sends treasury money through PayPal.

It runs only movements the safety engine already allowed, claimed atomically from 'allowed' to
'executing', so two callers can't both send the same one. A movement is 'failed' only when PayPal
clearly sent nothing. When the outcome is unknown (a timeout after retries) it becomes 'unconfirmed'
and keeps its key, and a later status check settles it. The ledger is written only after PayPal
confirms the payout.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from decimal import Decimal
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection

from app.audit import audit
from app.db import connection
from app.deps import get_gateway
from app.events import notify_treasury_changed
from app.paypal_gateway import PayPalError, PayPalGateway, TransientPayPalError

log = logging.getLogger("executor")

# PayPal Payouts statuses. https://developer.paypal.com/docs/api/payments.payouts-batch/v1/
BATCH_DONE_OK = {"SUCCESS"}
BATCH_DENIED = {"DENIED", "CANCELED"}
ITEM_OK = {"SUCCESS"}
ITEM_FAILED = {"FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "DENIED"}
# PENDING, UNCLAIMED, ONHOLD: money may still land or come back; leave it executing and check again.

SENDABLE = ("sweep", "release")


@dataclass(frozen=True)
class Execution:
    batch_id: str | None
    status: str  # nothing | executing | succeeded | failed | unconfirmed
    paypal_batch_id: str | None = None
    movements: tuple[str, ...] = ()


def batch_key(idempotency_keys: list[str]) -> str:
    """The same set of movements always makes the same sender_batch_id (and PayPal-Request-Id)."""
    digest = hashlib.sha256("\n".join(sorted(idempotency_keys)).encode()).hexdigest()
    return f"bp-{digest[:40]}"


def payout_items(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "recipient_type": "EMAIL",
            "receiver": r["paypal_email"],
            "amount": {"value": f"{Decimal(r['amount']):.2f}", "currency": r["currency"]},
            "sender_item_id": str(r["id"]),
            "note": f"BundoPay treasury {r['kind']} to {r['account_name']}",
        }
        for r in rows
    ]


async def _event(conn: AsyncConnection, merchant_id: UUID | str, event: str, flow_id: Any, data: dict[str, Any], label: str = "system_generated") -> None:
    await audit(conn, event, merchant_id=merchant_id, flow_id=flow_id, label=label, actor="executor", data=data)


async def _claim(conn: AsyncConnection, merchant_id: UUID | str, movement_ids: list[str]) -> list[dict[str, Any]]:
    cur = await conn.execute(
        """
        with claimed as (
          update movements m set status = 'executing', updated_at = now()
          where m.merchant_id = %s and m.id = any(%s) and m.status = 'allowed' and m.kind = any(%s)
          returning m.*
        )
        select c.*, a.paypal_email, a.name as account_name, a.verified_at
        from claimed c left join treasury_accounts a on a.id = c.to_account_id
        """,
        (merchant_id, movement_ids, list(SENDABLE)),
    )
    return await cur.fetchall()


async def execute(
    merchant_id: UUID | str, movement_ids: list[str], *, flow_id: UUID | str | None = None, gateway: PayPalGateway | None = None
) -> Execution:
    """Send every allowed movement in `movement_ids` as one Payouts batch."""
    gw = gateway or get_gateway()
    async with connection() as conn:
        async with conn.transaction():
            rows = await _claim(conn, merchant_id, [str(i) for i in movement_ids])
            # Re-check the destination now, not just when the engine ran: an account edited in between
            # lost its verification and gets nothing.
            stale = [r for r in rows if not r["paypal_email"] or r["verified_at"] is None]
            rows = [r for r in rows if r not in stale]
            for r in stale:
                await conn.execute("update movements set status = 'failed', updated_at = now() where id = %s", (r["id"],))
                await _event(conn, merchant_id, "execution.refused", flow_id,
                             {"movement_id": str(r["id"]), "reason": "Destination account is no longer verified", "money_moved": "0.00"})
            if not rows:
                return Execution(None, "nothing")
            batch = batch_key([r["idempotency_key"] for r in rows])
            await conn.execute(
                "update movements set batch_id = %s, updated_at = now() where id = any(%s)", (batch, [r["id"] for r in rows])
            )
            total = sum((Decimal(r["amount"]) for r in rows), Decimal("0"))
            await _event(conn, merchant_id, "execution.submitted", flow_id, {
                "api": "POST /v1/payments/payouts", "items": len(rows), "request_id": batch, "total": f"{total:.2f}",
                "movements": [str(r["id"]) for r in rows],
            })
            await notify_treasury_changed(conn, merchant_id)
    return await _send(merchant_id, rows, batch, flow_id, gw)


async def _send(merchant_id: UUID | str, rows: list[dict[str, Any]], batch: str, flow_id: Any, gw: PayPalGateway) -> Execution:
    ids = tuple(str(r["id"]) for r in rows)
    try:
        resp = await gw.create_payout_batch(
            sender_batch_id=batch, items=payout_items(rows), email_subject="BundoPay treasury transfer"
        )
    except TransientPayPalError as exc:
        # We don't know whether PayPal took it. Keep the key; the confirm job resends the same request id.
        async with connection() as conn:
            await conn.execute("update movements set status = 'unconfirmed', updated_at = now() where id = any(%s)", (list(ids),))
            await _event(conn, merchant_id, "execution.unconfirmed", flow_id, {"request_id": batch, "error": exc.name, "debug_id": exc.debug_id})
            await notify_treasury_changed(conn, merchant_id)
        return Execution(batch, "unconfirmed", movements=ids)
    except PayPalError as exc:
        # A definite rejection (4xx): nothing was paid.
        async with connection() as conn:
            await conn.execute("update movements set status = 'failed', updated_at = now() where id = any(%s)", (list(ids),))
            await _event(conn, merchant_id, "execution.failed", flow_id,
                         {"request_id": batch, "error": exc.name, "message": exc.message, "debug_id": exc.debug_id, "money_moved": "0.00"},
                         label="provider_verified")
            await notify_treasury_changed(conn, merchant_id)
        return Execution(batch, "failed", movements=ids)

    header = resp.get("batch_header") or {}
    paypal_batch = header.get("payout_batch_id")
    async with connection() as conn:
        async with conn.transaction():
            await conn.execute(
                "update movements set paypal_ref = %s, executed_at = now(), updated_at = now() where id = any(%s)",
                (paypal_batch, list(ids)),
            )
            await _event(conn, merchant_id, "execution.accepted", flow_id,
                         {"payout_batch": paypal_batch, "status": header.get("batch_status"), "request_id": batch}, label="provider_verified")
            await notify_treasury_changed(conn, merchant_id)
    if paypal_batch:
        return await confirm_batch(merchant_id, paypal_batch, flow_id=flow_id, gateway=gw)
    return Execution(batch, "executing", movements=ids)


async def confirm_batch(
    merchant_id: UUID | str, paypal_batch_id: str, *, flow_id: Any = None, gateway: PayPalGateway | None = None
) -> Execution:
    """Read the batch from PayPal (never from a webhook body) and settle each movement in it."""
    gw = gateway or get_gateway()
    body = await gw.get_payout_batch(paypal_batch_id)
    header = body.get("batch_header") or {}
    batch_status = header.get("batch_status")
    items = {
        (i.get("payout_item") or {}).get("sender_item_id"): i for i in body.get("items") or []
    }
    async with connection() as conn:
        async with conn.transaction():
            cur = await conn.execute(
                "select m.*, a.role from movements m left join treasury_accounts a on a.id = m.to_account_id "
                "where m.merchant_id = %s and m.paypal_ref = %s and m.status in ('executing', 'unconfirmed') for update of m",
                (merchant_id, paypal_batch_id),
            )
            rows = await cur.fetchall()
            settled: list[str] = []
            for r in rows:
                item = items.get(str(r["id"])) or {}
                status = item.get("transaction_status")
                if status in ITEM_OK or (not items and batch_status in BATCH_DONE_OK):
                    await _settle(conn, merchant_id, r, item, flow_id)
                    settled.append("succeeded")
                elif status in ITEM_FAILED or batch_status in BATCH_DENIED:
                    await conn.execute("update movements set status = 'failed', updated_at = now() where id = %s", (r["id"],))
                    await _event(conn, merchant_id, "execution.item_failed", flow_id or r["flow_id"],
                                 {"movement_id": str(r["id"]), "payout_batch": paypal_batch_id, "status": status or batch_status},
                                 label="provider_verified")
                    settled.append("failed")
                else:
                    settled.append("executing")
            if rows:
                await notify_treasury_changed(conn, merchant_id)
    overall = "succeeded" if settled and all(s == "succeeded" for s in settled) else (
        "failed" if settled and all(s == "failed" for s in settled) else "executing"
    )
    return Execution(None, overall, paypal_batch_id, tuple(str(r["id"]) for r in rows))


async def _settle(conn: AsyncConnection, merchant_id: UUID | str, r: dict[str, Any], item: dict[str, Any], flow_id: Any) -> None:
    await conn.execute(
        "update movements set status = 'succeeded', paypal_item_id = %s, updated_at = now() where id = %s",
        (item.get("payout_item_id"), r["id"]),
    )
    operating = await _account_id(conn, merchant_id, "operating")
    entries = [(r["to_account_id"], Decimal(r["amount"]))]
    if operating:
        entries.append((operating, -Decimal(r["amount"])))
    for account_id, amount in entries:
        if account_id:
            await conn.execute(
                "insert into treasury_ledger (merchant_id, account_id, movement_id, amount) values (%s, %s, %s, %s) "
                "on conflict (movement_id, account_id) do nothing",
                (merchant_id, account_id, r["id"], amount),
            )
    await _event(conn, merchant_id, "execution.confirmed", flow_id or r["flow_id"], {
        "movement_id": str(r["id"]), "payout_batch": r["paypal_ref"], "payout_item": item.get("payout_item_id"),
        "amount": f"{Decimal(r['amount']):.2f}", "status": "SUCCESS",
    }, label="provider_verified")


async def _account_id(conn: AsyncConnection, merchant_id: UUID | str, role: str) -> UUID | None:
    cur = await conn.execute("select id from treasury_accounts where merchant_id = %s and role = %s", (merchant_id, role))
    row = await cur.fetchone()
    return row["id"] if row else None


async def resend_unconfirmed(merchant_id: UUID | str, batch: str, *, gateway: PayPalGateway | None = None) -> Execution:
    """Repeat the exact same Payouts request (same sender_batch_id and PayPal-Request-Id). PayPal returns
    the original batch if it had one, and pays nothing new."""
    gw = gateway or get_gateway()
    async with connection() as conn:
        cur = await conn.execute(
            "select m.*, a.paypal_email, a.name as account_name from movements m "
            "join treasury_accounts a on a.id = m.to_account_id "
            "where m.merchant_id = %s and m.batch_id = %s and m.status = 'unconfirmed' order by m.id",
            (merchant_id, batch),
        )
        rows = await cur.fetchall()
    if not rows:
        return Execution(batch, "nothing")
    if batch_key([r["idempotency_key"] for r in rows]) != batch:
        # Part of the batch already settled; resending a smaller set would be a different request.
        log.warning("Batch %s is only partly unconfirmed; leaving it for a manual check", batch)
        return Execution(batch, "unconfirmed", movements=tuple(str(r["id"]) for r in rows))
    flow_id = rows[0]["flow_id"]
    return await _send(merchant_id, rows, batch, flow_id, gw)


async def confirm_pending(merchant_id: UUID | str, *, gateway: PayPalGateway | None = None) -> dict[str, int]:
    """Worker job: settle every batch still in flight for a merchant."""
    async with connection() as conn:
        cur = await conn.execute(
            "select distinct paypal_ref, batch_id, status from movements where merchant_id = %s "
            "and status in ('executing', 'unconfirmed') and batch_id is not null",
            (merchant_id,),
        )
        pending = await cur.fetchall()
    done = {"checked": 0, "resent": 0}
    for p in pending:
        if p["paypal_ref"]:
            await confirm_batch(merchant_id, p["paypal_ref"], gateway=gateway)
            done["checked"] += 1
        elif p["status"] == "unconfirmed":
            await resend_unconfirmed(merchant_id, p["batch_id"], gateway=gateway)
            done["resent"] += 1
    return done


@dataclass(frozen=True)
class Position:
    account_id: str
    role: str
    name: str
    balance: Decimal
    source: str  # paypal | simulated | ledger


async def positions(conn: AsyncConnection, merchant_id: UUID | str, *, gateway: PayPalGateway | None = None) -> list[Position]:
    """Operating comes from PayPal's balance when the sandbox returns one; otherwise from the merchant's
    seeded opening balance plus confirmed movements, labelled simulated. Reserves are always ledger-derived:
    BundoPay can't read another account's balance."""
    cur = await conn.execute(
        """
        select a.id, a.role, a.name, a.opening_balance, coalesce(sum(l.amount), 0) as moved
        from treasury_accounts a left join treasury_ledger l on l.account_id = a.id
        where a.merchant_id = %s group by a.id order by a.role, a.name
        """,
        (merchant_id,),
    )
    rows = await cur.fetchall()
    limits = await conn.execute("select currency from treasury_limits where merchant_id = %s", (merchant_id,))
    lim = await limits.fetchone()
    live = await paypal_balance(gateway or get_gateway(), lim["currency"] if lim else "USD")
    out = []
    for r in rows:
        if r["role"] == "operating" and live is not None:
            out.append(Position(str(r["id"]), r["role"], r["name"], live, "paypal"))
        elif r["role"] == "operating":
            out.append(Position(str(r["id"]), r["role"], r["name"], Decimal(r["opening_balance"]) + Decimal(r["moved"]), "simulated"))
        else:
            out.append(Position(str(r["id"]), r["role"], r["name"], Decimal(r["opening_balance"]) + Decimal(r["moved"]), "ledger"))
    return out


async def paypal_balance(gw: PayPalGateway, currency: str) -> Decimal | None:
    try:
        body = await gw.list_balances(currency)
    except PayPalError as exc:
        log.info("Balances unavailable (%s); using the simulated balance", exc.name)
        return None
    for b in body.get("balances") or []:
        if b.get("currency") == currency and (avail := (b.get("available_balance") or {}).get("value")) is not None:
            return Decimal(avail)
    return None
