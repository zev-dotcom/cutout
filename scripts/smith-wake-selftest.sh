#!/usr/bin/env bash
# One-command wake check for an agent. Needs SMITH_URL (instance URL) and SMITH_TOKEN (the agent token).
# It asks Smith for a canary message addressed to this agent, waits for it the way the agent normally
# would (long-poll), and prints the pickup latency. Exit 1 if it is slower than SMITH_MAX_S (default 30).
# If this agent has a webhook wake, the server-side wake status is shown too.
set -u
: "${SMITH_URL:?set SMITH_URL}"; : "${SMITH_TOKEN:?set SMITH_TOKEN}"
MAX=${SMITH_MAX_S:-30}; H=(-H "Authorization: Bearer $SMITH_TOKEN" -H 'Content-Type: application/json')
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null; }
T0=$(now_ms)
R=$(curl -s -X POST "${H[@]}" -d '{}' "$SMITH_URL/v1/agents/me/selftest")
CID=$(printf '%s' "$R" | jget "['canary_id']"); TID=$(printf '%s' "$R" | jget "['thread_id']")
[ -n "$CID" ] || { echo "FAIL: could not create canary: $R"; exit 1; }
GOT=""; DEADLINE=$(( $(date +%s) + MAX ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  B=$(curl -s "${H[@]}" "$SMITH_URL/v1/messages?thread_id=$TID&wait=10")
  GOT=$(printf '%s' "$B" | python3 -c "import sys,json
d=json.load(sys.stdin)
for m in d.get('messages',[]):
    if (m.get('metadata') or {}).get('canary')=='$CID': print(m['id']); break" 2>/dev/null)
  [ -n "$GOT" ] && break
done
T1=$(now_ms)
if [ -z "$GOT" ]; then echo "FAIL: canary $CID not picked up within ${MAX}s"; exit 1; fi
curl -s -X POST "${H[@]}" -d "{\"through_id\":\"$GOT\"}" "$SMITH_URL/v1/agents/me/ack" >/dev/null
S=$(curl -s "${H[@]}" "$SMITH_URL/v1/agents/me/selftest/$CID")
echo "pickup (client view): $((T1-T0)) ms"
echo "server view: $S"
[ $((T1-T0)) -le $((MAX*1000)) ] && echo "PASS" || { echo "SLOW"; exit 1; }
