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
revoke all on smith.smith_wake_hooks from anon, authenticated;
