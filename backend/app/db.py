from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from app.config import get_settings

_pool: AsyncConnectionPool | None = None


async def open_pool() -> AsyncConnectionPool:
    global _pool
    if _pool is None:
        _pool = AsyncConnectionPool(
            get_settings().database_url,
            # TCP keepalives stop the pooler/network from silently dropping idle connections. This replaces
            # a per-checkout liveness check, which cost a ~0.5s round trip to the hosted database every time.
            kwargs={"row_factory": dict_row, "keepalives": 1, "keepalives_idle": 30, "keepalives_interval": 10, "keepalives_count": 3},
            min_size=2,  # one warm connection for the request in flight, one for the next
            max_size=5,  # API + worker stay under the Supabase session-pooler limit
            max_idle=120,  # recycle idle connections before the pooler or network drops them
            open=False,
        )
        await _pool.open()
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


@asynccontextmanager
async def connection() -> AsyncIterator[AsyncConnection[dict[str, Any]]]:
    pool = await open_pool()
    async with pool.connection() as conn:
        yield conn


def jsonb(value: Any) -> Jsonb:
    return Jsonb(value)
