import asyncio

import psycopg
import pytest

from app.jobs import worker


async def test_worker_survives_dropped_database_connection(monkeypatch):
    calls = []
    sleeps = []

    async def flaky(_idle):
        calls.append(1)
        if len(calls) <= 2:
            raise psycopg.OperationalError("SSL SYSCALL error: Operation timed out")
        raise asyncio.CancelledError  # stop the loop once it has recovered

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(worker, "_drain_one", flaky)
    monkeypatch.setattr(worker.asyncio, "sleep", fake_sleep)
    with pytest.raises(asyncio.CancelledError):
        await worker.drain_forever(idle_sleep=2.0)
    assert len(calls) == 3  # kept running after two database failures
    assert sleeps == [2.0, 4.0]  # backed off between attempts
