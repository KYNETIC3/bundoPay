"""The only code in this project that talks to PayPal.

Responsibilities: partner OAuth token caching, PayPal-Auth-Assertion for merchant-scoped calls,
retries with backoff, PayPal-Request-Id idempotency keys, and error normalization.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx

from app.config import SANDBOX_BASE_URL, Settings

from .assertion import auth_assertion
from .errors import PayPalError, PermissionRevokedError, TransientPayPalError

log = logging.getLogger(__name__)

RETRYABLE_STATUSES = {429, 500, 502, 503, 504}
TOKEN_REFRESH_MARGIN_SECONDS = 60

# Features requested from the merchant during partner onboarding. These must match the
# third-party features enabled on the partner REST app.
THIRD_PARTY_FEATURES = [
    "READ_SELLER_DISPUTE",
    "UPDATE_SELLER_DISPUTE",
    "ADVANCED_TRANSACTIONS_SEARCH",
    "TRACKING_SHIPMENT_READWRITE",
    "ACCESS_MERCHANT_INFORMATION",
]


class EvidenceFile:
    def __init__(self, filename: str, content: bytes, content_type: str):
        self.filename = filename
        self.content = content
        self.content_type = content_type


def _iso(dt: datetime) -> str:
    dt = dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


class PayPalGateway:
    def __init__(
        self,
        settings: Settings,
        http: httpx.AsyncClient | None = None,
        *,
        max_attempts: int = 4,
        backoff_base: float = 0.5,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ):
        if settings.paypal_base_url != SANDBOX_BASE_URL:
            raise RuntimeError("PayPalGateway only targets the PayPal sandbox")
        self._settings = settings
        self._http = http or httpx.AsyncClient(base_url=settings.paypal_base_url, timeout=30.0)
        self._max_attempts = max_attempts
        self._backoff_base = backoff_base
        self._sleep = sleep
        self._token: str | None = None
        self._token_expires_at = 0.0
        self._token_lock = asyncio.Lock()
        self._scopes: list[str] = []

    async def aclose(self) -> None:
        await self._http.aclose()

    async def own_scopes(self) -> list[str]:
        """Scope URIs PayPal granted the partner app for its own account."""
        await self._access_token()
        return list(self._scopes)

    def _is_self(self, merchant_id: str) -> bool:
        # The app's own business account is called with the partner token alone; an auth
        # assertion is only for acting on behalf of a *different* merchant.
        return merchant_id == self._settings.paypal_partner_merchant_id

    # ---------------------------------------------------------------- auth

    async def _access_token(self, *, force_refresh: bool = False) -> str:
        async with self._token_lock:
            if not force_refresh and self._token and time.monotonic() < self._token_expires_at:
                return self._token
            resp = await self._send_with_retries(
                lambda: self._http.post(
                    "/v1/oauth2/token",
                    data={"grant_type": "client_credentials"},
                    auth=(self._settings.paypal_partner_client_id, self._settings.paypal_partner_client_secret),
                    headers={"Accept": "application/json"},
                ),
                retry_allowed=True,
            )
            if resp.status_code != 200:
                raise PayPalError.from_response(resp.status_code, _json_or_text(resp))
            body = resp.json()
            self._token = body["access_token"]
            self._scopes = body.get("scope", "").split()
            expires_in = int(body.get("expires_in", 3600))
            self._token_expires_at = time.monotonic() + max(expires_in - TOKEN_REFRESH_MARGIN_SECONDS, 0)
            return self._token

    # ------------------------------------------------------------- transport

    async def _send_with_retries(
        self, send: Callable[[], Awaitable[httpx.Response]], *, retry_allowed: bool
    ) -> httpx.Response:
        attempts = self._max_attempts if retry_allowed else 1
        last_exc: Exception | None = None
        resp: httpx.Response | None = None
        for attempt in range(1, attempts + 1):
            try:
                resp = await send()
            except httpx.TransportError as exc:
                last_exc = exc
                resp = None
            else:
                if resp.status_code not in RETRYABLE_STATUSES:
                    return resp
            if attempt == attempts:
                break
            await self._sleep(self._backoff_delay(attempt, resp))
        if resp is not None:
            err = PayPalError.from_response(resp.status_code, _json_or_text(resp))
            raise TransientPayPalError(err.status, err.name, err.message, err.debug_id, err.details)
        raise TransientPayPalError(0, "NETWORK_ERROR", str(last_exc))

    def _backoff_delay(self, attempt: int, resp: httpx.Response | None) -> float:
        if resp is not None and (retry_after := resp.headers.get("Retry-After")):
            try:
                return min(float(retry_after), 30.0)
            except ValueError:
                pass
        return self._backoff_base * (2 ** (attempt - 1)) + random.uniform(0, self._backoff_base / 2)

    async def _request(
        self,
        method: str,
        path: str,
        *,
        merchant_id: str | None = None,
        params: dict[str, Any] | None = None,
        json_body: Any = None,
        files: list[tuple[str, tuple[str | None, bytes | str, str]]] | None = None,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        """Send one PayPal call.

        GETs are always retried on transient failures. Writes are retried only when a
        PayPal-Request-Id is supplied, since that makes the retry idempotent on PayPal's side.
        """
        retry_allowed = method == "GET" or request_id is not None

        async def send(token: str) -> httpx.Response:
            headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
            if merchant_id and not self._is_self(merchant_id):
                headers["PayPal-Auth-Assertion"] = auth_assertion(self._settings.paypal_partner_client_id, merchant_id)
            if request_id:
                headers["PayPal-Request-Id"] = request_id
            return await self._http.request(method, path, params=params, json=json_body, files=files, headers=headers)

        token = await self._access_token()
        resp = await self._send_with_retries(lambda: send(token), retry_allowed=retry_allowed)
        if resp.status_code == 401:
            # Either our cached partner token expired early or the merchant grant is gone.
            token = await self._access_token(force_refresh=True)
            resp = await self._send_with_retries(lambda: send(token), retry_allowed=retry_allowed)

        if resp.status_code in (401, 403) and merchant_id:
            err = PayPalError.from_response(resp.status_code, _json_or_text(resp))
            raise PermissionRevokedError(err.status, err.name, err.message, err.debug_id, err.details)
        if resp.status_code >= 400:
            raise PayPalError.from_response(resp.status_code, _json_or_text(resp))
        if resp.status_code == 204 or not resp.content:
            return {}
        return resp.json()

    # ------------------------------------------------------------ onboarding

    async def create_partner_referral(self, *, tracking_id: str, return_url: str) -> dict[str, Any]:
        body = {
            "tracking_id": tracking_id,
            "operations": [
                {
                    "operation": "API_INTEGRATION",
                    "api_integration_preference": {
                        "rest_api_integration": {
                            "integration_method": "PAYPAL",
                            "integration_type": "THIRD_PARTY",
                            "third_party_details": {"features": THIRD_PARTY_FEATURES},
                        }
                    },
                }
            ],
            "products": ["EXPRESS_CHECKOUT"],
            "legal_consents": [{"type": "SHARE_DATA_CONSENT", "granted": True}],
            "partner_config_override": {"return_url": return_url},
        }
        return await self._request(
            "POST", "/v2/customer/partner-referrals", json_body=body, request_id=f"referral-{tracking_id}"
        )

    async def get_merchant_integration(self, merchant_id: str) -> dict[str, Any]:
        partner_id = self._settings.paypal_partner_merchant_id
        return await self._request("GET", f"/v1/customer/partners/{partner_id}/merchant-integrations/{merchant_id}")

    # -------------------------------------------------------------- disputes

    async def list_disputes(
        self, merchant_id: str, *, update_time_after: datetime | None = None, page_size: int = 50
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"page_size": page_size}
        if update_time_after:
            params["update_time_after"] = _iso(update_time_after)
        items: list[dict[str, Any]] = []
        for _ in range(100):  # hard stop against a pagination loop
            page = await self._request("GET", "/v1/customer/disputes", merchant_id=merchant_id, params=params)
            items.extend(page.get("items", []))
            next_token = _next_page_token(page)
            if not next_token:
                break
            params = {"page_size": page_size, "next_page_token": next_token}
        return items

    async def get_dispute(self, merchant_id: str, dispute_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/v1/customer/disputes/{dispute_id}", merchant_id=merchant_id)

    async def provide_evidence(
        self,
        merchant_id: str,
        dispute_id: str,
        input_json: dict[str, Any],
        files: list[EvidenceFile],
        *,
        request_id: str,
    ) -> dict[str, Any]:
        parts: list[tuple[str, tuple[str | None, bytes | str, str]]] = [
            ("input", (None, json.dumps(input_json), "application/json"))
        ]
        parts += [("evidence-file", (f.filename, f.content, f.content_type)) for f in files]
        return await self._request(
            "POST",
            f"/v1/customer/disputes/{dispute_id}/provide-evidence",
            merchant_id=merchant_id,
            files=parts,
            request_id=request_id,
        )

    async def make_offer(
        self, merchant_id: str, dispute_id: str, body: dict[str, Any], *, request_id: str
    ) -> dict[str, Any]:
        return await self._request(
            "POST",
            f"/v1/customer/disputes/{dispute_id}/make-offer",
            merchant_id=merchant_id,
            json_body=body,
            request_id=request_id,
        )

    async def accept_claim(
        self, merchant_id: str, dispute_id: str, body: dict[str, Any], *, request_id: str
    ) -> dict[str, Any]:
        return await self._request(
            "POST",
            f"/v1/customer/disputes/{dispute_id}/accept-claim",
            merchant_id=merchant_id,
            json_body=body,
            request_id=request_id,
        )

    # ------------------------------------------------- transactions/tracking

    async def search_transactions(
        self,
        merchant_id: str,
        *,
        start: datetime,
        end: datetime,
        transaction_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Transaction Search. PayPal caps a single query at a 31-day window."""
        params: dict[str, Any] = {"start_date": _iso(start), "end_date": _iso(end), "fields": "all", "page_size": 500}
        if transaction_id:
            params["transaction_id"] = transaction_id
        results: list[dict[str, Any]] = []
        page = 1
        while True:
            params["page"] = page
            body = await self._request("GET", "/v1/reporting/transactions", merchant_id=merchant_id, params=params)
            results.extend(body.get("transaction_details", []))
            if page >= int(body.get("total_pages", 1) or 1) or page >= 20:
                break
            page += 1
        return results

    async def get_trackers(self, merchant_id: str, transaction_id: str) -> list[dict[str, Any]]:
        body = await self._request(
            "GET", "/v1/shipping/trackers", merchant_id=merchant_id, params={"transaction_id": transaction_id}
        )
        return body.get("trackers", [])

    # ---------------------------------------------------------------- orders

    async def create_order(
        self, *, amount: str, currency: str, description: str, reference_id: str, request_id: str
    ) -> dict[str, Any]:
        """Checkout order paid to the app's own sandbox business account (no assertion, so the partner
        account is the payee). `request_id` makes a retried create return the same order."""
        body = {
            "intent": "CAPTURE",
            "purchase_units": [
                {
                    "reference_id": reference_id,
                    "description": description,
                    "amount": {"currency_code": currency, "value": amount},
                }
            ],
        }
        return await self._request("POST", "/v2/checkout/orders", json_body=body, request_id=request_id)

    async def get_order(self, order_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/v2/checkout/orders/{order_id}")

    async def capture_order(self, order_id: str, *, request_id: str) -> dict[str, Any]:
        # An empty JSON body, so PayPal sees the Content-Type it requires.
        return await self._request(
            "POST", f"/v2/checkout/orders/{order_id}/capture", json_body={}, request_id=request_id
        )

    # ------------------------------------------------------- payouts/balances

    async def create_payout_batch(
        self, *, sender_batch_id: str, items: list[dict[str, Any]], email_subject: str
    ) -> dict[str, Any]:
        """Payouts from the app's own sandbox business account. `sender_batch_id` doubles as the
        PayPal-Request-Id, so a retried call returns the first response instead of paying twice."""
        body = {
            "sender_batch_header": {"sender_batch_id": sender_batch_id, "email_subject": email_subject},
            "items": items,
        }
        return await self._request("POST", "/v1/payments/payouts", json_body=body, request_id=sender_batch_id)

    async def get_payout_batch(self, payout_batch_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/v1/payments/payouts/{payout_batch_id}", params={"page_size": 1000})

    async def get_capture(self, capture_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/v2/payments/captures/{capture_id}")

    async def list_balances(self, currency: str) -> dict[str, Any]:
        """The app account's own balances. The sandbox may return nothing useful; callers fall back."""
        return await self._request("GET", "/v1/reporting/balances", params={"currency_code": currency})

    # -------------------------------------------------------------- webhooks

    async def verify_webhook_signature(self, headers: dict[str, str], event: dict[str, Any]) -> bool:
        h = {k.lower(): v for k, v in headers.items()}
        body = {
            "auth_algo": h.get("paypal-auth-algo"),
            "cert_url": h.get("paypal-cert-url"),
            "transmission_id": h.get("paypal-transmission-id"),
            "transmission_sig": h.get("paypal-transmission-sig"),
            "transmission_time": h.get("paypal-transmission-time"),
            "webhook_id": self._settings.paypal_webhook_id,
            "webhook_event": event,
        }
        if not all(body.values()):
            return False
        result = await self._request("POST", "/v1/notifications/verify-webhook-signature", json_body=body)
        return result.get("verification_status") == "SUCCESS"


def _next_page_token(page: dict[str, Any]) -> str | None:
    for link in page.get("links", []):
        if link.get("rel") == "next" and link.get("href"):
            values = parse_qs(urlparse(link["href"]).query).get("next_page_token")
            if values:
                return values[0]
    return None


def _json_or_text(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return resp.text
