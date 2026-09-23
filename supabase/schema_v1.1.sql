-- Cutout bus schema migration v1 -> v1.1. Run after schema.sql (v1).
-- Leaves the shape of cutout.messages and cutout.receipts unchanged.

-- (3) resolve/reopen: new message type.
alter table cutout.messages drop constraint if exists messages_type_check;
alter table cutout.messages add constraint messages_type_check
  check (type in ('note','question','decision','task','link','receipt-info','resolve'));

-- (2) idempotency keys, scoped per from-agent. Rows cascade away with their
-- message, so keys are honored for exactly the retention window.
create table if not exists cutout.idempotency_keys (
  from_agent text not null,
  idem_key   text not null check (char_length(idem_key) between 1 and 128),
  message_id text not null references cutout.messages(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (from_agent, idem_key)
);
create index if not exists idempotency_keys_msg_idx on cutout.idempotency_keys (message_id);

-- (1) receipt reads: lookup by message ordered by time.
create index if not exists receipts_msg_at_idx on cutout.receipts (message_id, at);
alter table cutout.idempotency_keys enable row level security;
