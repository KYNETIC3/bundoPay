import base64
import json


def _b64url(data: dict) -> str:
    raw = json.dumps(data, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def auth_assertion(partner_client_id: str, merchant_id: str) -> str:
    """Unsigned JWT for PayPal-Auth-Assertion: header {"alg":"none"}, empty signature, trailing dot."""
    if not partner_client_id or not merchant_id:
        raise ValueError("partner_client_id and merchant_id are required for an auth assertion")
    header = _b64url({"alg": "none"})
    payload = _b64url({"iss": partner_client_id, "payer_id": merchant_id})
    return f"{header}.{payload}."
