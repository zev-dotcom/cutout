-- Smith v1: bring the LIVE agentcollab schema up to Smith level.
-- Option A (deploy-compat): the Smith edge function runs against the live
-- `agentcollab` schema when SMITH_SCHEMA=agentcollab. Run this file (once) on
-- the live Supabase project via the SQL editor, BEFORE deploying the
-- schema-aware function build. Idempotent and strictly add-only:
--   - base bus tables / indexes: CREATE IF NOT EXISTS only
--   - purge helpers: created only if the live schema lacks them
--   - message type check: widened only if 'resolve' is not already allowed
--   - Smith tables (smith_*): created in the default schema, IF NOT EXISTS
--   - seeds: INSERT ... ON CONFLICT DO NOTHING from agentcollab.messages
-- Untouched: archive triggers, existing cron jobs (no pg_cron statements
-- below), existing constraints and data. No DROP of live objects.
--
-- Builder: verify the real agentcollab tables/columns match the assumed v1.1
-- shape before running (especially idempotency_keys PK and messages.type).

-- Cutout bus schema (SPEC v1). Dedicated schema in the existing Supabase project.
create schema if not exists agentcollab;

create table if not exists agentcollab.messages (
  id          text primary key,                 -- msg_<ulid>
  thread_id   text not null,
  from_agent  text not null,
  to_agent    text not null,                    -- agent id or '*'
  type        text not null check (type in ('note','question','decision','task','link','receipt-info')),
  body        text not null,
  reply_to    text,
  created_at  timestamptz not null default now(),
  metadata    jsonb not null default '{}'::jsonb
);
create index if not exists messages_order_idx  on agentcollab.messages (created_at, id);
create index if not exists messages_thread_idx on agentcollab.messages (thread_id, created_at, id);
create index if not exists messages_to_idx     on agentcollab.messages (to_agent, created_at, id);

create table if not exists agentcollab.receipts (
  message_id text not null references agentcollab.messages(id) on delete cascade,
  agent      text not null,
  status     text not null check (status in ('received','acted','consumed')),
  at         timestamptz not null default now(),
  primary key (message_id, agent)
);

create table if not exists agentcollab.rate_log (
  at timestamptz not null default now()
);
create index if not exists rate_log_at_idx on agentcollab.rate_log (at);

create table if not exists agentcollab.meta (
  k text primary key,
  v jsonb not null
);

-- Timestamp cast that returns NULL instead of raising on malformed input, so
-- one bad metadata value cannot abort the purge for every row. Reads what the
-- reference server reads: ISO 8601 date-times only (not words such as
-- 'yesterday'), and no offset means UTC whatever the database time zone.
-- Add-only: only created when the live schema does not already define it.
do $mig$ begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'agentcollab' and p.proname = 'try_timestamptz'
  ) then
    create function agentcollab.try_timestamptz(v text)
returns timestamptz language plpgsql stable
set search_path = pg_catalog set timezone = 'UTC' as $func$
begin
  if v !~ '^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?([Zz]|[+-]\d{2}(:?\d{2})?)?$' then
    return null;
  end if;
  return v::timestamptz;
exception when others then
  return null;
end $func$;
  end if;
end $mig$;

-- Retention purge (SPEC: startup + at least daily; also marks expired one-time links consumed
-- and erases their URL).
-- A link whose expires_at does not parse never counts as expired.
-- Add-only: only created when the live schema does not already define it.
do $mig$ begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'agentcollab' and p.proname = 'purge'
  ) then
    create function agentcollab.purge(retention_days int default 30)
returns jsonb language plpgsql security definer set search_path = agentcollab as $func$
declare
  purged int := 0; marked int := 0;
begin
  if retention_days > 0 then
    delete from agentcollab.messages where created_at < now() - make_interval(days => retention_days);
    get diagnostics purged = row_count;
  end if;
  update agentcollab.messages
     set metadata = jsonb_set(metadata, '{one_time_link}', (metadata->'one_time_link')
           || '{"consumed": true, "url": null, "url_redacted": true}'::jsonb, false)
   where jsonb_typeof(metadata->'one_time_link') = 'object'
     and metadata->'one_time_link'->'consumed' is distinct from 'true'::jsonb
     and jsonb_typeof(metadata->'one_time_link'->'expires_at') = 'string'
     and agentcollab.try_timestamptz(metadata->'one_time_link'->>'expires_at')
           < now() - interval '5 minutes';
  get diagnostics marked = row_count;
  delete from agentcollab.rate_log where at < now() - interval '1 day';
  insert into agentcollab.meta(k, v) values ('last_purge', to_jsonb(now()))
    on conflict (k) do update set v = excluded.v;
  return jsonb_build_object('purged', purged, 'links_marked_consumed', marked);
end $func$;
  end if;
end $mig$;

-- Cutout bus schema migration v1 -> v1.1. Run after schema.sql (v1).
-- Leaves the shape of agentcollab.messages and agentcollab.receipts unchanged.

-- (3) resolve/reopen: new message type.
-- Add-only: widen the type check only when the live constraint does not
-- already allow 'resolve'.
do $mig$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'messages_type_check'
      and conrelid = 'agentcollab.messages'::regclass
      and pg_get_constraintdef(oid) ilike '%resolve%'
  ) then
    alter table agentcollab.messages drop constraint if exists messages_type_check;
    alter table agentcollab.messages add constraint messages_type_check
      check (type in ('note','question','decision','task','link','receipt-info','resolve'));
  end if;
end $mig$;

-- (2) idempotency keys, scoped per from-agent. Rows cascade away with their
-- message, so keys are honored for exactly the retention window.
create table if not exists agentcollab.idempotency_keys (
  from_agent text not null,
  idem_key   text not null check (char_length(idem_key) between 1 and 128),
  message_id text not null references agentcollab.messages(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (from_agent, idem_key)
);
create index if not exists idempotency_keys_msg_idx on agentcollab.idempotency_keys (message_id);

-- (1) receipt reads: lookup by message ordered by time.
create index if not exists receipts_msg_at_idx on agentcollab.receipts (message_id, at);
alter table agentcollab.idempotency_keys enable row level security;

-- Smith v1 schema: identity, pairing, thread ACLs, activity, owner audit.
-- Run after schema.sql + schema_v1.1.sql. Idempotent.
-- Single owner per instance; anyone can run their own instance.

create table if not exists smith_agents (
  agent_id     text primary key,                       -- e.g. 'koda', 'i2'
  display_name text not null,
  platform     text not null default 'unknown',        -- Muse, Instinct, Grokbot…
  token_hash   text unique,                           -- sha256 hex of sm_agt_ token; null = known id, no Smith token yet
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  legacy_unverified boolean not null default false     -- true when seeded from unverified legacy sender fields
);
alter table smith_agents add column if not exists legacy_unverified boolean not null default false;
create index if not exists smith_agents_token_idx on smith_agents (token_hash);

create table if not exists smith_pairings (
  id          text primary key,                        -- pg_ + ulid-ish
  code_hash   text not null unique,                    -- sha256 hex of the code
  agent_id    text not null references smith_agents(agent_id),
  expires_at  timestamptz not null,
  redeemed_at timestamptz,
  locked_at   timestamptz,                             -- set after too many failed redeem attempts
  created_at  timestamptz not null default now()
);
alter table smith_pairings add column if not exists locked_at timestamptz;

-- Failed unauthenticated auth attempts (pairing redeem, owner claim).
-- Backs the global brute-force budgets; pruned to the last hour on each attempt.
create table if not exists smith_auth_attempts (
  id        bigserial primary key,
  kind      text not null,                             -- 'redeem' or 'claim'
  code_hash text,                                      -- redeem code hash; null for claim/invalid
  at        timestamptz not null default now()
);
create index if not exists smith_auth_attempts_kind_at_idx on smith_auth_attempts (kind, at desc);

create table if not exists smith_threads (
  thread_id  text primary key,
  name       text,
  created_by text,
  created_at timestamptz not null default now()
);

create table if not exists smith_thread_members (
  thread_id text not null references smith_threads(thread_id) on delete cascade,
  agent_id  text not null,
  added_at  timestamptz not null default now(),
  legacy_unverified boolean not null default false,    -- true when seeded from unverified legacy sender fields
  primary key (thread_id, agent_id)
);
alter table smith_thread_members add column if not exists legacy_unverified boolean not null default false;
create index if not exists smith_members_agent_idx on smith_thread_members (agent_id);

create table if not exists smith_activity (
  thread_id  text not null,
  agent_id   text not null,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (thread_id, agent_id)
);
create index if not exists smith_activity_expiry_idx on smith_activity (expires_at);

-- One row per instance. The raw token is shown once by the mint script;
-- only the hash lives here.
create table if not exists smith_owner (
  id         int primary key default 1 check (id = 1),
  token_hash text not null,
  created_at timestamptz not null default now()
);

-- Append-only audit log. No route deletes rows.
create table if not exists smith_audit (
  id     bigserial primary key,
  at     timestamptz not null default now(),
  actor  text not null,                                 -- 'owner' or agent_id
  action text not null,                                 -- read_thread, issue_pairing, …
  detail jsonb not null default '{}'::jsonb
);
create index if not exists smith_audit_at_idx on smith_audit (at desc);

-- Migrate every pre-existing thread into managed threads, seeding members
-- from the agent ids already seen on each thread (excluding broadcasts).
-- Seeded rows are marked legacy_unverified: the owner reviews them (see the
-- verify_member owner route) before treating membership as authoritative.
-- Strict (P1-2): unverified seeded members get no thread access until verified.
-- added_at '-infinity' marks pre-existing participants: they see full history
-- (P1-3); explicitly added members default to now() and see history from join.
insert into smith_threads (thread_id, created_by)
select distinct thread_id, null from agentcollab.messages
on conflict (thread_id) do nothing;

insert into smith_thread_members (thread_id, agent_id, legacy_unverified, added_at)
select distinct thread_id, from_agent, true, '-infinity'::timestamptz from agentcollab.messages
where from_agent is not null and from_agent <> '*'
on conflict do nothing;

insert into smith_thread_members (thread_id, agent_id, legacy_unverified, added_at)
select distinct thread_id, to_agent, true, '-infinity'::timestamptz from agentcollab.messages
where to_agent is not null and to_agent <> '*'
on conflict do nothing;

-- Seed agent rows for ids already on the bus so re-pairing is a rotation,
-- not a duplicate. token_hash stays null until the owner issues a pairing
-- code; null means "known id, no Smith token yet".
insert into smith_agents (agent_id, display_name, platform, token_hash, legacy_unverified)
select distinct from_agent, from_agent, 'unknown', null, true from agentcollab.messages
where from_agent is not null and from_agent <> '*'
on conflict (agent_id) do nothing;

-- Append-only audit log: no route deletes rows, and the database itself
-- rejects UPDATE and DELETE so a compromised function cannot rewrite history.
-- P2-E: scope idempotency keys to (from_agent, idem_key, thread_id) so a reused
-- key in a different thread creates a new message instead of returning the old
-- thread's message id. The PK constraint is named explicitly so the idempotence
-- guard matches on re-run (an unnamed ADD PRIMARY KEY would be created as
-- idempotency_keys_pkey and the guard would never match, dropping and
-- re-adding the PK on every migration). The whole block runs in one
-- transaction so a re-run can never leave the table without its PK.
begin;
alter table agentcollab.idempotency_keys add column if not exists thread_id text;
update agentcollab.idempotency_keys k set thread_id = m.thread_id
  from agentcollab.messages m where m.id = k.message_id and k.thread_id is null;
alter table agentcollab.idempotency_keys alter column thread_id set not null;
alter table agentcollab.idempotency_keys drop constraint if exists idempotency_keys_pkey;
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'agentcollab.idempotency_keys'::regclass
      and conname = 'idempotency_keys_from_key_thread_pkey'
  ) then
    alter table agentcollab.idempotency_keys add constraint idempotency_keys_from_key_thread_pkey primary key (from_agent, idem_key, thread_id);
  end if;
end $$;
commit;

-- P2-D: per-identity rate-limit buckets. The base agentcollab.rate_log only has
-- (at); add an identity column so the limiter can enforce a per-credential
-- budget alongside the global ceiling.
alter table agentcollab.rate_log add column if not exists identity text;
create index if not exists rate_log_identity_at_idx on agentcollab.rate_log (identity, at desc);

create or replace function smith_audit_deny_write() returns trigger as $$
begin
  raise exception 'smith_audit is append-only';
end; $$ language plpgsql;
drop trigger if exists smith_audit_no_update_delete on smith_audit;
create trigger smith_audit_no_update_delete before update or delete on smith_audit
  for each row execute function smith_audit_deny_write();
-- P2-7: TRUNCATE is also blocked (row-level triggers do not fire on TRUNCATE).
drop trigger if exists smith_audit_no_truncate on smith_audit;
create trigger smith_audit_no_truncate before truncate on smith_audit
  for each statement execute function smith_audit_deny_write();

alter table smith_agents enable row level security;
alter table smith_pairings enable row level security;
alter table smith_threads enable row level security;
alter table smith_thread_members enable row level security;
alter table smith_activity enable row level security;
alter table smith_owner enable row level security;
alter table smith_audit enable row level security;
alter table smith_auth_attempts enable row level security;
