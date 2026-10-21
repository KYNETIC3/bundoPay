import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.db import close_pool, open_pool
from app.deps import close_gateway
from app.disputes.router import router as disputes_router
from app.onboarding.router import router as onboarding_router
from app.paypal_gateway import PermissionRevokedError, TransientPayPalError
from app.webhooks.router import router as webhooks_router

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await open_pool()
    yield
    await close_gateway()
    await close_pool()


app = FastAPI(title="BundoPay", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[get_settings().frontend_url],
    allow_methods=["*"],
    allow_headers=["*"],
)


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


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(onboarding_router)
app.include_router(disputes_router)
app.include_router(webhooks_router)
