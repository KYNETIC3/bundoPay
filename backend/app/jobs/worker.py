"""Background worker: drains the job queue and schedules the polling fallback.

Run with: uv run python -m app.jobs.worker
"""

from __future__ import annotations

import asyncio
import logging
from uuid import UUID

import psycopg
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from app.agent.orchestrator import run_agent
from app.config import get_settings
from app.db import close_pool, connection, open_pool
from app.deps import close_gateway
from app.disputes.sync import sync_dispute, sync_merchant
from app.executor.service import confirm_pending
from app.safety.engine import Trigger
from app.treasury.runner import run_policy
from app.treasury.triggers import TRIGGERS, enqueue_due_policies, on_dispute_synced
from app.paypal_gateway import PermissionRevokedError

from .queue import claim, complete, enqueue, fail

log = logging.getLogger("worker")


async def handle(job: dict) -> None:
    p = job["payload"]
    if job["kind"] == "sync_merchant":
        await sync_merchant(UUID(p["merchant_id"]))
    elif job["kind"] == "sync_dispute":
        await sync_dispute(UUID(p["merchant_id"]), p["paypal_merchant_id"], p["paypal_dispute_id"])
        async with connection() as conn:
            await on_dispute_synced(conn, p["merchant_id"], p["paypal_dispute_id"], trigger=p.get("trigger", "scheduler"))
    elif job["kind"] == "run_policy":
        # Jobs are written only by backend code paths that already established the trigger.
        source = p["trigger"] if p.get("trigger") in TRIGGERS else "untrusted"
        await run_policy(UUID(p["merchant_id"]), UUID(p["policy_id"]), trigger=Trigger(source, verified=source in TRIGGERS), slot=p["slot"])
    elif job["kind"] == "run_agent":
        await run_agent(UUID(p["dispute_id"]))
    elif job["kind"] == "confirm_payouts":
        await confirm_pending(UUID(p["merchant_id"]))
    else:
        raise ValueError(f"Unknown job kind {job['kind']}")


async def enqueue_polls() -> None:
    """Fallback for undelivered webhooks: re-sync every connected merchant."""
    async with connection() as conn:
        cur = await conn.execute("select id from merchants where grant_status = 'granted'")
        for m in await cur.fetchall():
            await enqueue(conn, "sync_merchant", {"merchant_id": str(m["id"])}, dedupe_key=f"sync:{m['id']}")


async def enqueue_payout_checks() -> None:
    """Fallback for undelivered payout webhooks: settle any batch still in flight."""
    async with connection() as conn:
        cur = await conn.execute(
            "select distinct merchant_id from movements where status in ('executing', 'unconfirmed') and batch_id is not null"
        )
        for m in await cur.fetchall():
            await enqueue(conn, "confirm_payouts", {"merchant_id": str(m["merchant_id"])}, dedupe_key=f"payouts:{m['merchant_id']}")


async def drain_forever(idle_sleep: float = 2.0, max_backoff: float = 60.0) -> None:
    backoff = idle_sleep
    while True:
        try:
            await _drain_one(idle_sleep)
            backoff = idle_sleep
        except psycopg.OperationalError as exc:
            # A dropped connection or database blip shouldn't kill the worker; wait and retry.
            log.warning("Database unavailable (%s); retrying in %.0fs", str(exc).strip().splitlines()[0], backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, max_backoff)


async def _drain_one(idle_sleep: float) -> None:
    async with connection() as conn:
        job = await claim(conn)
    if job is None:
        await asyncio.sleep(idle_sleep)
        return
    try:
        await handle(job)
    except PermissionRevokedError:
        log.warning("Job %s: merchant grant revoked; not retrying", job["id"])
        async with connection() as conn:
            await complete(conn, job["id"])
    except Exception as exc:
        log.exception("Job %s (%s) failed", job["id"], job["kind"])
        async with connection() as conn:
            await fail(conn, job, f"{type(exc).__name__}: {exc}")
    else:
        async with connection() as conn:
            await complete(conn, job["id"])


def make_scheduler() -> AsyncIOScheduler:
    settings = get_settings()
    scheduler = AsyncIOScheduler()
    scheduler.add_job(enqueue_polls, "interval", minutes=settings.poll_interval_minutes)
    scheduler.add_job(enqueue_payout_checks, "interval", minutes=2)
    scheduler.add_job(enqueue_due_policies, "interval", minutes=1)
    if settings.demo_email:
        from app.demo.service import reset_demo_account

        scheduler.add_job(reset_demo_account, "cron", hour=settings.demo_reset_hour_utc, minute=0)
    return scheduler


async def run_in_background() -> None:
    """The worker loop for an already-open pool, used when the API process hosts the worker."""
    scheduler = make_scheduler()
    scheduler.start()
    try:
        await enqueue_polls()
        await drain_forever()
    finally:
        scheduler.shutdown(wait=False)


async def main() -> None:
    logging.basicConfig(level=logging.INFO)
    await open_pool()
    scheduler = make_scheduler()
    scheduler.start()
    await enqueue_polls()
    try:
        await drain_forever()
    finally:
        scheduler.shutdown()
        await close_gateway()
        await close_pool()


if __name__ == "__main__":
    asyncio.run(main())
