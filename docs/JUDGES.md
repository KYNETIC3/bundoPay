# For judges

BundoPay helps a PayPal seller keep three kinds of money apart (money to spend, tax, dispute cover) and answer disputes. **Gemini drafts. Code decides. The owner approves.** Everything runs on the PayPal sandbox.

## Log in

| | |
|---|---|
| **Live demo** | https://bundo-pay.vercel.app/ |
| **Judge login** | `judge@bundopay.test` / `judge123` |
| **PayPal sandbox buyer** | `customer.bundo@gmail.com` / `bundo123` |

- Use the judge login for BundoPay. Use the sandbox buyer to pay in the test store (step 1) and to open a dispute at [sandbox.paypal.com](https://www.sandbox.paypal.com) (step 3).
- The first load can take up to a minute if the server was asleep.
- If the login page says *"AI is off on this server"*, Gemini isn't configured on that server and Bundo is using its built-in rules. Everything else still works.
- Settings → Demo account → **Reset demo** starts you over (other judges share this login). It also resets every night.

## The five steps

Home shows these as a **Start here** card, ticked off from real data. The full script, with what to say, is in [DEMO.md](DEMO.md).

1. **Make a sale** in the test store, paying with the sandbox buyer.
2. **See tax set aside** in Money → Jars: the 8.25% tax rule moved part of the sale.
3. **Open a dispute** as the buyer in the PayPal sandbox.
4. **Review Bundo's draft and approve** it in Money → Disputes. The card says *Reasoned by Gemini · checked by code*.
5. **Check your records** in Money → Jars → Activity: *Your records are intact*.

## Where each technology is used

| Technology | Where you see it | Where it lives in the code |
|---|---|---|
| PayPal Checkout (Orders v2) | Step 1, the test store | `backend/app/checkout/router.py`, `backend/app/paypal_gateway/client.py` |
| PayPal JS SDK v6 | The PayPal button in the test store | `frontend/src/app/store/page.tsx` |
| PayPal REST APIs | Captures (webhook), disputes and evidence, Payouts for jar transfers | `backend/app/paypal_gateway/client.py`, `backend/app/webhooks/router.py`, `backend/app/executor/` |
| PayPal Agent Toolkit | Ask Bundo: "What did I sell today?" reads live sandbox data; anything that changes PayPal becomes a draft to approve | `backend/app/agent/paypal_toolkit.py`, `backend/app/agent/chat.py` |
| PayPal Sandbox | Everything: test store, buyer disputes, jar transfers | `backend/app/config.py` refuses any non-sandbox host |
| Google Gemini | Step 4 (dispute recommendation and draft), the Rules helper, Ask Bundo | `backend/app/agent/orchestrator.py`, `backend/app/treasury/copilot.py`, `backend/app/agent/llm.py` |
| AG Grid | Tables on Money → Disputes and Jars → Activity | `frontend/src/components/DisputeTable.tsx`, `frontend/src/components/DataGrid.tsx` |
| AG Studio | Home and Money dashboards; Ask Bundo → build a chart | `frontend/src/components/Board.tsx`, `frontend/src/components/ChartBuilder.tsx`, `frontend/src/lib/studio/` |
| Safety engine (our own) | "Stopped" and "Needs your OK" in Activity; the blocked injection in the Rules helper | `backend/app/safety/engine.py` |
| Tamper-evident records (our own) | Step 5 | `backend/app/audit.py` |

## What's real

Sales, disputes and transfers are real sandbox calls, never seeded. The demo reset only seeds the four jar accounts and three approved rules, so you can see rules working from the first minute. See the table at the end of [DEMO.md](DEMO.md#whats-real).
