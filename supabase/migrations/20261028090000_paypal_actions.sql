-- Changes Ask Bundo proposes through the PayPal Agent Toolkit (adding shipment tracking). The model can only
-- create a row here; nothing reaches PayPal until the owner approves that exact row (args_hash).
create table paypal_actions (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants (id) on delete cascade,
  tool text not null check (tool in ('create_shipment_tracking')),
  args_json jsonb not null,
  args_hash text not null,
  status text not null default 'awaiting_approval'
    check (status in ('awaiting_approval', 'submitting', 'done', 'declined', 'failed')),
  result_json jsonb,
  error text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index paypal_actions_merchant_idx on paypal_actions (merchant_id, created_at desc);
alter table paypal_actions enable row level security;
