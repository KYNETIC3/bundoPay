import base64
import json

import httpx
import pytest

from app.paypal_gateway import (
    THIRD_PARTY_FEATURES,
    EvidenceFile,
    PayPalError,
    PayPalGateway,
    PermissionRevokedError,
    TransientPayPalError,
    auth_assertion,
)


def _decode(segment: str) -> dict:
    return json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))


def test_auth_assertion_shape():
    token = auth_assertion("PARTNER_CLIENT", "MERCHANT123")
    assert token.endswith(".")
    header, payload, signature = token.split(".")
    assert signature == ""
    assert "=" not in header + payload
    assert _decode(header) == {"alg": "none"}
    assert _decode(payload) == {"iss": "PARTNER_CLIENT", "payer_id": "MERCHANT123"}


def test_gateway_refuses_non_sandbox_host(settings):
    live = settings.model_copy(update={"paypal_base_url": "https://api-m.paypal.com"})
    with pytest.raises(RuntimeError):
        PayPalGateway(live)


async def test_merchant_call_sends_assertion_and_caches_token(gateway, paypal):
    route = paypal.get("/v1/customer/disputes/PP-D-1").mock(
        return_value=httpx.Response(200, json={"dispute_id": "PP-D-1"})
    )
    await gateway.get_dispute("MERCHANT123", "PP-D-1")
    await gateway.get_dispute("MERCHANT123", "PP-D-1")

    assert paypal.routes[0].call_count == 1  # token fetched once, then cached
    req = route.calls.last.request
    assert req.headers["Authorization"] == "Bearer A21-token"
    assert req.headers["PayPal-Auth-Assertion"] == auth_assertion("PARTNER_CLIENT", "MERCHANT123")


async def test_partner_referral_requests_exact_features(gateway, paypal):
    route = paypal.post("/v2/customer/partner-referrals").mock(
        return_value=httpx.Response(
            201, json={"links": [{"rel": "action_url", "href": "https://www.sandbox.paypal.com/x"}]}
        )
    )
    await gateway.create_partner_referral(tracking_id="trk-1", return_url="http://localhost:3000/onboarding/return")
    req = route.calls.last.request
    body = json.loads(req.content)
    details = body["operations"][0]["api_integration_preference"]["rest_api_integration"]["third_party_details"]
    assert details["features"] == THIRD_PARTY_FEATURES
    assert req.headers["PayPal-Request-Id"] == "referral-trk-1"
    assert "PayPal-Auth-Assertion" not in req.headers


async def test_get_retries_transient_errors(gateway, paypal):
    route = paypal.get("/v1/customer/disputes/PP-D-1").mock(
        side_effect=[
            httpx.Response(503, json={"name": "SERVICE_UNAVAILABLE"}),
            httpx.ConnectError("boom"),
            httpx.Response(200, json={"dispute_id": "PP-D-1"}),
        ]
    )
    assert (await gateway.get_dispute("M", "PP-D-1"))["dispute_id"] == "PP-D-1"
    assert route.call_count == 3


async def test_retries_exhausted_raise_transient(gateway, paypal):
    paypal.get("/v1/customer/disputes/PP-D-1").mock(
        return_value=httpx.Response(500, json={"name": "INTERNAL_SERVER_ERROR", "message": "x", "debug_id": "d1"})
    )
    with pytest.raises(TransientPayPalError) as exc:
        await gateway.get_dispute("M", "PP-D-1")
    assert exc.value.debug_id == "d1"


async def test_write_without_request_id_is_not_retried(settings, paypal):
    async def no_sleep(_):
        return None

    gw = PayPalGateway(settings, sleep=no_sleep)
    route = paypal.post("/v1/notifications/verify-webhook-signature").mock(
        return_value=httpx.Response(503, json={"name": "SERVICE_UNAVAILABLE"})
    )
    headers = {
        "PAYPAL-AUTH-ALGO": "SHA256withRSA",
        "PAYPAL-CERT-URL": "https://api.sandbox.paypal.com/cert",
        "PAYPAL-TRANSMISSION-ID": "t1",
        "PAYPAL-TRANSMISSION-SIG": "sig",
        "PAYPAL-TRANSMISSION-TIME": "2026-10-21T00:00:00Z",
    }
    with pytest.raises(TransientPayPalError):
        await gw.verify_webhook_signature(headers, {"id": "WH-EVT"})
    assert route.call_count == 1
    await gw.aclose()


async def test_provide_evidence_is_multipart_with_idempotency_key(gateway, paypal):
    route = paypal.post("/v1/customer/disputes/PP-D-1/provide-evidence").mock(
        side_effect=[httpx.Response(502), httpx.Response(200, json={"links": []})]
    )
    await gateway.provide_evidence(
        "M",
        "PP-D-1",
        {"evidences": [{"evidence_type": "PROOF_OF_FULFILLMENT", "notes": "Shipped."}]},
        [EvidenceFile("label.pdf", b"%PDF-1.4", "application/pdf")],
        request_id="submit-abc",
    )
    assert route.call_count == 2  # retried because the write carries a PayPal-Request-Id
    req = route.calls.last.request
    assert req.headers["PayPal-Request-Id"] == "submit-abc"
    assert req.headers["Content-Type"].startswith("multipart/form-data")
    assert b'name="input"' in req.content and b'name="evidence-file"; filename="label.pdf"' in req.content


async def test_403_on_merchant_call_means_revoked(gateway, paypal):
    paypal.get("/v1/customer/disputes").mock(
        return_value=httpx.Response(403, json={"name": "NOT_AUTHORIZED", "message": "no permission"})
    )
    with pytest.raises(PermissionRevokedError):
        await gateway.list_disputes("M")


async def test_401_refreshes_token_once_then_reports_revoked(gateway, paypal):
    route = paypal.get("/v1/customer/disputes/PP-D-1").mock(
        return_value=httpx.Response(401, json={"error": "invalid_token", "error_description": "expired"})
    )
    with pytest.raises(PermissionRevokedError):
        await gateway.get_dispute("M", "PP-D-1")
    assert route.call_count == 2
    assert paypal.routes[0].call_count == 2  # forced token refresh


async def test_errors_are_normalized(gateway, paypal):
    paypal.get("/v1/customer/disputes/BAD").mock(
        return_value=httpx.Response(
            404,
            json={"name": "RESOURCE_NOT_FOUND", "message": "missing", "debug_id": "abc", "details": [{"issue": "X"}]},
        )
    )
    with pytest.raises(PayPalError) as exc:
        await gateway.get_dispute("M", "BAD")
    err = exc.value
    assert (err.status, err.name, err.debug_id, err.details) == (404, "RESOURCE_NOT_FOUND", "abc", [{"issue": "X"}])
    assert not isinstance(err, PermissionRevokedError)


async def test_list_disputes_follows_pagination(gateway, paypal):
    route = paypal.get("/v1/customer/disputes").mock(
        side_effect=[
            httpx.Response(
                200,
                json={
                    "items": [{"dispute_id": "A"}],
                    "links": [{"rel": "next", "href": "https://api-m.sandbox.paypal.com/v1/customer/disputes?next_page_token=tok2"}],
                },
            ),
            httpx.Response(200, json={"items": [{"dispute_id": "B"}], "links": []}),
        ]
    )
    items = await gateway.list_disputes("M")
    assert [i["dispute_id"] for i in items] == ["A", "B"]
    assert route.calls.last.request.url.params["next_page_token"] == "tok2"


async def test_webhook_verification(gateway, paypal):
    route = paypal.post("/v1/notifications/verify-webhook-signature").mock(
        return_value=httpx.Response(200, json={"verification_status": "SUCCESS"})
    )
    headers = {
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
        "paypal-transmission-id": "t1",
        "paypal-transmission-sig": "sig",
        "paypal-transmission-time": "2026-10-21T00:00:00Z",
    }
    assert await gateway.verify_webhook_signature(headers, {"id": "WH-EVT"}) is True
    assert json.loads(route.calls.last.request.content)["webhook_id"] == "WH-1"
    # Missing headers never reach PayPal.
    assert await gateway.verify_webhook_signature({}, {"id": "WH-EVT"}) is False
    assert route.call_count == 1
