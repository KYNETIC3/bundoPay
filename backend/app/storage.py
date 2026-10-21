"""Evidence files in a private Supabase Storage bucket, accessed with the service role key."""

from __future__ import annotations

import httpx

from app.config import get_settings


def _headers() -> dict[str, str]:
    key = get_settings().supabase_service_role_key
    return {"Authorization": f"Bearer {key}", "apikey": key}


def _url(path: str) -> str:
    s = get_settings()
    return f"{s.supabase_url}/storage/v1/object/{s.evidence_bucket}/{path}"


async def put_object(path: str, content: bytes, content_type: str) -> None:
    async with httpx.AsyncClient(timeout=60) as http:
        resp = await http.post(
            _url(path), content=content, headers={**_headers(), "Content-Type": content_type, "x-upsert": "false"}
        )
        resp.raise_for_status()


async def get_object(path: str) -> bytes:
    async with httpx.AsyncClient(timeout=60) as http:
        resp = await http.get(_url(path), headers=_headers())
        resp.raise_for_status()
        return resp.content
