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
select distinct thread_id, null from cutout.messages
on conflict (thread_id) do nothing;

insert into smith_thread_members (thread_id, agent_id, legacy_unverified, added_at)
select distinct thread_id, from_agent, true, '-infinity'::timestamptz from cutout.messages
where from_agent is not null and from_agent <> '*'
on conflict do nothing;

insert into smith_thread_members (thread_id, agent_id, legacy_unverified, added_at)
select distinct thread_id, to_agent, true, '-infinity'::timestamptz from cutout.messages
where to_agent is not null and to_agent <> '*'
on conflict do nothing;

-- Seed agent rows for ids already on the bus so re-pairing is a rotation,
-- not a duplicate. token_hash stays null until the owner issues a pairing
-- code; null means "known id, no Smith token yet".
insert into smith_agents (agent_id, display_name, platform, token_hash, legacy_unverified)
select distinct from_agent, from_agent, 'unknown', null, true from cutout.messages
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
alter table cutout.idempotency_keys add column if not exists thread_id text;
update cutout.idempotency_keys k set thread_id = m.thread_id
  from cutout.messages m where m.id = k.message_id and k.thread_id is null;
alter table cutout.idempotency_keys alter column thread_id set not null;
alter table cutout.idempotency_keys drop constraint if exists idempotency_keys_pkey;
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'cutout.idempotency_keys'::regclass
      and conname = 'idempotency_keys_from_key_thread_pkey'
  ) then
    alter table cutout.idempotency_keys add constraint idempotency_keys_from_key_thread_pkey primary key (from_agent, idem_key, thread_id);
  end if;
end $$;
commit;

-- P2-D: per-identity rate-limit buckets. The base cutout.rate_log only has
-- (at); add an identity column so the limiter can enforce a per-credential
-- budget alongside the global ceiling.
alter table cutout.rate_log add column if not exists identity text;
create index if not exists rate_log_identity_at_idx on cutout.rate_log (identity, at desc);

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

-- Wake hooks (see docs/wake-recipe.md)
-- Smith wake hooks (additive, idempotent). One row per agent: how Smith nudges it
-- when mail arrives. Delivery never depends on wake; the payload carries only a count.
create table if not exists smith_wake_hooks (
  agent_id        text primary key references smith_agents(agent_id) on delete cascade,
  method          text not null default 'none'
                  check (method in ('none','wait','schedule','webhook','email')),
  config          jsonb not null default '{}'::jsonb,   -- webhook: {url}; schedule: {interval_minutes}; email: {address}
  signing_secret  text,                                 -- HMAC key for webhook signing; never returned after creation
  enabled         boolean not null default true,
  last_poll_at    timestamptz,                          -- last time the agent read its mail (suppresses wakes)
  last_wake_at    timestamptz,                          -- debounce anchor
  last_status     text,                                 -- ok | http_NNN | error:<short> | skipped:<why>
  fail_count      integer not null default 0,
  updated_at      timestamptz not null default now()
);
create index if not exists smith_wake_hooks_method_idx on smith_wake_hooks (method) where enabled;
alter table smith_wake_hooks enable row level security;

create table if not exists smith_owner_reads (
  thread_id    text primary key references smith_threads(thread_id) on delete cascade,
  last_read_at timestamptz not null default now()
);
alter table smith_owner_reads enable row level security;
