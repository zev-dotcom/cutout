-- Cutout bus schema migration: deliver messages in commit order.
-- For installs created from schema.sql before cutout.messages.seq existed.
-- Run after schema_v1.1.sql, and before deploying the matching index.ts.
-- Idempotent: safe to re-run, and a no-op on a fresh schema.sql install.
begin;

create sequence if not exists cutout.messages_seq;
alter table cutout.messages add column if not exists seq bigint;

-- Blocks new inserts (and waits for in-flight ones) until commit, so the
-- backfill and the trigger below see every row.
lock table cutout.messages in share row exclusive mode;

-- Same function and trigger as schema.sql.
create or replace function cutout.assign_seq()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  perform pg_advisory_xact_lock(hashtext('cutout.messages.seq'));
  new.seq := nextval('cutout.messages_seq');
  return new;
end $$;
drop trigger if exists messages_assign_seq on cutout.messages;
create trigger messages_assign_seq before insert on cutout.messages
  for each row execute function cutout.assign_seq();

-- Existing rows keep their old delivery order: (created_at, id).
update cutout.messages m
   set seq = b.base + b.n
  from (select id,
               row_number() over (order by created_at, id) as n,
               (select coalesce(max(seq), 0) from cutout.messages) as base
          from cutout.messages
         where seq is null) b
 where m.id = b.id;

select setval('cutout.messages_seq',
              greatest((select coalesce(max(seq), 1) from cutout.messages),
                       (select last_value from cutout.messages_seq)));

alter table cutout.messages alter column seq set not null;
create unique index if not exists messages_seq_idx on cutout.messages (seq);
create index if not exists messages_thread_seq_idx on cutout.messages (thread_id, seq);
create index if not exists messages_to_seq_idx     on cutout.messages (to_agent, seq);

commit;
