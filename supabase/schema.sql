-- Cutout bus schema (SPEC v1). Dedicated schema in the existing Supabase project.
create schema if not exists cutout;

create table if not exists cutout.messages (
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
create index if not exists messages_order_idx  on cutout.messages (created_at, id);
create index if not exists messages_thread_idx on cutout.messages (thread_id, created_at, id);
create index if not exists messages_to_idx     on cutout.messages (to_agent, created_at, id);

create table if not exists cutout.receipts (
  message_id text not null references cutout.messages(id) on delete cascade,
  agent      text not null,
  status     text not null check (status in ('received','acted','consumed')),
  at         timestamptz not null default now(),
  primary key (message_id, agent)
);

create table if not exists cutout.rate_log (
  at timestamptz not null default now()
);
create index if not exists rate_log_at_idx on cutout.rate_log (at);

create table if not exists cutout.meta (
  k text primary key,
  v jsonb not null
);

-- Retention purge (SPEC: startup + at least daily; also marks expired one-time links consumed).
create or replace function cutout.purge(retention_days int default 30)
returns jsonb language plpgsql security definer set search_path = cutout as $$
declare
  purged int := 0; marked int := 0;
begin
  if retention_days > 0 then
    delete from cutout.messages where created_at < now() - make_interval(days => retention_days);
    get diagnostics purged = row_count;
  end if;
  update cutout.messages
     set metadata = jsonb_set(metadata, '{one_time_link,consumed}', 'true'::jsonb, false)
   where metadata ? 'one_time_link'
     and coalesce((metadata->'one_time_link'->>'consumed')::boolean, false) = false
     and (metadata->'one_time_link'->>'expires_at')::timestamptz < now() - interval '5 minutes';
  get diagnostics marked = row_count;
  delete from cutout.rate_log where at < now() - interval '1 day';
  insert into cutout.meta(k, v) values ('last_purge', to_jsonb(now()))
    on conflict (k) do update set v = excluded.v;
  return jsonb_build_object('purged', purged, 'links_marked_consumed', marked);
end $$;

-- Daily purge via pg_cron (belt) on top of edge-function cold-start purge (braces).
create extension if not exists pg_cron;
do $$
begin
  perform cron.unschedule('cutout-daily-purge');
exception when others then null;
end $$;
select cron.schedule('cutout-daily-purge', '17 4 * * *', $cron$select cutout.purge(30);$cron$);
