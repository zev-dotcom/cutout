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

## Deploy

1. Create a Supabase project (or reuse one). Run `schema.sql`, then
   `schema_v1.1.sql`, in the SQL editor.
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
