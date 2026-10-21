"""Settings. Partner credentials come from the environment only; nothing merchant-secret is ever configured."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # PayPal partner app (sandbox only).
    paypal_partner_client_id: str = ""
    paypal_partner_client_secret: str = ""
    paypal_partner_merchant_id: str = ""  # the partner's own payer ID, used in merchant-integrations lookups
    paypal_webhook_id: str = ""
    paypal_base_url: str = SANDBOX_BASE_URL

    # Supabase.
    database_url: str = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
    supabase_url: str = "http://127.0.0.1:54321"
    supabase_service_role_key: str = ""
    supabase_jwt_secret: str = ""  # HS256 secret; when empty, tokens are verified against the project's JWKS
    evidence_bucket: str = "evidence"

    # Approvals.
    approval_signing_key: str = Field(default="", description="HMAC key for approval tokens")
    approval_token_ttl_seconds: int = 600

    # Agent.
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.5-flash"

    # App.
    frontend_url: str = "http://localhost:3000"
    poll_interval_minutes: int = 15


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    if settings.paypal_base_url != SANDBOX_BASE_URL:
        raise RuntimeError("Dispute Agent is sandbox-only; PAYPAL_BASE_URL must be the sandbox host.")
    return settings
