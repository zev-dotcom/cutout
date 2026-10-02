#!/bin/bash
# Dual-schema Smith integration run: full suite against the REAL edge function
# twice — once with the self-host defaults (SMITH_SCHEMA=cutout,
# SMITH_TABLES_SCHEMA=public, CUTOUT_TOKEN), once with the live settings
# (SMITH_SCHEMA=agentcollab, SMITH_TABLES_SCHEMA=smith, AGENTCOLLAB_TOKEN).
# Local only.
#
# Usage: bash tests/run_dual_schema.sh
# Requires: scratch Postgres on 127.0.0.1:5433 (user/db smithtest, pw smithtest),
# deno on PATH. Restarts the server between runs (in-memory rate-limiter maps
# do not survive a restart, and must not leak budgets across runs).
set -u
cd "$(dirname "$0")/.."
DENO=/home/hatch/.deno/bin/deno

PG=/usr/local/lib/python3.12/dist-packages/pgserver/pginstall/bin/psql
export LD_LIBRARY_PATH=/usr/local/lib/python3.12/dist-packages/pgserver/pginstall/lib
export PGPASSWORD=smithtest
PSQL="$PG -h 127.0.0.1 -p 5433 -U smithtest -d smithtest -v ON_ERROR_STOP=1 -q"

reset_db() {
  # Drop and recreate: TRUNCATE alone leaves old constraints behind (e.g. a
  # previous migration's PK), contaminating the next run's schema assertions.
  # DROP SCHEMA is safe here; the server is not running during reset.
  for s in cutout agentcollab smith; do
    $PG -h 127.0.0.1 -p 5433 -U smithtest -d smithtest -q -c "drop schema if exists $s cascade" 2>&1 | grep -vi "notice" || true
  done
  local tabs
  tabs=$($PG -h 127.0.0.1 -p 5433 -U smithtest -d smithtest -tA -c \
    "select 'public.'||tablename from pg_tables where schemaname='public' and tablename like 'smith\_%'")
  if [ -n "$tabs" ]; then
    echo "$tabs" | tr '\n' ',' | sed 's/,$//' | xargs -I{} $PG -h 127.0.0.1 -p 5433 -U smithtest -d smithtest -q -c "drop table if exists {} cascade" 2>&1 | grep -vi "notice" || true
  fi
}

run_suite() {
  local name="$1" port="$2" schema="$3" tables_schema="$4" token_env="$5" token_val="$6"
  echo "=== $name (schema=$schema, tables=$tables_schema, $token_env) ==="
  reset_db
  if [ "$schema" = "cutout" ]; then
    $PSQL -f tests/schema_local.sql
    $PSQL -f supabase/schema_v1.1.sql
    $PSQL -f supabase/schema_smith.sql
  else
    $PSQL -f supabase/migrate_smith_onto_agentcollab.sql
    $PSQL -f supabase/migrate_wake_hooks.sql
  fi
  local schema_env=()
  if [ "$schema" != "cutout" ]; then schema_env+=(SMITH_SCHEMA="$schema"); fi
  if [ "$tables_schema" != "public" ]; then schema_env+=(SMITH_TABLES_SCHEMA="$tables_schema"); fi
  # shellcheck disable=SC2086
  env SUPABASE_DB_URL="postgresql://smithtest:smithtest@127.0.0.1:5433/smithtest" \
      $token_env="$token_val" \
      SMITH_SETUP_KEY="test-setup-key-001" \
      SMITH_LEGACY_STRICT=1 \
      SMITH_REDEEM_BUDGET_PER_HOUR=40 \
      SMITH_REDEEM_CODE_LOCKOUT_AFTER=3 \
      SMITH_CLAIM_BUDGET_PER_HOUR=20 \
      "${schema_env[@]}" \
      "$DENO" run -A supabase/index.ts >/tmp/smith-dual-$schema.log 2>&1 &
  local pid=$!
  for i in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  SMITH_SCHEMA="$schema" SMITH_TABLES_SCHEMA="$tables_schema" python3 tests/smith_integration_test.py \
    "http://127.0.0.1:$port" "test-setup-key-001" "$token_val" 2>&1 | tail -4
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
}

run_suite "RUN A" 8000 cutout public CUTOUT_TOKEN "test-bus-token-001"
sleep 2
run_suite "RUN B" 8000 agentcollab smith AGENTCOLLAB_TOKEN "test-bus-token-002"
echo "done."
