-- One conversation between the merchant and the agent: the agent's own updates (refunds made,
-- decisions needed, disputes closed) and the merchant's questions with the agent's answers.
create table agent_messages (
  id bigint generated always as identity primary key,
  merchant_id uuid not null references merchants (id) on delete cascade,
  role text not null check (role in ('agent', 'owner')),
  kind text not null default 'chat',
  content text not null,
  dispute_id uuid references disputes (id) on delete set null,
  draft_id uuid references drafts (id) on delete set null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index agent_messages_merchant_idx on agent_messages (merchant_id, id desc);
alter table agent_messages enable row level security;

-- Finished disputes the merchant has cleared from their lists.
alter table disputes add column archived_at timestamptz;

-- Dispute IDs a chat reply refers to, so its cards survive a reload.
alter table agent_messages add column meta jsonb not null default '{}';
