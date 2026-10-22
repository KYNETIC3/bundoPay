import asyncio
import json
from uuid import uuid4

from app import events
from app.auth import CurrentMerchant, current_merchant
from app.main import app

MINE, THEIRS = str(uuid4()), str(uuid4())


async def test_fan_out_reaches_only_the_matching_merchant():
    mine, also_mine, theirs = events.subscribe(MINE), events.subscribe(MINE), events.subscribe(THEIRS)
    try:
        events.publish({"merchant_id": MINE, "dispute_id": "d1"})
        assert mine.get_nowait() == {"merchant_id": MINE, "dispute_id": "d1"}
        assert also_mine.get_nowait()["dispute_id"] == "d1"
        assert theirs.empty()
    finally:
        for merchant, queue in ((MINE, mine), (MINE, also_mine), (THEIRS, theirs)):
            events.unsubscribe(merchant, queue)
    assert MINE not in events._subscribers and THEIRS not in events._subscribers


async def test_sse_endpoint_streams_the_merchants_events_and_unsubscribes_on_disconnect():
    app.dependency_overrides[current_merchant] = lambda: CurrentMerchant(id=MINE, email="m@example.com")
    sent: asyncio.Queue[dict] = asyncio.Queue()
    disconnected = asyncio.Event()

    async def receive():
        await disconnected.wait()
        return {"type": "http.disconnect"}

    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET", "scheme": "http",
        "path": "/events", "raw_path": b"/events", "query_string": b"", "root_path": "",
        "headers": [(b"host", b"test"), (b"authorization", b"Bearer test")],
        "client": ("test", 1), "server": ("test", 80),
    }
    try:
        task = asyncio.create_task(app(scope, receive, sent.put))
        start = await asyncio.wait_for(sent.get(), 2)
        assert start["status"] == 200
        assert dict(start["headers"])[b"content-type"].startswith(b"text/event-stream")
        assert (await asyncio.wait_for(sent.get(), 2))["body"] == b": connected\n\n"

        events.publish({"merchant_id": THEIRS, "dispute_id": "other"})
        events.publish({"merchant_id": MINE, "dispute_id": "d1"})
        body = (await asyncio.wait_for(sent.get(), 2))["body"].decode()
        assert body.startswith("event: dispute_changed\ndata: ") and body.endswith("\n\n")
        assert json.loads(body.split("data: ", 1)[1]) == {"merchant_id": MINE, "dispute_id": "d1"}

        disconnected.set()
        await asyncio.wait_for(task, 2)
        assert MINE not in events._subscribers
    finally:
        app.dependency_overrides.clear()


async def test_sse_endpoint_pings_an_idle_stream(monkeypatch):
    from app import events_router

    monkeypatch.setattr(events_router, "PING_SECONDS", 0.01)
    queue = events.subscribe(MINE)
    stream = events_router._stream(MINE, queue)
    assert await anext(stream) == ": connected\n\n"
    assert await anext(stream) == ": ping\n\n"
    await stream.aclose()
    assert MINE not in events._subscribers
