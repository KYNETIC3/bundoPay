# BundoPay Treasury: pitch and enterprise blueprint

BundoPay began as a PayPal seller dispute assistant. For the PayPal AI Hackathon it becomes **BundoPay Treasury**, a policy autopilot for mid-market PayPal merchants. This document covers the value pivot, the pitch, and the blueprint behind it. The architecture and the live demo script are in [DEMO.md](DEMO.md).

> **Honesty constraints for anyone presenting this.**
> - BundoPay Treasury is an independent project built on PayPal's public APIs. It is not PayPal's own product, it is not a bank, and it does not provide escrow.
> - It does not give tax, legal or compliance advice. Tax rates are configured by the merchant.
> - Everything runs in the PayPal sandbox. Any figure that is seeded rather than read from PayPal is labelled as simulated on screen (see [What is real and what is simulated](#what-is-real-and-what-is-simulated)).
> - Don't quote market statistics unless you have checked them and can cite the source. This pitch deliberately uses none.

---

## 1. The value pivot

**Old:** "Tell your money what to do" (a consumer automation script).

**New:** **BundoPay Treasury is an autopilot for PayPal merchant treasury, and it can never move more than the CFO allowed.**

**Customer:** mid-market PayPal merchants with roughly $1M to $50M in yearly sales and no treasury team.

Mid-market merchants run treasury from a spreadsheet and memory. Sales tax is collected but sits in the operating balance. A bad dispute week can drain the money that pays suppliers. Ad budgets get topped up by hand, often from cash that was already owed to someone else. BundoPay turns each of these into a policy:

- Every capture sets aside its share for tax.
- Every new dispute raises a margin buffer.
- Spare cash goes to ad spend only when every reserve and the liquidity floor are covered.

The AI writes and explains the policies. Plain code enforces them. Every movement is simulated before it runs, approved at the right level, and recorded in an HMAC-chained audit trail.

### Three outcomes

- **Risk mitigation.** The dispute margin buffer and the liquidity floor are enforced in code. An AI or a prompt cannot override them.
- **Capital efficiency.** Cash above the floor is put to work (ad spend, operating) instead of sitting idle "just in case".
- **Merchant liquidity protection.** Tax and dispute money is ring-fenced the moment it arrives, not at month end.

### 60-second elevator pitch

> "Every PayPal merchant doing a few million a year has the same blind spot: one balance that's secretly three different kinds of money. Some of it is sales tax you owe. Some of it is exposure to disputes that haven't landed yet. Only what's left is actually yours to spend. Today a founder works that out in a spreadsheet, usually after the money is already gone.
>
> BundoPay Treasury is a policy autopilot built on PayPal. Webhooks for captures and disputes stream in live. Our AI turns a CFO's plain-English policy, like 'hold 8.25% for tax, keep a buffer of 100% of open disputes, and sweep whatever's left over $25k into ad spend on Fridays', into rules that can be checked.
>
> Before any dollar moves, a pre-flight simulator shows the outcome. A deterministic safety engine then checks every limit, reserve and floor, and returns allow, ask the CFO, or block. The AI never touches money, and every decision is HMAC-chained in an audit trail you can hand to your accountant.
>
> The result: tax is never spent, dispute losses never hit payroll, and idle cash goes to work. You'll see it block a dangerous sweep live, then run a validated multi-account rebalance through PayPal Payouts. Treasury discipline for the millions of merchants who'll never hire a treasurer."

*Before quoting any market figure on stage, check it and cite the source.*

---

## 2. The enterprise blueprint

### Demo entities, translated

The earlier consumer blueprint maps onto the treasury version like this.

| Consumer blueprint | Treasury equivalent |
|---|---|
| Kemi, the sender | **The CFO or founder of Northwind Supply Co.**, a fictional demo merchant with about $8M yearly sales |
| "John" | **Reserve accounts:** `Tax Reserve`, `Dispute Margin Buffer`, `Ad-Spend Wallet` and `Operating`, each a separate PayPal sandbox business account |
| "$5 every Friday" | **Dynamic amounts:** a percentage of captures, a function of open-dispute exposure, and the excess above a liquidity floor |
| "If balance ≥ $30" | **Liquidity floor:** Operating must stay at or above `max($25k, 1.5 × the next 7 days of payables)` *after* the movement |
| Weekly cap ($20) | **Treasury limits:** auto-execute up to $5k (solo), CFO approval from $5k to $50k, hard block above $50k per run or $150k per week |
| Ask Bundo chat | **Treasury Copilot**, which explains positions, drafts policies, and summarises dispute exposure |
| Disputes assistant | **Dispute exposure feed**, which drives the buffer and keeps the existing evidence agent |

Moving money into a reserve is a real PayPal sandbox Payouts call between separate accounts, not a ledger entry.

### The four flagship policies

Each policy is a rule block with a trigger, an action and limits. The safety engine checks every movement a policy proposes.

1. **Dynamic rolling tax reserve**
   - *When:* a `PAYMENT.CAPTURE.COMPLETED` webhook arrives.
   - *Do:* reserve `capture.amount × tax_rate` (by region, default 8.25%), batched into a sweep to `Tax Reserve` each hour.
   - *Limits:* the solo limit, plus a check that the payment wasn't already reserved, using the `capture_id` as the idempotency key.
2. **Dispute margin buffer**
   - *When:* `CUSTOMER.DISPUTE.CREATED` or `CUSTOMER.DISPUTE.UPDATED` arrives, or the hourly recompute runs.
   - *Target:* `Σ(open dispute amounts) × 1.0 + 2% × trailing 30-day captures`.
   - *Do:* top up `Dispute Margin Buffer` to the target. Releases back to Operating happen only when a dispute resolves, and always need approval.
3. **Ad-spend inventory sweep**
   - *When:* every Friday at 09:00.
   - *If:* Operating minus the reserves owed is above the floor.
   - *Do:* sweep `min(excess, ad_cap)` to `Ad-Spend Wallet`.
   - *Otherwise:* skip and notify the CFO.
4. **Multi-account balancing**
   - *When:* daily, or on demand.
   - *Do:* bring each reserve to its target in one multi-item Payouts batch, ordered by priority (tax, then dispute buffer, then ad spend).
   - *Never:* breach the floor.

### Existing stack mapped to treasury roles

Most of the treasury product reuses what the dispute assistant already has. Paths are relative to `backend/app/` unless stated.

| Existing component (file) | Treasury role |
|---|---|
| Webhook receiver with signature check (`webhooks/`) | A verified trigger source for captures and disputes. Unverified triggers are blocked (safety engine check 2). |
| Dispute sync and evidence agent (`disputes/`, `agent/orchestrator.py`) | Feeds dispute exposure to the buffer, and still drafts dispute responses |
| HMAC approval tokens (`approvals/tokens.py`) | CFO approval cards for movements in the "ask" band, single-use and tied to a payload hash |
| `audit_log` (`audit.py`) | Becomes an **HMAC hash-chained** treasury ledger. Each row stores `hmac(prev_hash ‖ row)`, plus a label and a `flow_id`. |
| SSE stream (`events.py`, `events_router.py`, `frontend/src/lib/events.ts`) | The live treasury console: positions, verdicts and executions |
| Jobs queue and APScheduler (`jobs/`) | Time triggers: the hourly batch, the Friday sweep, and the buffer recompute |
| PayPal gateway (`paypal_gateway/client.py`) | The executor's only path to PayPal: Payouts plus a Balances read, with an idempotent `PayPal-Request-Id` |
| Gemini LLM (`agent/llm.py`) | Turns plain-English policy into rule specs and explains verdicts. It has no authority over money. |
| Auto-refund limit (`merchants.auto_refund_limit`) | Becomes the general **solo limit** in the safety engine |

New treasury modules (the safety engine, simulator, planner and executor) are being built in separate PRs. [DEMO.md](DEMO.md) shows where each one sits in the pipeline.

### What is real and what is simulated

This is stated on screen during the demo.

- **Real:** the PayPal sandbox webhooks, Payouts calls between sandbox accounts, the safety engine, the simulator, the HMAC chain, and the approvals.
- **Labelled as simulated:**
  - Operating balance figures, if sandbox `GET /v1/reporting/balances` doesn't return them. The app then falls back to seeded data and labels it.
  - Upcoming payables, which are seeded.
  - Tax rates, which are configured by the merchant and are not tax advice.
- **Never claimed:** that this is PayPal's own product, that it is a bank or escrow, or that it gives tax or compliance guarantees.
