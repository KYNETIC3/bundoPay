# BundoPay

A web app where an AI agent reviews a merchant's PayPal disputes and refunds buyers, within limits the merchant sets. Runs against the **PayPal sandbox** only.

## What you need

| Tool | Version | Install |
|---|---|---|
| Git | any | https://git-scm.com |
| Python | 3.12+ | https://www.python.org |
| uv | latest | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Node.js | 20+ | https://nodejs.org |

You also need free accounts on:

- **Supabase** (database, login, file storage): https://supabase.com
- **PayPal Developer** (sandbox): https://developer.paypal.com
- **Google AI Studio** (Gemini API key): https://aistudio.google.com/apikey

## 1. Get the code

```bash
git clone -b claude/dispute-agent-app-fe7697 https://github.com/KYNETIC3/bundoPay.git
cd bundoPay
```

Once that branch is merged into `main`, drop `-b claude/dispute-agent-app-fe7697`.

## 2. Set up Supabase

1. Create a new project at supabase.com. Save the database password you choose.
2. Open **SQL Editor**. Paste and run each file in `supabase/migrations/`, in name order:
   - `20261021000000_init.sql`
   - `20261021120000_agent_limits.sql`
3. In **Authentication → Sign In / Providers → Email**, turn off **Confirm email** (easier for testing).
4. Note these values; they go into the `.env` files in step 5:

| Value | Where to find it |
|---|---|
| Project URL | **Project Settings → Data API** |
| Publishable (anon) key | **Project Settings → API Keys** |
| `service_role` key | **Project Settings → API Keys → Legacy API keys** |
| Session pooler connection string | **Connect** button at the top of the project → **Session pooler** |

## 3. Set up PayPal sandbox

1. At developer.paypal.com, switch to **Sandbox**, open **Apps & Credentials**, and create a REST app.
2. In the app's settings, enable **Disputes**, **Transaction Search** and **Tracking**.
3. Copy the app's **Client ID** and **Secret**.
4. Get the merchant ID of the business account that owns the app: **Testing Tools → Sandbox Accounts** → that account → **View/Edit account**.
5. Note the sandbox **personal** (buyer) account's email and password. You'll use it to create test disputes.

Connecting *other* merchants' PayPal accounts needs PayPal Partner-program approval. Until then, use test mode (`PAYPAL_DEV_SELF_MERCHANT=true` below), which works with the app's own sandbox account.

## 4. Get a Gemini API key

Create one at https://aistudio.google.com/apikey.

## 5. Create the config files

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
```

Fill in **`backend/.env`**:

| Variable | Value |
|---|---|
| `PAYPAL_PARTNER_CLIENT_ID` | PayPal app Client ID |
| `PAYPAL_PARTNER_CLIENT_SECRET` | PayPal app Secret |
| `PAYPAL_PARTNER_MERCHANT_ID` | Merchant ID from step 3.4 |
| `PAYPAL_DEV_SELF_MERCHANT` | `true` for testing with the app's own sandbox account |
| `DATABASE_URL` | Session pooler string, with the password replaced by `YOUR-PASSWORD` |
| `DATABASE_PASSWORD` | Your Supabase database password |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` key |
| `APPROVAL_SIGNING_KEY` | Output of `python3 -c "import secrets; print(secrets.token_urlsafe(48))"` |
| `GEMINI_API_KEY` | Gemini key |

Leave everything else as it is.

Fill in **`frontend/.env.local`**:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` |
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Publishable (anon) key |

Never commit these two files; they are already in `.gitignore`.

## 6. Install and run

```bash
cd backend && uv sync && cd ..
cd frontend && npm install && cd ..
./dev.sh
```

`dev.sh` starts the API (port 8000), the background worker and the website (port 3000). Open **http://localhost:3000**. Press **Ctrl+C** to stop everything.

## 7. First use

1. Create an account on the sign-in page.
2. On **Connect PayPal**, click **Use test account**.
3. To create a dispute: log in to https://www.sandbox.paypal.com as the sandbox buyer, pay the app's business account ("Paying for an item or service"), then open that payment and choose **Report a problem**.
4. In BundoPay, click **Sync**. The dispute appears on the Overview.

## Run the tests

```bash
cd backend && uv run pytest
```
