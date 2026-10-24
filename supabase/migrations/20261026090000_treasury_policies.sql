-- Treasury policies: versioned, simulated and approved before they run; plans waiting for the owner;
-- and the captures that feed the tax reserve and the dispute buffer.

create table treasury_policies (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants (id) on delete cascade,
  kind text not null check (kind in ('tax_reserve', 'dispute_buffer', 'ad_sweep', 'rebalance')),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'retired')),
  active_version_id uuid,
  next_run_at timestamptz,
  failures int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One live policy of each kind per merchant keeps the planner's inputs unambiguous.
create unique index treasury_policies_kind_idx on treasury_policies (merchant_id, kind) where status <> 'retired';
create index treasury_policies_due_idx on treasury_policies (next_run_at) where status = 'active';

-- Every edit is a new version. A version runs only once it has been simulated and approved as-is.
create table treasury_policy_versions (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references treasury_policies (id) on delete cascade,
  version int not null,
  doc_json jsonb not null,
  spec_hash text not null,
  simulated_hash text,
  simulated_at timestamptz,
  approved_hash text,
  approved_at timestamptz,
  created_by text not null check (created_by in ('owner', 'copilot')),
  created_at timestamptz not null default now(),
  unique (policy_id, version)
);
alter table treasury_policies
  add constraint treasury_policies_active_version_fk
  foreign key (active_version_id) references treasury_policy_versions (id) on delete set null;

-- A run the engine said to ask about, waiting for an authenticated tap. plan_hash binds the approval to
-- exactly these items; approving re-runs the engine before anything is sent.
create table treasury_plans (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants (id) on delete cascade,
  flow_id uuid not null,
  policy_version_id uuid references treasury_policy_versions (id) on delete set null,
  items_json jsonb not null,
  plan_hash text not null,
  total numeric(14, 2) not null,
  status text not null check (status in ('needs_approval', 'approved', 'rejected', 'expired', 'executed', 'blocked')),
  reason text not null,
  expires_at timestamptz not null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index treasury_plans_open_idx on treasury_plans (merchant_id, status, created_at desc);

-- Captures confirmed by PayPal (re-fetched, not taken from webhook bodies).
create table treasury_captures (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants (id) on delete cascade,
  paypal_capture_id text not null,
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null,
  captured_at timestamptz not null,
  reserved_by uuid references movements (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (merchant_id, paypal_capture_id)
);
create index treasury_captures_unreserved_idx on treasury_captures (merchant_id) where reserved_by is null;

alter table movements add column plan_id uuid references treasury_plans (id) on delete set null;

alter table treasury_policies enable row level security;
alter table treasury_policy_versions enable row level security;
alter table treasury_plans enable row level security;
alter table treasury_captures enable row level security;
