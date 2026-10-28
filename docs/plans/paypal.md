# Plan: good use of PayPal (Checkout, JS SDK v6, Agent Toolkit)

Branch `feat/paypal-checkout-agent-toolkit`. This is one of three separate plans. The other two are the judge demo (`docs/plans/demo.md`) and AG Grid/AG Studio (`docs/plans/ag-grid-studio.md`).

## Why

The hackathon features PayPal Checkout, the JavaScript SDK v6, the REST APIs, the sandbox and the PayPal Agent Toolkit. BundoPay already used the REST APIs deeply: Disputes, Transaction Search, Tracking, Payouts, Partner Referrals and webhooks. It didn't use Checkout, the JS SDK or the Agent Toolkit.

There was also a gap in the demo: a sale reaching the tax reserve had never been tested live, because there was no way to make a sale.

## What this branch adds

### 1. A test store, using PayPal Checkout and the JS SDK v6
- **`/store`** (`frontend/src/app/store/page.tsx`): a public page for the sandbox *buyer*, outside the merchant app.
  - It loads `https://www.sandbox.paypal.com/web-sdk/v6/core` and starts it with the client ID (`createInstance`).
  - It shows the PayPal button only if `findEligibleMethods` says PayPal is available.
  - It pays with `createPayPalOneTimePaymentSession`, using `presentationMode: "auto"`. That opens a pop-up, or an in-page window if pop-ups are blocked.
- **Backend** (`backend/app/checkout/`):
  - `GET /checkout/config` returns the public client ID and the catalog.
  - `POST /checkout/orders` takes only a product ID. **The price comes from the server's catalog.** It is sent with a `PayPal-Request-Id`.
  - `POST /checkout/orders/{id}/capture` is idempotent through `capture-{id}`.
  - Both POST routes are rate-limited per IP.
- **The loop it closes:** a captured sale is a real sandbox capture.
  - `PAYMENT.CAPTURE.COMPLETED`, which already existed and is signature-verified, re-fetches it and runs the tax reserve.
  - The capture route also records the sale straight away for the merchant using the app's own account, so it works on a laptop without webhooks.
  - The capture ID keeps it to once.
- **Gateway** (`paypal_gateway/client.py`): `create_order`, `get_order`, `capture_order`. The app's own account is the payee, so no auth assertion is sent.

### 2. The PayPal Agent Toolkit in Ask Bundo
- **`backend/app/agent/paypal_toolkit.py`** uses the toolkit's framework-neutral layer (`paypal_agent_toolkit.shared`). It turns the toolkit's own tool definitions and pydantic schemas into Gemini function declarations, prefixed `paypal_`.
- **Who gets it:** only the merchant whose PayPal account *is* the app's account (the hosted judge login, or "Use test account"). The toolkit signs in with the app's credentials. It is sandbox only.
- **Reads, which run directly:**
  - `list_transactions`
  - `get_order_details`
  - `get_shipment_tracking`
  - `list_disputes`
  - `get_dispute`

  Each call is audited (`agent.tool_call`, `via: paypal-agent-toolkit`), and large results are trimmed. The reply gets a **Live from PayPal** label.
- **One gated write, `create_shipment_tracking`:**
  - The model calling it only stores a proposal in `paypal_actions` (migration `20261028090000_paypal_actions.sql`).
  - Ask Bundo shows a card listing the tracking number, carrier and PayPal payment.
  - **Approve and add tracking** runs exactly that stored proposal, once. It's matched by hash, and the status moves from `awaiting_approval` to `submitting` in one conditional update.
  - Then the toolkit makes the call. Approve, done, failed and decline are all audited.
- **Not offered from chat:** refunds (`accept_dispute_claim`), orders, invoices and subscriptions.
  - Refunds keep their single route: a dispute draft that the safety engine checks before an approval token is issued.
  - A second refund route through the model would weaken that.
- **Studio:** AG Studio turns can never declare a `paypal_` tool (`studio.BUNDO_TOOLS`).

### Toolkit issues found and worked around (version 1.11)
- `list_transactions` sends its default dates without a timezone, which PayPal rejects. We add `Z`.
- `list_transactions` with `transaction_id` calls the HTTP client with an argument it doesn't accept, so it never finds anything. We search the date window instead and pick the transaction out ourselves.
- `get_merchant_insights` refuses to run in the sandbox, so it isn't offered.
- The toolkit's method is called `get_order_details`, not `get_order`.

## Accessibility and clarity
- **The store does one job: pick an item, then pay.**
  - Items are a native radio group with `<fieldset>`/`<legend>` and arrow-key selection.
  - There is one PayPal button, with a plain hint linked by `aria-describedby`.
  - Status uses `role="status"`. Cancels and errors use `role="alert"` ("Payment cancelled. Nothing was charged.").
  - A visible banner says it's the sandbox and no real money moves.
  - Phones get no sideways scrolling, and the spinner respects reduced motion.
- **No new navigation tab.** The store is reached from Settings, via **Open test store** (shown only for the test account), and opens in a new tab.
- **Ask Bundo cards say what will happen in plain words.** State is shown with icon and text, never colour alone, and Decline is always next to Approve.

## Tests
- `backend/tests/test_checkout.py` checks:
  - the catalog price wins over a browser-sent amount;
  - request IDs are sent and there is no auth assertion;
  - capture is idempotent and records the sale once;
  - malformed IDs are refused;
  - the rate limit works;
  - the store is off without keys.
- `backend/tests/test_paypal_toolkit.py` checks:
  - only allowlisted tools are offered, and only for the app's own account;
  - reads are audited;
  - the write only proposes;
  - approve runs the stored proposal once and refuses a changed or foreign one;
  - failure and decline are handled;
  - the date and ID workaround works;
  - studio can't use these tools.

## Verified
- `uv run pytest`: 397 passed.
- `npm run typecheck`: passed.
- **In the browser:**
  - `/store` loads the v6 SDK, and the PayPal button is eligible and reachable by keyboard.
  - `POST /checkout/orders` created a real sandbox order, and PayPal's checkout opened.
  - Cancelling showed the alert.
  - The phone layout has no sideways scrolling.
- **Not yet tested live:**
  - A completed buyer payment, which needs a sandbox buyer login.
  - The Ask Bundo toolkit cards against the hosted database, which needs the new migration run there first.
