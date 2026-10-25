"""Settings. Partner credentials come from the environment only; nothing merchant-secret is ever configured."""

from functools import lru_cache
from urllib.parse import quote

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
    # Developer-only: let a signed-in user use the partner app's own business account as their merchant,
    # for testing before PayPal approves partner onboarding. Never enable outside the sandbox.
    paypal_dev_self_merchant: bool = False

    # Supabase.
    database_url: str = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
    database_password: str = ""  # substituted for YOUR-PASSWORD in database_url, URL-encoded
    supabase_url: str = "http://127.0.0.1:54321"
    supabase_service_role_key: str = ""
    supabase_jwt_secret: str = ""  # HS256 secret; when empty, tokens are verified against the project's JWKS
    evidence_bucket: str = "evidence"

    # Approvals.
    approval_signing_key: str = Field(default="", description="HMAC key for approval tokens")
    approval_token_ttl_seconds: int = 600
    # HMAC key for the audit-log chain; falls back to the approval key when empty.
    audit_chain_key: str = ""

    # Agent.
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.8-flash"
    gemini_fallback_model: str = "gemini-3.5-flash-lite"  # used when the main model is busy or out of quota

    # App.
    frontend_url: str = "http://localhost:3000"
    poll_interval_minutes: int = 15
    # Run the job worker inside the API process (for hosts with a single free web service, like Render).
    run_worker_in_process: bool = False

    # Hosted demo. Empty demo_email turns the demo features off.
    demo_email: str = ""
    demo_password: str = ""  # read only by `python -m app.demo` when it creates the account
    # Four sandbox account emails, comma-separated: operating, tax reserve, dispute buffer, ad spend.
    demo_account_emails: str = ""
    demo_reset_hour_utc: int = 3
    # Gemini calls each signed-in user may make per rolling 10 minutes (chat and copilot).
    llm_requests_per_10_minutes: int = 20


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    if settings.database_password and "YOUR-PASSWORD" in settings.database_url:
        settings.database_url = settings.database_url.replace("YOUR-PASSWORD", quote(settings.database_password, safe=""))
    if settings.paypal_base_url != SANDBOX_BASE_URL:
        raise RuntimeError("BundoPay is sandbox-only; PAYPAL_BASE_URL must be the sandbox host.")
    return settings
