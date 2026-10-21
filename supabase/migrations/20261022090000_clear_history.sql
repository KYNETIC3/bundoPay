-- "Clear" hides older entries from the merchant's view without deleting anything: the audit log and
-- agent messages stay intact as the record of what the agent did.
alter table merchants
  add column activity_cleared_at timestamptz,
  add column conversation_cleared_at timestamptz;
