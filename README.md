# BundoPay

BundoPay helps PayPal sellers look after their money.

- **Disputes.** When a buyer opens a dispute, BundoPay's assistant, **Bundo**, looks at it and drafts a reply. Small ones are refunded automatically. Bigger ones wait for you to say yes or no.
- **Jars.** BundoPay sets money aside for tax, disputes and ads, in separate accounts. It checks every transfer against safety limits you choose, and asks you before moving large amounts.

**Gemini drafts. Code decides. The owner approves.** Everything runs on PayPal's **test mode** (the sandbox). No real money ever moves.

---

## Try it now

BundoPay is live. You don't need to install anything.

| | |
|---|---|
| **Live demo** | <LIVE_URL> |
| **Judge login** | `<JUDGE_EMAIL>` / `<JUDGE_PASSWORD>` |
| **PayPal sandbox buyer** (to pay in the test store and open a dispute) | `<BUYER_EMAIL>` / `<BUYER_PASSWORD>` |

- The first load can take up to a minute if the server was asleep. The login page says "Waking up the server" while it does.
- Other judges share this login. **Settings → Demo account → Reset demo** puts it back to the starting point. It also resets every night.
- If the login page says *"AI is off on this server"*, Bundo is using its built-in rules instead of Gemini. Everything else still works.

---

## The five-step tour

Home shows these steps as a **Start here** card and ticks them off as you go. The full three-minute script is in [docs/DEMO.md](docs/DEMO.md).

1. **Make a sale.** Home → Start here → **Open test store**, and pay with the sandbox buyer.
2. **See tax set aside.** Money → Jars: the 8.25% tax rule moved part of that sale into the Tax jar.
3. **Open a dispute.** Sign in to the PayPal sandbox as the buyer and choose **Report a problem** on that payment.
4. **Review Bundo's draft and approve it.** Money → Disputes. The card says *Reasoned by Gemini · checked by code*.
5. **Check your records.** Money → Jars → Activity: *Your records are intact*.

---

## Built with

| Technology | What it does in BundoPay |
|---|---|
| PayPal Checkout (Orders v2) and JS SDK v6 | The test store and its PayPal button |
| PayPal REST APIs | Captures (webhook), disputes and evidence, Payouts for jar transfers |
| PayPal Agent Toolkit | Ask Bundo reads live sandbox data; anything that changes PayPal becomes a draft to approve |
| Google Gemini | Dispute recommendations and drafts, the Rules helper, Ask Bundo |
| AG Grid | Tables on Money → Disputes and Jars → Activity |
| AG Studio | Home and Money dashboards; Ask Bundo → build a chart |
| Safety engine (our own) | Checks every transfer against your limits; blocks prompt injection |
| Tamper-evident records (our own) | A signed chain of every action, checked on the Activity page |

[docs/JUDGES.md](docs/JUDGES.md) shows where each one lives in the code, and what is real and what is seeded.

---

## How it's hosted

- **Website:** Vercel (Next.js, in `frontend/`)
- **API and background worker:** Render (FastAPI, in `backend/`)
- **Database and logins:** Supabase (Postgres, in `supabase/migrations/`)
- **Payments:** PayPal sandbox only. The API refuses any non-sandbox PayPal host.

---

## Run it yourself

You only need this to run your own copy. It takes about 30–45 minutes, mostly creating free Supabase, PayPal Developer and Google AI Studio accounts.

```bash
git clone https://github.com/KYNETIC3/bundoPay.git
```

```bash
cd bundoPay
```

```bash
./setup.sh
```

Fill in the keys in `backend/.env` and `frontend/.env.local`, then start it:

```bash
./dev.sh
```

Open **http://localhost:3000**. The [setup guide](docs/SETUP.md) covers every step, Windows, and how to host your own copy ([step 11](docs/SETUP.md#11-host-it-for-judges)).
