-- Merchant-set limits for the agent. Auto-refund is off until the merchant turns it on.
alter table merchants
  add column auto_refund_enabled boolean not null default false,
  add column auto_refund_limit numeric(14, 2) not null default 20.00 check (auto_refund_limit >= 0);

-- Who approved: the merchant clicking Approve, or the merchant's standing auto-refund rule.
alter table approvals
  add column source text not null default 'merchant' check (source in ('merchant', 'policy'));
