"""Server-sent events: tells the signed-in merchant's browser when one of their disputes changed."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app import events
from app.auth import CurrentMerchant, current_merchant

router = APIRouter()

PING_SECONDS = 20.0


async def _stream(merchant_id: str, queue: asyncio.Queue) -> AsyncIterator[str]:
    try:
        yield ": connected\n\n"
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=PING_SECONDS)
            except TimeoutError:
                # Keeps proxies from closing an idle stream and lets the browser notice a dead one.
                yield ": ping\n\n"
                continue
            yield f"event: {events.CHANNEL}\ndata: {json.dumps(event)}\n\n"
    finally:
        # Runs when the client disconnects and Starlette cancels the stream.
        events.unsubscribe(merchant_id, queue)


@router.get("/events")
async def stream_events(merchant: CurrentMerchant = Depends(current_merchant)) -> StreamingResponse:
    merchant_id = str(merchant.id)
    queue = events.subscribe(merchant_id)
    return StreamingResponse(
        _stream(merchant_id, queue),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
