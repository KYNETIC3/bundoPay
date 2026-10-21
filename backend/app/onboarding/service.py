"""PayPal partner onboarding (third-party permissions). Only the merchant's PayPal ID and grant status are stored."""

from __future__ import annotations

import secrets
from typing import Any
from uuid import UUID

from app.audit import audit
from app.config import get_settings
from app.db import connection, jsonb
from app.deps import get_gateway
from app.jobs.queue import enqueue
from app.paypal_gateway import THIRD_PARTY_FEATURES

# Scope URIs PayPal reports in merchant-integrations, matched to the features we request.
SCOPE_FEATURES = {
    "disputes/read-seller": "READ_SELLER_DISPUTE",
    "disputes/update-seller": "UPDATE_SELLER_DISPUTE",
    "reporting/search/read": "ADVANCED_TRANSACTIONS_SEARCH",
    "shipping/trackers/readwrite": "TRACKING_SHIPMENT_READWRITE",
    "customer/merchant-integrations/read": "ACCESS_MERCHANT_INFORMATION",
}
REQUIRED_FEATURES = {"READ_SELLER_DISPUTE", "UPDATE_SELLER_DISPUTE"}


class OnboardingError(Exception):
    pass


def granted_features(integration: dict[str, Any]) -> tuple[list[str], list[str]]:
    """Return (features, raw scopes) granted to this partner in a merchant-integrations response."""
    partner_client_id = get_settings().paypal_partner_client_id
    scopes: list[str] = []
    for oauth in integration.get("oauth_integrations", []):
        for third_party in oauth.get("oauth_third_party", []):
            if third_party.get("partner_client_id") not in (None, partner_client_id):
                continue
            scopes.extend(third_party.get("scopes", []))
    features = sorted({f for s in scopes for frag, f in SCOPE_FEATURES.items() if frag in s})
    return features, scopes


async def start(merchant_id: UUID) -> str:
    tracking_id = secrets.token_hex(16)
    return_url = f"{get_settings().frontend_url}/onboarding/return"
    referral = await get_gateway().create_partner_referral(tracking_id=tracking_id, return_url=return_url)
    action_url = next((l["href"] for l in referral.get("links", []) if l.get("rel") == "action_url"), None)
    if not action_url:
        raise OnboardingError("PayPal did not return an onboarding link")
    async with connection() as conn:
        await conn.execute(
            "update merchants set onboarding_tracking_id = %s, "
            "grant_status = case when grant_status = 'granted' then grant_status else 'pending' end where id = %s",
            (tracking_id, merchant_id),
        )
        await audit(conn, "onboarding.started", merchant_id=merchant_id, data={"features": THIRD_PARTY_FEATURES})
    return action_url


async def complete(
    merchant_id: UUID, *, tracking_id: str, paypal_merchant_id: str, permissions_granted: bool
) -> dict[str, Any]:
    async with connection() as conn:
        cur = await conn.execute("select onboarding_tracking_id from merchants where id = %s", (merchant_id,))
        row = await cur.fetchone()
    if not row or not row["onboarding_tracking_id"] or not secrets.compare_digest(row["onboarding_tracking_id"], tracking_id):
        raise OnboardingError("This PayPal return doesn't match the connection you started. Please try again.")
    if not permissions_granted:
        raise OnboardingError("Permissions were not granted on PayPal.")

    # Never trust the redirect alone: confirm the grant with PayPal.
    integration = await get_gateway().get_merchant_integration(paypal_merchant_id)
    features, scopes = granted_features(integration)
    missing = sorted(REQUIRED_FEATURES - set(features))
    status = "granted" if not missing else "pending"
    async with connection() as conn:
        await conn.execute(
            """
            update merchants set paypal_merchant_id = %s, grant_status = %s, granted_scopes = %s,
              connected_at = case when %s = 'granted' then now() else connected_at end,
              onboarding_tracking_id = null
            where id = %s
            """,
            (paypal_merchant_id, status, jsonb(features), status, merchant_id),
        )
        await audit(
            conn,
            "onboarding.verified",
            merchant_id=merchant_id,
            data={"paypal_merchant_id": paypal_merchant_id, "features": features, "scopes": scopes, "missing": missing},
        )
        if status == "granted":
            await enqueue(conn, "sync_merchant", {"merchant_id": str(merchant_id)}, dedupe_key=f"sync:{merchant_id}")
    if missing:
        raise OnboardingError(f"PayPal didn't grant: {', '.join(missing)}. Please reconnect and approve all permissions.")
    return {"paypal_merchant_id": paypal_merchant_id, "granted_features": features}


async def dev_connect_self(merchant_id: UUID) -> dict[str, Any]:
    """Developer-only test mode: treat the partner app's own sandbox business account as this user's
    connected merchant. Used while PayPal partner onboarding is not yet approved."""
    settings = get_settings()
    if not settings.paypal_dev_self_merchant:
        raise OnboardingError("Developer test mode is turned off.")
    own_id = settings.paypal_partner_merchant_id
    if not own_id:
        raise OnboardingError("PAYPAL_PARTNER_MERCHANT_ID is not set.")

    scopes = await get_gateway().own_scopes()
    features = sorted({f for s in scopes for frag, f in SCOPE_FEATURES.items() if frag in s})
    missing = sorted(REQUIRED_FEATURES - set(features))
    if missing:
        raise OnboardingError(f"Your PayPal app is missing: {', '.join(missing)}. Enable Disputes on the app in the PayPal dashboard.")

    async with connection() as conn:
        cur = await conn.execute(
            "select id from merchants where paypal_merchant_id = %s and id <> %s", (own_id, merchant_id)
        )
        if await cur.fetchone():
            raise OnboardingError("Another BundoPay user is already using the test account. Disconnect it there first.")
        await conn.execute(
            """
            update merchants set paypal_merchant_id = %s, grant_status = 'granted', granted_scopes = %s,
              connected_at = now(), onboarding_tracking_id = null
            where id = %s
            """,
            (own_id, jsonb(features), merchant_id),
        )
        await audit(conn, "onboarding.dev_self_connected", merchant_id=merchant_id,
                    data={"paypal_merchant_id": own_id, "features": features})
        await enqueue(conn, "sync_merchant", {"merchant_id": str(merchant_id)}, dedupe_key=f"sync:{merchant_id}")
    return {"paypal_merchant_id": own_id, "granted_features": features, "test_mode": True}


async def disconnect(merchant_id: UUID) -> None:
    async with connection() as conn:
        await conn.execute(
            "update merchants set paypal_merchant_id = null, grant_status = 'not_connected', granted_scopes = '[]', "
            "connected_at = null where id = %s",
            (merchant_id,),
        )
        await audit(conn, "onboarding.disconnected", merchant_id=merchant_id)
