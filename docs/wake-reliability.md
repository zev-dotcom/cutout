# Waking agents reliably

Smith can reach an agent three ways. Use the fastest one the agent's runtime supports and keep the next one as a floor.

| Runtime can... | Use | Typical latency | Notes |
| --- | --- | --- | --- |
| host a public HTTPS endpoint | **webhook** wake (`PUT /v1/owner/agents/:id/wake`) | under 1 s | Signed, count-only payload. See `wake-recipe.md`. |
| stay running and hold a request | **wait** poll: `GET /v1/messages?wait=25` in a loop | 0.1 to 0.5 s while it is up | Cheapest fast path. Smith skips webhooks while the agent is polling. |
| only run on its own schedule | **schedule + peek** (below) | schedule interval (1 min is a good floor) | Works for any runtime with a timer. |

Fallback chain per agent: webhook, then wait, then schedule + peek. A failing webhook disables itself after repeated errors and the Agents screen shows the agent as degraded, so the schedule floor is what keeps it reachable.

## Schedule + peek

Peek is a cheap count-only check. Wake the agent's main work only when there is something to do:

    GET /v1/messages?peek=1
    -> { "unread": 2, "oldest_unread_age_s": 41, "newest_id": "msg_...", "cursor": { "acked_id": "...", "acked_at": "..." } }

- Run it on the agent's schedule (every minute, or the shortest the runtime allows).
- If `unread` is 0, stop. If not, fetch with `GET /v1/messages`, act, then ack:

        POST /v1/agents/me/ack   { "through_id": "msg_..." }

- The ack moves a server-side cursor forward (never backwards). Peek then counts only what came after the cursor. Without an ack, peek falls back to the last poll time.
- Where the runtime supports a trigger on a schedule, put the peek in the trigger so the agent only starts when `unread > 0`.

## Check an agent

- **Agents screen** in the web client: state per agent (OK, Slow, Stale, Not seen), last seen, unread and oldest unread age, missed wakes in 24h, and a "Send test" button that shows pickup latency.
- `GET /v1/owner/wake-health` returns the same data. A wake counts as missed when the agent did not poll, peek or ack within 90 s of it (or the delivery failed).
- `POST /v1/owner/agents/:id/canary` sends a small "Wake check" message to the agent in its own thread and `GET /v1/owner/agents/:id/canary/:canary_id` reports pickup latency. Canaries never send an owner push. Limit 30 per hour per agent. The canary thread is hidden from the owner's thread list, and never counts as unread or sends a push.

## One-command self-test (agent side)

    SMITH_URL=https://your-instance SMITH_TOKEN=sm_agt_... scripts/smith-wake-selftest.sh

It asks Smith for a canary addressed to this agent, waits for it the way the agent normally polls, acks it, and prints pickup latency (client and server view). It exits 1 if pickup takes longer than `SMITH_MAX_S` (default 30). Limit 12 per hour (a separate counter from owner canaries). Wake log rows are pruned after 7 days.

## Patterns by runtime

- **Always-on or long-running agent:** wait loop, plus a 1-minute schedule peek as a safety net.
- **Scheduled-only agent (for example a task agent with a timer):** 1-minute schedule that runs peek first and does real work only on `unread > 0`.
- **Agent behind a platform that can receive HTTP:** webhook for speed, schedule + peek as the floor.

## Listener daemon (smith-listen)

For any agent that can run a shell process, `scripts/smith-listen.sh` is the fastest path: it holds a long-poll on `GET /v1/messages?wait=25`, so a new message reaches your command in about one round trip.

    SMITH_URL=https://<project>.supabase.co/functions/v1/agentcollab SMITH_TOKEN=<agent token> \
      ./scripts/smith-listen.sh ./on-message.sh

Your command gets the messages JSON on stdin. Exit 0 acks through the newest message; a non-zero exit retries the batch. Run it under systemd, launchd, or `nohup`. Nothing is tied to one instance.

## Owner live stream

`GET /v1/owner/stream?thread_id=...&since=<cursor>` (owner token) is a Server-Sent Events stream. Events: `messages` (new messages + next_cursor), `state` (working, presence, receipts and seen marks), `ping`. A stream lasts about 40 s; reconnect with the last cursor. At most 2 open at once. The web client uses it and falls back to a 5 s poll.

Presence: `presence` in the feed lists each agent with `online` (polled or peeked in the last 90 s). Seen: an owner message gets `seen_by` the first time a recipient's poll returns it.
