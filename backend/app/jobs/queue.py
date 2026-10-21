"""A small Postgres job queue (FOR UPDATE SKIP LOCKED)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from psycopg import AsyncConnection

from app.db import jsonb

MAX_ATTEMPTS = 5


async def enqueue(
    conn: AsyncConnection,
    kind: str,
    payload: dict[str, Any],
    *,
    dedupe_key: str | None = None,
    run_at: datetime | None = None,
) -> None:
    await conn.execute(
        """
        insert into jobs (kind, payload, dedupe_key, run_at)
        values (%s, %s, %s, coalesce(%s, now()))
        on conflict (dedupe_key) where status in ('queued', 'running') do nothing
        """,
        (kind, jsonb(payload), dedupe_key, run_at),
    )


async def claim(conn: AsyncConnection) -> dict[str, Any] | None:
    cur = await conn.execute(
        """
        update jobs set status = 'running', attempts = attempts + 1, updated_at = now()
        where id = (
          select id from jobs where status = 'queued' and run_at <= now()
          order by run_at for update skip locked limit 1
        )
        returning *
        """
    )
    return await cur.fetchone()


async def complete(conn: AsyncConnection, job_id: int) -> None:
    await conn.execute("update jobs set status = 'done', updated_at = now() where id = %s", (job_id,))


async def fail(conn: AsyncConnection, job: dict[str, Any], error: str) -> None:
    if job["attempts"] >= MAX_ATTEMPTS:
        await conn.execute(
            "update jobs set status = 'failed', last_error = %s, updated_at = now() where id = %s",
            (error[:2000], job["id"]),
        )
        return
    retry_at = datetime.now(timezone.utc) + timedelta(seconds=30 * 2 ** job["attempts"])
    await conn.execute(
        "update jobs set status = 'queued', run_at = %s, last_error = %s, updated_at = now() where id = %s",
        (retry_at, error[:2000], job["id"]),
    )
