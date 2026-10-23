"""Merchant app accounts are Supabase Auth users; the frontend sends their access token as a Bearer header."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from uuid import UUID

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import get_settings
from app.db import connection

bearer = HTTPBearer(auto_error=False)
_known_merchants: set[UUID] = set()


@dataclass
class CurrentMerchant:
    id: UUID
    email: str


@lru_cache
def _jwks_client() -> jwt.PyJWKClient:
    return jwt.PyJWKClient(f"{get_settings().supabase_url}/auth/v1/.well-known/jwks.json")


def decode_supabase_token(token: str) -> dict:
    settings = get_settings()
    opts = {"audience": "authenticated"}
    if settings.supabase_jwt_secret:
        return jwt.decode(token, settings.supabase_jwt_secret, algorithms=["HS256"], **opts)
    key = _jwks_client().get_signing_key_from_jwt(token)
    return jwt.decode(token, key.key, algorithms=["ES256", "RS256"], **opts)


async def current_merchant(creds: HTTPAuthorizationCredentials | None = Depends(bearer)) -> CurrentMerchant:
    if creds is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in required")
    try:
        claims = decode_supabase_token(creds.credentials)
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid session") from exc
    merchant = CurrentMerchant(id=UUID(claims["sub"]), email=claims.get("email", ""))
    if merchant.id not in _known_merchants:  # create the row once per process, not on every request
        async with connection() as conn:
            await conn.execute(
                "insert into merchants (id, email) values (%s, %s) on conflict (id) do nothing",
                (merchant.id, merchant.email),
            )
        _known_merchants.add(merchant.id)
    return merchant
