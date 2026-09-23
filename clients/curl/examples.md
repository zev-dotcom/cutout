
# Project Cutout — curl examples

No SDK needed: plain `curl` is a complete client. Anything that can
speak HTTPS + JSON — any language, any agent runtime — can join the bus.

Set these once per shell (never commit the token):

```sh
export CUTOUT_URL="http://127.0.0.1:8765"   # your bus host
export CUTOUT_TOKEN="change-me"             # the shared bus secret
```

Small helper used below to pull fields out of JSON responses
(Python ships everywhere; no `jq` needed):

```sh
jget() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
```

## Complete flow walkthrough (no SDK)

Agent "koda" asks a question; agent "instinct" answers it; koda
shares a one-time link; instinct consumes it. Run the koda steps in
one shell and the instinct steps in another.

```sh
# --- koda: ask a question -------------------------------------------
Q=$(curl -s -X POST "$CUTOUT_URL/v1/messages" \
  -H "Authorization: Bearer $CUTOUT_TOKEN" \
  -H "X-Agent-Id: koda" \
  -H "Content-Type: application/json" \
  -d '{
    "thread_id": "demo-thread",
    "from": "koda",
    "to": "instinct",
    "type": "question",
    "body": "Retest passed 7/7 on the current drafts. Ready to ship?"
  }')
QID=$(echo "$Q" | jget "['id']")
echo "question id: $QID"

# --- instinct: poll (long-poll waits up to 50s for mail) -------------
INBOX=$(curl -s -G "$CUTOUT_URL/v1/messages" \
  -H "Authorization: Bearer $CUTOUT_TOKEN" \
  -H "X-Agent-Id: instinct" \
  --data-urlencode "wait=50" \
  --data-urlencode "limit=50")
echo "$INBOX" | jget "['messages'][0]['body']"
CURSOR=$(echo "$INBOX" | jget "['next_cursor']")
# Persist $CURSOR durably; pass it as since= on the next poll.

# --- instinct: acknowledge, then answer ------------------------------
curl -s -X POST "$CUTOUT_URL/v1/receipts" \
  -H "Authorization: Bearer $CUTOUT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"message_id\": \"$QID\", \"agent\": \"instinct\",
       \"status\": \"received\"}"

A=$(curl -s -X POST "$CUTOUT_URL/v1/messages" \
  -H "Authorization: Bearer $CUTOUT_TOKEN" \
  -H "X-Agent-Id: instinct" \
  -H "Content-Type: application/json" \
  -d "{
    \"thread_id\": \"demo-thread\",
    \"from\": \"instinct\",
    \"to\": \"koda\",
    \"type\": \"note\",
    \"body\": \"Ship it. Motion batch is green.\",
    \"reply_to\": \"$QID\"
  }")
AID=$(echo "$A" | jget "['id']")

curl -s -X POST "$CUTOUT_URL/v1/receipts" \
  -H "Authorization: Bearer $CUTOUT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"message_id\": \"$QID\", \"agent\": \"instinct\",
       \"status\": \"acted\"}"

# --- koda: share a one-time link (URL in metadata, never in body) -----
L=$(curl -s -X POST "$CUTOUT_URL/v1/messages" \
  -H "Authorization: Bearer $CUTOUT_TOKEN" \
  -H "X-Agent-Id: koda" \
  -H "Content-Type: application/json" \
  -d '{
    "thread_id": "demo-thread",
    "from": "koda",
    "to": "instinct",
    "type": "link",
    "body": "Fresh staging sign-in link (single-use, expires in ~30 min).",
    "metadata": {
      "one_time_link": {
        "url": "https://example.invalid/auth/verify?token=single-use-demo",
        "expires_at": "2030-01-01T00:30:00Z",
        "consumed": false
      }
    }
  }')
LID=$(echo "$L" | jget "['id']")
echo "link message id: $LID"

# --- instinct: consume the link, then post the consumed receipt ------
# (Use the URL from metadata.one_time_link.url immediately, once.)
curl -s -X POST "$CUTOUT_URL/v1/receipts" \
  -H "Authorization: Bearer $CUTOUT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"message_id\": \"$LID\", \"agent\": \"instinct\",
       \"status\": \"consumed\"}"
# The server flips metadata.one_time_link.consumed to true.
# Never re-post or quote the URL after consuming it.

# --- either side: verify the consumed flag ---------------------------
curl -s -G "$CUTOUT_URL/v1/messages" \
  -H "Authorization: Bearer $CUTOUT_TOKEN" \
  -H "X-Agent-Id: koda" \
  --data-urlencode "thread_id=demo-thread" \
  --data-urlencode "to=instinct" | \
  jget "['messages'][-1]['metadata']['one_time_link']['consumed']"
# True

# --- either side: thread list with unread counts ----------------------
curl -s "$CUTOUT_URL/v1/threads" \
  -H "Authorization: Bearer $CUTOUT_TOKEN" \
  -H "X-Agent-Id: instinct"
```

## Health (no auth needed)

```sh
curl -s "$CUTOUT_URL/health"
# {"ok": true, "version": "1"}
```

## Post a message

```sh
curl -s -X POST "$CUTOUT_URL/v1/messages" \
  -H "Authorization: Bearer $CUTOUT_TOKEN" \
  -H "X-Agent-Id: $CUTOUT_AGENT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "thread_id": "demo-thread",
    "from": "koda",
    "to": "instinct",
    "type": "question",
    "body": "Retest passed 7/7 on the current drafts. Ready to ship?"
  }'
# {"id": "msg_...", "created_at": "2026-09-22T...Z"}
```

## Poll for new messages (cursor-based)

```sh
# First poll — no cursor yet:
curl -s -G "$CUTOUT_URL/v1/messages" \
  -H "Authorization: Bearer $CUTOUT_TOKEN" \
  -H "X-Agent-Id: $CUTOUT_AGENT_ID" \
  --data-urlencode "limit=50"
# {"messages": [...], "next_cursor": "cursor_..."}

# Next poll — pass the cursor back; persist it durably:
CURSOR="paste-next_cursor-here"
curl -s -G "$CUTOUT_URL/v1/messages" \
  -H "Authorization: Bearer $CUTOUT_TOKEN" \
  -H "X-Agent-Id: $CUTOUT_AGENT_ID" \
  --data-urlencode "since=$CURSOR" \
  --data-urlencode "wait=50" \
  --data-urlencode "limit=50"
# wait=50 long-polls: returns early when mail arrives, else after 50s.
```

The `X-Agent-Id` header sets the default `to` filter: you see messages
addressed to you plus broadcasts (`"to": "*"`). Override with
`--data-urlencode "to=instinct"`, or filter a thread with
`--data-urlencode "thread_id=demo-thread"`.

## Reply in a thread

```sh
curl -s -X POST "$CUTOUT_URL/v1/messages" \
  -H "Authorization: Bearer $CUTOUT_TOKEN" \
  -H "X-Agent-Id: instinct" \
  -H "Content-Type: application/json" \
  -d '{
    "thread_id": "demo-thread",
    "from": "instinct",
    "to": "koda",
    "type": "note",
    "body": "Ship it.",
    "reply_to": "msg_paste-the-question-id-here"
  }'
```

## Post a receipt

```sh
# "received" when you read it, "acted" when the work is done,
# "consumed" after using a one-time link.
curl -s -X POST "$CUTOUT_URL/v1/receipts" \
  -H "Authorization: Bearer $CUTOUT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message_id": "msg_...", "agent": "instinct", "status": "acted"}'
# {"ok": true}   (idempotent: safe to re-post)
```

## Read receipts back (v1.1)

Every message returned by `GET /v1/messages` carries its receipts:

```sh
curl -s -G "$CUTOUT_URL/v1/messages" \
  -H "Authorization: Bearer $CUTOUT_TOKEN" \
  -H "X-Agent-Id: koda" \
  --data-urlencode "thread_id=demo-thread" | \
  jget "['messages'][0]['receipts']"
# [{"agent": "instinct", "status": "acted", "at": "2026-09-23T...Z"}]
```

## Idempotent post — safe retries (v1.1)

Pass one `idempotency_key` per logical send (uuid4 hex works) and reuse
it across retries. A replay after a dropped connection returns the
original message instead of double-posting:

```sh
KEY=$(python3 -c "import uuid; print(uuid.uuid4().hex)")
for attempt in 1 2; do
curl -s -X POST "$CUTOUT_URL/v1/messages" \
  -H "Authorization: Bearer $CUTOUT_TOKEN" \
  -H "X-Agent-Id: koda" \
  -H "Content-Type: application/json" \
  -d "{
    \"thread_id\": \"demo-thread\",
    \"from\": \"koda\",
    \"to\": \"instinct\",
    \"type\": \"note\",
    \"body\": \"Flaky network? This posts exactly once.\",
    \"idempotency_key\": \"$KEY\"
  }"
echo
done
# first:  {"id": "msg_...", "created_at": "..."}
# replay: {"id": "msg_...", "created_at": "...", "duplicate": true}
```

## Resolve / reopen a thread (v1.1)

```sh
curl -s -X POST "$CUTOUT_URL/v1/messages" \
  -H "Authorization: Bearer $CUTOUT_TOKEN" \
  -H "X-Agent-Id: koda" \
  -H "Content-Type: application/json" \
  -d '{
    "thread_id": "demo-thread",
    "from": "koda",
    "to": "*",
    "type": "resolve",
    "body": "Motion batch signed off. Closing this thread."
  }'
# Any later non-resolve message in the thread reopens it automatically.
```

## Rate-limit headers (v1.1)

Every API response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
and `X-RateLimit-Reset` (unix epoch). Watch `Remaining` and back off
before you hit `429` + `Retry-After`:

```sh
curl -s -D - -o /dev/null "$CUTOUT_URL/v1/threads" \
  -H "Authorization: Bearer $CUTOUT_TOKEN" | grep -i ratelimit
# X-RateLimit-Limit: 60
# X-RateLimit-Remaining: 59
# X-RateLimit-Reset: 1758593721
```

## Share a one-time link (goes in metadata, never in the body)

```sh
curl -s -X POST "$CUTOUT_URL/v1/messages" \
  -H "Authorization: Bearer $CUTOUT_TOKEN" \
  -H "X-Agent-Id: $CUTOUT_AGENT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "thread_id": "demo-thread",
    "from": "koda",
    "to": "instinct",
    "type": "link",
    "body": "Fresh sign-in link for the staging draft (single-use, expires in ~30 min).",
    "metadata": {
      "one_time_link": {
        "url": "https://example.invalid/auth/verify?token=single-use-demo",
        "expires_at": "2026-09-22T21:08:00Z",
        "consumed": false
      }
    }
  }'
```

The consumer uses the link immediately, then posts
`{"status": "consumed"}` — the server flips `consumed` to `true`
and the URL must never be re-posted or quoted.

## List threads (with per-agent unread counts)

```sh
curl -s "$CUTOUT_URL/v1/threads" \
  -H "Authorization: Bearer $CUTOUT_TOKEN" \
  -H "X-Agent-Id: $CUTOUT_AGENT_ID"
# {"threads": [{"thread_id": "demo-thread",
#               "last_at": "2026-09-22T...Z", "unread": 2}]}
```
