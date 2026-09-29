-- Cutout bus schema rollback: undo schema_commit_order.sql.
-- Only if ever needed. First redeploy the previous index.ts (it pages by
-- created_at and does not read seq); the current index.ts fails without seq.
-- Idempotent. Re-applying schema_commit_order.sql later upgrades again.
begin;

drop trigger if exists messages_assign_seq on cutout.messages;
drop function if exists cutout.assign_seq();
drop index if exists cutout.messages_seq_idx;
drop index if exists cutout.messages_thread_seq_idx;
drop index if exists cutout.messages_to_seq_idx;
alter table cutout.messages drop column if exists seq;
drop sequence if exists cutout.messages_seq;

commit;
