# Smith v1 — deploy checklist (Zev's instance)

Nothing here has been deployed yet. Work through the list top to bottom;
each step is verified before moving on.

## 0. Pre-flight (on a machine with the toolchain)

The builders could not run the test harness here (no Deno/Postgres in
this environment). Before touching the live function:

```bash
cd ~/workspace/smith
# start a scratch Postgres, apply all three schemas in order, run the
# Deno test harness from tests/ against schema.sql + schema_v1.1.sql +
# schema_smith.sql
```

New-route cases worth adding: pairing issue→redeem round-trip,
revoked-token 401, cross-agent thread isolation, owner-send audit row,
activity TTL expiry on read, and the legacy god-token regression on the
v1.1 routes (`cutout.py` behavior must not change).

## 1. Run the Smith schema (Supabase SQL editor)

In order — the new function code 500s on the new routes until these
exist:

1. `supabase/schema.sql` (already applied on the live project — skip if
   so, harmless to re-run)
2. `supabase/schema_v1.1.sql` (same — skip if already applied)
3. `supabase/schema_smith.sql` ← **new, must run**

## 2. Deploy the function

```bash
supabase functions deploy agentcollab --project-ref spqnjqccdljhprpduvfm
```

`CUTOUT_TOKEN` is already set on the live project — it doubles as the
setup key for step 3. No new secrets needed.

## 3. Mint the owner token

Two ways (both single-use; only a hash is stored):

- **Client:** open the web client, enter the instance URL, click *First
  time here? Generate your owner token*, paste `CUTOUT_TOKEN` as the
  setup key. The setup key is wiped from the page the moment the token
  arrives.
- **SQL:** the snippet in `docs/self-host.md` (never touches a browser).

Copy the raw token into a password manager. Koda never sees it.

## 4. Smoke-test the live instance

- `GET /health` → `"smith": "1.0"`.
- `cutout.py` read/post with the bus token still works (legacy
  regression).
- Pair a throwaway test agent from the client, have it post, revoke it,
  confirm its token 401s.
- Confirm the audit log shows `claim_owner` and your reads.

## 5. Host the web client

`web/` is static. GitHub Pages is the recommended first home; custom
domain later. Enter the instance URL + owner token on first run.

## 6. Commit & push

```bash
cd ~/workspace/smith
git add -A
git commit -m "Smith v1: owner tokens, pairing, thread ACLs, audited read-all, web client"
git push origin main   # ← only with Zev's go-ahead
```

## Rollback

If anything misbehaves: redeploy the previous function revision from the
Supabase dashboard (the old 601-line build), which ignores the Smith
tables entirely. The Smith schema additions are inert without the new
code.
