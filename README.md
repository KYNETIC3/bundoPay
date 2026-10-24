# BundoPay

BundoPay is a web app that handles a merchant's PayPal disputes. Its assistant, **Bundo**, reviews each new dispute. It refunds the buyer when the amount is within a limit the merchant sets, and asks the merchant first when it isn't.

BundoPay runs against the **PayPal sandbox** only, so no real money moves.

The app has three parts. The setup below gets all three running on your computer.

| Part | What it does | Address |
|---|---|---|
| **API** (Python) | Talks to PayPal, the database and Gemini | http://localhost:8000 |
| **Worker** (Python) | Checks PayPal for new disputes every 15 minutes, in the background | none |
| **Website** (Next.js) | The dashboard you use | http://localhost:3000 |

## Contents

1. [Before you start](#1-before-you-start)
2. [Install the tools](#2-install-the-tools)
3. [Get the code](#3-get-the-code)
4. [Set up Supabase](#4-set-up-supabase)
5. [Set up the PayPal sandbox](#5-set-up-the-paypal-sandbox)
6. [Get a Gemini API key](#6-get-a-gemini-api-key)
7. [Create the config files](#7-create-the-config-files)
8. [Install the dependencies](#8-install-the-dependencies)
9. [Start the app](#9-start-the-app)
10. [Try it out](#10-try-it-out)
11. [Optional: receive PayPal webhooks](#11-optional-receive-paypal-webhooks)
12. [Run the tests](#12-run-the-tests)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Before you start

Setup takes about 30–45 minutes the first time. Most of it is creating accounts and copying keys.

You need three free accounts. Create them now, or as you reach each step:

- **Supabase**, for the database, logins and file storage: https://supabase.com
- **PayPal Developer**, for the sandbox: https://developer.paypal.com
- **Google AI Studio**, for the Gemini key: https://aistudio.google.com

> **Tip:** Keep a text file open while you work. Steps 4–6 give you about ten values (keys, IDs and a password) that you'll paste into config files in step 7.

---

## 2. Install the tools

You need four tools. If you already have one, check its version and skip installing it.

| Tool | Version | What it's for |
|---|---|---|
| Git | any | Downloading the code |
| Python | 3.12 or newer | Running the API and the worker |
| uv | latest | Installing Python packages |
| Node.js | 20 or newer | Running the website |

### On macOS

The easiest way is Homebrew. If you don't have it, install it from https://brew.sh first.

1. Open **Terminal**.
2. Install Git, Python and Node.js:

   ```bash
   brew install git python node
   ```

3. Install uv:

   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```

4. **Close Terminal and open a new window**, so it picks up uv.

### On Windows

1. Open **PowerShell** from the Start menu.
2. Install Git:

   ```powershell
   winget install --id Git.Git
   ```

3. Install Python:

   ```powershell
   winget install --id Python.Python.3.12
   ```

4. Install Node.js:

   ```powershell
   winget install --id OpenJS.NodeJS.LTS
   ```

5. Install uv:

   ```powershell
   powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
   ```

6. **Close PowerShell and open a new window**, so it picks up the new tools.

### Check that everything installed

Run each of these. Each one should print a version number:

```bash
git --version
```

```bash
python3 --version
```

```bash
uv --version
```

```bash
node --version
```

On Windows, use `python --version` instead of `python3 --version`.

---

## 3. Get the code

1. In your terminal, go to the folder where you keep projects. For example:

   ```bash
   cd ~/Desktop
   ```

2. Download the code:

   ```bash
   git clone https://github.com/KYNETIC3/bundoPay.git
   ```

3. Go into the project folder:

   ```bash
   cd bundoPay
   ```

**Run every command from here on inside this `bundoPay` folder**, unless a step says otherwise.

---

## 4. Set up Supabase

Supabase stores the app's data and handles logins.

### 4.1 Create a project

1. Sign in at https://supabase.com and click **New project**.
2. Pick any name and a region near you.
3. Choose a **database password** and save it in your text file. You'll need it in step 7, and Supabase won't show it again.
4. Wait a minute or two for the project to finish setting up.

### 4.2 Create the database tables

The tables are defined in five SQL files in the `supabase/migrations/` folder. You run each one in Supabase's SQL Editor, **in this order**:

1. `20261021000000_init.sql`
2. `20261021120000_agent_limits.sql`
3. `20261021220000_agent_messages.sql`
4. `20261022090000_clear_history.sql`
5. `20261024090000_treasury_safety.sql`

For each file:

1. In Supabase, open **SQL Editor** from the left sidebar and click **New query**.
2. Open the file in a text editor, copy all of it, and paste it into the editor.
3. Click **Run**. You should see **Success. No rows returned**.

### 4.3 Turn off email confirmation

This lets you sign up and log in straight away while testing, without clicking an email link.

1. Go to **Authentication → Sign In / Providers → Email**.
2. Turn off **Confirm email** and save.

### 4.4 Copy four values

Save each of these in your text file:

| Value | Where to find it |
|---|---|
| **Project URL** | **Project Settings → Data API** |
| **Publishable (anon) key** | **Project Settings → API Keys** |
| **`service_role` key** | **Project Settings → API Keys → Legacy API keys** |
| **Session pooler connection string** | Click **Connect** at the top of the project, then choose **Session pooler** |

> **Use the session pooler string, not the transaction pooler.** It looks like `postgresql://postgres.xxxx:[YOUR-PASSWORD]@aws-0-….pooler.supabase.com:5432/postgres`. The port must be **5432**. With the transaction pooler (port 6543), the dashboard's live updates silently stop working.

> **Keep the `service_role` key secret.** It can read and change everything in your database.

---

## 5. Set up the PayPal sandbox

The sandbox is PayPal's test environment. It comes with fake accounts and fake money.

### 5.1 Create an app

1. Sign in at https://developer.paypal.com and make sure the toggle at the top says **Sandbox**.
2. Open **Apps & Credentials** and click **Create App**. Choose **Merchant** as the type.
3. Open the new app. Under **Features**, turn on:
   - **Disputes**
   - **Transaction Search**
   - **Tracking**
4. Save, then copy the app's **Client ID** and **Secret** into your text file.

### 5.2 Find the merchant ID

1. Go to **Testing Tools → Sandbox Accounts**.
2. Find the **Business** account. It's the one your app belongs to.
3. Click **⋯ → View/Edit account** and copy the **Account ID** (merchant ID).

### 5.3 Note the buyer account

On the same **Sandbox Accounts** page, find the **Personal** account. Save its **email** and **password**. You'll log in as this buyer in step 10 to open a test dispute.

> BundoPay can't connect *other* merchants' PayPal accounts until PayPal approves it as a partner. Until then, it uses **test mode**: it works with your own sandbox business account. You turn test mode on in step 7.

---

## 6. Get a Gemini API key

Bundo uses Gemini to explain disputes and answer your questions.

1. Go to https://aistudio.google.com/apikey.
2. Click **Create API key** and copy it into your text file.

> **Optional:** without a key, Bundo still works. It falls back to simple built-in rules and fixed message templates.

---

## 7. Create the config files

The API and the website each read their settings from a file. You'll make copies of the example files, then fill in the values you saved.

### 7.1 Copy the example files

**macOS:**

```bash
cp backend/.env.example backend/.env
```

```bash
cp frontend/.env.example frontend/.env.local
```

**Windows (PowerShell):**

```powershell
copy backend\.env.example backend\.env
```

```powershell
copy frontend\.env.example frontend\.env.local
```

### 7.2 Make an approval signing key

BundoPay signs each approval with a secret key. Generate a random one:

**macOS:**

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

**Windows:**

```powershell
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Copy the long string it prints.

### 7.3 Fill in `backend/.env`

Open `backend/.env` in a text editor and fill in these lines. Paste each value right after the `=`, with no spaces or quotes.

| Setting | What to paste |
|---|---|
| `PAYPAL_PARTNER_CLIENT_ID` | PayPal **Client ID** (step 5.1) |
| `PAYPAL_PARTNER_CLIENT_SECRET` | PayPal **Secret** (step 5.1) |
| `PAYPAL_PARTNER_MERCHANT_ID` | PayPal **merchant ID** (step 5.2) |
| `PAYPAL_DEV_SELF_MERCHANT` | `true` (turns on test mode) |
| `DATABASE_URL` | The **session pooler string** (step 4.4), with `[YOUR-PASSWORD]` changed to `YOUR-PASSWORD`: remove the square brackets, and don't put your real password here. |
| `DATABASE_PASSWORD` | Your Supabase **database password** (step 4.1) |
| `SUPABASE_URL` | Supabase **Project URL** |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase **`service_role` key** |
| `APPROVAL_SIGNING_KEY` | The string from step 7.2 |
| `GEMINI_API_KEY` | Your **Gemini key** (step 6), or leave empty |

Leave every other line as it is. `PAYPAL_WEBHOOK_ID` stays empty unless you do step 11.

For example, `DATABASE_URL` ends up looking like this:

```text
postgresql://postgres.abcd1234:YOUR-PASSWORD@aws-0-eu-west-1.pooler.supabase.com:5432/postgres
```

> **Why is the password separate?** When the app starts, it replaces `YOUR-PASSWORD` with your `DATABASE_PASSWORD`. That way, passwords with symbols like `@` or `#` work without any escaping.

### 7.4 Fill in `frontend/.env.local`

Open `frontend/.env.local` and fill in:

| Setting | What to paste |
|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` (already set) |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase **Project URL** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase **Publishable (anon) key** |

> Git already ignores both files, so your keys won't be committed. Never share them or paste them anywhere public.

---

## 8. Install the dependencies

This downloads the packages the API and the website need. It only has to be done once, and again after you pull new code that changes them.

1. Install the Python packages:

   ```bash
   cd backend
   ```

   ```bash
   uv sync
   ```

   ```bash
   cd ..
   ```

2. Install the website packages. This can take a minute or two:

   ```bash
   cd frontend
   ```

   ```bash
   npm install
   ```

   ```bash
   cd ..
   ```

You're back in the `bundoPay` folder.

---

## 9. Start the app

### On macOS: one command

From the `bundoPay` folder, run:

```bash
./dev.sh
```

This starts the API, the worker and the website together. Their logs appear in the same window, labelled `[api]`, `[worker]` and `[web]`.

Leave the window open while you use the app. Press **Ctrl+C** once to stop all three.

### On Windows, or if `dev.sh` doesn't work: three terminals

Open **three** terminal windows and go to the `bundoPay` folder in each.

**Terminal 1: the API**

```bash
cd backend
```

```bash
uv run uvicorn app.main:app --port 8000
```

**Terminal 2: the worker**

```bash
cd backend
```

```bash
uv run python -m app.jobs.worker
```

**Terminal 3: the website**

```bash
cd frontend
```

```bash
npm run dev
```

Press **Ctrl+C** in each window to stop it.

### Check it's running

1. Open http://localhost:8000/health. You should see `{"status":"ok"}`.
2. Open http://localhost:3000. You should see the BundoPay sign-in page.

If either doesn't load, see [Troubleshooting](#13-troubleshooting).

---

## 10. Try it out

### 10.1 Create your account and connect PayPal

1. On http://localhost:3000, click **New here? Create an account**. Use any email and password. This is a BundoPay login, not your PayPal password.
2. On the **Connect PayPal** page, click **Use test account**. This links your sandbox business account from step 5.

### 10.2 Open a test dispute

You'll act as a buyer who pays the business, then complains.

1. Go to https://www.sandbox.paypal.com and log in with the **Personal** (buyer) account from step 5.3.
2. Send a payment to your sandbox **Business** account's email. Choose **Paying for an item or service**.
3. Open that payment in the buyer's activity and choose **Report a problem**. Follow the steps to open a dispute.

### 10.3 See it in BundoPay

1. Back on http://localhost:3000, click **Refresh** at the top right.
2. The dispute appears under **Open disputes** on the Overview.
3. Bundo reviews it. Within your refund limit, it refunds on its own. Above the limit, it asks you in **Ask Bundo**, with **Approve** and **Decline** buttons.

Set the refund limit in **Settings**.

---

## 11. Optional: receive PayPal webhooks

Without webhooks, new disputes arrive when you click **Refresh**, or within 15 minutes through the worker. With webhooks, PayPal tells BundoPay the moment a dispute opens, changes or closes.

PayPal can't reach `localhost`, so you expose the API through a free **Cloudflare tunnel**.

### 11.1 Install the tunnel tool

**macOS:**

```bash
brew install cloudflared
```

**Windows:**

```powershell
winget install --id Cloudflare.cloudflared
```

### 11.2 Start a tunnel

With the app running (step 9), open **another** terminal and run:

```bash
cloudflared tunnel --url http://localhost:8000
```

It prints an address like `https://something-random.trycloudflare.com`. Copy it, and leave this window open.

### 11.3 Add the webhook in PayPal

1. At https://developer.paypal.com, go to **Sandbox → Apps & Credentials → your app → Webhooks → Add Webhook**.
2. **Webhook URL:** your tunnel address followed by `/webhooks/paypal`, for example:

   ```text
   https://something-random.trycloudflare.com/webhooks/paypal
   ```

3. **Events:** tick these three:
   - *Customer dispute created*
   - *Customer dispute updated*
   - *Customer dispute resolved*
4. Save, then copy the new **Webhook ID**.

### 11.4 Tell BundoPay the webhook ID

1. Paste the ID into `backend/.env` as `PAYPAL_WEBHOOK_ID=…`.
2. Stop the app (**Ctrl+C**) and start it again (step 9), so the API reads the new setting.

### 11.5 Test it

Open a new sandbox dispute, as in step 10.2. Within a few seconds:

- the `[api]` log shows `POST /webhooks/paypal … 200`
- the `[worker]` log syncs the dispute
- the dispute appears in BundoPay without clicking **Refresh**

> **Don't use PayPal's Webhooks Simulator.** Its mock events fail PayPal's own signature check, so BundoPay always rejects them with a `400`. Test with a real sandbox dispute instead.

> **The tunnel address changes every time you restart `cloudflared`.** When it does, update the webhook's URL in the PayPal dashboard. The Webhook ID stays the same, so you don't need to change `.env`. For a permanent address, set up a [named Cloudflare tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/). It needs a free Cloudflare account and your own domain.

---

## 12. Run the tests

From the `bundoPay` folder:

```bash
cd backend
```

```bash
uv run pytest
```

All tests should pass. They don't need PayPal, Supabase or Gemini.

---

## 13. Troubleshooting

### The app won't start

| What you see | What to do |
|---|---|
| `Missing backend/.env` or `Missing frontend/.env.local` | You skipped step 7.1. Copy the example files. |
| `command not found: uv`, `npm` or `python3` | Close the terminal and open a new one. If it still fails, reinstall the tool (step 2). |
| `Address already in use` / port 8000 or 3000 is taken | An old copy of the app is still running. Stop it with **Ctrl+C**, or close its terminal window. |
| `./dev.sh: Permission denied` (macOS) | Run `chmod +x dev.sh` once, then try again. |

### The app starts but something's wrong

| What you see | What to do |
|---|---|
| The sign-in page shows an error, or sign-up fails | Check `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `frontend/.env.local`, then restart. |
| The API log shows database or connection errors | Check `DATABASE_URL` is the **session pooler** string on port **5432**, and that `DATABASE_PASSWORD` is right. |
| Errors mentioning a missing table or column | A migration wasn't run. Repeat step 4.2, in order. |
| No **Use test account** button | Set `PAYPAL_DEV_SELF_MERCHANT=true` in `backend/.env` and restart. |
| **Refresh** finds no disputes | Make sure the dispute was opened against the **same** sandbox business account as your app (step 5.2). |

### Webhooks (step 11)

| What you see | Why |
|---|---|
| `400 Signature verification failed` | `PAYPAL_WEBHOOK_ID` is empty or wrong, the API wasn't restarted after setting it, or the event came from the simulator. |
| `200 {"status":"ignored"}` | Not a dispute event, or the seller isn't connected yet. Click **Use test account** first. |
| Nothing in the `[api]` log | The tunnel isn't running, or PayPal still has an old tunnel address. |
| `503` | PayPal's verification service was briefly down. PayPal retries on its own. |
