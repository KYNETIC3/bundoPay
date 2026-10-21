"""HMAC-signed approval tokens bound to the SHA-256 hash of one exact payload and file set.

A token is minted only when the merchant clicks Approve. Its hash, not the token, is stored.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

VERSION = "v1"


class ApprovalError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ApprovalClaims:
    draft_id: str
    merchant_id: str
    payload_hash: str
    issued_at: int
    expires_at: int
    nonce: str


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _sign(key: str, message: str) -> str:
    if len(key) < 32:
        raise ApprovalError("misconfigured", "APPROVAL_SIGNING_KEY must be at least 32 characters")
    return _b64(hmac.new(key.encode(), message.encode(), hashlib.sha256).digest())


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def issue(
    key: str, *, draft_id: str, merchant_id: str, payload_hash: str, ttl_seconds: int, now: datetime | None = None
) -> tuple[str, ApprovalClaims]:
    now = now or datetime.now(timezone.utc)
    claims = ApprovalClaims(
        draft_id=str(draft_id),
        merchant_id=str(merchant_id),
        payload_hash=payload_hash,
        issued_at=int(now.timestamp()),
        expires_at=int((now + timedelta(seconds=ttl_seconds)).timestamp()),
        nonce=secrets.token_hex(16),
    )
    body = _b64(json.dumps(claims.__dict__, sort_keys=True, separators=(",", ":")).encode())
    signed = f"{VERSION}.{body}"
    return f"{signed}.{_sign(key, signed)}", claims


def verify(key: str, token: str | None, now: datetime | None = None) -> ApprovalClaims:
    if not token:
        raise ApprovalError("missing_token", "Submission requires an approval token")
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != VERSION:
        raise ApprovalError("malformed_token", "Approval token is malformed")
    signed = f"{parts[0]}.{parts[1]}"
    if not hmac.compare_digest(_sign(key, signed), parts[2]):
        raise ApprovalError("bad_signature", "Approval token signature is invalid")
    try:
        claims = ApprovalClaims(**json.loads(_unb64(parts[1])))
    except (ValueError, TypeError) as exc:
        raise ApprovalError("malformed_token", "Approval token claims are unreadable") from exc
    now = now or datetime.now(timezone.utc)
    if now.timestamp() >= claims.expires_at:
        raise ApprovalError("expired_token", "Approval has expired; approve again")
    return claims
