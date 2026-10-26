"""Hosted demo: one shared judge account, connected to the app's own sandbox business account and
reset to the runbook's starting state (docs/DEMO.md) every night or on demand.

Reset deletes the demo account's treasury rows, chat and audit chain, so the next judge starts from a
clean, verifiable chain. It only ever touches the account whose email is DEMO_EMAIL.
"""

from __future__ import annotations

import logging
from uuid import UUID

import httpx

from app.audit import audit
from app.config import get_settings
from app.db import connection, jsonb
from app.deps import get_gateway
from app.jobs.queue import enqueue
from app.onboarding.service import SCOPE_FEATURES
from app.safety.service import load_limits
from app.treasury.router import _details_hash

log = logging.getLogger("demo")

# (role, name), in the order of DEMO_ACCOUNT_EMAILS. No opening balances: every figure shown comes from PayPal.
DEMO_ACCOUNTS = (
    ("operating", "Operating"),
    ("tax_reserve", "Tax Reserve"),
    ("dispute_buffer", "Dispute Margin Buffer"),
    ("ad_spend", "Ad-Spend Wallet"),
)

# Children before parents; treasury_policy_versions go with their policies.
_RESET_TABLES = (
    "treasury_ledger", "treasury_captures", "movements", "treasury_plans", "treasury_policies",
    "treasury_accounts", "treasury_limits", "agent_messages", "audit_log",
)


class DemoError(Exception):
    pass


def is_demo(email: str) -> bool:
    demo = get_settings().demo_email
    return bool(demo) and email.strip().lower() == demo.strip().lower()


def account_emails() -> list[str]:
    emails = [e.strip() for e in get_settings().demo_account_emails.split(",") if e.strip()]
    if len(emails) != len(DEMO_ACCOUNTS):
        raise DemoError("DEMO_ACCOUNT_EMAILS needs four comma-separated emails: operating, tax, buffer, ad spend.")
    return emails


async def demo_merchant_id() -> UUID | None:
    async with connection() as conn:
        cur = await conn.execute("select id from merchants where lower(email) = lower(%s)", (get_settings().demo_email,))
        row = await cur.fetchone()
    return row["id"] if row else None


async def reset(merchant_id: UUID) -> None:
    emails = account_emails()
    async with connection() as conn:
        async with conn.transaction():
            for table in _RESET_TABLES:
                await conn.execute(f"delete from {table} where merchant_id = %s", (merchant_id,))
            await conn.execute(
                "update merchants set activity_cleared_at = null, conversation_cleared_at = null, "
                "auto_refund_enabled = true, auto_refund_limit = 20.00 where id = %s",
                (merchant_id,),
            )
            for (role, name), email in zip(DEMO_ACCOUNTS, emails):
                await conn.execute(
                    "insert into treasury_accounts (merchant_id, role, name, paypal_email, details_hash, verified_at) "
                    "values (%s, %s, %s, %s, %s, now())",
                    (merchant_id, role, name, email, _details_hash(name, email)),
                )
            await load_limits(conn, merchant_id)  # the runbook's defaults
            await audit(conn, "demo.reset", merchant_id=merchant_id, actor="system", data={"accounts": len(emails)})
            await enqueue(conn, "sync_merchant", {"merchant_id": str(merchant_id)}, dedupe_key=f"sync:{merchant_id}")


async def reset_demo_account() -> None:
    """Nightly job. Does nothing until the demo account exists."""
    merchant_id = await demo_merchant_id()
    if merchant_id:
        await reset(merchant_id)
        log.info("Demo account reset")


async def _auth_user_id(client: httpx.AsyncClient, email: str, password: str) -> UUID:
    """Create the Supabase Auth user, or set the password of the existing one."""
    r = await client.post("/admin/users", json={"email": email, "password": password, "email_confirm": True})
    if r.status_code < 300:
        return UUID(r.json()["id"])
    page = 1
    while True:
        users = (await client.get("/admin/users", params={"page": page, "per_page": 200})).raise_for_status().json()["users"]
        match = next((u for u in users if u["email"].lower() == email.lower()), None)
        if match:
            (await client.put(f"/admin/users/{match['id']}", json={"password": password})).raise_for_status()
            return UUID(match["id"])
        if len(users) < 200:
            raise DemoError(f"Supabase refused to create {email}: {r.text}")
        page += 1


async def setup() -> UUID:
    """Create (or refresh) the demo login, connect it to the sandbox business account, and reset it."""
    settings = get_settings()
    if not (settings.demo_email and settings.demo_password and settings.paypal_partner_merchant_id):
        raise DemoError("Set DEMO_EMAIL, DEMO_PASSWORD and PAYPAL_PARTNER_MERCHANT_ID first.")
    account_emails()
    key = settings.supabase_service_role_key
    async with httpx.AsyncClient(
        base_url=f"{settings.supabase_url}/auth/v1", headers={"apikey": key, "Authorization": f"Bearer {key}"}, timeout=20
    ) as client:
        merchant_id = await _auth_user_id(client, settings.demo_email, settings.demo_password)

    scopes = await get_gateway().own_scopes()
    features = sorted({f for s in scopes for frag, f in SCOPE_FEATURES.items() if frag in s})
    own_id = settings.paypal_partner_merchant_id
    async with connection() as conn:
        await conn.execute(
            "insert into merchants (id, email) values (%s, %s) on conflict (id) do nothing", (merchant_id, settings.demo_email)
        )
        # On a hosted demo the judge account owns the sandbox business account.
        await conn.execute(
            "update merchants set paypal_merchant_id = null, grant_status = 'not_connected' where paypal_merchant_id = %s and id <> %s",
            (own_id, merchant_id),
        )
        await conn.execute(
            "update merchants set paypal_merchant_id = %s, grant_status = 'granted', granted_scopes = %s, connected_at = now() where id = %s",
            (own_id, jsonb(features), merchant_id),
        )
    await reset(merchant_id)
    return merchant_id
