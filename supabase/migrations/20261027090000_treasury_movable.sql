-- When PayPal returns no Operating balance (common in the sandbox), the owner may set how much BundoPay may
-- treat as available. It is the owner's own number, never shown as PayPal's, and is used only while PayPal gives none.
alter table treasury_limits add column movable_when_unknown numeric(14, 2) check (movable_when_unknown >= 0);
