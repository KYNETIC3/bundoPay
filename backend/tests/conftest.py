import httpx
import pytest
import respx

from app.config import SANDBOX_BASE_URL, Settings
from app.paypal_gateway import PayPalGateway


@pytest.fixture
def settings() -> Settings:
    return Settings(
        paypal_partner_client_id="PARTNER_CLIENT",
        paypal_partner_client_secret="PARTNER_SECRET",
        paypal_partner_merchant_id="PARTNERPAYERID",
        paypal_webhook_id="WH-1",
        approval_signing_key="test-signing-key-0123456789abcdef",
        _env_file=None,
    )


@pytest.fixture
def paypal():
    with respx.mock(base_url=SANDBOX_BASE_URL, assert_all_called=False) as mock:
        mock.post("/v1/oauth2/token").mock(
            return_value=httpx.Response(200, json={"access_token": "A21-token", "expires_in": 32400})
        )
        yield mock


@pytest.fixture
async def gateway(settings, paypal):
    async def no_sleep(_):
        return None

    gw = PayPalGateway(settings, sleep=no_sleep)
    yield gw
    await gw.aclose()
