-- Treasury safety layer: allow-listed reserve accounts, account-level limits, one row per proposed money
-- movement (its idempotency key is the PayPal-Request-Id), and an HMAC-chained audit log.

create table treasury_accounts (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants (id) on delete cascade,
  role text not null check (role in ('operating', 'tax_reserve', 'dispute_buffer', 'ad_spend', 'other')),
  name text not null,
  paypal_email text not null,
  -- Verification is an authenticated tap; any change to the payout details clears it.
  details_hash text not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (merchant_id, name)
);
create unique index treasury_accounts_role_idx on treasury_accounts (merchant_id, role) where role <> 'other';

-- Hard limits set at account level. No policy can raise them.
create table treasury_limits (
  merchant_id uuid primary key references merchants (id) on delete cascade,
  currency text not null default 'USD',
  solo_limit numeric(14, 2) not null default 5000.00 check (solo_limit >= 0),
  hard_cap_per_run numeric(14, 2) not null default 50000.00 check (hard_cap_per_run >= 0),
  hard_cap_per_day numeric(14, 2) check (hard_cap_per_day >= 0),
  hard_cap_per_week numeric(14, 2) not null default 150000.00 check (hard_cap_per_week >= 0),
  hard_cap_per_month numeric(14, 2) check (hard_cap_per_month >= 0),
  liquidity_floor numeric(14, 2) not null default 25000.00 check (liquidity_floor >= 0),
  updated_at timestamptz not null default now(),
  check (solo_limit <= hard_cap_per_run)
);

create table movements (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants (id) on delete cascade,
  flow_id uuid,
  kind text not null check (kind in ('sweep', 'refund', 'release')),
  to_account_id uuid references treasury_accounts (id) on delete set null,
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null,
  idempotency_key text not null,
  policy_version text,
  trigger_source text not null,
  verdict text not null check (verdict in ('allow', 'ask', 'block')),
  check_code text,
  reason text not null,
  status text not null check (status in ('blocked', 'needs_approval', 'allowed', 'executing', 'succeeded', 'failed')),
  paypal_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, idempotency_key)
);
create index movements_spend_idx on movements (merchant_id, created_at) where status in ('allowed', 'executing', 'succeeded');

alter table treasury_accounts enable row level security;
alter table treasury_limits enable row level security;
alter table movements enable row level security;

-- History: each entry belongs to a flow, says where its facts came from, and is chained to the previous
-- entry for the same merchant: row_hash = HMAC(key, prev_hash || canonical entry).
alter table audit_log
  add column flow_id uuid,
  add column label text not null default 'system_generated'
    check (label in ('provider_verified', 'user_uploaded', 'system_generated', 'ai_assessment')),
  add column actor text,
  add column prev_hash text,
  add column row_hash text;
create index audit_log_chain_idx on audit_log (merchant_id, id) where row_hash is not null;
create index audit_log_flow_idx on audit_log (flow_id, created_at) where flow_id is not null;

-- Append-only: corrections are new entries. Deletes still cascade when an account is removed, and
-- verify_chain() reports any gap a delete leaves in the middle of a chain.
create function audit_log_no_update() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end;
$$;
create trigger audit_log_append_only before update on audit_log
  for each row execute function audit_log_no_update();
