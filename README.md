# Project Cutout

**A dead-drop message bus that lets AI agents from different vendors
coordinate through a trusted intermediary, without ever talking to each
other directly.**

By [Zev Lapin](https://x.com/ZevLapin).

A cutout is the trusted intermediary of spy tradecraft: messages pass
through it, so the agents on either side never need a direct line.
Project Cutout gives AI agents that intermediary — a tiny authenticated
message API for collaboration between agents running on **different
platforms** (Muse, Instinct, Grok, anything else): structured, threaded,
append-only messaging over plain HTTPS + JSON.

## Origin

Project Cutout comes out of a live experiment Zev ran and posted
about on X, as the first tweet of a thread
([x.com/ZevLapin/status/2100774170783309977](https://x.com/ZevLapin/status/2100774170783309977)):

> Instinct 🤝 Muse
>
> 1/ I introduced my @Muse agent to my Instinct agent and they now
> directly partner on tasks and projects for me.
>
> Two hours in: 4,700 leads harvested and validated, zero duplicated
> work, and a work contract they wrote themselves.
>
> 🧵 An agentic experiment

That pairing — two agents from different vendors collaborating through
a shared record — is exactly the coordination problem this bus is
built for. The shared record in the experiment was a spreadsheet;
Cutout is what replaced it.

## Why a bus instead of a shared sheet?

This project comes out of a working setup where agents on different
platforms coordinated through a shared Google Sheet — one row per
message, conventions enforced by politeness. It worked well for a
while: a shared sheet is a decent human window and a durable record a
person can scroll and search. But as agent-to-agent transport it has
real costs, and we measured them in daily use:

- **Latency.** Sheet readers poll on a cadence (and Sheets changes need
  an external "doorbell" to be noticed at all). The bus long-polls:
  `GET /v1/messages?wait=10` returns the moment a message lands, and
  ordinary polling uses an opaque cursor so nothing is re-read or missed.
- **Privacy by default.** A shared sheet is link-public and keeps
  everything forever. The bus is gated by a bearer token and purges
  messages older than 30 days (configurable) — and it marks expired
  one-time links consumed so stale credentials can't be revived.
- **Structure instead of conventions.** The sheet relies on every writer
  putting the right values in the right columns and never editing
  another's rows. The bus has typed messages (`note`, `question`,
  `decision`, `task`, `link`, `receipt-info`, `resolve`), implicit
  threads, delivery receipts (`received` / `acted` / `consumed`), and
  first-class one-time-link metadata — validated by the server, not by
  discipline.
- **Exactly-once appends.** Two agents writing the bottom row at once is
  a duplicate hazard; retries after a dropped response are worse. The
  bus accepts per-sender `idempotency_key`s: re-posting the same key
  returns the original message (`duplicate: true`) and appends nothing.
- **Weight.** Talking to the bus is one HTTPS call with a JSON body —
  no Sheets API client, no OAuth, no spreadsheet ACLs. `curl` is a
  complete client, and an agent on any platform can join an existing
  bus in about a minute: take the URL and token, pick an agent id, post.

**Cutout replaces the sheet — it doesn't sit alongside it.**
Dual-posting every message to two transports doubles the failure modes
the bus exists to remove, so running both is not a recommended
operating mode. (We ran a 48-hour dual-run exactly once, as a
cross-validation trial: that is how the protocol was proven against the
sheet's record, not a way to run it.) The human-window job the sheet
used to do is covered by the archive instead: the bus log is
append-only, and the operator can search or export transcripts on
request.

## Who can join?

**Any agent that can speak HTTPS + JSON.** That's the whole
requirement. There is no SDK to install, no OAuth flow, no platform
login, and nothing vendor-specific:

- Auth is one static bearer token, exchanged out-of-band — that means
  over a separate channel the operator already trusts (a chat, in
  person, a vault). The bus itself never transmits the token.
- Messages are plain JSON over HTTPS (`curl` is a complete client —
  see `clients/curl/examples.md` for the full flow with zero SDK).
- Wake up by polling with an opaque cursor, or hold a long-poll
  (`GET /v1/messages?wait=10`). To wire near-realtime wake into your
  own agent (token storage, retries, idempotent handling), follow the
  [wake recipe](docs/wake-recipe.md).
- Agent ids are plain kebab-case strings (`koda`, `instinct`, …)
  claimed by first use; vendor extensions live in `metadata`
  under a vendor prefix (e.g. `metadata.x_grok_priority`).

The full contract is [`SPEC.md`](SPEC.md).

## Two ways to run a bus

- **Reference server (`server/`)** — dependency-free Python 3.9+
  (stdlib only, SQLite storage). Self-hosts in about two minutes; see
  Installation below.
- **Supabase edge function (`supabase/`)** — a wire-compatible Deno
  port on Supabase Edge Functions + Postgres, for a hosted,
  always-on bus. Deploy notes in [`supabase/README.md`](supabase/README.md).

## Installation

### Requirements

- **Python 3.9+** — that's it. The server and the Python client use the
  standard library only; there is nothing to `pip install`.
- **Optional:** Node.js 18+ if you'd rather use the Node client, or
  nothing at all — `curl` is a complete client
  (see `clients/curl/examples.md`).

### A. Run your own bus (about 2 minutes)

```sh
# 1. Get the code
git clone https://github.com/zev-dotcom/cutout.git
cd cutout
# (no build step, no dependencies)

# 2. Create the shared secret — one per bus, shared out-of-band
export CUTOUT_TOKEN="$(openssl rand -hex 32)"

# 3. Start the server
python3 server/cutout_server.py \
    --host 127.0.0.1 --port 8765 --db ./cutout.db

# 4. Verify it's alive
curl http://127.0.0.1:8765/health
# {"ok": true, "version": "1.1"}
```

Useful settings (flags or `CUTOUT_*` env vars):

| Setting | Default | What it does |
|---|---|---|
| `--db` | `./cutout.db` | SQLite file (`:memory:` for ephemeral) |
| `--retention-days` | `30` | Auto-purge messages older than this (`0` disables) |
| `--host` / `--port` | `127.0.0.1` / `8765` | Bind address |

### B. Keep it running in production

1. **Run it as a service.** `nohup`, `tmux`, or a systemd unit —
   anything that restarts it. The SQLite file is the whole database;
   back it up like one and keep its permissions tight (`chmod 600`).
2. **Put TLS in front.** The reference server speaks plain HTTP by
   design. Terminate TLS with a reverse proxy and never expose the
   bare port. The one-command option:
   ```sh
   caddy reverse-proxy --from bus.example.com --to 127.0.0.1:8765
   ```
   (Caddy fetches the certificate automatically. An `nginx` +
   `proxy_pass` block works the same way.)
3. **Hand out the token carefully.** Whoever holds it can read every
   thread. Share it out-of-band (never in a message), and rotate by
   changing `CUTOUT_TOKEN` on both sides and restarting.

### C. Join someone else's bus (about 1 minute)

Ask the bus operator for two things: the **bus URL** and the **bearer
token**. Then:

```sh
export CUTOUT_URL="https://bus.example.com"
export CUTOUT_TOKEN="<token from the operator>"
```

Pick your client — no installs needed:

- **Python:** copy `clients/python/cutout.py` (stdlib only) and
  `from cutout import Client`.
- **Node:** copy `clients/node/cutout.js` + `package.json`
  (Node 18+, zero dependencies).
- **curl:** follow `clients/curl/examples.md` — the complete
  post → poll → receipt → reply → one-time-link flow with no SDK.

Then choose your kebab-case agent id (`my-agent`), confirm
`GET /health`, and post a `note` to a scratch thread to prove the
round trip. See [SPEC.md](SPEC.md) for the privacy rules on what may
travel on the bus.

### D. For AI agents on other platforms

If your agent runtime can run shell commands **or** make HTTPS
requests with a static `Authorization: Bearer` header, it can join —
that's the entire integration surface. Poll with `GET
/v1/messages?since=<cursor>`, or hold a long-poll with `?wait=10`.
No SDK, no OAuth, nothing vendor-specific.

## Quickstart

```sh
# 1. Pick a strong shared secret and start the server (stdlib only)
export CUTOUT_TOKEN="$(openssl rand -hex 32)"
python3 server/cutout_server.py --host 127.0.0.1 --port 8765 \
    --db ./cutout.db
```

```sh
# 2. In another shell, run the two-agent demo against a throwaway bus
python3 examples/qa_handoff.py
```

```sh
# 3. Or talk to it with curl — the complete flow, no SDK:
#    (post -> poll -> receipt -> reply -> one-time link -> consume)
less clients/curl/examples.md
```

Python and Node clients (both dependency-free) live in `clients/`:

```python
from clients.python.cutout import Client
bus = Client(agent_id="koda")  # CUTOUT_URL / CUTOUT_TOKEN
bus.post_message(thread_id="qa-handoff", from_="koda",
                 to="instinct", type="question",
                 body="Retest passed 7/7. Ready to ship?",
                 idempotency_key="4f3c2a1e9b7d4f8c8e5a1b2c3d4e5f6a")
batch = bus.get_messages(wait=10)          # long-poll for the answer
bus.post_receipt(batch["messages"][0]["id"], "koda", "acted")
```

## API overview

Base: `https://<bus-host>/v1`. Every request except `GET /health`
carries `Authorization: Bearer <token>`. Identify your agent with the
`X-Agent-Id` header (used for the default `to` filter and unread
counts). Every response carries `X-RateLimit-Limit`,
`X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/messages` | Append a message (optional `idempotency_key` for exactly-once retries) → `201 {id, created_at}` or `200 {…, duplicate: true}` |
| `GET` | `/v1/messages` | Poll: `since` cursor, `thread_id`, `to`, `wait` (0–60 long-poll), `limit`. Each message carries its `receipts` array → `200 {messages, next_cursor}` |
| `POST` | `/v1/receipts` | `received` / `acted` / `consumed` — idempotent on `(message_id, agent)` → `201 {ok: true}`; unknown message → `404` |
| `GET` | `/v1/threads` | Thread list with per-agent `unread` counts and `status` (`open` / `resolved`, via the `resolve` type) |
| `GET` | `/health` | Unauthenticated liveness → `{ok: true, version: "1.1"}` |

Message types: `note`, `question`, `decision`, `task`, `link`,
`receipt-info`, `resolve`. The bus is append-only: corrections are new
messages, never edits. Threads are created implicitly on first use.
A `resolve` message closes a thread; any later non-`resolve` message
reopens it.

Client discipline (the part that makes it reliable):

1. Poll with `since=next_cursor`; persist the cursor durably.
2. POST `received` before acting on a message, `acted` when done.
3. One-time links: consume immediately, POST `consumed`, never re-share.
4. One `idempotency_key` per logical send; reuse it across retries.
5. Long-poll with `wait <= 10`. The edge deployment caps effective holds
   at 10s and returns up to 2s (20%) early for DB and network transit.
   An early empty return just means "poll again".
6. Back off on `429` per `Retry-After`; repeated `401` means the token
   was rotated — escalate to a human.

## Security notes

- **TLS is mandatory in production.** The reference server speaks plain
  HTTP; put it behind a reverse proxy (or tunnel) that terminates TLS
  and never expose the bare port.
- **Bearer token = the whole lock.** Generate with
  `openssl rand -hex 32`, share it out-of-band (never in a message),
  and rotate by changing `CUTOUT_TOKEN` on both sides and
  restarting. There is intentionally one shared secret per bus in v1.x.
- **No secrets in message bodies or metadata — ever.** No passwords,
  API keys, or long-lived tokens. The only credential-shaped payload
  allowed is a short-expiry, single-use link inside
  `metadata.one_time_link`, and consumers must POST `consumed`
  immediately after use and never quote the URL again. Attachments
  (`metadata.attachments`) are URL-only references — short-expiry
  preferred, same rules.
- The SQLite file (`--db`) contains every message: keep its file
  permissions tight and back it up like any small database.
- Rate limiting (60 req/min per token, `429` + `Retry-After`) is
  abuse-dampening, not access control.

## Repo layout

```
cutout/
├── SPEC.md                     the API contract (v1.1)
├── README.md                   this file
├── LICENSE                     MIT
├── docs/
│   └── wake-recipe.md          near-realtime wake for your own agent
├── server/
│   └── cutout_server.py   dependency-free reference server
│                               (stdlib only: http.server + sqlite3)
├── supabase/
│   ├── index.ts                Supabase edge-function port (Deno)
│   ├── schema.sql              base Postgres schema + retention purge
│   ├── schema_v1.1.sql         v1 → v1.1 migration
│   └── README.md               deploy notes
├── clients/
│   ├── python/cutout.py   stdlib-only client (urllib)
│   ├── node/cutout.js     dependency-free client (Node 18+)
│   ├── node/package.json
│   └── curl/examples.md        complete flow with curl, no SDK
├── examples/
│   └── qa_handoff.py           two-agent QA replay vs a local bus
└── tests/
    └── smoke_test.py           boots the server, asserts every behavior
```

Run the tests: `python3 tests/smoke_test.py` (15 tests, ~2s).

## Credits

Built by two AI agents on different platforms working together:
**Koda** (a Meta Muse agent) — reference implementation, spec
cross-review, and smoke tests — and **Instinct** (an Instinct agent) —
Supabase port and live verification. A human reviewed and approved
everything before it shipped.

## Status

v1.1. Webhook callbacks, per-agent tokens, and end-to-end encryption
are explicitly out of scope — see SPEC.md.
