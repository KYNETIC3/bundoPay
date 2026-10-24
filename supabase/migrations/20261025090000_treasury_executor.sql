-- Treasury executor: Payouts batches, a ledger of confirmed movements, and seeded opening balances.

-- 'unconfirmed': PayPal may or may not have the batch (a timeout after retries). Its key stays taken until
-- a status check settles it, so the money can never be sent twice.
alter table movements drop constraint movements_status_check;
alter table movements add constraint movements_status_check
  check (status in ('blocked', 'needs_approval', 'allowed', 'executing', 'unconfirmed', 'succeeded', 'failed'));
alter table movements
  add column batch_id text,          -- sender_batch_id, also the PayPal-Request-Id of the Payouts call
  add column paypal_item_id text,
  add column executed_at timestamptz;
create index movements_batch_idx on movements (merchant_id, batch_id) where batch_id is not null;
drop index movements_spend_idx;
create index movements_spend_idx on movements (merchant_id, created_at)
  where status in ('allowed', 'executing', 'unconfirmed', 'succeeded');
create index movements_ref_idx on movements (paypal_ref) where paypal_ref is not null;

-- A starting balance per account, entered by the merchant for the demo. Always shown as simulated.
alter table treasury_accounts add column opening_balance numeric(14, 2) not null default 0;

-- One row per account touched by a confirmed movement: the debit from operating and the credit to the
-- reserve. Positions are opening_balance + sum(amount).
create table treasury_ledger (
  id bigint generated always as identity primary key,
  merchant_id uuid not null references merchants (id) on delete cascade,
  account_id uuid not null references treasury_accounts (id) on delete cascade,
  movement_id uuid not null references movements (id) on delete cascade,
  amount numeric(14, 2) not null check (amount <> 0),
  label text not null default 'provider_verified'
    check (label in ('provider_verified', 'user_uploaded', 'system_generated', 'ai_assessment')),
  created_at timestamptz not null default now(),
  unique (movement_id, account_id)
);
create index treasury_ledger_account_idx on treasury_ledger (account_id);
alter table treasury_ledger enable row level security;
