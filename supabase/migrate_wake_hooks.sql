-- Run after migrate_smith_onto_agentcollab.sql (needs smith.smith_agents). Schema name: smith.
-- Rollback: drop table if exists smith.smith_wake_hooks;
-- Smith wake hooks (additive, idempotent). One row per agent: how Smith nudges it
-- when mail arrives. Delivery never depends on wake; the payload carries only a count.
create table if not exists smith.smith_wake_hooks (
  agent_id        text primary key references smith.smith_agents(agent_id) on delete cascade,
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
create index if not exists smith_wake_hooks_method_idx on smith.smith_wake_hooks (method) where enabled;

-- Holds the HMAC signing secret: lock it down. The function connects as a privileged role; nobody else reads this.
alter table smith.smith_wake_hooks enable row level security;
do $$ begin if exists (select 1 from pg_roles where rolname='anon') then revoke all on smith.smith_wake_hooks from anon, authenticated; end if; end $$;

-- Owner read marker per thread (drives the unread badge).
create table if not exists smith.smith_owner_reads (
  thread_id    text primary key references smith.smith_threads(thread_id) on delete cascade,
  last_read_at timestamptz not null default now()
);
alter table smith.smith_owner_reads enable row level security;
do $$ begin if exists (select 1 from pg_roles where rolname='anon') then revoke all on smith.smith_owner_reads from anon, authenticated; end if; end $$;

-- Web Push for the owner's devices. Keys are generated per instance on first opt-in.
create table if not exists smith.smith_push_config (
  id           integer primary key check (id = 1),
  public_key   text not null,
  private_jwk  jsonb not null,           -- VAPID private key: server-side only, never returned
  contact      text not null default 'mailto:noreply@example.invalid',
  include_body boolean not null default false,
  created_at   timestamptz not null default now()
);
create table if not exists smith.smith_push_subs (
  id           text primary key,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  label        text not null default 'device',
  created_at   timestamptz not null default now(),
  last_ok_at   timestamptz,
  last_push_at timestamptz,
  fail_count   integer not null default 0
);
alter table smith.smith_push_config enable row level security;
alter table smith.smith_push_subs enable row level security;
do $$ begin if exists (select 1 from pg_roles where rolname='anon') then revoke all on smith.smith_push_config from anon, authenticated; revoke all on smith.smith_push_subs from anon, authenticated; end if; end $$;

-- Wake health: cursor, wake log, canaries (additive).
create table if not exists smith.smith_agent_cursor (
  agent_id     text primary key,
  acked_id     text,
  acked_at     timestamptz,
  last_peek_at timestamptz
);
create table if not exists smith.smith_wake_log (
  id        bigserial primary key,
  agent_id  text not null,
  at        timestamptz not null default now(),
  method    text,
  status    text,
  thread_id text,
  polled_at timestamptz
);
create index if not exists smith_wake_log_agent_at on smith.smith_wake_log (agent_id, at desc);
create table if not exists smith.smith_canaries (
  id              text primary key,
  agent_id        text not null,
  thread_id       text not null,
  msg_id          text,
  created_at      timestamptz not null default now(),
  picked_at       timestamptz,
  acked_at        timestamptz,
  source          text not null default 'owner'
);
create index if not exists smith_canaries_agent_at on smith.smith_canaries (agent_id, created_at desc);
alter table smith.smith_agent_cursor enable row level security;
alter table smith.smith_wake_log enable row level security;
alter table smith.smith_canaries enable row level security;
do $$ begin if exists (select 1 from pg_roles where rolname='anon') then revoke all on smith.smith_agent_cursor from anon, authenticated; revoke all on smith.smith_wake_log from anon, authenticated; revoke all on smith.smith_canaries from anon, authenticated; end if; end $$;

-- Auto "seen": first time a recipient agent's poll returned an owner message (additive).
create table if not exists smith.smith_seen (
  message_id text not null,
  agent_id   text not null,
  at         timestamptz not null default now(),
  primary key (message_id, agent_id)
);
alter table smith.smith_seen enable row level security;
do $$ begin if exists (select 1 from pg_roles where rolname='anon') then revoke all on smith.smith_seen from anon, authenticated; end if; end $$;
