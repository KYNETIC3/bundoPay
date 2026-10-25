import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.db import close_pool, connection, open_pool
from app.deps import close_gateway
from app.agent.router import router as agent_router
from app.demo.router import router as demo_router
from app.disputes.router import router as disputes_router
from app.events import start_listener, stop_listener
from app.events_router import router as events_router
from app.onboarding.router import router as onboarding_router
from app.paypal_gateway import PayPalError, PermissionRevokedError, TransientPayPalError
from app.treasury.router import router as treasury_router
from app.treasury.service import TreasuryError
from app.webhooks.router import router as webhooks_router

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await open_pool()
    start_listener()
    worker_task = None
    if get_settings().run_worker_in_process:
        from app.jobs.worker import run_in_background

        worker_task = asyncio.create_task(run_in_background())
    yield
    if worker_task:
        worker_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await worker_task
    await stop_listener()
    await close_gateway()
    await close_pool()


app = FastAPI(title="BundoPay", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[get_settings().frontend_url],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(TreasuryError)
async def treasury_error(_request: Request, exc: TreasuryError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"detail": {"code": exc.code, "message": str(exc)}})


@app.exception_handler(PermissionRevokedError)
async def revoked(_: Request, exc: PermissionRevokedError) -> JSONResponse:
    return JSONResponse(
        status_code=409,
        content={"detail": {"code": "reconnect_required", "message": "PayPal no longer grants BundoPay access. Reconnect your account."}},
    )


@app.exception_handler(TransientPayPalError)
async def transient(_: Request, exc: TransientPayPalError) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={"detail": {"code": "paypal_unavailable", "message": "PayPal is not responding. Try again shortly.", "debug_id": exc.debug_id}},
    )


@app.exception_handler(PayPalError)
async def paypal_error(_: Request, exc: PayPalError) -> JSONResponse:
    # Handled here (inside the CORS middleware) so the browser sees PayPal's message, not "Failed to fetch".
    if exc.status == 403 and exc.name == "NOT_AUTHORIZED":
        message = "PayPal hasn't given this app permission for that action. " + (exc.message or "")
    else:
        message = f"PayPal returned an error: {exc.message or exc.name}"
    return JSONResponse(
        status_code=502,
        content={"detail": {"code": "paypal_error", "paypal_name": exc.name, "message": message.strip(), "debug_id": exc.debug_id}},
    )


@app.get("/health")
async def health() -> dict[str, str]:
    # Touches the database so the keep-awake ping also keeps the hosted Supabase project active.
    async with connection() as conn:
        await conn.execute("select 1")
    return {"status": "ok"}


app.include_router(onboarding_router)
app.include_router(disputes_router)
app.include_router(webhooks_router)
app.include_router(agent_router)
app.include_router(events_router)
app.include_router(treasury_router)
app.include_router(demo_router)
