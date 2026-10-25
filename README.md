# BundoPay

BundoPay helps PayPal sellers look after their money.

- **Disputes.** When a buyer opens a dispute, BundoPay's assistant, **Bundo**, looks at it. Small ones are refunded automatically. Bigger ones wait for you to say yes or no.
- **Treasury.** BundoPay sets money aside for tax, disputes and ads, in separate accounts. It checks every transfer against safety limits you choose, and asks you before moving large amounts.

BundoPay only uses PayPal's **test mode** (the sandbox). No real money ever moves.

---

## What you need

**Three free accounts:**

- [Supabase](https://supabase.com), for the database and logins
- [PayPal Developer](https://developer.paypal.com), for PayPal's test mode
- [Google AI Studio](https://aistudio.google.com), for the AI assistant (optional)

**Four free programs** on your computer:

- Git
- Python 3.12 or newer
- uv
- Node.js 20 or newer

You **don't** need Docker.

The first setup takes about 30–45 minutes. Most of that is creating the accounts and copying keys.

---

## Quick start

The [full setup guide](docs/SETUP.md) walks you through every step, including where to click. Here's the short version.

**1. Get the code**

```bash
git clone https://github.com/KYNETIC3/bundoPay.git
```

```bash
cd bundoPay
```

**2. Run the setup script** (macOS)

```bash
./setup.sh
```

The script checks your programs, creates the two settings files, and installs everything. At the end, it lists the settings you still need to fill in.

On Windows, follow [steps 7 and 8 of the guide](docs/SETUP.md#7-fill-in-the-settings-files) instead.

**3. Fill in your keys**

Open `backend/.env` and `frontend/.env.local` in a text editor. Paste in the keys from your Supabase, PayPal and Google accounts. [Step 7 of the guide](docs/SETUP.md#7-fill-in-the-settings-files) shows which key goes where.

**4. Start BundoPay**

```bash
./dev.sh
```

Open **http://localhost:3000** in your browser. To stop the app, press **Ctrl+C** in the terminal.

**5. Try it out**

Create an account, click **Use test account**, then open a test dispute. The [Try it out](docs/SETUP.md#10-try-it-out) section of the guide shows you how, and how to set up Treasury.

---

## Getting new updates

When there's new code, run these from the `bundoPay` folder:

```bash
git pull
```

```bash
./setup.sh
```

If the update adds a new file to `supabase/migrations/`, run that file once in Supabase. [Step 4.2 of the guide](docs/SETUP.md#42-create-the-database-tables) shows how.
