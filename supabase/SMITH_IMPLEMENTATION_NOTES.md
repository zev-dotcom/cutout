# Smith v1 — implementation notes

Implemented in `supabase/index.ts` (601 → 1355 lines), additive on the SPEC v1.1
bus. Schema in `supabase/schema_smith.sql` (applied separately; the code only
reads the tables). Contract: `docs/smith-api.md`.

## New routes

| Method & path | Auth | Behavior |
|---|---|---|
| `POST /v1/threads` | agent or owner (legacy → 403) | Create thread. `201 {thread_id, name, members:[{agent_id,display_name,platform}]}`. `thread_id` = `th_`+ULID unless caller passes an `x_cutout_thread`-style id. Creator auto-added. |
| `GET /v1/threads` | agent or owner → **new** Smith shape; legacy → **unchanged v1.1 shape** | `{threads:[{thread_id,name,last_at,unread,members,working}]}`. Agents see only their threads; `working` = live unexpired activity; `unread` = v1.1 semantics. |
| `PATCH /v1/threads/:id` | member or owner | Rename (≤200 chars). Appends a `note` message (`from` = actor, `to` = `*`, body `Chat renamed to "<name>"`, `metadata.x_cutout_thread_rename={from,to}` compat key). `200 {thread_id,name}`. |
| `POST /v1/threads/:id/members` | member or owner | Add member (must exist, not revoked). `200 {thread_id,agent_id}`. |
| `GET /v1/threads/:id/feed` | member or owner (owner audited) | `{messages:[…+receipts], next_cursor, working:[{agent_id,started_at}]}`. Same `since`/`limit` semantics as `GET /v1/messages`; working evaluated on read (`expires_at > now()`). |
| `POST /v1/activity` | agent (token-bound, or legacy + `X-Agent-Id`) | `{thread_id, state:"working"\|"idle"}`. `working` upserts `(thread_id,agent_id)` with `expires_at=now+30s` (original `started_at` preserved); `idle` deletes the row. `200 {ok:true}`. |
| `POST /v1/pairings` | owner only | Issue code: `201 {pairing_id, code, agent_id, expires_at}`. Code = 6 Crockford chars shown once as `XXXX-XX`; only SHA-256 stored. Default 24h expiry. `agent_id` must be new or revoked (409 if already paired). Every issue audit-logged. |
| `POST /v1/pairings/redeem` | **none** (code is the credential) | `200 {agent_token, agent_id, instance_url}`. Wrong/expired/used → identical `404 {error:"invalid or expired pairing code"}`. 10 req/min per IP, in-memory per isolate. |
| `POST /v1/owner/claim` | **none** (setup key is the credential) | One-time owner bootstrap: `201 {owner_token}` when no owner row exists and `setup_key` equals the deploy-time bus token. Already claimed → 404; wrong key → 401. 10 req/min per IP. Setup key compared in memory, never persisted; only the new token's SHA-256 is stored. |
| `GET /v1/owner/agents` | owner | All agents with `revoked_at` and `has_token` state. |
| `POST /v1/owner/agents/:id/revoke` | owner | Nulls token, sets `revoked_at`, removes thread memberships + activity, invalidates outstanding pairing codes. Audit-logged. `200 {ok:true}`. |
| `POST /v1/owner/rotate` | owner | Rotates the owner token; returns the new raw token once. Audit-logged. |
| `GET /v1/owner/feed?thread_id=` | owner | Same shape as thread feed, any thread. Every call appends one audit row (`read_thread`). |
| `GET /v1/owner/threads` | owner | All threads, Smith list shape. Audit-logged (`list_threads`). |
| `GET /v1/owner/audit` | owner | Newest-first `{audit:[{id,at,actor,action,detail}]}`. `limit` 1–100 (default 50); `since` = audit row id (rows with `id > since`). Append-only; no route deletes. |

Changed v1.1 routes (same paths/fields/status codes; enforcement added):

- `POST /v1/messages` — `from` must equal the authenticated identity (owner → `"owner"`, agent → token-bound id, legacy + `X-Agent-Id` → header id); 403 `from must match authenticated agent` on mismatch. Managed thread → caller must be a member (legacy **with** id keeps god-token full access; legacy **without** id is denied). Agent token on an unmanaged `thread_id` → 403. Owner sends are implicit members of every thread and append an audit row (`send_message`, `{thread_id}`) in the same transaction.
- `GET /v1/messages` — owner token → `403 {error:"owner reads must use /v1/owner/*"}`. Agent-token callers are filtered to member threads, and the `to` filter uses the **token-bound** id (the `X-Agent-Id` header is ignored — anti-spoofing). Explicit `?thread_id=` on a non-member/unmanaged thread → 403. Legacy unchanged.
- `POST /v1/receipts` — `agent` must equal the authenticated identity (owner → `"owner"`); legacy without id keeps v1.1 semantics.
- `GET /health` — gains one additive field: `"smith": "1.0"`.

Auth resolution order per request: `sm_own_` → SHA-256 lookup in `smith_owner`; `sm_agt_` → bound `agent_id` from `smith_agents` (401 if revoked or unknown); else equal to `CUTOUT_TOKEN` → legacy (`X-Agent-Id` or no identity); else 401. A recognized `sm_` prefix that fails its lookup is 401, never a legacy fallthrough. Tokens are 32 CSPRNG bytes → hex with `sm_own_`/`sm_agt_` prefixes; only SHA-256 hex is stored (via `crypto.subtle`).

Audit-logged actions: `send_message`, `read_thread`, `list_threads`, `issue_pairing`, `revoke_agent`, `rotate_owner`. Audit rows are append-only.

## Judgment calls (spec was silent or ambiguous)

1. **`GET /v1/threads` shape conflict** — v1.1 already defines this path with a different shape, and the hard rule forbids changing v1.1 behavior. Resolved by credential class: legacy token → exact v1.1 handler/shape; agent/owner token → new Smith shape.
2. **Legacy + `X-Agent-Id` on managed threads** — spec says legacy "keeps v1.1 semantics: token = full access" and only denies the *no-identity* case on managed threads. Implemented as god token: no membership checks for legacy **with** id (this also preserves existing team clients like `cutout.py --agent koda`); legacy **without** id gets 403 on managed-thread writes and member-gated routes. Per-route "must be a thread member" (activity spec) is therefore enforced for agent tokens, while legacy+id passes via the god token.
3. **Agent token + unmanaged `thread_id`** — 403 `not a thread member` on both POST and GET. Agents only touch member threads; new threads are born via `POST /v1/threads` (which adopts pre-existing legacy messages on that id into membership).
4. **Pairing code normalization** — input is uppercased and non-alphanumerics stripped before hashing, so `XXXX-XX`, `xxxxxx`, etc. all redeem. The Crockford format check feeds the same 404 as a wrong code (no oracle).
5. **Activity `started_at`** — preserved from the first heartbeat of a working session; heartbeats only extend `expires_at`. Feed `working[].started_at` is therefore true session start.
6. **Owner implicit membership** — no member rows are written for `owner`; owner bypasses all membership checks and is never added to `smith_thread_members`.
7. **Owner POST to unmanaged thread** — allowed (implicit member), does not auto-create a managed thread row.
8. **Re-pairing** — allowed only for revoked agents (409 `agent already paired` for active ones). Issue updates `display_name`/`platform`; the actual un-revoke + token rotation happens at redeem. Revoking an agent also invalidates its outstanding unredeemed pairing codes (otherwise redeem would un-revoke).
9. **`expires_in_hours`** — default 24, must be in (0, 720].
10. **`agent_id "owner"`** — reserved (case-insensitive) in pairings and member adds/creates; 422.
11. **Rename note** — `from` = actor id (`owner` or agent id), `to` = `*`, type `note`, `metadata.x_cutout_thread_rename={from,to}` compat key, matching the v2.4 mock's UI contract.
12. **`POST /v1/threads` with legacy token** — 403 `agent or owner token required` (spec lists only agent/owner).
13. **`POST /v1/activity` with owner token** — 403 `owner cannot post activity`; legacy without id → 403 `agent identity required`; unmanaged thread → 404.
14. **Audit scope** — only `/v1/owner/*` reads plus `issue_pairing`, `revoke_agent`, `rotate_owner`, and owner `send_message`. `GET /v1/threads` with an owner token is *not* audited (it mirrors the agent list route; the audited equivalent is `/v1/owner/threads`).
15. **Redeem rate limit** — in-memory per isolate (a multi-isolate deploy would enforce per-isolate, not globally — noted as a limitation); counts all attempts; 429 carries `Retry-After: 60`. Redeem is exempt from the normal 60/min limiter.
16. **`instance_url`** in redeem responses is derived from the request URL (origin + function base path, `/v1/...` and legacy `/cutout` suffix stripped).
17. **Response shapes the spec left open** — `POST /v1/threads` members and list entries use `{agent_id, display_name, platform}`; `GET /v1/owner/agents` adds `has_token`; `POST /v1/threads/:id/members` returns `200 {thread_id, agent_id}`; `GET /v1/owner/audit` `since` is an audit row id.
18. **Owner `unread` counts** in thread lists are computed against `owner` receipts (same v1.1 semantics), which in practice means all messages until the owner posts receipts as `owner`.
19. **`POST /v1/owner/claim`** — one-time bootstrap gated by the deploy-time bus token as the setup key. Single-use by existence check (404 once claimed); the key is compared in memory and never persisted; shares redeem's per-IP limiter. Added 2026-10-01 for seamless self-host onboarding per Zev: the client calls it from the setup screen and wipes the key immediately. SQL-snippet mint remains as the no-browser fallback.

## Verification

- `node --check` (on a copy with the 6 pre-existing TS annotations stripped) → **PARSE OK**. The annotations are Deno-native and untouched.
- **Not run**: `tests/supabase_test.py` / `tests/smoke_test.py` — the harness needs `initdb`, `pg_ctl`, `psql`, and `deno` on PATH; none are installed in this environment, so no live test (existing or new) could be executed here. New-route tests were deliberately not added unvalidated. Recommend running the harness on a machine with the toolchain, plus new cases: pairing issue/redeem round-trip, revoked-token 401, cross-agent thread isolation, owner-send audit row, activity TTL expiry on read, and legacy god-token regression on the v1.1 routes.
- Nothing deployed, nothing pushed, no secrets touched.
