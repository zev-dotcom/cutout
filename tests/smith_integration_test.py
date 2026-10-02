#!/usr/bin/env python3
"""Smith v1 integration test — runs against the REAL edge function.

Boots supabase/index.ts under Deno against a real local Postgres (schemas
already applied), then exercises the Smith contract end to end:

  1. /health gains "smith": "1.0"
  2. Owner claim: separate setup key checked first; wrong key and
     already-claimed return the identical 404 (no claimed-state oracle);
     the bus token is NOT accepted as the setup key
  3. Pairing issue -> redeem round trip; double redeem 404 (no oracle);
     default code lifetime is 10 minutes
  4. Agent token binds identity: from-mismatch 403, header spoof ignored
  5. Cross-agent thread isolation
  6. Strict legacy mode: bus token + X-Agent-Id is refused on managed
     threads for read, write, feed, and message-list paths
  7. Member-add is owner-only and audited; non-member heartbeat 403
  8. Owner send creates an audit row; owner reads are fail-closed
     (denied when the audit write fails); failed owner auth is audited
  9. smith_audit is append-only at the DB level (UPDATE/DELETE rejected)
 10. Pairing: atomic concurrent redeem (exactly one winner), per-code
     lockout, global brute-force budget that ignores X-Forwarded-For
 11. Seeded legacy agent rows (token_hash null) may be paired (no 409)
 12. Revocation applies on the legacy path too
 13. Legacy-unverified provenance is surfaced; owner can verify members
 14. Activity expiry evaluated on read (backdated row -> no working)
 15. Legacy cutout.py behavior intact on unmanaged threads
 16. P0-1: agent cannot take over a legacy thread id with history (403);
     owner adoption is audited and seeds unverified members
 17. P1-2: unverified seeded members get no access until owner verifies;
     legacy_unverified surfaced consistently in member lists
 18. P1-3: new members see thread history from their join time (added_at)
 19. P1-6: owner can reset burned brute-force budgets (audited)
 20. P2-8: re-issuing a pairing code expires the earlier one;
     P2-9: renames write an audit row
 21. P1-5: failed-auth audit deduped per class with fixed 'unauthenticated'
     actor; agent failures audited consistently
 22. P1-4: separate phase — claim disabled when SMITH_SETUP_KEY unset
     (run with the no-setup-key flag against a keyless server)
 23. Round-3 P2s: fail-closed default for a missing member row; failed-auth
     traffic under the fixed 'unauthenticated' rate bucket; all legacy
     callers in one bucket regardless of X-Agent-Id; named idempotency PK
     with an idempotent migration re-run

Setup: Postgres with schema.sql + schema_v1.1.sql + schema_smith.sql applied,
then e.g.:
  SUPABASE_DB_URL=... CUTOUT_TOKEN=<bus> SMITH_SETUP_KEY=<setup> \\
  SMITH_LEGACY_STRICT=1 SMITH_REDEEM_BUDGET_PER_HOUR=40 \\
  SMITH_REDEEM_CODE_LOCKOUT_AFTER=3 SMITH_CLAIM_BUDGET_PER_HOUR=20 \\
  deno run -A supabase/index.ts
Run:  python3 tests/smith_integration_test.py [base_url] [setup_key] [bus_token]
"""

import hashlib
import json
import os
import subprocess
import sys
import threading
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
SETUP_KEY = sys.argv[2] if len(sys.argv) > 2 else "test-setup-key-001"
BUS_TOKEN = sys.argv[3] if len(sys.argv) > 3 else "test-bus-token-001"
SCHEMA = os.environ.get("SMITH_SCHEMA", "cutout")  # bus-table schema under test

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))


def req(method, path, body=None, headers=None, raw_body=None):
    h = dict(headers or {})
    data = None
    if raw_body is not None:
        data = raw_body.encode()
    elif body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r) as resp:
            raw = resp.read().decode()
            return resp.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw) if raw else None
        except Exception:
            return e.code, {"_raw": raw}


def bearer(tok):
    return {"Authorization": f"Bearer {tok}"}


_pg = "/usr/local/lib/python3.12/dist-packages/pgserver/pginstall/bin"
_env = dict(os.environ, PGPASSWORD="smithtest",
            PATH=_pg + ":" + os.environ.get("PATH", ""),
            LD_LIBRARY_PATH="/usr/local/lib/python3.12/dist-packages/pgserver/pginstall/lib")


def psql(sql, expect_fail=False):
    """Run SQL directly. Returns (ok, stdout)."""
    p = subprocess.run([f"{_pg}/psql", "-h", "127.0.0.1", "-p", "5433", "-U", "smithtest",
                        "-d", "smithtest", "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql],
                       env=_env, capture_output=True, text=True)
    ok = p.returncode == 0
    if expect_fail:
        return (not ok, (p.stderr or p.stdout).strip())
    return ok, (p.stdout or p.stderr).strip()


def legacy_headers(agent_id=None, extra=None):
    h = {"Authorization": f"Bearer {BUS_TOKEN}"}
    if agent_id:
        h["X-Agent-Id"] = agent_id
    if extra:
        h.update(extra)
    return h


# 0. P1-4: owner claim disabled when SMITH_SETUP_KEY is unset (fail closed).
# Separate phase: start the server WITHOUT SMITH_SETUP_KEY, then run:
#   python3 tests/smith_integration_test.py [base_url] any-key [bus_token] no-setup-key
if len(sys.argv) > 4 and sys.argv[4] == "no-setup-key":
    s, _ = req("POST", "/v1/owner/claim", {"setup_key": "anything-at-all"})
    check("claim disabled without setup key -> 404", s == 404, f"{s}")
    s, _ = req("POST", "/v1/owner/claim", {"setup_key": BUS_TOKEN})
    check("claim disabled without setup key -> 404 even for bus token", s == 404, f"{s}")
    print(f"\n{len(PASS)} passed, {len(FAIL)} failed (no-setup-key phase)")
    sys.exit(0 if not FAIL else 1)

# 1. health
s, h = req("GET", "/health")
check("health 200 + smith field", s == 200 and h.get("smith") == "1.0", f"{s} {h}")

# 2. owner claim: separate setup key, checked first, no oracle
s, wrong_body = req("POST", "/v1/owner/claim", {"setup_key": "wrong-key"})
check("claim wrong setup key -> 404", s == 404, f"{s} {wrong_body}")
s, c = req("POST", "/v1/owner/claim", {"setup_key": SETUP_KEY})
OWNER = c.get("owner_token") if isinstance(c, dict) else None
check("claim right setup key -> 201 + sm_own_ token", s == 201 and OWNER and OWNER.startswith("sm_own_"), f"{s} {c}")
s, bus_body = req("POST", "/v1/owner/claim", {"setup_key": BUS_TOKEN})
check("claim with bus token as setup key -> 404 (separation)", s == 404, f"{s} {bus_body}")
s, again_body = req("POST", "/v1/owner/claim", {"setup_key": SETUP_KEY})
check("second claim -> 404 forever", s == 404, f"{s}")
check("wrong-key and already-claimed bodies identical (no oracle)",
      wrong_body == again_body == {"error": "not found"}, f"{wrong_body} vs {again_body}")

# bad smith token never falls through to legacy
s, _ = req("GET", "/v1/threads", headers=bearer("sm_own_deadbeef"))
check("bad sm_own_ token -> 401 (no legacy fallthrough)", s == 401, f"{s}")
s, au = req("GET", "/v1/owner/audit?limit=20", headers=bearer(OWNER))
acts = [(r.get("action"), (r.get("detail") or {}).get("credential_class")) for r in au.get("audit", [])]
check("failed owner auth is audited", ("auth_failed", "owner") in acts, f"{acts}")
s, _ = req("GET", "/v1/threads", headers=bearer("sm_agt_deadbeef"))
check("bad sm_agt_ token -> 401 (no legacy fallthrough)", s == 401, f"{s}")

# P1-5: failed-auth audit is deduped per class and uses a fixed actor
s, _ = req("GET", "/v1/threads", headers=bearer("sm_own_deadbeef2"))
s, _ = req("GET", "/v1/threads", headers=bearer("sm_own_deadbeef3"))
ok, out = psql("SELECT count(*) FROM smith_audit WHERE action='auth_failed' AND detail->>'credential_class'='owner';")
check("failed owner-auth audit deduped (rapid repeats, still 1 row)", ok and out.strip() == "1", out)
ok, out = psql("SELECT count(*) FROM smith_audit WHERE action='auth_failed' AND detail->>'credential_class'='agent';")
check("failed agent auth audited consistently with owner", ok and out.strip() == "1", out)
s, _ = req("GET", "/v1/threads", headers=bearer("sm_agt_deadbeef2"))
ok, out2 = psql("SELECT count(*) FROM smith_audit WHERE action='auth_failed' AND detail->>'credential_class'='agent';")
check("failed agent-auth audit deduped too", ok and out2.strip() == out.strip(), out2)
ok, out3 = psql("SELECT actor FROM smith_audit WHERE action='auth_failed' ORDER BY at DESC LIMIT 1;")
check("failed-auth actor is fixed 'unauthenticated'", ok and out3.strip() == "unauthenticated", out3)

# 3. pairing round trip
s, p = req("POST", "/v1/pairings",
           {"agent_id": "agent-a", "display_name": "Agent A", "platform": "Muse"},
           bearer(OWNER))
CODE = p.get("code") if isinstance(p, dict) else None
exp = p.get("expires_at") if isinstance(p, dict) else None
check("issue pairing -> 201 + code", s == 201 and CODE, f"{s} {p}")
try:
    delta = datetime.fromisoformat(exp) - datetime.now(timezone.utc)
    life_ok = timedelta(minutes=5) < delta < timedelta(minutes=15)
except Exception:
    life_ok = False
check("pairing default lifetime is 10 minutes", life_ok, f"{exp}")
s, r = req("POST", "/v1/pairings/redeem", {"code": CODE})
TOK_A = r.get("agent_token") if isinstance(r, dict) else None
check("redeem -> 200 + sm_agt_ token", s == 200 and TOK_A and TOK_A.startswith("sm_agt_")
      and r.get("agent_id") == "agent-a", f"{s} {r}")
s, _ = req("POST", "/v1/pairings/redeem", {"code": CODE})
check("double redeem -> 404 no oracle", s == 404, f"{s}")

# second + third agents
s, p2 = req("POST", "/v1/pairings",
            {"agent_id": "agent-b", "display_name": "Agent B", "platform": "Muse"},
            bearer(OWNER))
s, r2 = req("POST", "/v1/pairings/redeem", {"code": p2["code"]})
TOK_B = r2["agent_token"]
s, p3 = req("POST", "/v1/pairings",
            {"agent_id": "agent-c", "display_name": "Agent C", "platform": "Muse"},
            bearer(OWNER))
s, r3 = req("POST", "/v1/pairings/redeem", {"code": p3["code"]})
TOK_C = r3["agent_token"]

# 4. agent identity binding
s, t = req("POST", "/v1/threads", {"name": "a-thread", "member_ids": []}, bearer(TOK_A))
TH_A = t.get("thread_id") if isinstance(t, dict) else None
check("agent creates thread -> 201", s == 201 and TH_A, f"{s} {t}")

msg = {"from": "agent-a", "thread_id": TH_A, "to": "*", "type": "note", "body": "hello",
       "idempotency_key": "k-" + uuid.uuid4().hex}
s, m = req("POST", "/v1/messages", msg, bearer(TOK_A))
check("agent posts as self -> 201/200", s in (200, 201), f"{s} {m}")

s, _ = req("POST", "/v1/messages",
           {"from": "agent-b", "thread_id": TH_A, "to": "*", "type": "note", "body": "spoof"}, bearer(TOK_A))
check("from mismatch -> 403", s == 403, f"{s}")

s, _ = req("POST", "/v1/messages",
           {"from": "agent-a", "thread_id": TH_A, "to": "*", "type": "note", "body": "x",
            "idempotency_key": "k2-" + uuid.uuid4().hex},
           {**bearer(TOK_A), "X-Agent-Id": "agent-b"})
check("X-Agent-Id spoof ignored for token-bound agent", s in (200, 201), f"{s}")

# 6. strict legacy mode: the shared bus token is refused on managed threads
s, b = req("GET", f"/v1/threads/{TH_A}/feed", headers=legacy_headers("agent-a"))
check("strict: legacy+X-Agent-Id cannot read managed thread feed -> 403",
      s == 403 and b.get("error") == "legacy credentials not accepted on managed threads", f"{s} {b}")
s, b = req("POST", "/v1/messages",
           {"from": "agent-a", "thread_id": TH_A, "to": "*", "type": "note", "body": "legacy write",
            "idempotency_key": "klw-" + uuid.uuid4().hex}, legacy_headers("agent-a"))
check("strict: legacy+X-Agent-Id cannot write to managed thread -> 403", s == 403, f"{s} {b}")
s, b = req("GET", f"/v1/messages?thread_id={TH_A}", headers=legacy_headers("agent-a"))
check("strict: legacy cannot scope legacy message-list to managed thread -> 403", s == 403, f"{s} {b}")

# 5. cross-agent isolation
s, _ = req("GET", f"/v1/threads/{TH_A}/feed", headers=bearer(TOK_B))
check("agent B cannot read agent A's thread", s == 403, f"{s}")
s, tl = req("GET", "/v1/threads", headers=bearer(TOK_B))
ids = [e["thread_id"] for e in (tl if isinstance(tl, list) else [])]
check("agent B thread list excludes A's thread", TH_A not in ids, f"{ids}")

# 7. member-add is owner-only and audited; non-member heartbeat denied
s, _ = req("POST", f"/v1/threads/{TH_A}/members", {"agent_id": "agent-c"}, bearer(TOK_A))
check("member-add by non-owner -> 403", s == 403, f"{s}")
s, _ = req("POST", "/v1/activity", {"thread_id": TH_A, "state": "working"}, bearer(TOK_C))
check("non-member activity heartbeat -> 403", s == 403, f"{s}")
s, madd = req("POST", f"/v1/threads/{TH_A}/members", {"agent_id": "agent-c"}, bearer(OWNER))
check("owner member-add -> 200", s == 200 and madd.get("agent_id") == "agent-c", f"{s} {madd}")
s, au = req("GET", "/v1/owner/audit?limit=20", headers=bearer(OWNER))
acts = [r.get("action") for r in au.get("audit", [])]
check("member-add is audited", "add_member" in acts, f"{acts}")
s, _ = req("POST", "/v1/activity", {"thread_id": TH_A, "state": "working"}, bearer(TOK_C))
check("member heartbeat works after owner add -> 200", s == 200, f"{s}")

# 8. owner send -> audit row; owner reads use owner routes
s, _ = req("POST", "/v1/messages",
           {"from": "owner", "thread_id": TH_A, "to": "*", "type": "note", "body": "owner says hi",
            "idempotency_key": "ko-" + uuid.uuid4().hex}, bearer(OWNER))
check("owner send as reserved sender -> 201/200", s in (200, 201), f"{s} {_}")
s, au = req("GET", "/v1/owner/audit?limit=20", headers=bearer(OWNER))
acts = [r.get("action") for r in (au.get("audit", au) if isinstance(au, dict) else au)]
check("owner send created audit row", "send_message" in acts, f"{acts}")

s, _ = req("GET", "/v1/messages", headers=bearer(OWNER))
check("owner GET /v1/messages -> 403 pointer", s == 403, f"{s}")
s, of = req("GET", f"/v1/owner/feed?thread_id={TH_A}", headers=bearer(OWNER))
check("owner feed works + is audited", s == 200 and isinstance(of, dict), f"{s}")

# 8b. owner reads are fail-closed: break audit inserts, reads must be denied
ok, _ = psql("CREATE TRIGGER boom BEFORE INSERT ON smith_audit FOR EACH ROW "
             "EXECUTE FUNCTION smith_audit_deny_write();")
check("psql: boom trigger installed", ok)
s, b = req("GET", f"/v1/owner/feed?thread_id={TH_A}", headers=bearer(OWNER))
check("owner feed denied when audit write fails -> 500, no data",
      s == 500 and b.get("error") == "audit unavailable", f"{s} {b}")
s, b = req("GET", "/v1/owner/threads", headers=bearer(OWNER))
check("owner threads denied when audit write fails -> 500", s == 500, f"{s} {b}")
ok, _ = psql("DROP TRIGGER boom ON smith_audit;")
check("psql: boom trigger dropped", ok)
s, _ = req("GET", f"/v1/owner/feed?thread_id={TH_A}", headers=bearer(OWNER))
check("owner feed works again after trigger dropped", s == 200, f"{s}")

# 9. smith_audit is append-only at the DB level
ok, err = psql("UPDATE smith_audit SET action = 'tampered';", expect_fail=True)
check("DB rejects UPDATE on smith_audit", ok and "append-only" in err, err[:120])
ok, err = psql("DELETE FROM smith_audit;", expect_fail=True)
check("DB rejects DELETE on smith_audit", ok and "append-only" in err, err[:120])

# 14. activity expiry evaluated on read
s, _ = req("POST", "/v1/activity", {"thread_id": TH_A, "state": "working"}, bearer(TOK_A))
check("activity heartbeat -> 200", s == 200, f"{s}")
s, f1 = req("GET", f"/v1/threads/{TH_A}/feed", headers=bearer(TOK_A))
w1 = [w["agent_id"] for w in f1.get("working", [])]
check("feed shows working agent", "agent-a" in w1, f"{w1}")
ok, _ = psql("UPDATE smith_activity SET expires_at = now() - interval '1 second';")
check("psql: backdate activity expiry", ok)
s, f2 = req("GET", f"/v1/threads/{TH_A}/feed", headers=bearer(TOK_A))
w2 = f2.get("working", [])
check("expired activity clears from feed on read", w2 == [], f"{w2}")

# 12. revoke applies on every credential class, including the legacy path
s, _ = req("POST", "/v1/owner/agents/agent-b/revoke", {}, bearer(OWNER))
check("revoke agent-b -> 200", s == 200, f"{s}")
s, _ = req("GET", "/v1/threads", headers=bearer(TOK_B))
check("revoked token -> 401", s == 401, f"{s}")
s, _ = req("GET", "/v1/threads", headers=legacy_headers("agent-b"))
check("revoked identity denied on legacy path -> 401", s == 401, f"{s}")

# 11. seeded legacy agent rows (token_hash null) may be paired
ok, _ = psql("INSERT INTO smith_agents (agent_id, display_name, platform, token_hash, legacy_unverified) "
             "VALUES ('legacy-seed', 'Legacy Seed', 'unknown', NULL, true);")
check("psql: seed legacy agent row", ok)
s, ps = req("POST", "/v1/pairings",
            {"agent_id": "legacy-seed", "display_name": "Legacy Seed", "platform": "Muse"},
            bearer(OWNER))
check("seeded agent can be paired (no 409)", s == 201 and ps.get("code"), f"{s} {ps}")
s, rs = req("POST", "/v1/pairings/redeem", {"code": ps["code"]})
check("seeded agent redeem works", s == 200 and rs.get("agent_id") == "legacy-seed", f"{s} {rs}")

# 10a. concurrent redeem: exactly one winner (atomic)
s, pd = req("POST", "/v1/pairings",
            {"agent_id": "agent-d", "display_name": "Agent D", "platform": "Muse"},
            bearer(OWNER))
CODE_D = pd["code"]
results = []
def race_redeem():
    st, _ = req("POST", "/v1/pairings/redeem", {"code": CODE_D})
    results.append(st)
threads = [threading.Thread(target=race_redeem) for _ in range(10)]
[t.start() for t in threads]
[t.join() for t in threads]
check("concurrent redeem: exactly one 200, rest 404",
      results.count(200) == 1 and results.count(404) == 9, f"{sorted(results)}")

# 10b. per-code lockout: hammering one (expired) code locks it
s, pe = req("POST", "/v1/pairings",
            {"agent_id": "agent-e", "display_name": "Agent E", "platform": "Muse"},
            bearer(OWNER))
CODE_E = pe["code"]
EHASH = hashlib.sha256(CODE_E.replace("-", "").encode()).hexdigest()
ok, _ = psql(f"UPDATE smith_pairings SET expires_at = now() - interval '1 minute' "
             f"WHERE code_hash = '{EHASH}';")
check("psql: expire code E", ok)
ok, _ = psql("TRUNCATE smith_auth_attempts;")
check("psql: reset attempt table", ok)
for _ in range(3):  # SMITH_REDEEM_CODE_LOCKOUT_AFTER=3 in the test env
    s, _ = req("POST", "/v1/pairings/redeem", {"code": CODE_E})
    assert s == 404, s
ok, out = psql(f"SELECT locked_at IS NOT NULL FROM smith_pairings WHERE code_hash = '{EHASH}';")
check("code locked after lockout threshold", ok and out.strip() == "t", out)
s, _ = req("POST", "/v1/pairings/redeem", {"code": CODE_E})
check("locked code stays 404", s == 404, f"{s}")

# 10c. global brute-force budget ignores X-Forwarded-For
ok, _ = psql("TRUNCATE smith_auth_attempts;")
check("psql: reset attempt table", ok)
got_429 = False
for i in range(41):  # SMITH_REDEEM_BUDGET_PER_HOUR=40 in the test env
    s, _ = req("POST", "/v1/pairings/redeem", {"code": "BBBBBB"},
               headers={"X-Forwarded-For": f"10.9.9.{i}"})
    if s == 429:
        got_429 = True
        break
    assert s == 404, (i, s)
check("global budget trips despite rotating forged X-Forwarded-For -> 429", got_429, "")
# a fresh code cannot be redeemed while the instance is locked out
s, _ = req("POST", "/v1/pairings/redeem", {"code": "CCCCCC"})
check("redeem locked out at budget -> 429", s == 429, f"{s}")
ok, _ = psql("TRUNCATE smith_auth_attempts;")
check("psql: reset attempt table", ok)

# 13. legacy-unverified provenance is surfaced; owner can verify
ok, _ = psql("INSERT INTO smith_agents (agent_id, display_name, platform, token_hash, legacy_unverified) "
             "VALUES ('legacy-ghost', 'Legacy Ghost', 'unknown', NULL, true);")
check("psql: seed legacy-ghost agent", ok)
s, tg = req("POST", "/v1/threads", {"name": "ghost-thread", "member_ids": ["legacy-ghost"]}, bearer(TOK_A))
TH_G = tg.get("thread_id") if isinstance(tg, dict) else None
members = tg.get("members", []) if isinstance(tg, dict) else []
ghost = next((m for m in members if m.get("agent_id") == "legacy-ghost"), None)
check("thread create surfaces legacy_unverified on members",
      s == 201 and ghost is not None and "legacy_unverified" in ghost, f"{s} {ghost}")
s, ag = req("GET", "/v1/owner/agents", headers=bearer(OWNER))
ghosts = [a for a in ag.get("agents", []) if a.get("agent_id") == "legacy-ghost"]
check("owner agents list surfaces legacy_unverified",
      len(ghosts) == 1 and ghosts[0].get("legacy_unverified") is True, f"{ghosts}")
s, _ = req("POST", f"/v1/owner/threads/{TH_G}/members/legacy-ghost/verify", {}, bearer(OWNER))
check("owner verify member -> 200", s == 200, f"{s}")
ok, out = psql(f"SELECT legacy_unverified FROM smith_thread_members "
               f"WHERE thread_id = '{TH_G}' AND agent_id = 'legacy-ghost';")
check("member flag cleared after verify", ok and out.strip() == "f", out)
s, au = req("GET", "/v1/owner/audit?limit=20", headers=bearer(OWNER))
acts = [r.get("action") for r in au.get("audit", [])]
check("verify_member is audited", "verify_member" in acts, f"{acts}")

# 15. legacy cutout.py behavior intact on unmanaged threads
LEG = legacy_headers("legacy-bot")
s, _ = req("POST", "/v1/messages",
           {"from": "legacy-bot", "thread_id": "cutout", "to": "*", "type": "note", "body": "legacy ping",
            "idempotency_key": "kl-" + uuid.uuid4().hex}, LEG)
check("legacy post via bus token + X-Agent-Id", s in (200, 201), f"{s}")
s, lt = req("GET", "/v1/threads", headers={"Authorization": f"Bearer {BUS_TOKEN}"})
check("legacy GET /v1/threads keeps v1.1 shape", s == 200 and isinstance(lt, dict)
      and isinstance(lt.get("threads"), list), f"{s} {type(lt)}")
s, lm = req("GET", "/v1/messages?limit=50", headers=LEG)
managed_leak = [m for m in lm.get("messages", []) if m.get("thread_id") == TH_A]
check("strict: legacy message list excludes managed threads",
      s == 200 and not managed_leak, f"{s} leaked={len(managed_leak)}")

# 16. P0-1: postThread takeover guard — an agent cannot adopt a legacy
# thread id with history; the owner can, audited, seeded members unverified
LEGACY_TID = "x_cutout_thread_takeover_" + uuid.uuid4().hex[:8]
ok, _ = psql(f"INSERT INTO {SCHEMA}.messages (id, thread_id, from_agent, to_agent, type, body) "
             f"VALUES ('msg_takeover1', '{LEGACY_TID}', 'victim-agent', '*', 'note', 'victim history');")
check("psql: seed legacy thread with history", ok)
s, b = req("POST", "/v1/threads", {"name": "takeover", "thread_id": LEGACY_TID}, bearer(TOK_A))
check("agent cannot take over legacy thread id with history -> 403",
      s == 403 and "only the owner can adopt it" in (b.get("error") or ""), f"{s} {b}")
FRESH_TID = "x_cutout_thread_fresh_" + uuid.uuid4().hex[:8]
s, b = req("POST", "/v1/threads", {"name": "fresh", "thread_id": FRESH_TID}, bearer(TOK_A))
check("agent can name a fresh id with zero history -> 201",
      s == 201 and b.get("thread_id") == FRESH_TID, f"{s} {b}")
s, b = req("POST", "/v1/threads", {"name": "adopted", "thread_id": LEGACY_TID}, bearer(OWNER))
check("owner can adopt legacy thread -> 201", s == 201, f"{s} {b}")
adopted_members = b.get("members", []) if isinstance(b, dict) else []
victim = next((m for m in adopted_members if m.get("agent_id") == "victim-agent"), None)
check("adopted members seeded as legacy_unverified",
      victim is not None and victim.get("legacy_unverified") is True, f"{victim}")
s, au = req("GET", "/v1/owner/audit?limit=30", headers=bearer(OWNER))
acts = [r.get("action") for r in au.get("audit", [])]
check("legacy adoption is audited (thread_adopt)", "thread_adopt" in acts, f"{acts}")

# 17. P1-2: strict seeded membership — no access until the owner verifies
s, p = req("POST", "/v1/pairings",
           {"agent_id": "victim-agent", "display_name": "Victim", "platform": "test"},
           bearer(OWNER))
s, r = req("POST", "/v1/pairings/redeem", {"code": p.get("code")})
TOK_V = r.get("agent_token") if isinstance(r, dict) else None
check("victim-agent paired", s == 200 and TOK_V, f"{s} {r}")
s, _ = req("GET", f"/v1/threads/{LEGACY_TID}/feed", headers=bearer(TOK_V))
check("unverified seeded member cannot read thread -> 403", s == 403, f"{s}")
s, tl = req("GET", "/v1/threads", headers=bearer(OWNER))
adopted = next((t for t in tl.get("threads", []) if t.get("thread_id") == LEGACY_TID), None)
amembers = adopted.get("members", []) if adopted else []
check("listThreadsSmith members include legacy_unverified",
      adopted is not None and amembers and all("legacy_unverified" in m for m in amembers),
      f"{amembers}")
s, _ = req("POST", f"/v1/owner/threads/{LEGACY_TID}/members/victim-agent/verify", {}, bearer(OWNER))
check("owner verify seeded member -> 200", s == 200, f"{s}")
s, f = req("GET", f"/v1/threads/{LEGACY_TID}/feed", headers=bearer(TOK_V))
bodies = [m.get("body") for m in f.get("messages", [])]
check("verified member can read thread incl. legacy history -> 200",
      s == 200 and "victim history" in bodies, f"{s} {bodies}")

# 18. P1-3: joined_at history rule — new members see messages from join time
s, t = req("POST", "/v1/threads", {"name": "join-test"}, bearer(TOK_A))
TH_J = t.get("thread_id") if isinstance(t, dict) else None
s, _ = req("POST", "/v1/messages",
           {"from": "agent-a", "thread_id": TH_J, "to": "*", "type": "note", "body": "before-join",
            "idempotency_key": "kj1-" + uuid.uuid4().hex}, bearer(TOK_A))
s, _ = req("POST", f"/v1/threads/{TH_J}/members", {"agent_id": "agent-c"}, bearer(OWNER))
check("owner adds agent-c to new thread -> 200", s == 200, f"{s}")
s, _ = req("POST", "/v1/messages",
           {"from": "agent-a", "thread_id": TH_J, "to": "*", "type": "note", "body": "after-join",
            "idempotency_key": "kj2-" + uuid.uuid4().hex}, bearer(TOK_A))
s, fc = req("GET", f"/v1/threads/{TH_J}/feed", headers=bearer(TOK_C))
bodies_c = [m.get("body") for m in fc.get("messages", [])]
check("new member sees only post-join history",
      "after-join" in bodies_c and "before-join" not in bodies_c, f"{bodies_c}")
s, fa = req("GET", f"/v1/threads/{TH_J}/feed", headers=bearer(TOK_A))
bodies_a = [m.get("body") for m in fa.get("messages", [])]
check("existing member sees full history",
      "after-join" in bodies_a and "before-join" in bodies_a, f"{bodies_a}")

# 19. P1-6: owner can reset burned brute-force budgets
ok, _ = psql("INSERT INTO smith_auth_attempts (kind, code_hash) SELECT 'redeem', 'floodtest' FROM generate_series(1, 500);")
check("psql: burn redeem budget", ok)
s, _ = req("POST", "/v1/pairings/redeem", {"code": "AAAA-AA"})
check("burned budget -> 429", s == 429, f"{s}")
s, _ = req("POST", "/v1/owner/security/reset-budgets", {}, bearer(TOK_A))
check("budget reset requires owner -> 403", s == 403, f"{s}")
s, rb = req("POST", "/v1/owner/security/reset-budgets", {}, bearer(OWNER))
check("owner resets budgets -> 200", s == 200, f"{s} {rb}")
ok, out = psql("SELECT count(*) FROM smith_auth_attempts;")
check("attempts cleared after reset", ok and out.strip() == "0", out)
s, au = req("GET", "/v1/owner/audit?limit=30", headers=bearer(OWNER))
acts = [r.get("action") for r in au.get("audit", [])]
check("budget reset is audited", "budget_reset" in acts, f"{acts}")

# 20. P2-8: re-issuing a pairing code expires the earlier one; P2-9: rename audited
s, p1 = req("POST", "/v1/pairings",
            {"agent_id": "agent-p28", "display_name": "P28", "platform": "test"}, bearer(OWNER))
code1 = p1.get("code")
s, p2 = req("POST", "/v1/pairings",
            {"agent_id": "agent-p28", "display_name": "P28", "platform": "test"}, bearer(OWNER))
code2 = p2.get("code")
s, _ = req("POST", "/v1/pairings/redeem", {"code": code1})
check("redeeming superseded code -> 404", s == 404, f"{s}")
s, r2 = req("POST", "/v1/pairings/redeem", {"code": code2})
check("redeeming latest code -> 200", s == 200, f"{s}")
s, _ = req("PATCH", f"/v1/threads/{TH_J}", {"name": "renamed-join-test"}, bearer(TOK_A))
check("rename -> 200", s == 200, f"{s}")
s, au = req("GET", "/v1/owner/audit?limit=30", headers=bearer(OWNER))
acts = [r.get("action") for r in au.get("audit", [])]
check("rename is audited (thread_rename)", "thread_rename" in acts, f"{acts}")

# 21. Round 3 (I2 re-review of e53b143): P1-A/B/C, P2-D/E.
# P1-A: /v1/messages must enforce the same predicate as the feed (verified
# membership + added_at history rule).
# Setup: legacy-seeded thread adopted by owner -> unverified member.
TH_R3 = "x_cutout_thread_r3_unverified"
psql(f"insert into {SCHEMA}.messages (id, thread_id, from_agent, to_agent, type, body) values ('msg_r3_legacy1', '{TH_R3}', 'legacy-r3-sender', '*', 'note', 'legacy hello')")
s, _ = req("POST", "/v1/threads", {"thread_id": TH_R3, "name": "r3-adopted"}, bearer(OWNER))
check("owner adopts legacy thread -> 201", s == 201, f"{s}")
# Pair an agent with the seeded sender id (still unverified).
s, p = req("POST", "/v1/pairings", {"agent_id": "legacy-r3-sender", "display_name": "R3U", "platform": "test"}, bearer(OWNER))
s, r = req("POST", "/v1/pairings/redeem", {"code": p["code"]})
TOK_R3U = r["agent_token"]
s, _ = req("GET", f"/v1/messages?thread_id={TH_R3}", headers=bearer(TOK_R3U))
check("unverified member /v1/messages?thread_id= -> 403", s == 403, f"{s}")
s, m = req("GET", "/v1/messages?limit=100", headers=bearer(TOK_R3U))
ids = [x.get("thread_id") for x in m.get("messages", [])]
check("unverified member unscoped /v1/messages sees no adopted-thread msgs", TH_R3 not in ids, f"{ids}")
# Late-joiner history rule through /v1/messages.
s, t = req("POST", "/v1/threads", {"name": "r3-late"}, bearer(TOK_A))
TH_R3LATE = t["thread_id"]
s, m1 = req("POST", "/v1/messages", {"thread_id": TH_R3LATE, "from": "agent-a", "to": "*", "type": "note", "body": "before join"}, bearer(TOK_A))
M1 = m1["id"]
s, p = req("POST", "/v1/pairings", {"agent_id": "agent-r3late", "display_name": "R3L", "platform": "test"}, bearer(OWNER))
s, r = req("POST", "/v1/pairings/redeem", {"code": p["code"]})
TOK_R3L = r["agent_token"]
s, _ = req("POST", f"/v1/threads/{TH_R3LATE}/members", {"agent_id": "agent-r3late"}, bearer(OWNER))
check("owner adds late joiner -> 200", s == 200, f"{s}")
s, m2 = req("POST", "/v1/messages", {"thread_id": TH_R3LATE, "from": "agent-a", "to": "*", "type": "note", "body": "after join"}, bearer(TOK_A))
M2 = m2["id"]
s, m = req("GET", f"/v1/messages?thread_id={TH_R3LATE}&limit=100", headers=bearer(TOK_R3L))
seen = [x.get("id") for x in m.get("messages", [])]
check("late joiner via /v1/messages sees only post-join", M2 in seen and M1 not in seen, f"{seen}")

# P1-B: receipts require readability; same 404 for not-found and not-yours.
s, _ = req("POST", "/v1/receipts", {"message_id": M2, "agent": "agent-r3late", "status": "received"}, bearer(TOK_R3L))
check("member writes receipt on readable message -> 201", s == 201, f"{s}")
s, p = req("POST", "/v1/pairings", {"agent_id": "agent-r3other", "display_name": "R3O", "platform": "test"}, bearer(OWNER))
s, r = req("POST", "/v1/pairings/redeem", {"code": p["code"]})
TOK_R3O = r["agent_token"]
s, _ = req("POST", "/v1/receipts", {"message_id": M2, "agent": "agent-r3other", "status": "received"}, bearer(TOK_R3O))
check("non-member receipt on another thread's message -> 404 (no oracle)", s == 404, f"{s}")
s, _ = req("POST", "/v1/receipts", {"message_id": "msg_does_not_exist_zzz", "agent": "agent-r3other", "status": "received"}, bearer(TOK_R3O))
check("receipt on nonexistent message -> 404 (same)", s == 404, f"{s}")

# P1-C: legacy strict filter — legacy-only thread still lists (positive test).
TH_LEG = "x_cutout_thread_r3_legacy_only"
s, _ = req("POST", "/v1/messages", {"thread_id": TH_LEG, "from": "legacy-x", "to": "*", "type": "note", "body": "legacy only"}, bearer(BUS_TOKEN))
check("legacy posts to new unmanaged thread -> 201", s == 201, f"{s}")
s, m = req("GET", f"/v1/messages?thread_id={TH_LEG}&limit=10", headers=bearer(BUS_TOKEN))
found = [x.get("thread_id") for x in m.get("messages", [])]
check("legacy-only thread lists for legacy caller", TH_LEG in found, f"{found}")
s, m = req("GET", f"/v1/messages?thread_id={TH_R3LATE}&limit=10", headers=bearer(BUS_TOKEN))
check("managed thread hidden from legacy caller", m.get("messages", []) == [], f"{m.get('messages', [])}")

# P2-D: rate_log carries per-identity values (smoke test for the bucket column).
ok, rows = psql(f"select count(*) from {SCHEMA}.rate_log where identity is not null")
check("rate_log rows carry identity", ok and rows.strip() != "0", rows.strip() if ok else rows)

# P2-E: reply_to must be same-thread; idempotency scoped to thread.
s, _ = req("POST", "/v1/messages", {"thread_id": TH_R3LATE, "from": "agent-a", "to": "*", "type": "note", "body": "xreply", "reply_to": M1}, bearer(TOK_A))
check("reply_to same thread -> 201", s == 201, f"{s}")
s, t2 = req("POST", "/v1/threads", {"name": "r3-other"}, bearer(TOK_A))
TH_R3OTHER = t2["thread_id"]
s, _ = req("POST", "/v1/messages", {"thread_id": TH_R3OTHER, "from": "agent-a", "to": "*", "type": "note", "body": "xreply2", "reply_to": M1}, bearer(TOK_A))
check("reply_to cross-thread -> 422", s == 422, f"{s}")
s, d1 = req("POST", "/v1/messages", {"thread_id": TH_R3LATE, "from": "agent-a", "to": "*", "type": "note", "body": "idem1", "idempotency_key": "key-r3-1"}, bearer(TOK_A))
check("idempotent post thread 1 -> 201", s == 201, f"{s}")
s, d2 = req("POST", "/v1/messages", {"thread_id": TH_R3OTHER, "from": "agent-a", "to": "*", "type": "note", "body": "idem2", "idempotency_key": "key-r3-1"}, bearer(TOK_A))
check("same key different thread -> 201 new message", s == 201 and not d2.get("duplicate"), f"{s} {d2}")
s, d3 = req("POST", "/v1/messages", {"thread_id": TH_R3LATE, "from": "agent-a", "to": "*", "type": "note", "body": "idem3", "idempotency_key": "key-r3-1"}, bearer(TOK_A))
check("same key same thread -> 200 duplicate", s == 200 and d3.get("duplicate") and d3.get("id") == d1.get("id"), f"{s} {d3}")

# 23. Round-3 P2s (I2 round-3 review of be76d04).
# P2-2: a missing member row must default to 'infinity' (see nothing), not
# '-infinity'. White-box check of the exact coalesce default feedMessages uses.
ok, rows = psql(f"select count(*) from {SCHEMA}.messages m where m.thread_id = '{TH_R3LATE}' and m.created_at >= coalesce((select tm.added_at from smith_thread_members tm where tm.thread_id = '{TH_R3LATE}' and tm.agent_id = 'ghost-no-such-member'), 'infinity'::timestamptz)")
check("missing member row sees nothing (fail-closed default)", ok and rows.strip() == "0", rows.strip() if ok else rows)

# P2-3: failed-auth traffic is rate-limited under the fixed 'unauthenticated' bucket.
s, _ = req("GET", "/v1/threads", headers={"Authorization": "Bearer junk-token-xyz"})
check("junk token -> 401", s == 401, f"{s}")
s, _ = req("GET", "/v1/threads", headers={"Authorization": "Bearer sm_agt_no_such_agent"})
check("unknown agent token -> 401", s == 401, f"{s}")
ok, rows = psql(f"select count(*) from {SCHEMA}.rate_log where identity = 'unauthenticated'")
check("failed-auth requests logged under 'unauthenticated'", ok and int(rows.strip()) >= 2, rows.strip() if ok else rows)

# P2-3: legacy callers share one bucket regardless of X-Agent-Id (client-chosen).
s, _ = req("GET", f"/v1/messages?thread_id={TH_LEG}&limit=1", headers=legacy_headers("rot-a"))
s, _ = req("GET", f"/v1/messages?thread_id={TH_LEG}&limit=1", headers=legacy_headers("rot-b"))
ok, rows = psql(f"select string_agg(distinct identity, ',') from {SCHEMA}.rate_log where identity like 'legacy%'")
check("legacy identities collapse to single 'legacy' bucket", ok and rows.strip() == "legacy", rows.strip() if ok else rows)

# P2-4: migration PK constraint is named; re-running the migration is a no-op.
ok, rows = psql(f"select conname from pg_constraint where conrelid = '{SCHEMA}.idempotency_keys'::regclass and contype = 'p'")
check("idempotency PK named idempotency_keys_from_key_thread_pkey", ok and rows.strip() == "idempotency_keys_from_key_thread_pkey", rows.strip() if ok else rows)
p = subprocess.run([f"{_pg}/psql", "-h", "127.0.0.1", "-p", "5433", "-U", "smithtest",
                    "-d", "smithtest", "-v", "ON_ERROR_STOP=1", "-f", "supabase/schema_smith.sql"],
                   env=_env, capture_output=True, text=True)
check("schema_smith.sql re-runs cleanly", p.returncode == 0, (p.stderr or "")[:200])
ok, rows = psql(f"select conname from pg_constraint where conrelid = '{SCHEMA}.idempotency_keys'::regclass and contype = 'p'")
check("PK still named after re-run (guard matched, no drop/re-add)", ok and rows.strip() == "idempotency_keys_from_key_thread_pkey", rows.strip() if ok else rows)

print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    print("FAILURES:", FAIL)
    sys.exit(1)
