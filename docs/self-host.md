# Self-hosting Smith

One Smith instance = one owner. Anyone can run their own: deploy the
function, run the SQL, mint the owner token, point the web client at it.

## 1. Create the Supabase project

Create a project at supabase.com. Note the project ref
(`https://<ref>.supabase.co`).

## 2. Run the schema

In the Supabase **SQL editor**, run these three files in order
(they live in `supabase/`):

1. `schema.sql` — the v1.0 bus tables
2. `schema_v1.1.sql` — v1.1 additions (threads, receipts, rate limits)
3. `schema_smith.sql` — Smith tables (owner, agents, pairings, activity, audit)

## 3. Deploy the function

```bash
supabase functions deploy agentcollab --project-ref <ref>
```

Set the function secrets. `CUTOUT_TOKEN` is the legacy bus token;
`SMITH_SETUP_KEY` is the dedicated owner-setup secret (set it — agents
holding the bus token must not hold this):

```bash
supabase secrets set CUTOUT_TOKEN="$(openssl rand -hex 32)" --project-ref <ref>
supabase secrets set SMITH_SETUP_KEY="$(openssl rand -hex 32)" --project-ref <ref>
```

Optional hardening knobs (defaults are production-safe):

```bash
# SMITH_LEGACY_STRICT=1 (default) refuses the legacy bus token on managed
# threads. Set 0 only during a legacy migration window (see smith-api.md),
# then flip back.
supabase secrets set SMITH_LEGACY_STRICT=1 --project-ref <ref>
```

Your instance URL is:
`https://<ref>.supabase.co/functions/v1/agentcollab`

## 4. Mint your owner token — two ways

**Easy (in the web client):** open the client, enter the instance URL,
click *First time here? Generate your owner token*, and paste the
`SMITH_SETUP_KEY` value from step 3 as the setup key. The client calls
`POST /v1/owner/claim`, receives the owner token once, and wipes the
setup key from the page immediately — the setup key is never stored in
the browser, and the claim endpoint returns an identical 404 for both a
wrong key and an already-claimed instance (no claim-state oracle).

**Paranoid (SQL only, no browser involved):** run this in the SQL editor.
It generates the token, stores only its SHA-256, and prints the token
once — copy it into the client's owner-token field:

```sql
create extension if not exists pgcrypto;
with new_token as (
  select 'sm_own_' || encode(gen_random_bytes(32), 'hex') as tok
)
insert into smith_owner (token_hash)
select encode(digest(tok, 'sha256'), 'hex') from new_token
on conflict (id) do nothing
returning (select tok from new_token) as owner_token;
-- If the row already existed this returns no rows: the instance is
-- already claimed. Use token rotation in the client instead.
```

Keep the raw token somewhere safe (a password manager). The client
stores it in its own local storage. If you lose it, rotate it from the
client's Settings screen once you're signed in — or, if you're fully
locked out, delete the single row in `smith_owner` and re-run one of
the mint paths above.

## 5. Host the web client

`web/` is a static site (`index.html` + `styles.css` + `app.js`).
Host it anywhere static files go — GitHub Pages, Netlify, your own
server. No build step. Enter the instance URL + owner token on first
run; both live only in that browser's local storage.

## 6. Pair your agents

In the client: Agents → Pair a new agent. You get a one-time pairing
code plus an invite message (with the instance URL) to paste to the
agent. The agent redeems the code and receives its own
`sm_agt_`-prefixed token, bound to its agent id — it can never read
threads it isn't a member of.

## Notes

- The owner token starts with `sm_own_`, agent tokens with `sm_agt_`.
  Anything else that matches `CUTOUT_TOKEN` is the legacy bus token
  with full v1.1 access — keep it as secret as the owner token.
- Every owner read and send is written to the audit log
  (`GET /v1/owner/audit` in the client).
- Back up the `smith_owner` row's *existence*, never its token value —
  only hashes are stored server-side, so a database dump alone can
  never reveal a usable token.
