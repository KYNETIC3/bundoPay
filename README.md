# BundoPay

BundoPay lets a PayPal merchant connect their account. It prepares responses to their open disputes and sends nothing until the merchant approves the exact response. PayPal is the source of truth for dispute data, the permission layer and the action layer. **Sandbox only.**

```
frontend/   Next.js (App Router) + TypeScript: onboarding, inbox, dispute detail, approval, records, settings
backend/    FastAPI
  app/paypal_gateway/  the ONLY module that calls PayPal (token cache, auth assertion, retries, idempotency, errors)
  app/onboarding/      partner referral + grant verification (stores merchant ID and grant status only)
  app/disputes/        sync (polling + webhook-triggered), dispute parsing, HTTP routes
  app/webhooks/        CUSTOMER.DISPUTE.* receiver, verified with PayPal, then enqueued
  app/jobs/            Postgres job queue + worker + 15-minute polling fallback (APScheduler)
  app/adapters/        merchant data sources behind one interface (CSV now)
  app/agent/           tools, evidence map + integrity checks, recommendation, payload assembly, Gemini orchestrator
  app/approvals/       HMAC approval tokens and submit_dispute_response (the only write path)
  app/audit.py         append-only audit_log
supabase/migrations/  schema + private "evidence" storage bucket
samples/              example CSVs for the records page
```

## How the guarantees are enforced (in code)

- **No auto-submit.** The agent pipeline ends by saving a draft. The model is only given read-only tools (`app/agent/tools.py`). `ToolBox.call` refuses anything else.
- **Approval binds to the exact payload.** Approve mints an HMAC token over the SHA-256 of the dispute ID, action, payload and file set (`app/agent/assemble.py: payload_hash`). It does this only if the hash the merchant was shown equals the stored hash. `submit_dispute_response` (`app/approvals/submit.py`) rejects any of these:
  - a missing, malformed or forged token
  - an expired token
  - a token that was never recorded, or was revoked by an edit
  - a token that was already used
  - a payload or file change after approval (file bytes are re-hashed from storage)
  - an action whose HATEOAS link has disappeared since approval
- **HATEOAS gate.** `allowed_actions()` derives the possible actions only from the dispute's `links`. Both the rules engine and the model's choice pass through `enforce_allowed()`. A disallowed model choice is logged and replaced with the rules baseline.
- **No invented evidence.** Tracking numbers and refund IDs in a payload are copied from PayPal or merchant records. A model-written note is dropped if it mentions an ID or number that isn't in those records. Merchant edits can change notes and remove items, but can't add evidence details.
- **Past deadlines.** The agent won't run, and Approve won't proceed, after `seller_response_due_date` unless the merchant explicitly acknowledges that the deadline has passed.
- **Revoked access.** A 401/403 on a merchant-scoped call raises `PermissionRevokedError`. The backend marks the grant revoked, the API returns `409 reconnect_required`, and the UI asks the merchant to reconnect.

## Setup

### 1. Tools

- Python 3.12+ and [uv](https://docs.astral.sh/uv/)
- Node 20+
- Docker Desktop, plus the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) (`brew install supabase/tap/supabase`)

### 2. Database (local Supabase)

```bash
supabase init        # creates supabase/config.toml; keep the existing migrations folder
supabase start       # prints API URL, anon key, service_role key, DB URL
supabase db reset    # applies supabase/migrations
```

### 3. PayPal sandbox partner app

1. At developer.paypal.com → **Apps & Credentials** (Sandbox), create a REST app under your sandbox **business** account. This account is the partner.
2. In the app's features, enable **Disputes**, **Transaction Search**, **Tracking**, and third-party permissions for: `READ_SELLER_DISPUTE`, `UPDATE_SELLER_DISPUTE`, `ADVANCED_TRANSACTIONS_SEARCH`, `TRACKING_SHIPMENT_READWRITE`, `ACCESS_MERCHANT_INFORMATION`. These must match what `paypal_gateway` requests.
3. Copy the client ID and secret into `backend/.env`. Set `PAYPAL_PARTNER_MERCHANT_ID` to the partner sandbox account's merchant ID (Sandbox → Accounts → account details).
4. Optional webhooks: add a webhook to the app pointing at `https://<your-tunnel>/webhooks/paypal`, subscribed to `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED` and `CUSTOMER.DISPUTE.RESOLVED`. Put its ID in `PAYPAL_WEBHOOK_ID`. Without a tunnel, the 15-minute poll and the **Sync with PayPal** button keep data current.
5. Create one more sandbox **business** account (the merchant who connects) and a **personal** account (the buyer).

### 4. Configure and run

```bash
cp backend/.env.example backend/.env          # fill in PayPal, Supabase, APPROVAL_SIGNING_KEY, GEMINI_API_KEY
cp frontend/.env.example frontend/.env.local  # anon key from `supabase start`

cd backend && uv sync && uv run uvicorn app.main:app --reload --port 8000
cd backend && uv run python -m app.jobs.worker
cd frontend && npm install && npm run dev
```

Open http://localhost:3000, create an account, then go through **Connect PayPal** and log in with the sandbox *merchant* business account.

### 5. Create a test dispute

1. Log in to sandbox.paypal.com as the buyer and pay the merchant: send money for goods, or use a checkout integration.
2. As the buyer, open **Resolution Center → Report a problem** on that payment, choose *item not received*, and escalate it if needed so the merchant is asked for a response.
3. Upload `samples/*.csv` on **Your records**. Put the sandbox transaction ID in `orders.csv` first, so the agent can match the order.
4. **Sync with PayPal**, open the dispute, then **Prepare a response**.

## Tests

```bash
cd backend && uv run pytest
```

The tests cover:
- the gateway against mocked PayPal responses: assertion format, token caching, retries/backoff, idempotency keys, pagination, error normalization, and revocation detection
- every way `submit_dispute_response` must reject a submission
- the HATEOAS gate across all link combinations, including a model that proposes a forbidden action
- integrity flags, file limits, and the CSV adapter

They need neither a database nor network access.

## Not built yet

- Shopify adapter (the `MerchantDataAdapter` protocol is ready for it)
- UI polish pass (build-order step 7)
- Learning from outcomes is basic: past win rate per dispute reason feeds into the recommendation once there are at least five outcomes.
