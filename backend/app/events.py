"""Live dispute updates: Postgres NOTIFY from whichever process changed a row, fanned out to browser streams.

The worker and the API are separate processes, so changes travel through `pg_notify`. The API keeps one
dedicated LISTEN connection (outside the pool) and hands each notification to that merchant's open streams.
LISTEN needs a session connection: point DATABASE_URL at the Supabase session pooler (port 5432), not the
transaction pooler (6543), which drops LISTEN registrations between transactions.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any
from uuid import UUID

import psycopg
from psycopg import AsyncConnection

from app.config import get_settings

log = logging.getLogger("events")

CHANNEL = "dispute_changed"
QUEUE_SIZE = 100

_subscribers: dict[str, set[asyncio.Queue[dict[str, Any]]]] = {}
_listener: asyncio.Task[None] | None = None


async def notify_dispute_changed(conn: AsyncConnection, merchant_id: UUID | str, dispute_id: UUID | str) -> None:
    """Delivered when `conn`'s transaction commits, so listeners never see a change that rolled back."""
    payload = json.dumps({"merchant_id": str(merchant_id), "dispute_id": str(dispute_id)})
    await conn.execute("select pg_notify(%s, %s)", (CHANNEL, payload))


def subscribe(merchant_id: UUID | str) -> asyncio.Queue[dict[str, Any]]:
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=QUEUE_SIZE)
    _subscribers.setdefault(str(merchant_id), set()).add(queue)
    return queue


def unsubscribe(merchant_id: UUID | str, queue: asyncio.Queue[dict[str, Any]]) -> None:
    queues = _subscribers.get(str(merchant_id))
    if queues is None:
        return
    queues.discard(queue)
    if not queues:
        del _subscribers[str(merchant_id)]


def publish(event: dict[str, Any]) -> None:
    """Hand an event to every stream open for its merchant, and no one else's."""
    for queue in _subscribers.get(str(event.get("merchant_id")), ()):
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            # A stalled client misses this one; its regular poll still catches up.
            log.warning("Dropping event for a slow stream (merchant=%s)", event.get("merchant_id"))


async def listen_forever(initial_backoff: float = 2.0, max_backoff: float = 60.0) -> None:
    backoff = initial_backoff
    while True:
        try:
            async with await psycopg.AsyncConnection.connect(get_settings().database_url, autocommit=True) as conn:
                await conn.execute(f"listen {CHANNEL}")
                log.info("Listening for %s", CHANNEL)
                backoff = initial_backoff
                async for note in conn.notifies():
                    try:
                        publish(json.loads(note.payload))
                    except ValueError:
                        log.warning("Ignoring malformed %s payload: %r", CHANNEL, note.payload)
        except psycopg.OperationalError as exc:
            # A dropped connection or database blip shouldn't stop live updates; wait and reconnect.
            log.warning("Event listener lost the database (%s); retrying in %.0fs", str(exc).strip().splitlines()[0], backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, max_backoff)


def start_listener() -> None:
    global _listener
    if _listener is None:
        _listener = asyncio.create_task(listen_forever())


async def stop_listener() -> None:
    global _listener
    if _listener is not None:
        _listener.cancel()
        try:
            await _listener
        except asyncio.CancelledError:
            pass
        _listener = None
