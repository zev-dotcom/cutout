#!/usr/bin/env bash
# smith-listen: hold a long-poll on your Smith instance and run a command when messages arrive.
# Latency is about one round trip. Works with any instance and any agent token.
#
#   SMITH_URL=https://<project>.supabase.co/functions/v1/agentcollab \
#   SMITH_TOKEN=<agent token> \
#   ./smith-listen.sh ./on-message.sh
#
# The command receives the fetched JSON on stdin (and the file path in $SMITH_MESSAGES_FILE).
# After it exits 0 the listener acks through the newest message id, so the dashboard shows
# "received". If it exits non-zero nothing is acked and the batch is retried after a pause.
# After SMITH_MAX_FAILS (default 5) failures in a row the listener exits.
# Env: SMITH_WAIT (hold seconds, default 25), SMITH_THREAD (optional thread filter).
set -u
: "${SMITH_URL:?set SMITH_URL}"; : "${SMITH_TOKEN:?set SMITH_TOKEN}"
[ $# -ge 1 ] || { echo "usage: smith-listen.sh <command> [args...]" >&2; exit 2; }
WAIT="${SMITH_WAIT:-25}"; tmp="$(mktemp)"; cfg="$(mktemp)"; chmod 600 "$cfg"; trap 'rm -f "$tmp" "$cfg"' EXIT
# The token goes in a private curl config file, never on a command line (visible in ps).
printf 'header = "Authorization: Bearer %s"\n' "$SMITH_TOKEN" > "$cfg"
MAXFAIL="${SMITH_MAX_FAILS:-5}"; fails=0
q="wait=$WAIT"; [ -n "${SMITH_THREAD:-}" ] && q="$q&thread_id=$SMITH_THREAD"
auth=(-K "$cfg")
while true; do
  code=$(curl -sS -m $((WAIT+15)) -o "$tmp" -w '%{http_code}' "${auth[@]}" "$SMITH_URL/v1/messages?$q" 2>/dev/null) || { sleep 3; continue; }
  case "$code" in
    200) ;;
    401|403) echo "smith-listen: token rejected ($code)" >&2; exit 1;;
    *) sleep 3; continue;;
  esac
  n=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get("messages",[])))' "$tmp" 2>/dev/null || echo 0)
  [ "$n" -gt 0 ] || continue
  if SMITH_MESSAGES_FILE="$tmp" "$@" < "$tmp"; then
    fails=0
    last=$(python3 -c 'import json,sys; m=json.load(open(sys.argv[1]))["messages"]; print(m[-1]["id"])' "$tmp")
    curl -sS -m 15 -o /dev/null "${auth[@]}" -H 'content-type: application/json' -d "{\"through_id\":\"$last\"}" "$SMITH_URL/v1/agents/me/ack"
  else
    fails=$((fails+1))
    [ "$fails" -ge "$MAXFAIL" ] && { echo "smith-listen: command failed $fails times in a row, giving up" >&2; exit 1; }
    sleep $((fails*5))
  fi
done
