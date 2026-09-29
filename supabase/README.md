# Supabase edge-function port

A drop-in port of the SPEC v1.1 reference server to a Supabase Edge
Function (Deno) backed by Postgres. Wire-compatible with `../SPEC.md`:
same endpoints, fields, and status codes.

## Files

- `index.ts` — the edge function (Deno, `npm:postgres`). Config is env
  only, no secrets in code.
- `schema.sql` — base schema: messages, receipts, rate log, meta, and
  the retention purge (runs at cold start and daily via pg_cron).
- `schema_v1.1.sql` — v1 → v1.1 migration: `resolve` message type,
  `idempotency_keys` table, receipt-read index.
- `schema_commit_order.sql` — adds `messages.seq` (commit order, used by
  polls) to installs created before it existed. Idempotent; a no-op on
  a fresh `schema.sql`. See [Upgrading](#upgrading-to-commit-order-delivery).
- `schema_commit_order_down.sql` — undoes it, if ever needed.

## Deploy

1. Create a Supabase project (or reuse one). Run `schema.sql`, then
   `schema_v1.1.sql`, then `schema_commit_order.sql`, in the SQL editor.
   Upgrading an existing install: follow
   [Upgrading](#upgrading-to-commit-order-delivery) instead.
2. Deploy the function (JWT verification off; the bus does its own
   bearer check):
   ```sh
   supabase functions deploy cutout --no-verify-jwt
   ```
3. Set the secrets:
   ```sh
   supabase secrets set CUTOUT_TOKEN="$(openssl rand -hex 32)"
   ```
   `SUPABASE_DB_URL` is provided to edge functions automatically.
   Optional: `POOLER_HOST` to route through your project's Supavisor
   transaction pooler (recommended; direct connection slots are scarce).
4. Verify:
   ```sh
   curl https://<project-ref>.supabase.co/functions/v1/cutout/health
   # {"ok":true,"version":"1.1"}
   ```

The function slug is stripped before routing, so the API paths are
exactly the spec's: `.../cutout/v1/messages`, etc.

Limits match the spec: 60 req/min sliding window, 20 KB body cap,
16 KB metadata cap, 30-day retention purge (cold start + pg_cron daily).

## Upgrading to commit-order delivery

Polls page by `messages.seq`, which a trigger assigns in commit order.
`created_at` is the transaction start time, so paging by it can skip a
message whose transaction commits late. The cursor format does not
change: a cursor still names the last message delivered.

Deploy in two stages. Each stage can be rolled back on its own.

1. **Schema.** Run `schema_commit_order.sql` while the current
   function keeps serving. It locks `cutout.messages` for the length of
   the backfill (reads and writes wait), then numbers existing rows in
   their old `(created_at, id)` order. The current function works
   unchanged on the migrated schema: its inserts get a `seq` from the
   trigger, and it still pages by `created_at`. Re-running is safe.
2. **Function.** Deploy the new `index.ts`. Cursors that clients already
   hold resume in place, also when their message has been purged.

Check after each stage: post a message, then poll with a saved cursor.

**Rollback.**

- Function: redeploy the previous `index.ts`. It keeps working on the
  migrated schema, including with cursors issued by the new function
  (same format). Until you roll forward again, a message that commits
  late can be skipped, as it could before the upgrade.
- Schema, only if ever needed: first redeploy the previous `index.ts`
  (the new one needs `seq`), then run `schema_commit_order_down.sql`.
  To upgrade again, repeat stage 1.

**Inserts are serialized.** The trigger holds a lock until the inserting
transaction commits, so inserts run one at a time. API posts hold it for
milliseconds. A long transaction that inserts into `cutout.messages`
(for example, a manual SQL session left open) blocks other inserts until
it ends. The function waits at most 2.5 s for the lock, inside its 3.5 s
post budget. Then it returns `503` with `Retry-After: 1` and stores
nothing, so a client retry (with the same `idempotency_key`) is safe.
Polls do not take the lock and are not affected.

## Tests

`../tests/edge_test.py` runs this function under Deno against a
throwaway local Postgres 16 cluster. It needs `initdb`, `pg_ctl`,
`psql` and `deno` on `PATH` and skips otherwise. No Docker, no
Supabase CLI, no network after Deno has cached `npm:postgres`.

```sh
python3 tests/edge_test.py
```

The upgrade and rollback tests read the previous function and schema
from git history, so run them from a git checkout.
