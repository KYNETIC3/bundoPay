-- Dispute Agent schema. The backend connects with a privileged Postgres role; RLS is enabled with no
-- policies so the public anon/authenticated API roles can read nothing directly.

create extension if not exists pgcrypto;

create table merchants (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  paypal_merchant_id text unique,
  grant_status text not null default 'not_connected'
    check (grant_status in ('not_connected', 'pending', 'granted', 'revoked')),
  granted_scopes jsonb not null default '[]',
  onboarding_tracking_id text unique,
  connected_at timestamptz,
  last_synced_at timestamptz
);

create table disputes (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants (id) on delete cascade,
  paypal_dispute_id text not null,
  status text not null,
  reason text,
  lifecycle_stage text,
  amount numeric(14, 2),
  currency text,
  due_date timestamptz,
  work_item_key text,           -- hash of the current set of evidence requests; changes => new work item
  raw_json jsonb not null,
  updated_at timestamptz not null default now(),
  unique (merchant_id, paypal_dispute_id)
);
create index disputes_inbox_idx on disputes (merchant_id, due_date nulls last);

create table evidence_maps (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references disputes (id) on delete cascade,
  work_item_key text,
  rows_json jsonb not null,
  integrity_flags jsonb not null default '[]',
  coverage_score numeric(4, 3) not null,
  recommendation jsonb,
  created_at timestamptz not null default now()
);

create table drafts (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references disputes (id) on delete cascade,
  evidence_map_id uuid references evidence_maps (id) on delete set null,
  action text not null check (action in ('provide_evidence', 'make_offer', 'accept_claim')),
  payload_json jsonb not null,
  files jsonb not null default '[]',   -- [{filename, content_type, size, sha256, storage_path}]
  missing_items jsonb not null default '[]',
  payload_hash text not null,
  status text not null default 'awaiting_approval'
    check (status in ('awaiting_approval', 'approved', 'submitting', 'submitted', 'rejected', 'failed', 'superseded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table approvals (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references drafts (id) on delete cascade,
  merchant_id uuid not null references merchants (id) on delete cascade,
  token_hash text not null unique,
  payload_hash text not null,
  approved_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz
);

create table outcomes (
  dispute_id uuid primary key references disputes (id) on delete cascade,
  final_status text not null,
  resolved_at timestamptz,
  evidence_map_id uuid references evidence_maps (id) on delete set null,
  action_taken text,
  reason text
);

create table audit_log (
  id bigint generated always as identity primary key,
  merchant_id uuid references merchants (id) on delete cascade,
  dispute_id uuid references disputes (id) on delete set null,
  event text not null,
  data_json jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_log_dispute_idx on audit_log (dispute_id, created_at);

-- Merchant data imported through adapters (CSV first).
create table merchant_records (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants (id) on delete cascade,
  kind text not null check (kind in ('orders', 'shipments', 'refunds', 'tickets')),
  source_system text not null default 'csv',
  record_key text not null,
  order_id text,
  data jsonb not null,
  imported_at timestamptz not null default now(),
  unique (merchant_id, kind, record_key)
);
create index merchant_records_order_idx on merchant_records (merchant_id, kind, order_id);

-- Postgres-backed job queue.
create table jobs (
  id bigint generated always as identity primary key,
  kind text not null,
  payload jsonb not null default '{}',
  dedupe_key text,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts int not null default 0,
  run_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_ready_idx on jobs (run_at) where status = 'queued';
create unique index jobs_dedupe_idx on jobs (dedupe_key) where status in ('queued', 'running');

alter table merchants enable row level security;
alter table disputes enable row level security;
alter table evidence_maps enable row level security;
alter table drafts enable row level security;
alter table approvals enable row level security;
alter table outcomes enable row level security;
alter table audit_log enable row level security;
alter table merchant_records enable row level security;
alter table jobs enable row level security;

insert into storage.buckets (id, name, public) values ('evidence', 'evidence', false)
on conflict (id) do nothing;
