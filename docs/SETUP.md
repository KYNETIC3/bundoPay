# BundoPay setup guide

This guide takes you from nothing to BundoPay running on your computer. Follow the steps in order.

The first time takes about 30–45 minutes. Most of it is creating accounts and copying keys.

1. [Before you start](#1-before-you-start)
2. [Install the programs](#2-install-the-programs)
3. [Get the code](#3-get-the-code)
4. [Set up Supabase](#4-set-up-supabase)
5. [Set up PayPal test mode](#5-set-up-paypal-test-mode)
6. [Get a Google AI key (optional)](#6-get-a-google-ai-key-optional)
7. [Fill in the settings files](#7-fill-in-the-settings-files)
8. [Install the packages](#8-install-the-packages)
9. [Start the app](#9-start-the-app)
10. [Try it out](#10-try-it-out)

---

## 1. Before you start

Open a blank text file (for example in Notes or Notepad). As you go, you'll copy about ten keys and passwords into it. You'll need them all in step 7.

> **Keep this file private.** Don't share these keys, or paste them anywhere public.

---

## 2. Install the programs

If you already have a program, you can skip installing it.

### On a Mac

1. Install Homebrew from https://brew.sh, if you don't have it.
2. Open the **Terminal** app and run:

   ```bash
   brew install git python node
   ```

3. Then run:

   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```

4. **Close Terminal and open it again.**

### On Windows

1. Open **PowerShell** from the Start menu.
2. Run these one at a time:

   ```powershell
   winget install --id Git.Git
   ```

   ```powershell
   winget install --id Python.Python.3.12
   ```

   ```powershell
   winget install --id OpenJS.NodeJS.LTS
   ```

   ```powershell
   powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
   ```

3. **Close PowerShell and open it again.**

---

## 3. Get the code

1. Go to the folder where you want BundoPay. For example, your Desktop:

   ```bash
   cd ~/Desktop
   ```

2. Download the code:

   ```bash
   git clone https://github.com/KYNETIC3/bundoPay.git
   ```

3. Go into the new folder:

   ```bash
   cd bundoPay
   ```

Run all the commands in the rest of this guide from this `bundoPay` folder.

---

## 4. Set up Supabase

Supabase stores BundoPay's data and handles logins.

### 4.1 Create a project

1. Sign in at https://supabase.com and click **New project**.
2. Choose any name, and a region near you.
3. Choose a **database password**. Copy it into your text file. Supabase won't show it to you again.
4. Wait a minute or two while the project is created.

### 4.2 Create the database tables

The `supabase/migrations/` folder has seven files. Run each one in Supabase, **in this order**:

1. `20261021000000_init.sql`
2. `20261021120000_agent_limits.sql`
3. `20261021220000_agent_messages.sql`
4. `20261022090000_clear_history.sql`
5. `20261024090000_treasury_safety.sql`
6. `20261025090000_treasury_executor.sql`
7. `20261026090000_treasury_policies.sql`

For each file:

1. In Supabase, click **SQL Editor** in the left menu, then **New query**.
2. Open the file in a text editor. Copy everything in it and paste it into Supabase.
3. Click **Run**. You should see **Success. No rows returned**.

### 4.3 Turn off email confirmation

This lets you log in straight away, without waiting for an email.

1. Go to **Authentication → Sign In / Providers → Email**.
2. Turn off **Confirm email**, then save.

### 4.4 Copy four values

Copy each of these into your text file:

| What | Where to find it in Supabase |
|---|---|
| **Project URL** | **Project Settings → Data API** |
| **Publishable (anon) key** | **Project Settings → API Keys** |
| **service_role key** | **Project Settings → API Keys → Legacy API keys** |
| **Session pooler string** | Click **Connect** at the top, then choose **Session pooler** |

> **Choose "Session pooler", not "Transaction pooler".** The right one has `:5432` in it. With the other one, the dashboard stops updating live.

---

## 5. Set up PayPal test mode

PayPal's test mode (the "sandbox") gives you pretend accounts with pretend money.

### 5.1 Create an app

1. Sign in at https://developer.paypal.com. Make sure the switch at the top says **Sandbox**.
2. Open **Apps & Credentials** and click **Create App**. Choose **Merchant**.
3. Open the app. Under **Features**, turn on **Disputes**, **Transaction Search**, **Tracking** and **Payouts**.
4. Save. Copy the **Client ID** and **Secret** into your text file.

### 5.2 Find your seller account ID

1. Go to **Testing Tools → Sandbox Accounts**.
2. Find the **Business** account.
3. Click **⋯ → View/Edit account**. Copy the **Account ID** into your text file.

### 5.3 Note the buyer account

On the same page, find the **Personal** account. Copy its **email** and **password**. In step 10, you'll log in as this buyer to open a test dispute.

### 5.4 Create reserve accounts (for Treasury)

Treasury moves money into separate accounts for tax, disputes and ads.

1. On **Sandbox Accounts**, click **Create account** and choose **Business**.
2. Do this three times: one for tax, one for disputes, one for ads.
3. Copy each account's **email** into your text file.

> You can skip this if you only want to try disputes.

---

## 6. Get a Google AI key (required for the hosted demo)

Bundo uses Google's Gemini AI to explain disputes, draft responses, turn plain words into rules and answer questions. On your own computer it still works without a key, using simpler built-in rules. **The hosted judge demo needs a key**: without one the API logs a warning at startup and the login page tells judges that AI is off.

1. Go to https://aistudio.google.com/apikey.
2. Click **Create API key**, and copy it into your text file.

---

## 7. Fill in the settings files

BundoPay reads its keys from two settings files.

### 7.1 Create the files

**On a Mac**, run:

```bash
./setup.sh
```

This creates both files for you, and also does step 8. It makes the approval key too, so you can skip 7.2.

**On Windows**, run these two commands:

```powershell
copy backend\.env.example backend\.env
```

```powershell
copy frontend\.env.example frontend\.env.local
```

### 7.2 Make an approval key (Windows only)

BundoPay uses a secret key to sign your approvals. Make one by running:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Copy the long line of text it prints.

### 7.3 Fill in `backend/.env`

Open `backend/.env` in a text editor. Paste each value straight after the `=` sign, with no spaces or quote marks.

| Setting | What to paste |
|---|---|
| `PAYPAL_PARTNER_CLIENT_ID` | PayPal **Client ID** (5.1) |
| `PAYPAL_PARTNER_CLIENT_SECRET` | PayPal **Secret** (5.1) |
| `PAYPAL_PARTNER_MERCHANT_ID` | PayPal **Account ID** (5.2) |
| `PAYPAL_DEV_SELF_MERCHANT` | `true` |
| `DATABASE_URL` | The **Session pooler string** (4.4). Change `[YOUR-PASSWORD]` to `YOUR-PASSWORD`: just remove the square brackets. Don't put your real password here. |
| `DATABASE_PASSWORD` | Your Supabase **database password** (4.1) |
| `SUPABASE_URL` | Supabase **Project URL** (4.4) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase **service_role key** (4.4) |
| `APPROVAL_SIGNING_KEY` | Windows only: the key from 7.2. On a Mac, `setup.sh` already filled it in. |
| `GEMINI_API_KEY` | Your Google AI key (step 6), or leave it empty |

Leave every other line as it is.

Your `DATABASE_URL` should look something like this:

```text
postgresql://postgres.abcd1234:YOUR-PASSWORD@aws-0-eu-west-1.pooler.supabase.com:5432/postgres
```

### 7.4 Fill in `frontend/.env.local`

Open `frontend/.env.local` and fill in:

| Setting | What to paste |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase **Project URL** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase **Publishable (anon) key** |
| `NEXT_PUBLIC_AG_STUDIO_LICENSE` | Optional. Your [AG Studio](https://www.ag-grid.com/studio/react/enterprise-licence/) trial or full licence key. Without it, the Insights charts show a watermark. |

Leave `NEXT_PUBLIC_API_URL` as it is.

---

## 8. Install the packages

**On a Mac**, `./setup.sh` already did this. Run it again any time to check your settings. It never overwrites what you've filled in.

**On Windows**, run these one at a time:

```powershell
cd backend
```

```powershell
uv sync
```

```powershell
cd ..\frontend
```

```powershell
npm install
```

```powershell
cd ..
```

---

## 9. Start the app

### On a Mac

```bash
./dev.sh
```

Keep the Terminal window open while you use BundoPay. Press **Ctrl+C** to stop it.

### On Windows

Open **three** PowerShell windows. In each one, go to the `bundoPay` folder, then run:

| Window | Commands |
|---|---|
| 1 | `cd backend`, then `uv run uvicorn app.main:app --port 8000` |
| 2 | `cd backend`, then `uv run python -m app.jobs.worker` |
| 3 | `cd frontend`, then `npm run dev` |

Press **Ctrl+C** in each window to stop it.

### Check it's working

Open **http://localhost:3000** in your browser. You should see the BundoPay sign-in page.

---

## 10. Try it out

### 10.1 Create your account

1. On http://localhost:3000, click **New here? Create an account**. Use any email and password. This is just for BundoPay, not PayPal.
2. On the **Connect PayPal** page, click **Use test account**.

### 10.2 Open a test dispute

Now pretend to be an unhappy buyer.

1. Go to https://www.sandbox.paypal.com and log in with the **buyer** account (5.3).
2. Send a payment to your **Business** account's email. Choose **Paying for an item or service**.
3. Find that payment in the buyer's activity and click **Report a problem**. Follow the steps to open a dispute.

### 10.3 See it in BundoPay

1. In BundoPay, click **Refresh** at the top right.
2. The dispute appears on the **Overview** page.
3. If the amount is within your refund limit, Bundo refunds it on its own. If not, it asks you in **Ask Bundo**, with **Approve** and **Decline** buttons.

You can change the refund limit in **Settings**.

### 10.4 Set up Treasury

1. Click **Treasury** in the side menu, then the **Accounts** tab.
2. Click **Add account** and add four accounts:
   - **Operating:** your connected PayPal. No email is needed to start. If PayPal's test mode doesn't share its balance, you'll see **Not available**; set an "allow up to" amount under Safety limits to test anyway.
   - **Tax Reserve**, **Dispute Margin Buffer** and **Ad-Spend Wallet:** use the three emails from 5.4.
3. Click **Verify with $0.01** on each reserve. BundoPay sends one cent to the email and only marks it verified when PayPal delivers it, so each email must belong to a real sandbox account (5.4). BundoPay never sends money to an account you haven't verified.
4. Look at the **Safety limits** on the same page. The defaults are fine to start with:
   - **Always keep in Operating:** $25,000
   - **Move on its own up to:** $5,000. Anything bigger waits for your OK.
   - **Never more than:** $50,000 per run and $150,000 per 7 days, even if you approve.

### 10.5 Create a policy

A policy is a rule for moving money, like "every Friday, move spare money into the ads account".

1. Click **Copilot**. Type what you want in plain words, for example:

   > Every Friday, sweep anything above a $25k floor into ad spend, up to $15k.

2. Click **Save as drafts**. The Copilot only writes drafts. It can never move money or change your limits.
3. Open the draft on the **Policies** tab.
4. Click **Preview next runs** to see what it would do.
5. If you're happy, click **Approve and turn on**.
6. Click **Run now** to try it straight away. If the amount is over $5,000, BundoPay asks for your OK first.
7. Open the **Activity** tab to see every step in plain words.

For a full demo with example numbers, see [DEMO.md](DEMO.md).

---

## 11. Host it for judges

This puts BundoPay online for free, with one shared judge login. No credit card is needed. PayPal stays in test mode.

- **Website:** Vercel (free Hobby plan)
- **API and worker:** Render (free plan), in one service
- **Database and logins:** your Supabase project from step 4
- **Keep-awake:** a GitHub Action pings the API every 10 minutes until 15 Dec 2026

Render's free plan sleeps after 15 minutes without visitors, and Supabase pauses free projects after 7 quiet days. The ping prevents both. GitHub sometimes runs scheduled jobs late, so a judge may still occasionally wait up to a minute; the login page says "Waking up the server" when that happens.

### 11.1 Choose the demo account emails

1. **Judge login.** Pick an email for the shared login, for example `judge@bundopay.test`. It doesn't need to be a real inbox.
2. **Password.** Make a strong one:

   ```bash
   python3 -c "import secrets; print(secrets.token_urlsafe(18))"
   ```

   Keep it somewhere safe. It goes in your Devpost testing instructions, never in the repo.
3. **Treasury accounts.** Use the four sandbox business emails from [step 5.4](#54-create-reserve-accounts-for-treasury): operating, tax reserve, dispute buffer and ad spend, in that order.

### 11.2 Deploy the API on Render

1. Sign up at [render.com](https://render.com) with GitHub. No card is needed.
2. Click **New** → **Blueprint** and pick your `bundoPay` repository. Render reads `render.yaml`.
3. Fill in the values it asks for. They're the same as in `backend/.env`, plus:
   - `FRONTEND_URL`: leave as `https://example.com` for now; you'll fix it in 11.4.
   - `DEMO_EMAIL`: the judge login email.
   - `DEMO_ACCOUNT_EMAILS`: the four emails, separated by commas.
   - `GEMINI_API_KEY`: **required** for the judge demo (step 6). Judges should see Gemini at work, not the fallback rules.
   - `APPROVAL_SIGNING_KEY` and `AUDIT_CHAIN_KEY`: copy them **exactly** from `backend/.env` (leave `AUDIT_CHAIN_KEY` empty if it's empty there). The demo setup in 11.5 runs on your computer, so both sides must sign with the same keys, or the **Check records** button on Jars → Activity reports a mismatch.
4. Click **Apply**. When it's live, open `https://<your-service>.onrender.com/health`. It should say `{"status":"ok"}`.

### 11.3 Deploy the website on Vercel

1. Sign up at [vercel.com](https://vercel.com) with GitHub (Hobby plan).
2. Click **Add New** → **Project**, import `bundoPay`, and set **Root Directory** to `frontend`.
3. Add these environment variables:
   - `NEXT_PUBLIC_API_URL`: your Render URL, for example `https://bundopay-api.onrender.com`
   - `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`: as in `frontend/.env.local`
   - `NEXT_PUBLIC_AG_STUDIO_LICENSE` (optional): your AG Studio licence key, as in `frontend/.env.local`
4. Click **Deploy**.

### 11.4 Connect the pieces

1. **Render:** set `FRONTEND_URL` to your Vercel URL (no trailing slash) and save. Render restarts the API.
2. **Supabase:** go to **Authentication** → **URL Configuration** and set **Site URL** to your Vercel URL.
3. **PayPal (optional):** if you use webhooks, change the webhook URL to `https://<your-service>.onrender.com/webhooks/paypal`.

### 11.5 Create the judge login

From the `backend` folder on your computer, with `backend/.env` pointing at the same Supabase project, run:

```bash
DEMO_EMAIL=judge@bundopay.test DEMO_PASSWORD='the-password' DEMO_ACCOUNT_EMAILS='op@…,tax@…,buffer@…,ads@…' uv run python -m app.demo
```

It creates the login (or updates its password), connects it to your sandbox business account, and sets up Treasury with four pre-verified accounts as described in [DEMO.md](DEMO.md). Running it again is safe.

The demo resets itself every night at 03:00 UTC. Judges can also click **Settings** → **Reset demo**. A reset clears the demo account's treasury, chat and history. PayPal disputes stay, because they live in the PayPal sandbox.

### 11.6 Turn on the keep-awake ping

1. On GitHub, open the repository's **Settings** → **Secrets and variables** → **Actions**.
2. Under **Variables**, add:
   - `BUNDOPAY_API_URL`: your Render URL
   - `BUNDOPAY_SUPABASE_URL`: your Supabase Project URL
3. Under **Secrets**, add `BUNDOPAY_SUPABASE_ANON_KEY`: your Supabase anon key.
4. Open the **Actions** tab, pick **Keep demo awake**, and click **Run workflow** once to check it goes green.

GitHub turns off scheduled workflows after 60 days without a commit, so push at least one commit before then if judging is still running.

### 11.7 Testing instructions for Devpost

Paste something like this into the submission:

> **Live demo:** https://your-app.vercel.app
> **Login:** judge@bundopay.test / *the-password*
> The first load can take up to a minute if the server was asleep. Everything runs on the PayPal sandbox; no real money moves. Settings → Reset demo puts it back to the starting point.
