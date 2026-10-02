#!/usr/bin/env python3
"""Email wake test (adapter enabled with an allowlist, endpoint faked by wake_preload.ts).
Usage: wake_email_test.py <base-url> <psql cmd...>"""
import json, os, subprocess, sys, time, urllib.request, urllib.error
BASE = sys.argv[1]; PSQL = sys.argv[2:]; HITS = os.environ.get("WAKE_HITS_FILE", "/tmp/wake-email-hits.jsonl")
fails = 0
def check(n, c, d=""):
    global fails
    print(("PASS " if c else "FAIL ") + n + (f"  [{d}]" if d and not c else ""))
    if not c: fails += 1
def req(m, p, b=None, tok=None):
    r = urllib.request.Request(BASE + p, data=json.dumps(b).encode() if b is not None else None, method=m, headers={"content-type": "application/json", **({"authorization": "Bearer " + tok} if tok else {})})
    try:
        with urllib.request.urlopen(r, timeout=30) as x: return x.status, json.loads(x.read() or b"null")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or b"null")
        except Exception: return e.code, None
def sql(q): return subprocess.run(PSQL + ["-tAc", q], capture_output=True, text=True).stdout.strip()
def hits():
    try: return [json.loads(l) for l in open(HITS) if l.strip()]
    except FileNotFoundError: return []
open(HITS, "w").close()
s, c = req("POST", "/v1/owner/claim", {"setup_key": "test-setup-key-001"}); OWN = c["owner_token"]
def pair(a):
    s, p = req("POST", "/v1/pairings", {"agent_id": a, "display_name": a}, OWN); return req("POST", "/v1/pairings/redeem", {"code": p["code"]})[1]["agent_token"]
A, B = pair("em-a"), pair("em-b")
s, th = req("POST", "/v1/threads", {"member_ids": ["em-a", "em-b"], "name": "e"}, OWN); TID = th["thread_id"]
def post(body): return req("POST", "/v1/messages", {"thread_id": TID, "from": "em-a", "to": "em-b", "type": "note", "body": body}, A)
s, _ = req("PUT", "/v1/owner/agents/em-b/wake", {"method": "email", "address": "evil@example.com"}, OWN); check("non-allowlisted address rejected", s == 422, s)
s, _ = req("PUT", "/v1/owner/agents/em-b/wake", {"method": "email", "address": "owner@example.com"}, B); check("agent cannot set email", s == 403, s)
s, w = req("PUT", "/v1/owner/agents/em-b/wake", {"method": "email", "address": "OWNER@example.com"}, OWN); check("allowlisted address accepted (case-insensitive)", s == 200 and w["config"]["address"] == "owner@example.com", w)
post("PRIVATE MESSAGE CONTENT"); time.sleep(1.2); h = hits()
check("one email ping sent to the endpoint", len(h) == 1, len(h))
if h:
    b = json.loads(h[0]["body"]); check("ping has no message content", "PRIVATE" not in h[0]["body"] and b["to"] == "owner@example.com" and "1 new message" in b["text"], b)
    check("endpoint auth is a bearer key, from address set", h[0]["headers"].get("authorization") == "Bearer test-key" and b["from"] == "wake@test.example")
for i in range(4): time.sleep(1.8); post(f"n{i}")
time.sleep(1.5)
check("global email rate limit holds (2/hour in this test)", len(hits()) <= 2, len(hits()))
check("rate-limited sends are audited as failures", "email_rate_limited" in sql("select string_agg(detail::text,' ') from smith.smith_audit where action='wake_failed'"))
print("ALL PASS" if not fails else f"{fails} FAILED"); sys.exit(1 if fails else 0)
