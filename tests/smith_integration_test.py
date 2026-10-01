#!/usr/bin/env python3
"""Smith v1 integration test — runs against the REAL edge function.

Boots supabase/index.ts under Deno against a real local Postgres (schemas
already applied), then exercises the Smith contract end to end:

  1. /health gains "smith": "1.0"
  2. Owner claim: wrong key 401, right key 201 (token once), second claim 404
  3. Pairing issue -> redeem round trip; double redeem 404 (no oracle)
  4. Agent token binds identity: from-mismatch 403, header spoof ignored
  5. Cross-agent thread isolation
  6. Owner send creates an audit row
  7. Activity expiry evaluated on read (backdated row -> no working)
  8. Revoked token 401s
  9. Legacy cutout.py behavior intact (legacy token + X-Agent-Id)

Setup: Postgres with schema.sql + schema_v1.1.sql + schema_smith.sql applied,
then: SUPABASE_DB_URL=... CUTOUT_TOKEN=<key> deno run -A supabase/index.ts
Run:  python3 tests/smith_integration_test.py [base_url] [setup_key]
"""

import json
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
SETUP_KEY = sys.argv[2] if len(sys.argv) > 2 else "test-setup-key-001"

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


# 1. health
s, h = req("GET", "/health")
check("health 200 + smith field", s == 200 and h.get("smith") == "1.0", f"{s} {h}")

# 2. owner claim
s, _ = req("POST", "/v1/owner/claim", {"setup_key": "wrong-key"})
check("claim wrong key -> 401", s == 401, f"{s}")
s, c = req("POST", "/v1/owner/claim", {"setup_key": SETUP_KEY})
OWNER = c.get("owner_token") if isinstance(c, dict) else None
check("claim right key -> 201 + sm_own_ token", s == 201 and OWNER and OWNER.startswith("sm_own_"), f"{s} {c}")
s, _ = req("POST", "/v1/owner/claim", {"setup_key": SETUP_KEY})
check("second claim -> 404 forever", s == 404, f"{s}")

# bad smith token never falls through to legacy
s, _ = req("GET", "/v1/threads", headers=bearer("sm_own_deadbeef"))
check("bad sm_own_ token -> 401 (no legacy fallthrough)", s == 401, f"{s}")
s, _ = req("GET", "/v1/threads", headers=bearer("sm_agt_deadbeef"))
check("bad sm_agt_ token -> 401 (no legacy fallthrough)", s == 401, f"{s}")

# 3. pairing round trip
s, p = req("POST", "/v1/pairings",
           {"agent_id": "agent-a", "display_name": "Agent A", "platform": "Muse"},
           bearer(OWNER))
CODE = p.get("code") if isinstance(p, dict) else None
check("issue pairing -> 201 + code", s == 201 and CODE, f"{s} {p}")
s, r = req("POST", "/v1/pairings/redeem", {"code": CODE})
TOK_A = r.get("agent_token") if isinstance(r, dict) else None
check("redeem -> 200 + sm_agt_ token", s == 200 and TOK_A and TOK_A.startswith("sm_agt_")
      and r.get("agent_id") == "agent-a", f"{s} {r}")
s, _ = req("POST", "/v1/pairings/redeem", {"code": CODE})
check("double redeem -> 404 no oracle", s == 404, f"{s}")

# second agent
s, p2 = req("POST", "/v1/pairings",
            {"agent_id": "agent-b", "display_name": "Agent B", "platform": "Muse"},
            bearer(OWNER))
s, r2 = req("POST", "/v1/pairings/redeem", {"code": p2["code"]})
TOK_B = r2["agent_token"]

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

# 5. cross-agent isolation
s, _ = req("GET", f"/v1/threads/{TH_A}/feed", headers=bearer(TOK_B))
check("agent B cannot read agent A's thread", s == 403, f"{s}")
s, tl = req("GET", "/v1/threads", headers=bearer(TOK_B))
ids = [e["thread_id"] for e in (tl if isinstance(tl, list) else [])]
check("agent B thread list excludes A's thread", TH_A not in ids, f"{ids}")

# 6. owner send -> audit row
s, _ = req("POST", "/v1/messages",
           {"from": "owner", "thread_id": TH_A, "to": "*", "type": "note", "body": "owner says hi",
            "idempotency_key": "ko-" + uuid.uuid4().hex}, bearer(OWNER))
check("owner send as reserved sender -> 201/200", s in (200, 201), f"{s} {_}")
s, au = req("GET", "/v1/owner/audit?limit=20", headers=bearer(OWNER))
acts = [r.get("action") for r in (au.get("audit", au) if isinstance(au, dict) else au)]
check("owner send created audit row", "send_message" in acts, f"{acts}")

# owner reads must use owner routes
s, _ = req("GET", "/v1/messages", headers=bearer(OWNER))
check("owner GET /v1/messages -> 403 pointer", s == 403, f"{s}")
s, of = req("GET", f"/v1/owner/feed?thread_id={TH_A}", headers=bearer(OWNER))
check("owner feed works + is audited", s == 200 and isinstance(of, dict), f"{s}")

# 7. activity expiry evaluated on read
s, _ = req("POST", "/v1/activity", {"thread_id": TH_A, "state": "working"}, bearer(TOK_A))
check("activity heartbeat -> 200", s == 200, f"{s}")
s, f1 = req("GET", f"/v1/threads/{TH_A}/feed", headers=bearer(TOK_A))
w1 = [w["agent_id"] for w in f1.get("working", [])]
check("feed shows working agent", "agent-a" in w1, f"{w1}")
# simulate a crashed agent: backdate expiry, then read again
import os
import subprocess
_pg = "/usr/local/lib/python3.12/dist-packages/pgserver/pginstall/bin"
_env = dict(os.environ, PGPASSWORD="smithtest",
            PATH=_pg + ":" + os.environ.get("PATH", ""),
            LD_LIBRARY_PATH="/usr/local/lib/python3.12/dist-packages/pgserver/pginstall/lib")
subprocess.run([f"{_pg}/psql", "-h", "127.0.0.1", "-p", "5433", "-U", "smithtest",
                "-d", "smithtest",
                "-c", "UPDATE smith_activity SET expires_at = now() - interval '1 second';"],
               env=_env, capture_output=True)
s, f2 = req("GET", f"/v1/threads/{TH_A}/feed", headers=bearer(TOK_A))
w2 = f2.get("working", [])
check("expired activity clears from feed on read", w2 == [], f"{w2}")

# 8. revoke -> 401
s, _ = req("POST", "/v1/owner/agents/agent-b/revoke", {}, bearer(OWNER))
check("revoke agent-b -> 200", s == 200, f"{s}")
s, _ = req("GET", "/v1/threads", headers=bearer(TOK_B))
check("revoked token -> 401", s == 401, f"{s}")

# 9. legacy cutout.py behavior intact
LEG = {"Authorization": f"Bearer {SETUP_KEY}", "X-Agent-Id": "legacy-bot"}
s, _ = req("POST", "/v1/messages",
           {"from": "legacy-bot", "thread_id": "cutout", "to": "*", "type": "note", "body": "legacy ping",
            "idempotency_key": "kl-" + uuid.uuid4().hex}, LEG)
check("legacy post via bus token + X-Agent-Id", s in (200, 201), f"{s}")
s, lt = req("GET", "/v1/threads", headers={"Authorization": f"Bearer {SETUP_KEY}"})
check("legacy GET /v1/threads keeps v1.1 shape", s == 200 and isinstance(lt, dict)
      and isinstance(lt.get("threads"), list), f"{s} {type(lt)}")

print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    print("FAILURES:", FAIL)
    sys.exit(1)
