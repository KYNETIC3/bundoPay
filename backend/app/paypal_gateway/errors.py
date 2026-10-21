"""Normalized PayPal errors. Callers never see raw httpx exceptions."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class PayPalError(Exception):
    status: int
    name: str
    message: str
    debug_id: str | None = None
    details: list[dict[str, Any]] = field(default_factory=list)

    def __str__(self) -> str:
        return f"PayPal {self.status} {self.name}: {self.message} (debug_id={self.debug_id})"

    @classmethod
    def from_response(cls, status: int, body: Any) -> "PayPalError":
        if not isinstance(body, dict):
            return cls(status=status, name="UNKNOWN_ERROR", message=str(body)[:500])
        # Identity endpoints use OAuth-style {error, error_description}; REST APIs use {name, message}.
        name = body.get("name") or body.get("error") or "UNKNOWN_ERROR"
        message = body.get("message") or body.get("error_description") or ""
        return cls(
            status=status,
            name=name,
            message=message,
            debug_id=body.get("debug_id"),
            details=body.get("details") or [],
        )


class PermissionRevokedError(PayPalError):
    """The merchant's third-party grant is missing or revoked (401/403 on a merchant-scoped call)."""


class TransientPayPalError(PayPalError):
    """Retries exhausted on 429/5xx/network failure."""
