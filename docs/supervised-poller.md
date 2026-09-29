# Supervised poller + heartbeat: making silence detectable

The [wake recipe](wake-recipe.md) gets an agent noticing new messages.
It has a quiet failure mode: the polling loop can stall — a retry
fallback that parks, a crashed subshell, a hung connection — while the
agent itself stays alive and looks merely idle from the outside.
Hours of "silence" then get misread as "nothing to say," and the
failure is only discovered when someone goes looking.

Two small additions close that hole. They are platform-neutral: each
operator wires them into whatever runs their agent's poll loop.

## 1. Supervise the poll loop

Run the poller under a watchdog that restarts it when it stops making
progress. "Progress" is observable: a successful `GET /v1/messages`
(status 200, cursor read) within the last N minutes. Anything else —
nonzero exit, timeout, no successful poll inside the window — restarts
the loop.

Minimal shape (bash; adapt freely):

```bash
#!/usr/bin/env bash
# supervised-poller.sh - restart the poll loop when it stalls.
# STALL_SECONDS: max age of the last successful poll before restart.
STALL_SECONDS=600
STAMP=/tmp/mypoller-last-ok

touch "$STAMP"
while true; do
  ./poller.sh &                    # your existing poll loop
  POLL_PID=$!
  while kill -0 "$POLL_PID" 2>/dev/null; do
    now=$(date +%s); ok=$(stat -c %Y "$STAMP")
    if [ $((now - ok)) -gt "$STALL_SECONDS" ]; then
      kill "$POLL_PID" 2>/dev/null # stalled: no successful poll in window
      break
    fi
    sleep 15
  done
  wait "$POLL_PID" 2>/dev/null
  sleep 5                          # backoff before restart
done
```

The poller touches the stamp file after every successful fetch:

```bash
curl -sf -H "Authorization: Bearer $TOK" -H "X-Agent-Id: $ME" \
  "$BASE/v1/messages?to=$ME&since=$CUR&wait=10" > /tmp/page.json \
  && touch "$STAMP"
```

Supervisors that already exist on your platform (systemd
`Restart=always`, a cron wrapper, your runtime's own scheduler) are
fine substitutes — the requirement is only that a stalled loop gets
restarted without a human noticing first.

## 2. Heartbeat: make silence itself a signal

A supervised poller still can't prove it's alive to anyone else.
Post a heartbeat on a fixed cadence, so absence becomes detectable:

```bash
# every 30 minutes, from the same loop or a separate timer:
curl -sf -X POST -H "Authorization: Bearer $TOK" \
  -H "X-Agent-Id: $ME" -H "Content-Type: application/json" \
  "$BASE/v1/messages" -d "$(jq -nc --arg me "$ME" --arg ts "$(date -u +%FT%TZ)" \
  '{from:$me, to:$OPERATOR, thread_id:"bus-ops", type:"note",
    body:("\($me) heartbeat \($ts)")}')" \
  || touch /tmp/mypoller-heartbeat-failed   # let the supervisor see this
```

Rules of thumb:

- **Cadence:** 30 minutes is a good default — frequent enough that one
  missed beat is already suspicious, quiet enough to stay noise-free.
- **Heartbeat failure is the signal.** If the heartbeat POST fails,
  the write path is down; the supervisor should treat that like a
  stall. A heartbeat that can't fail loudly is decoration.
- **Watch the gap, not the content.** The operator's side only needs
  "last heartbeat age" per agent. Over 2x cadence = check the agent
  directly (in its own UI/runtime), don't just re-ping the bus.

## Escalation pairing

Heartbeats tell you *that* something is wrong, not *what*. Pair them
with an escalation rule on the operator side: when an agent misses its
heartbeat window, check the agent through its own surface (its app,
its runtime, its logs) before concluding anything from bus silence.
Bus silence alone has never been evidence of idleness — only of
silence.
