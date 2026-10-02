#!/bin/bash
# Wake hooks test against the REAL edge function + a scratch Postgres (live schema layout).
# Usage: bash tests/run_wake_test.sh <deno> <psql> <pg-host-dir> <db>
set -u; cd "$(dirname "$0")/.."
DENO=${1:-deno}; PSQL=${2:-psql}; PGHOST_DIR=${3:-/tmp/smith-scratch-pg}; DB=${4:-wake}
P=("$PSQL" -h 127.0.0.1 -p 5433 -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q)
"$PSQL" -h 127.0.0.1 -p 5433 -U postgres -d postgres -q -c "drop database if exists $DB" -c "create database $DB" >/dev/null 2>&1
"${P[@]}" -f supabase/migrate_smith_onto_agentcollab.sql >/dev/null 2>&1
"${P[@]}" -f supabase/migrate_wake_hooks.sql >/dev/null 2>&1
env SUPABASE_DB_URL="postgresql://postgres@127.0.0.1:5433/$DB" AGENTCOLLAB_TOKEN=test-bus-token-001 \
  SMITH_SCHEMA=agentcollab SMITH_TABLES_SCHEMA=smith SMITH_SETUP_KEY=test-setup-key-001 SMITH_LEGACY_STRICT=1 \
  SMITH_PUSH_HOSTS="*.test.example,fcm.googleapis.com" CUTOUT_RATE_LIMIT=1000 SMITH_PUSH_DEBOUNCE_MS=1500 SMITH_WAKE_DEBOUNCE_MS=1500 SMITH_WAKE_RECHECK_MS=3000 SMITH_WAKE_URGENT_PER_HOUR=3 \
  "$DENO" run -A --preload tests/wake_preload.ts supabase/index.ts >/tmp/wake-server.log 2>&1 &
PID=$!; trap 'kill $PID 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -s localhost:8000/health >/dev/null 2>&1 && break; sleep 0.5; done
python3 tests/wake_hooks_test.py http://127.0.0.1:8000 "${P[@]}"
# ---- phase 2: email adapter enabled with an exact-address allowlist ----
kill $PID 2>/dev/null; sleep 1
"$PSQL" -h 127.0.0.1 -p 5433 -U postgres -d postgres -q -c "drop database if exists ${DB}_email" -c "create database ${DB}_email" >/dev/null 2>&1
P2=("$PSQL" -h 127.0.0.1 -p 5433 -U postgres -d "${DB}_email" -v ON_ERROR_STOP=1 -q)
"${P2[@]}" -f supabase/migrate_smith_onto_agentcollab.sql >/dev/null 2>&1; "${P2[@]}" -f supabase/migrate_wake_hooks.sql >/dev/null 2>&1
env SUPABASE_DB_URL="postgresql://postgres@127.0.0.1:5433/${DB}_email" AGENTCOLLAB_TOKEN=test-bus-token-001 \
  SMITH_SCHEMA=agentcollab SMITH_TABLES_SCHEMA=smith SMITH_SETUP_KEY=test-setup-key-001 SMITH_LEGACY_STRICT=1 \
  SMITH_WAKE_DEBOUNCE_MS=1000 SMITH_WAKE_RECHECK_MS=60000 SMITH_WAKE_EMAIL_PER_HOUR=2 \
  SMITH_WAKE_EMAIL_ENABLED=1 SMITH_WAKE_EMAIL_ENDPOINT=https://mail.test.example/send SMITH_WAKE_EMAIL_KEY=test-key \
  SMITH_WAKE_EMAIL_FROM=wake@test.example SMITH_WAKE_EMAIL_ALLOW=owner@example.com,second@example.com \
  WAKE_HITS_FILE=/tmp/wake-email-hits.jsonl \
  "$DENO" run -A --preload tests/wake_preload.ts supabase/index.ts >/tmp/wake-server-email.log 2>&1 &
PID=$!
for i in $(seq 1 40); do curl -s localhost:8000/health >/dev/null 2>&1 && break; sleep 0.5; done
WAKE_HITS_FILE=/tmp/wake-email-hits.jsonl python3 tests/wake_email_test.py http://127.0.0.1:8000 "${P2[@]}"
