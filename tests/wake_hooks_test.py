#!/usr/bin/env python3
"""Wake hooks test. Usage: wake_hooks_test.py <base-url> <db-psql-cmd...>
Server must run with: SMITH_SCHEMA=agentcollab SMITH_TABLES_SCHEMA=smith SMITH_SETUP_KEY=test-setup-key-001
SMITH_WAKE_DEBOUNCE_MS=1500 SMITH_WAKE_RECHECK_MS=3000 SMITH_WAKE_URGENT_PER_HOUR=3
and --preload tests/wake_preload.ts (fake DNS/fetch for *.test.example)."""
import urllib.parse, re, hashlib, hmac, json, os, subprocess, sys, time, urllib.request, urllib.error
BASE = sys.argv[1]; PSQL = sys.argv[2:]
HITS = os.environ.get("WAKE_HITS_FILE", "/tmp/wake-hits.jsonl")
fails = 0
def check(n, c, d=""):
    global fails
    print(("PASS " if c else "FAIL ") + n + (f"  [{d}]" if d and not c else ""))
    if not c: fails += 1
def req(m, p, b=None, tok=None):
    r = urllib.request.Request(BASE + p, data=json.dumps(b).encode() if b is not None else None, method=m,
        headers={"content-type": "application/json", **({"authorization": "Bearer " + tok} if tok else {})})
    try:
        with urllib.request.urlopen(r, timeout=70) as x: return x.status, json.loads(x.read() or b"null")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or b"null")
        except Exception: return e.code, None
def sql(q): return subprocess.run(PSQL + ["-tAc", q], capture_output=True, text=True).stdout.strip()
def hits():
    try: return [json.loads(l) for l in open(HITS) if l.strip()]
    except FileNotFoundError: return []
open(HITS, "w").close()
s, c = req("POST", "/v1/owner/claim", {"setup_key": "test-setup-key-001"}); OWN = c["owner_token"]
def pair(aid):
    s, p = req("POST", "/v1/pairings", {"agent_id": aid, "display_name": aid}, OWN)
    s, r = req("POST", "/v1/pairings/redeem", {"code": p["code"]}); return r["agent_token"]
A, B, C = pair("wk-a"), pair("wk-b"), pair("wk-c")
s, th = req("POST", "/v1/threads", {"member_ids": ["wk-a", "wk-b"], "name": "wake"}, OWN); TID = th["thread_id"]
def post(tok, frm, to, body="hi", **kw): return req("POST", "/v1/messages", {"thread_id": TID, "from": frm, "to": to, "type": "note", "body": body, **kw}, tok)

s, w = req("GET", "/v1/owner/agents/wk-b/wake", tok=OWN); check("default wake is none", s == 200 and w["method"] == "none" and not w["has_secret"])
for bad in ["http://hooks.test.example/x", "https://127.0.0.1/x", "https://localhost/x", "https://10.1.2.3/x", "https://[::1]/x", "https://[::ffff:7f00:1]/x", "https://[::ffff:127.0.0.1]/x", "https://[64:ff9b::7f00:1]/x", "https://8.8.8.8/x", "https://2130706433/x",
            "https://hooks.test.example:8443/x", "https://u:p@hooks.test.example/x", "https://169.254.169.254/latest", "nope", "https://intranet/x"]:
    s, _ = req("PUT", "/v1/owner/agents/wk-b/wake", {"method": "webhook", "url": bad}, OWN); check("reject url " + bad, s == 422, s)
s, _ = req("PUT", "/v1/agents/me/wake", {"method": "webhook", "url": "https://hooks.test.example/x"}, B); check("agent cannot set a webhook URL (403)", s == 403, s)
s, _ = req("PUT", "/v1/owner/agents/wk-b/wake", {"method": "bogus"}, OWN); check("reject unknown method", s == 422)
s, _ = req("PUT", "/v1/owner/agents/wk-b/wake", {"method": "email", "address": "x@example.com"}, OWN); check("email wake disabled by default (409)", s == 409, s)
s, _ = req("PUT", "/v1/agents/me/wake", {"method": "email", "address": "x@example.com"}, B); check("agent cannot set email (403)", s == 403, s)
s, _ = req("GET", "/v1/owner/agents/wk-b/wake", tok=B); check("agent token cannot use owner route (403)", s == 403)

s, w = req("PUT", "/v1/owner/agents/wk-b/wake", {"method": "webhook", "url": "https://hooks.test.example/wake"}, OWN)
SECRET = w.get("signing_secret"); check("webhook set, secret returned once", s == 200 and SECRET and SECRET.startswith("whsec_"))
s, w = req("GET", "/v1/owner/agents/wk-b/wake", tok=OWN); check("secret never returned again", s == 200 and "signing_secret" not in w and w["has_secret"])
s, w = req("PUT", "/v1/owner/agents/wk-b/wake", {"method": "webhook", "url": "https://hooks.test.example/wake"}, OWN)
check("re-PUT keeps the secret", "signing_secret" not in w and w["has_secret"])

n0 = len(hits()); s, m = post(A, "wk-a", "wk-b", "SECRET-BODY-TEXT"); check("post 201", s == 201)
time.sleep(1.2); h = hits()[n0:]
check("one wake after a post", len(h) == 1, len(h))
if h:
    p = json.loads(h[0]["body"]); ts = h[0]["headers"]["x-smith-timestamp"]
    check("payload is count-only", set(p) == {"event", "agent_id", "unread", "thread_id", "urgent", "ts"} and p["unread"] == 1 and p["thread_id"] == TID and "SECRET-BODY-TEXT" not in h[0]["body"], p)
    exp = "sha256=" + hmac.new(SECRET.encode(), f"{ts}.{h[0]['body']}".encode(), hashlib.sha256).hexdigest()
    check("HMAC signature verifies", h[0]["headers"]["x-smith-signature"] == exp)
    check("redirects not followed", h[0]["redirect"] == "manual")

time.sleep(2.0); n1 = len(hits())  # clear debounce window
for i in range(5): post(A, "wk-a", "wk-b", f"burst {i}")
time.sleep(4.2); b = hits()[n1:]
check("burst coalesces (<=2 wakes for 5 posts)", 1 <= len(b) <= 2, len(b))
if len(b) == 2: check("trailing wake carries the coalesced count", json.loads(b[1]["body"])["unread"] >= 2)

# polling agent suppresses wakes (let trailing/recheck wakes from the burst drain first)
time.sleep(6.0); n2 = len(hits())
import threading
cur = None
while True:  # drain the backlog so the long-poll actually holds
    s, r = req("GET", "/v1/messages?to=wk-b&limit=50" + (f"&since={cur}" if cur else ""), tok=B)
    if not r["messages"]: break
    cur = r["next_cursor"]
def poll(): req("GET", f"/v1/messages?to=wk-b&wait=6&limit=1&since={cur}", tok=B)
t = threading.Thread(target=poll); t.start(); time.sleep(0.8)
post(A, "wk-a", "wk-b", "while polling"); time.sleep(1.0)
check("no wake while the agent is long-polling", len(hits()) == n2, [(h["body"], h["at"]-int(time.time()*1000)) for h in hits()[n2:]]); t.join()

time.sleep(2.0); n3 = len(hits())
for i in range(2):
    s, m = post(A, "wk-a", "wk-b", f"urgent {i}", urgent=True); check(f"urgent accepted #{i}", s == 201 and m.get("urgent") is True, m)
time.sleep(1.0); u = [x for x in hits()[n3:] if json.loads(x["body"])["urgent"]]; check("urgent bypasses debounce (2 urgent wakes)", len(u) == 2, len(u))
s, m = post(A, "wk-a", "wk-b", "urgent 3", urgent=True); check("3rd urgent still allowed", m.get("urgent") is True, m)
s, m = post(A, "wk-a", "wk-b", "urgent 4", urgent=True)
check("urgent rate-limited (limit 3/h) but delivered", s == 201 and m.get("urgent") is False, m)
check("limited urgent audited", sql("select count(*) from smith.smith_audit where action='urgent_wake_limited'") != "0")

s, w = req("POST", "/v1/owner/agents/wk-b/wake/test", tok=OWN); check("test wake ok", s == 200 and w.get("status") == "ok", w)
s, _ = req("POST", "/v1/owner/agents/wk-b/wake/test", tok=B); check("agent cannot trigger test (403)", s == 403)
check("test hit recorded", any(json.loads(x["body"])["event"] == "wake_test" for x in hits()))

# non-member and revoked agents are not woken; failing + private hosts
req("PUT", "/v1/owner/agents/wk-c/wake", {"method": "webhook", "url": "https://hooks.test.example/c"}, OWN)
time.sleep(2.0); n4 = len(hits()); post(A, "wk-a", "*", "broadcast"); time.sleep(1.0)
check("non-member not woken", not any("/c" == h["url"][-2:] for h in hits()[n4:]))
req("PUT", "/v1/owner/agents/wk-b/wake", {"method": "webhook", "url": "https://fail.test.example/x"}, OWN)
time.sleep(2.0); s, m = post(A, "wk-a", "wk-b", "to failing hook"); time.sleep(1.0)
check("message delivered despite failing hook", s == 201 and any(x["body"] == "to failing hook" for x in req("GET", "/v1/messages?to=wk-b&limit=50", tok=B)[1]["messages"]))
st = sql("select last_status||'|'||fail_count from smith.smith_wake_hooks where agent_id='wk-b'"); check("failure recorded", st.startswith("http_500|") and not st.endswith("|0"), st)
for host in ["private.test.example", "rebind.test.example"]:
    req("PUT", "/v1/owner/agents/wk-b/wake", {"method": "webhook", "url": f"https://{host}/x"}, OWN)
    time.sleep(2.0); nb = len(hits()); post(A, "wk-a", "wk-b", "ssrf probe"); time.sleep(1.0)
    check(f"SSRF blocked at send: {host}", len(hits()) == nb and "blocked_private_host" in sql("select last_status from smith.smith_wake_hooks where agent_id='wk-b'"))
# auto-disable after repeated failures
sql("update smith.smith_wake_hooks set fail_count=19, enabled=true, last_wake_at=null where agent_id='wk-b'")
req("PUT", "/v1/owner/agents/wk-b/wake", {"method": "webhook", "url": "https://fail.test.example/x"}, OWN)
sql("update smith.smith_wake_hooks set fail_count=19 where agent_id='wk-b'"); time.sleep(2.0); post(A, "wk-a", "wk-b", "disable me"); time.sleep(1.2)
check("hook auto-disables after repeated failures", sql("select enabled from smith.smith_wake_hooks where agent_id='wk-b'") == "f")
# schedule + wait + none via self-service
s, w = req("PUT", "/v1/agents/me/wake", {"method": "schedule", "interval_minutes": 5}, B); check("agent self-sets schedule", s == 200 and w["config"] == {"interval_minutes": 5})
s, _ = req("PUT", "/v1/agents/me/wake", {"method": "schedule", "interval_minutes": 0}, B); check("schedule validated", s == 422)
s, w = req("PUT", "/v1/agents/me/wake", {"method": "wait"}, B); check("agent self-sets wait", s == 200 and w["method"] == "wait")
# revoked agents are not woken
req("PUT", "/v1/owner/agents/wk-b/wake", {"method": "webhook", "url": "https://hooks.test.example/rev"}, OWN)
req("POST", "/v1/owner/agents/wk-b/revoke", {}, OWN); time.sleep(2.0); nr = len(hits()); post(A, "wk-a", "wk-b", "to revoked"); time.sleep(1.0)
check("revoked agent not woken", len(hits()) == nr)
sql("insert into smith.smith_agents (agent_id, display_name, platform, token_hash, legacy_unverified) values ('legacy-x','legacy-x','unknown',null,true) on conflict do nothing")
s_, r_ = req("POST", f"/v1/threads/{TID}/members", {"agent_id": "legacy-x"}, OWN); check("add-member refuses unregistered legacy ids (422)", s_ == 422 and "legacy" in json.dumps(r_), (s_, r_))
aud = sql("select string_agg(action||detail::text, ' ') from smith.smith_audit")
check("audit has set_wake/wake_sent/wake_failed/urgent_wake", all(k in aud for k in ["set_wake", "wake_sent", "wake_failed", "urgent_wake"]))
check("no secrets/urls with paths in audit", "whsec_" not in aud and "/wake" not in aud.replace("set_wake", ""))
req("PUT", "/v1/owner/agents/wk-c/wake", {"method": "webhook", "url": "https://hooks.test.example/s"}, OWN)
req("PUT", "/v1/owner/agents/wk-c/wake", {"method": "wait"}, OWN)
_sec = sql("select coalesce(signing_secret,'NULL') from smith.smith_wake_hooks where agent_id='wk-c'")
check("secret cleared when switching away from webhook", "NULL" in str(_sec), _sec)
def _unread(tid):
    s2, l = req("GET", "/v1/owner/threads", tok=OWN)
    return [x for x in (l.get("threads") if isinstance(l, dict) else l) if x["thread_id"] == tid][0]["unread"]
_s, _th = req("POST", "/v1/threads", {"name": "unread-t", "member_ids": ["wk-a", "wk-c"]}, OWN); _tid = _th["thread_id"]
_p = lambda tok, frm, body: req("POST", "/v1/messages", {"thread_id": _tid, "from": frm, "to": "*", "type": "note", "body": body}, tok)
_p(A, "wk-a", "one"); _p(C, "wk-c", "two"); _p(OWN, "owner", "mine")
check("unread counts only others' messages (2)", _unread(_tid) == 2, _unread(_tid))
s_, r_ = req("PUT", f"/v1/owner/threads/{_tid}/read", {}, OWN); check("owner marks thread read", s_ == 200, (s_, r_))
check("unread is 0 after read", _unread(_tid) == 0, _unread(_tid))
_p(OWN, "owner", "mine2"); check("owner's own message does not add unread", _unread(_tid) == 0)
import time; time.sleep(0.05); _p(A, "wk-a", "three"); check("new message from others adds unread (1)", _unread(_tid) == 1, _unread(_tid))
s_, _ = req("PUT", f"/v1/owner/threads/{_tid}/read", {}, A); check("agent cannot set owner read marker (403)", s_ == 403, s_)
s_, _ = req("PUT", "/v1/owner/threads/nope/read", {}, OWN); check("read marker on unknown thread 404", s_ == 404, s_)

# ---- Web Push ----
import base64, time as _t
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
def _b(x): return base64.urlsafe_b64encode(x).rstrip(b"=").decode()
def _ub(x): return base64.urlsafe_b64decode(x + "=" * (-len(x) % 4))
s_, r_ = req("GET", "/v1/owner/push", tok=OWN); check("push not enabled by default", s_ == 200 and r_["enabled"] is False and r_["public_key"] is None, r_)
s_, _ = req("GET", "/v1/owner/push", tok=A); check("agent cannot read push settings (403)", s_ == 403, s_)
s_, _ = req("PUT", "/v1/owner/push/subscription", {"endpoint": "https://push.test.example/a", "keys": {}}, OWN); check("subscribe before setup is 409", s_ == 409, s_)
s_, r_ = req("POST", "/v1/owner/push/setup", {}, OWN); PUB = r_.get("public_key"); check("setup returns public VAPID key (65 bytes)", s_ == 200 and len(_ub(PUB)) == 65, r_)
s_, r2 = req("POST", "/v1/owner/push/setup", {}, OWN); check("setup is idempotent (same key)", r2.get("public_key") == PUB)
check("private key never returned", "private" not in json.dumps(r_) and "private" not in json.dumps(req("GET", "/v1/owner/push", tok=OWN)[1]))
dev = ec.generate_private_key(ec.SECP256R1()); devpub = dev.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
auths = os.urandom(16)
for bad in ["http://push.test.example/x", "https://127.0.0.1/x", "https://localhost/x", "https://[::ffff:7f00:1]/x", "https://169.254.169.254/x", "https://u:p@push.test.example/x", "https://push.not-allowed.example.org/x"]:
    s_, _ = req("PUT", "/v1/owner/push/subscription", {"endpoint": bad, "keys": {"p256dh": _b(devpub), "auth": _b(auths)}}, OWN); check("push endpoint rejected: " + bad, s_ == 422, s_)
s_, _ = req("PUT", "/v1/owner/push/subscription", {"endpoint": "https://push.test.example/a", "keys": {"p256dh": "AAAA", "auth": "BBBB"}}, OWN); check("bad keys rejected", s_ == 422, s_)
s_, _ = req("PUT", "/v1/agents/me/push", {}, A)
s_, sub = req("PUT", "/v1/owner/push/subscription", {"endpoint": "https://push.test.example/dev1", "label": "Test phone", "keys": {"p256dh": _b(devpub), "auth": _b(auths)}}, OWN); check("subscribe ok", s_ == 200 and sub["id"].startswith("ps_") and sub["host"] == "push.test.example", sub)
_ptid = req("POST", "/v1/threads", {"name": "Push thread", "member_ids": ["wk-a"]}, OWN)[1]["thread_id"]
open(HITS, "w").close()
req("POST", "/v1/messages", {"thread_id": _ptid, "from": "wk-a", "to": "*", "type": "note", "body": "SECRETBODY one"}, A)
_t.sleep(0.6)
ph = [h for h in hits() if "push.test.example/dev1" in h["url"]]
check("push sent on agent message", len(ph) == 1, len(ph))
def decrypt(h):
    body = _ub(h["body"][4:].replace("+", "-").replace("/", "_"))
    salt, rs, idl = body[:16], body[16:20], body[20]; asp = body[21:21 + idl]; ct = body[21 + idl:]
    shared = dev.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), asp))
    ikm = HKDF(hashes.SHA256(), 32, auths, b"WebPush: info\0" + devpub + asp).derive(shared)
    cek = HKDF(hashes.SHA256(), 16, salt, b"Content-Encoding: aes128gcm\0").derive(ikm)
    nonce = HKDF(hashes.SHA256(), 12, salt, b"Content-Encoding: nonce\0").derive(ikm)
    pt = AESGCM(cek).decrypt(nonce, ct, None)
    assert pt[-1] == 2
    return json.loads(pt[:-1])
if ph:
    pl = decrypt(ph[0]); check("payload decrypts (RFC 8291) with title and count", pl["title"] == "Push thread" and pl["count"] == 1 and pl["thread_id"] == _ptid and pl["total"] >= 1, pl)
    check("payload has no message body by default", "body" not in pl and "SECRETBODY" not in json.dumps(pl))
    hd = ph[0]["headers"]; check("content-encoding aes128gcm + TTL", hd.get("content-encoding") == "aes128gcm" and hd.get("ttl") == "3600", hd)
    m_ = re.match(r"vapid t=([^,]+), k=(\S+)", hd.get("authorization", "")); check("VAPID header present with the instance key", bool(m_) and m_.group(2) == PUB, hd.get("authorization", "")[:40])
    if m_:
        hdr, clm, sg = m_.group(1).split("."); sgb = _ub(sg)
        pk = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), _ub(PUB))
        try: pk.verify(encode_dss_signature(int.from_bytes(sgb[:32], "big"), int.from_bytes(sgb[32:], "big")), (hdr + "." + clm).encode(), ec.ECDSA(hashes.SHA256())); ok = True
        except Exception as e: ok = False
        cl = json.loads(_ub(clm)); check("VAPID JWT verifies (ES256), aud + sub + exp", ok and cl["aud"] == "https://push.test.example" and cl["sub"].startswith("mailto:") and cl["exp"] > _t.time(), cl)
req("POST", "/v1/messages", {"thread_id": _ptid, "from": "wk-a", "to": "*", "type": "note", "body": "two"}, A)
_t.sleep(0.5)
check("second message inside debounce is not sent immediately", len([h for h in hits() if "push.test.example/dev1" in h["url"]]) == 1)
_t.sleep(float(os.environ.get("SMITH_PUSH_DEBOUNCE_MS", "1500")) / 1000 + 2)
ph = [h for h in hits() if "push.test.example/dev1" in h["url"]]
check("trailing push coalesces the burst", len(ph) == 2 and decrypt(ph[1])["count"] == 2, len(ph))
req("PUT", "/v1/owner/push/settings", {"include_body": True}, OWN)
_t.sleep(float(os.environ.get("SMITH_PUSH_DEBOUNCE_MS", "1500")) / 1000 + 1)
req("POST", "/v1/messages", {"thread_id": _ptid, "from": "wk-a", "to": "*", "type": "note", "body": "visible body"}, A); _t.sleep(1.5)
ph = [h for h in hits() if "push.test.example/dev1" in h["url"]]
check("body included only after owner opt-in", len(ph) >= 3 and decrypt(ph[-1]).get("body") == "visible body", len(ph))
req("PUT", "/v1/owner/push/settings", {"include_body": False}, OWN)
# --- @mentions ---
_t.sleep(float(os.environ.get("SMITH_PUSH_DEBOUNCE_MS", "1500")) / 1000 + 1)
req("POST", "/v1/messages", {"thread_id": _ptid, "from": "wk-a", "to": "*", "type": "note", "body": "hey owner", "metadata": {"mentions": ["owner", "ghost-agent"]}}, A); _t.sleep(1.5)
ph = [h for h in hits() if "push.test.example/dev1" in h["url"]]
check("owner push flags a mention", len(ph) >= 1 and decrypt(ph[-1]).get("mention") is True and "hey owner" not in json.dumps(decrypt(ph[-1])), decrypt(ph[-1]) if ph else None)
_nn = len([h for h in hits() if "push.test.example/dev1" in h["url"]])
s, cnp = req("POST", "/v1/owner/agents/wk-a/canary", {}, OWN)
req("POST", "/v1/messages", {"thread_id": cnp["thread_id"], "from": "wk-a", "to": "owner", "type": "note", "body": "pong"}, A); _t.sleep(float(os.environ.get("SMITH_PUSH_DEBOUNCE_MS", "1500")) / 1000 + 1.5)
check("canary and its reply send no owner push", len([h for h in hits() if "push.test.example/dev1" in h["url"]]) == _nn, len([h for h in hits() if "push.test.example/dev1" in h["url"]]) - _nn)
_t.sleep(float(os.environ.get("SMITH_PUSH_DEBOUNCE_MS", "1500")) / 1000 + 1)
_np = len([h for h in hits() if "push.test.example/dev1" in h["url"]])
req("PUT", "/v1/owner/threads/" + _ptid + "/prefs", {"muted": "1h"}, OWN)
req("POST", "/v1/messages", {"thread_id": _ptid, "from": "wk-a", "to": "*", "type": "note", "body": "muted one"}, A)
req("POST", "/v1/messages", {"thread_id": _ptid, "from": "wk-a", "to": "*", "type": "note", "body": "muted two"}, A)
_t.sleep(float(os.environ.get("SMITH_PUSH_DEBOUNCE_MS", "1500")) / 1000 + 1.5)
check("muted thread sends no push (including the trailing one)", len([h for h in hits() if "push.test.example/dev1" in h["url"]]) == _np, len([h for h in hits() if "push.test.example/dev1" in h["url"]]) - _np)
req("PUT", "/v1/owner/threads/" + _ptid + "/prefs", {"muted": False}, OWN)
_t.sleep(float(os.environ.get("SMITH_PUSH_DEBOUNCE_MS", "1500")) / 1000 + 1)
req("POST", "/v1/messages", {"thread_id": _ptid, "from": "wk-a", "to": "*", "type": "note", "body": "unmuted"}, A); _t.sleep(1.2)
check("push resumes after unmute", len([h for h in hits() if "push.test.example/dev1" in h["url"]]) > _np, None)
s_, _ = req("PUT", "/v1/owner/push/settings", {"contact": "javascript:alert(1)"}, OWN); check("bad contact rejected", s_ == 422, s_)
req("POST", "/v1/owner/threads/%s/read" % _ptid, {}, OWN)
s_, r_ = req("POST", "/v1/owner/push/test", {}, OWN); check("push test ok", s_ == 200 and r_["results"][0]["status"] == "ok", r_)
s_, g = req("PUT", "/v1/owner/push/subscription", {"endpoint": "https://gone.test.example/x", "keys": {"p256dh": _b(devpub), "auth": _b(auths)}}, OWN)
req("POST", "/v1/owner/push/test", {}, OWN)
s_, r_ = req("GET", "/v1/owner/push", tok=OWN); check("410 endpoint auto-removed", all(d["host"] != "gone.test.example" for d in r_["devices"]), r_["devices"])
s_, r_ = req("DELETE", "/v1/owner/push/subscription/" + sub["id"], None, OWN); check("revoke device", s_ == 200, (s_, r_))
s_, r_ = req("GET", "/v1/owner/push", tok=OWN); check("device list empty after revoke", r_["devices"] == [], r_)
_ = sql("select count(*) from smith.smith_audit where action like 'push%' and (detail::text like '%private%' or detail::text like '%p256dh%' or detail::text like '%auth%')"); check("audit holds no keys", _ == "0", _)
# --- @mentions: validation, targeted wake, poll visibility ---
MA, MB, MC = pair("mn-a"), pair("mn-b"), pair("mn-c")
s, th2 = req("POST", "/v1/threads", {"member_ids": ["mn-a", "mn-b", "mn-c"], "name": "mentions"}, OWN); T2 = th2["thread_id"]
s, w = req("PUT", "/v1/owner/agents/mn-c/wake", {"method": "webhook", "url": "https://hooks.test.example/wakec"}, OWN)
def post2(tok, frm, to, body, **kw): return req("POST", "/v1/messages", {"thread_id": T2, "from": frm, "to": to, "type": "note", "body": body, **kw}, tok)
s, _ = post2(MA, "mn-a", "mn-b", "x", metadata={"mentions": "mn-c"}); check("mentions must be an array (422)", s == 422, s)
s, _ = post2(MA, "mn-a", "mn-b", "x", metadata={"mentions": [1]}); check("mentions entries must be strings (422)", s == 422, s)
nc = len([h for h in hits() if "hooks.test.example/wakec" in h["url"]])
s, m = post2(MA, "mn-a", "mn-b", "plain to b")
_t.sleep(1.5); check("no wake for a non-mentioned member", len([h for h in hits() if "hooks.test.example/wakec" in h["url"]]) == nc)
s, m = post2(MA, "mn-a", "mn-b", "ping @mn-c", metadata={"mentions": ["mn-c", "mn-c", "ghost-agent", "owner"]})
check("mention post 201", s == 201, s)
_t.sleep(1.5); wc = [h for h in hits() if "hooks.test.example/wakec" in h["url"]]
check("mentioned member is woken", len(wc) == nc + 1, len(wc) - nc)
s, g = req("GET", "/v1/messages?thread_id=" + T2, tok=MC)
got = [x for x in g["messages"] if x["body"] == "ping @mn-c"]
check("mentioned agent sees the message addressed to someone else", len(got) == 1 and got[0]["metadata"]["mentions"] == ["mn-c", "owner"], got)
check("unmentioned message not visible to mn-c", all(x["body"] != "plain to b" for x in g["messages"]))
for _i in range(21):
    post2(MA, "mn-a", "mn-b", "m%d" % _i, metadata={"mentions": ["owner"]}); 
s, g = req("GET", "/v1/messages?thread_id=" + T2, tok=MB)
ms = [x for x in g["messages"] if x["body"].startswith("m") and x["body"][1:].isdigit()]
n_own = sum(1 for x in ms if "owner" in x["metadata"].get("mentions", []))
check("owner mentions capped per sender (20/h, 1 used earlier)", n_own == 19 and len(ms) == 21, (n_own, len(ms)))
# --- wake health: peek, ack cursor, canary, health ---
PA, PB = pair("pk-a"), pair("pk-b")
s, th3 = req("POST", "/v1/threads", {"member_ids": ["pk-a", "pk-b"], "name": "peek"}, OWN); T3 = th3["thread_id"]
s, pk = req("GET", "/v1/messages?peek=1", tok=PB); check("peek works and is empty", s == 200 and pk["unread"] == 0 and pk["newest_id"] is None, pk)
s, m1 = req("POST", "/v1/messages", {"thread_id": T3, "from": "pk-a", "to": "pk-b", "type": "note", "body": "one"}, PA)
s, m2 = req("POST", "/v1/messages", {"thread_id": T3, "from": "pk-a", "to": "pk-b", "type": "note", "body": "two"}, PA)
s, pk = req("GET", "/v1/messages?peek=1", tok=PB); check("peek counts unread, no bodies", pk["unread"] == 2 and pk["newest_id"] == m2["id"] and "body" not in json.dumps(pk), pk)
s, _ = req("GET", "/v1/messages?peek=1", tok=OWN); check("owner cannot use the agent peek (403)", s == 403, s)
s, a = req("POST", "/v1/agents/me/ack", {"through_id": m1["id"]}, PB); check("ack first message", s == 200, (s, a))
s, pk = req("GET", "/v1/messages?peek=1", tok=PB); check("cursor leaves one unread", pk["unread"] == 1 and pk["cursor"]["acked_id"] == m1["id"], pk)
s, a = req("POST", "/v1/agents/me/ack", {"through_id": m2["id"]}, PB); s, pk = req("GET", "/v1/messages?peek=1", tok=PB); check("ack second clears unread", pk["unread"] == 0, pk)
req("POST", "/v1/agents/me/ack", {"through_id": m1["id"]}, PB); s, pk = req("GET", "/v1/messages?peek=1", tok=PB); check("cursor never moves backwards", pk["cursor"]["acked_id"] == m2["id"], pk)
s, _ = req("POST", "/v1/agents/me/ack", {"through_id": "msg_nope"}, PB); check("ack unknown id 404", s == 404, s)
s, _ = req("POST", "/v1/agents/me/ack", {"through_id": m1["id"]}, C); check("non-member cannot ack (404)", s == 404, s)
s, cn = req("POST", "/v1/owner/agents/pk-b/canary", {}, OWN); check("owner canary created", s == 201 and cn["canary_id"], (s, cn))
s, g = req("GET", "/v1/messages?thread_id=" + cn["thread_id"], tok=PB)
check("agent receives the canary", any((x.get("metadata") or {}).get("canary") == cn["canary_id"] for x in g["messages"]), g)
time.sleep(0.3); s, r = req("GET", "/v1/owner/agents/pk-b/canary/" + cn["canary_id"], tok=OWN)
check("canary pickup latency recorded", s == 200 and r["pickup_ms"] is not None and r["pickup_ms"] < 5000, r)
s, _ = req("POST", "/v1/owner/agents/pk-b/canary", {}, PB); check("agent cannot make an owner canary (403)", s == 403, s)
s, sc = req("POST", "/v1/agents/me/selftest", {}, PA); check("agent selftest canary", s == 201, (s, sc))
s, h = req("GET", "/v1/owner/wake-health", tok=OWN); hb = {x["agent_id"]: x for x in h["agents"]}
check("health lists registered agents with states", s == 200 and "pk-b" in hb and hb["pk-b"]["state"] in ("ok", "slow", "stale", "never") and hb["pk-b"]["last_canary"]["pickup_ms"] is not None, hb.get("pk-b"))
check("health shows peek-based liveness", hb["pk-b"]["last_peek_at"] is not None and hb["pk-b"]["alive_ago_s"] is not None, hb["pk-b"])
s, _ = req("GET", "/v1/owner/wake-health", tok=PB); check("agent cannot read health (403)", s == 403, s)
s, tl = req("GET", "/v1/threads", tok=OWN); tl = tl.get("threads", tl) if isinstance(tl, dict) else tl
check("canary threads hidden from the owner list", all(not x["thread_id"].startswith("th_wakecheck_") for x in tl), [x["thread_id"] for x in tl][:5])
for _i in range(13): s, _r = req("POST", "/v1/agents/me/selftest", {}, PB)
check("selftest has its own limit (429)", s == 429, s)
s, _r = req("POST", "/v1/owner/agents/pk-b/canary", {}, OWN); check("owner canary unaffected by selftest limit", s == 201, s)
s, cn3 = req("POST", "/v1/owner/agents/pk-a/canary", {}, OWN)
s, ms3 = req("GET", "/v1/messages?peek=1", tok=PA)
s, g3 = req("GET", "/v1/messages?thread_id=" + T3, tok=PA)
s, a3 = req("POST", "/v1/agents/me/ack", {"through_id": m2["id"]}, PA)
check("acking an old message does not mark an unpicked canary", sql("select acked_at is null from smith.smith_canaries where id = '%s'" % cn3["canary_id"]) == "t", sql("select acked_at from smith.smith_canaries where id = '%s'" % cn3["canary_id"]))
s, _p = req("GET", "/v1/messages?peek=1", tok=OWN); check("owner peek is refused (403)", s == 403, s)
s, h = req("GET", "/v1/owner/wake-health", tok=OWN); hb = {x["agent_id"]: x for x in h["agents"]}
check("webhook-only agent shows ok, not Not seen", hb["mn-c"]["state"] in ("ok", "slow") and hb["mn-c"]["wake_method"] == "webhook", hb["mn-c"])
# --- live stream, presence, seen ---
import http.client, threading as _th2, urllib.parse as _up
SU = _up.urlparse(sys.argv[1])
def read_stream(path, tok, secs, out):
    c = http.client.HTTPConnection(SU.hostname, SU.port, timeout=secs + 3)
    c.request("GET", path, headers={"Authorization": "Bearer " + tok})
    r = c.getresponse(); out["status"] = r.status; out["ctype"] = r.getheader("content-type"); out["events"] = []
    t0 = time.time(); ev = None
    while time.time() - t0 < secs:
        line = r.readline().decode()
        if not line: break
        line = line.strip()
        if line.startswith("event:"): ev = line[6:].strip()
        elif line.startswith("data:") and ev: out["events"].append((time.time() - t0, ev, json.loads(line[5:]))); ev = None
    c.close()
s, th4 = req("POST", "/v1/threads", {"member_ids": ["pk-a", "pk-b"], "name": "stream"}, OWN); T4 = th4["thread_id"]
s, _r = req("GET", "/v1/owner/stream?thread_id=" + T4, tok=PA); check("stream is owner-only (403)", s == 403, s)
out = {}; th_ = _th2.Thread(target=read_stream, args=("/v1/owner/stream?thread_id=" + T4, OWN, 5, out)); th_.start()
time.sleep(1.5)
req("POST", "/v1/messages", {"thread_id": T4, "from": "pk-a", "to": "*", "type": "note", "body": "live one"}, PA)
time.sleep(0.3)
s, mo = req("POST", "/v1/messages", {"thread_id": T4, "from": "owner", "to": "*", "type": "note", "body": "from owner"}, OWN)
time.sleep(0.5); req("GET", "/v1/messages?thread_id=" + T4, tok=PB)   # pk-b polls: auto-seen
th_.join()
evs = out.get("events", [])
check("stream is event-stream", out.get("status") == 200 and "text/event-stream" in (out.get("ctype") or ""), out.get("ctype"))
live = [e for e in evs if e[1] == "messages" and any(m["body"] == "live one" for m in e[2]["messages"])]
check("new message pushed within one 2 s tick", live and live[0][0] - 1.5 < 2.6, [e[0] for e in live])
sts = [e for e in evs if e[1] == "state"]
check("state event carries presence for members", sts and {p["agent_id"] for p in sts[-1][2]["presence"]} == {"pk-a", "pk-b"}, sts[-1][2]["presence"] if sts else None)
check("presence marks a just-polled agent online", sts and any(p["agent_id"] == "pk-b" and p["online"] for p in sts[-1][2]["presence"]), sts[-1][2]["presence"] if sts else None)
check("seen mark appears for an owner message", sts and any(any(x["agent"] == "pk-b" for x in v["seen_by"]) for v in sts[-1][2]["marks"].values()), sts[-1][2]["marks"] if sts else None)
s, fd = req("GET", "/v1/owner/feed?thread_id=" + T4, tok=OWN); om = [m for m in fd["messages"] if m["body"] == "from owner"][0]
check("feed shows seen_by on owner messages", [x["agent"] for x in om["seen_by"]] == ["pk-b"], om.get("seen_by"))
s, _r = req("GET", "/v1/messages?peek=1", tok=PA)
# --- smith-listen.sh ---
import subprocess, tempfile, os as _os
_d = tempfile.mkdtemp(); _out = _d + "/got.json"
open(_d + "/cmd.sh", "w").write("#!/bin/bash\ncat > " + _out + "\n"); _os.chmod(_d + "/cmd.sh", 0o755)
s, th5 = req("POST", "/v1/threads", {"member_ids": ["pk-a", "pk-b"], "name": "listen"}, OWN); T5 = th5["thread_id"]
lp = subprocess.Popen(["bash", _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "scripts", "smith-listen.sh"), _d + "/cmd.sh"],
    env={**_os.environ, "SMITH_URL": sys.argv[1], "SMITH_TOKEN": PB, "SMITH_WAIT": "3"}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5); t0 = time.time()
req("POST", "/v1/messages", {"thread_id": T5, "from": "pk-a", "to": "*", "type": "note", "body": "listen-ping"}, PA)
while time.time() - t0 < 6 and "listen-ping" not in (open(_out).read() if _os.path.exists(_out) else ""): time.sleep(0.1)
lat = time.time() - t0
got = open(_out).read() if _os.path.exists(_out) else ""
check("smith-listen runs the command on a new message", "listen-ping" in got, got[:80])
check("smith-listen latency under 3 s", lat < 3, lat)
time.sleep(1.0)
s, pk = req("GET", "/v1/messages?peek=1", tok=PB)
check("smith-listen acks after the command ran", pk.get("unread") == 0, pk)
lp.kill()
s, fa = req("GET", "/v1/threads/" + T4 + "/feed", tok=PB)
check("agent feed carries no presence or seen_by", "presence" not in fa and all("seen_by" not in m for m in fa["messages"]), list(fa))
s, ga = req("GET", "/v1/messages?thread_id=" + T4 + "&since=", tok=PB)
check("agent poll carries no seen_by", all("seen_by" not in m for m in ga.get("messages", [])), None)
# --- Koda queue: peek detail, unacked re-serve, health declared/p95 ---
s, th6 = req("POST", "/v1/threads", {"member_ids": ["pk-a", "pk-b"], "name": "koda-q"}, OWN); T6 = th6["thread_id"]
s, m1 = req("POST", "/v1/messages", {"thread_id": T6, "from": "pk-a", "to": "pk-b", "type": "note", "body": "q1"}, PA)
s, m2 = req("POST", "/v1/messages", {"thread_id": T6, "from": "pk-a", "to": "pk-b", "type": "note", "body": "q2"}, PA)
s, pk = req("GET", "/v1/messages?peek=1", tok=PB)
check("peek has per-thread unread and oldest_unread_at", any(t["thread_id"] == T6 and t["unread"] >= 2 and t.get("oldest_unread_at") for t in pk.get("threads", [])) and pk.get("oldest_unread_at"), pk)
req("POST", "/v1/agents/me/ack", {"through_id": m1.get("id") or m1.get("message_id")}, PB)
s, un = req("GET", "/v1/messages?unacked=1&thread_id=" + T6, tok=PB)
check("unacked=1 re-serves after the ack cursor", [m["body"] for m in un["messages"]] == ["q2"], [m["body"] for m in un.get("messages", [])])
s, un2 = req("GET", "/v1/messages?unacked=1&thread_id=" + T6, tok=PB)
check("unacked=1 re-serves again until acked", [m["body"] for m in un2["messages"]] == ["q2"], None)
s, hh = req("GET", "/v1/owner/wake-health", tok=OWN)
check("health rows carry declared_interval_s, stale_vs_declared, canary_p95_ms", all(k in hh["agents"][0] for k in ("declared_interval_s", "stale_vs_declared", "canary_p95_ms")), list(hh["agents"][0]))
s, a6 = req("POST", "/v1/agents/me/ack", {"through_id": m2.get("id") or m2.get("message_id")}, PB)
s, un3 = req("GET", "/v1/messages?unacked=1&thread_id=" + T6, tok=PB)
check("unacked=1 after full ack returns nothing and no fallback flag", un3["messages"] == [] and "cursor_fallback" not in un3, un3)
# --- creator member-add ---
s, th7 = req("POST", "/v1/threads", {"name": "creator-add", "member_ids": ["pk-b"]}, PA); T7 = th7["thread_id"]
s, r = req("POST", "/v1/threads/" + T7 + "/members", {"agent_id": "mn-a"}, PB); check("plain member cannot add members (403)", s == 403, (s, r))
s, r = req("POST", "/v1/threads/" + T7 + "/members", {"agent_id": "mn-a"}, PA); check("thread creator can add a registered agent", s == 200, (s, r))
s, r = req("POST", "/v1/threads/" + T7 + "/members", {"agent_id": "nobody-zz"}, PA); check("creator cannot add unknown agent (422)", s == 422, (s, r))
s, r = req("GET", "/v1/threads/" + T7 + "/feed", tok=MA); check("added member can read the thread", s == 200, s)
s, r = req("POST", "/v1/threads/" + T7 + "/members", {"agent_id": "mn-b"}, OWN); check("owner can still add members", s == 200, (s, r))
# --- implicit working dots ---
s, th8 = req("POST", "/v1/threads", {"name": "dots", "member_ids": ["pk-b"]}, OWN); T8 = th8["thread_id"]
req("POST", "/v1/messages", {"thread_id": T8, "from": "owner", "to": "pk-b", "type": "note", "body": "please look"}, OWN)
s, fd = req("GET", "/v1/owner/feed?thread_id=" + T8, tok=OWN); check("no dots before the agent has seen it", fd["working"] == [], fd["working"])
req("GET", "/v1/messages?peek=1", tok=PB)
s, fd = req("GET", "/v1/owner/feed?thread_id=" + T8, tok=OWN); check("peek of an addressed owner message shows working dots", [w["agent_id"] for w in fd["working"]] == ["pk-b"], fd["working"])
req("POST", "/v1/messages", {"thread_id": T8, "from": "pk-b", "to": "owner", "type": "note", "body": "on it"}, PB)
time.sleep(0.4)
s, fd = req("GET", "/v1/owner/feed?thread_id=" + T8, tok=OWN); check("posting clears the dots", fd["working"] == [], fd["working"])
s, r = req("POST", "/v1/agents/me/working", {"thread_id": T8, "ttl_seconds": 90}, PB); check("explicit working endpoint ok", s == 200, (s, r))
s, fd = req("GET", "/v1/owner/feed?thread_id=" + T8, tok=OWN); check("explicit working shows dots", len(fd["working"]) == 1, fd["working"])
# --- owner live + adaptive hint ---
s, th9 = req("POST", "/v1/threads", {"name": "live", "member_ids": ["pk-b"]}, OWN); T9 = th9["thread_id"]
req("GET", "/v1/messages?thread_id=" + T9 + "&limit=1", tok=PB)
s, pk = req("GET", "/v1/messages?peek=1", tok=PB)
check("idle peek: no owner_live and no hot hint", not any(x["thread_id"] == T9 for x in pk["owner_live"]), pk.get("owner_live"))
req("GET", "/v1/owner/feed?thread_id=" + T9, tok=OWN)
time.sleep(0.3)
s, pk = req("GET", "/v1/messages?peek=1", tok=PB)
check("owner viewing the thread shows owner_live and hint <= 10", any(x["thread_id"] == T9 and not x["typing"] for x in pk["owner_live"]) and pk["next_wake_hint_s"] is not None and pk["next_wake_hint_s"] <= 10, pk)
s, r = req("POST", "/v1/owner/typing", {"thread_id": T9}, OWN); check("owner typing ping ok", s == 200, (s, r))
s, r = req("POST", "/v1/owner/typing", {"thread_id": T9}, PB); check("agent cannot send owner typing (403)", s == 403, s)
s, pk = req("GET", "/v1/messages?peek=1", tok=PB)
check("typing shows typing=true and hint 5", any(x["thread_id"] == T9 and x["typing"] for x in pk["owner_live"]) and pk["next_wake_hint_s"] == 5, pk)
# --- I2 P2s ---
s, thx = req("POST", "/v1/threads", {"name": "p2", "member_ids": ["pk-b"]}, OWN); TX = thx["thread_id"]
s, r = req("POST", "/v1/agents/me/working", {"thread_id": TX}, MA); check("working on a thread you are not in -> 403", s == 403, (s, r))
req("POST", "/v1/messages", {"thread_id": TX, "from": "owner", "to": "pk-b", "type": "note", "body": "p2 one"}, OWN)
req("GET", "/v1/messages?peek=1", tok=PB)
req("POST", "/v1/activity", {"thread_id": TX, "state": "idle"}, PB)
req("GET", "/v1/messages?peek=1", tok=PB); req("GET", "/v1/messages?peek=1", tok=PB)
s, fd = req("GET", "/v1/owner/feed?thread_id=" + TX, tok=OWN); check("dots arm once per message, later peeks do not re-arm", fd["working"] == [], fd["working"])
req("POST", "/v1/messages", {"thread_id": TX, "from": "owner", "to": "pk-b", "type": "note", "body": "p2 two"}, OWN)
req("GET", "/v1/messages?peek=1", tok=PB)
s, fd = req("GET", "/v1/owner/feed?thread_id=" + TX, tok=OWN); check("a new message arms the dots again", len(fd["working"]) == 1, fd["working"])
s, r = req("POST", "/v1/owner/typing", {"thread_id": "no-such-thread"}, OWN); check("owner typing on an unmanaged thread -> 404", s == 404, s)
s, r = req("POST", "/v1/threads/" + T7 + "/members", {"agent_id": "stub-unreg"}, OWN)
s, r2 = req("POST", "/v1/threads/" + T7 + "/members", {"agent_id": "stub-unreg"}, PA); check("creator cannot add an unregistered stub id", s == 422, (s, r2))
# --- archive + mute ---
s, thA = req("POST", "/v1/threads", {"name": "arch", "member_ids": ["pk-b"]}, OWN); TA = thA["thread_id"]
def row(tid):
    s, l = req("GET", "/v1/owner/threads", tok=OWN); return [t for t in l["threads"] if t["thread_id"] == tid][0]
check("thread starts not archived, not muted", row(TA)["archived"] is False and row(TA)["muted"] is False, row(TA))
s, r = req("PUT", "/v1/owner/threads/" + TA + "/prefs", {"archived": True}, OWN); check("archive ok", s == 200, (s, r))
check("thread list shows archived", row(TA)["archived"] is True, None)
s, r = req("PUT", "/v1/owner/threads/" + TA + "/prefs", {"muted": "1h"}, OWN)
check("mute 1h sets muted_until, archive kept", s == 200 and row(TA)["muted"] is True and row(TA)["archived"] is True, row(TA))
s, r = req("PUT", "/v1/owner/threads/" + TA + "/prefs", {"muted": "bogus"}, OWN); check("bad mute value -> 422", s == 422, s)
s, r = req("PUT", "/v1/owner/threads/" + TA + "/prefs", {"archived": False}, PB); check("agent cannot set prefs (403)", s == 403, s)
s, r = req("PUT", "/v1/owner/threads/" + TA + "/prefs", {"archived": True}, OWN)
req("POST", "/v1/messages", {"thread_id": TA, "from": "pk-b", "to": "owner", "type": "note", "body": "ping"}, PB); time.sleep(0.4)
check("a new agent message unarchives", row(TA)["archived"] is False and row(TA)["muted"] is True, row(TA))
s, r = req("PUT", "/v1/owner/threads/" + TA + "/prefs", {"muted": False}, OWN); check("unmute", row(TA)["muted"] is False, None)
s, r = req("GET", "/v1/threads", tok=PB); check("agents never see prefs fields", all("archived" not in x for x in r), None)
# --- reactions ---
s, mm = req("POST", "/v1/messages", {"thread_id": TA, "from": "pk-b", "to": "owner", "type": "note", "body": "react to me"}, PB); MID = mm["id"]
RP = "/v1/messages/" + MID + "/reactions"
s, r = req("PUT", RP, {"emoji": "\U0001F44D"}, OWN); check("owner adds a reaction", s == 200 and r["reactions"][0]["count"] == 1, (s, r))
s, r = req("PUT", RP, {"emoji": "\U0001F44D"}, PB); check("agent adds the same emoji: count 2, actors listed", s == 200 and r["reactions"][0]["count"] == 2 and set(r["reactions"][0]["actors"]) == {"owner", "pk-b"}, r)
s, r = req("PUT", RP, {"emoji": "\U0001F44D"}, OWN); check("duplicate reaction is idempotent", r["reactions"][0]["count"] == 2, r)
s, r = req("PUT", RP, {"emoji": "hello"}, OWN); check("non-emoji -> 422", s == 422, s)
s, r = req("PUT", RP, {"emoji": "\U0001F44D\U0001F44D"}, OWN); check("two graphemes -> 422", s == 422, s)
s, r = req("PUT", RP, {"emoji": "\U0001F44D"}, PA); check("non-member agent cannot react (403)", s == 403, s)
s, r = req("PUT", "/v1/messages/nope/reactions", {"emoji": "\U0001F44D"}, OWN); check("unknown message -> 404", s == 404, s)
s, fd = req("GET", "/v1/owner/feed?thread_id=" + TA, tok=OWN); mine = [m for m in fd["messages"] if m["id"] == MID][0]
check("feed carries reactions", mine["reactions"][0]["emoji"] == "\U0001F44D" and mine["reactions"][0]["count"] == 2, mine.get("reactions"))
s, r = req("DELETE", RP + "/" + urllib.parse.quote("\U0001F44D"), tok=PB); check("agent removes only its own reaction", s == 200 and r["reactions"][0]["actors"] == ["owner"], r)
s, r = req("GET", RP, tok=PB); check("GET reactions", s == 200 and len(r["reactions"]) == 1, r)
s, r = req("DELETE", RP + "/" + urllib.parse.quote("\U0001F44D"), tok=OWN); check("owner removes; none left", r["reactions"] == [], r)
for i, e in enumerate("\U0001F600\U0001F601\U0001F602\U0001F603\U0001F604\U0001F605\U0001F606\U0001F607\U0001F608\U0001F609\U0001F60A\U0001F60B\U0001F60C\U0001F60D\U0001F60E\U0001F60F\U0001F610\U0001F611\U0001F612\U0001F613"):
    req("PUT", RP, {"emoji": e}, OWN)
s, r = req("PUT", RP, {"emoji": "\U0001F914"}, OWN); check("21st distinct emoji -> 422", s == 422, s)
s, r = req("PUT", RP, {"emoji": "\U0001F600"}, PB); check("existing emoji still joinable at the cap", s == 200, s)
check("reactions are audited", int(sql("select count(*) from smith.smith_audit where action in ('reaction_add','reaction_remove')") or 0) > 3, None)
sql("insert into smith.smith_audit (actor, action, detail) select 'pk-b', 'reaction_add', '{}'::jsonb from generate_series(1, 60)")
s, r = req("PUT", RP, {"emoji": "\U0001F601"}, PB); check("61st reaction write in an hour -> 429", s == 429, s)
s, r = req("PUT", RP, {"emoji": "\U0001F600"}, OWN); check("reaction rate limit is per actor (owner unaffected)", s == 200, s)
# --- activity cards ---
def act(**a): return {"thread_id": TA, "from": "pk-b", "to": "owner", "type": "activity", "body": "Calling the clinic", "metadata": {"activity": {"kind": "call", "title": "Call Dr. Lee's office", "state": "running", **a}}}
s, r = req("POST", "/v1/messages", act(), PB); check("activity post ok", s == 201, (s, r)); AID = r.get("id")
s, r = req("POST", "/v1/messages", {**act(), "metadata": {"activity": {"kind": "bogus", "title": "x", "state": "running"}}}, PB); check("bad kind -> 422", s == 422, s)
s, r = req("POST", "/v1/messages", {**act(), "metadata": {}}, PB); check("activity without metadata -> 422", s == 422, s)
s, r = req("POST", "/v1/messages", act(summary="x" * 700), PB); check("summary over 600 -> 422", s == 422, s)
s, fd = req("GET", "/v1/owner/feed?thread_id=" + TA, tok=OWN); am = [m for m in fd["messages"] if m["id"] == AID][0]
check("feed shows running activity with started_at", am["metadata"]["activity"]["state"] == "running" and "started_at" in am["metadata"]["activity"] and "finished_at" not in am["metadata"]["activity"], am["metadata"])
s, r = req("PATCH", "/v1/messages/" + AID + "/activity", {"state": "done", "summary": "Booked Tuesday 3pm. Bring the insurance card."}, PA); check("non-member cannot update (403)", s == 403, s)
s, r = req("PATCH", "/v1/messages/" + AID + "/activity", {"state": "done", "summary": "Booked Tuesday 3pm."}, OWN); check("owner cannot update an agent's activity (403)", s == 403, s)
s, r = req("PATCH", "/v1/messages/" + AID + "/activity", {"state": "done", "summary": "Booked Tuesday 3pm. Bring the insurance card."}, PB)
check("author finishes the activity, finished_at set", s == 200 and r["activity"]["state"] == "done" and "finished_at" in r["activity"] and r["activity"]["kind"] == "call", (s, r))
s, r = req("PATCH", "/v1/messages/" + AID + "/activity", {"state": "nope"}, PB); check("bad state on update -> 422", s == 422, s)
s, r = req("PATCH", "/v1/messages/" + mm["id"] + "/activity", {"state": "done"}, PB); check("update on a non-activity message -> 422", s == 422, s)
s, r = req("POST", "/v1/messages", act(foo="bar", secret="x"), PB); check("activity post ok with extra keys", s == 201, s)
s, fd = req("GET", "/v1/owner/feed?thread_id=" + TA, tok=OWN); lastact = [m for m in fd["messages"] if m["type"] == "activity"][-1]
check("unknown activity keys are dropped", "foo" not in lastact["metadata"]["activity"] and "secret" not in lastact["metadata"]["activity"], lastact["metadata"])
sql("insert into smith.smith_audit (actor, action, detail) select 'pk-b', 'activity_post', '{}'::jsonb from generate_series(1, 30)")
s, r = req("POST", "/v1/messages", act(), PB); check("pk-b over 30 activity writes/hour -> 429", s == 429, s)
# --- peek isolation and consistency ---
req("POST", "/v1/messages", {"thread_id": TA, "from": "owner", "to": "*", "type": "note", "body": "for members only"}, OWN); time.sleep(0.3)
s, pa = req("GET", "/v1/messages?peek=1", tok=PA); check("peek: non-member sees no thread it is not in", all(x["thread_id"] != TA for x in pa["threads"]), pa["threads"])
s, pb = req("GET", "/v1/messages?peek=1", tok=PB); check("peek: member sees the thread", any(x["thread_id"] == TA for x in pb["threads"]), pb["threads"])
check("peek: sum of per-thread unread matches total unread", sum(x["unread"] for x in pb["threads"]) == pb["unread"], (pb["unread"], pb["threads"]))
# --- chat photo ---
def raw(m, p, data=None, tok=None, ct="application/octet-stream"):
    r = urllib.request.Request(BASE + p, data=data, method=m, headers={"content-type": ct, **({"authorization": "Bearer " + tok} if tok else {})})
    try:
        with urllib.request.urlopen(r, timeout=70) as x: return x.status, x.read(), dict(x.headers)
    except urllib.error.HTTPError as e: return e.code, e.read(), dict(e.headers)
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 200
s, thav = req("POST", "/v1/threads", {"name": "avatar-t", "member_ids": ["pk-b"]}, PA); TAV = thav["thread_id"]
s, b, h = raw("GET", "/v1/threads/" + TAV + "/avatar", tok=PB); check("avatar: none yet -> 404", s == 404, s)
s, b, h = raw("PUT", "/v1/threads/" + TAV + "/avatar", PNG, PB); check("avatar: non-creator member cannot set -> 403", s == 403, s)
s, b, h = raw("PUT", "/v1/threads/" + TAV + "/avatar", b"GIF89a" + b"\x00" * 50, PA); check("avatar: gif rejected -> 415", s == 415, s)
s, b, h = raw("PUT", "/v1/threads/" + TAV + "/avatar", b"<svg xmlns='http://www.w3.org/2000/svg'/>", PA); check("avatar: svg rejected -> 415", s == 415, s)
s, b, h = raw("PUT", "/v1/threads/" + TAV + "/avatar", PNG + b"\x00" * 110000, PA); check("avatar: over 100KB -> 413", s == 413, s)
def rawnl(m, p, data, tok):
    import http.client, urllib.parse
    u = urllib.parse.urlparse(BASE); c = http.client.HTTPConnection(u.hostname, u.port, timeout=30)
    c.putrequest(m, p, skip_accept_encoding=True); c.putheader("authorization", "Bearer " + tok); c.putheader("transfer-encoding", "chunked"); c.endheaders()
    c.send(("%x\r\n" % len(data)).encode() + data + b"\r\n0\r\n\r\n"); r = c.getresponse(); return r.status
check("avatar: chunked PUT without content-length rejected", rawnl("PUT", "/v1/threads/" + TAV + "/avatar", PNG, PA) in (411, 413), None)
s, b, h = raw("PUT", "/v1/threads/" + TAV + "/avatar", PNG, PA); v1 = json.loads(b).get("avatar_version") if s == 200 else None; check("avatar: creator sets png", s == 200 and v1 and len(v1) == 12, (s, b))
s, b, h = raw("GET", "/v1/threads/" + TAV + "/avatar", tok=PB); check("avatar: member GET returns the bytes with image type", s == 200 and b == PNG and h.get("Content-Type", h.get("content-type")) == "image/png" and "nosniff" in str(h).lower(), (s, h))
s, b, h = raw("GET", "/v1/threads/" + TAV + "/avatar?v=" + v1, tok=PB); check("avatar: GET with ?v=<version> returns 200 (query ignored by router)", s == 200 and b == PNG, s)
s, b, h = raw("GET", "/v1/threads/" + TAV + "/avatar", tok=PA2) if False else raw("GET", "/v1/threads/" + TAV + "/avatar", tok=OWN); check("avatar: owner can read", s == 200, s)
s, ls = req("GET", "/v1/owner/threads", tok=OWN); row = [t for t in ls["threads"] if t["thread_id"] == TAV]
check("avatar: owner thread list carries avatar_version", row and row[0].get("avatar_version") == v1, row)
s, b, h = raw("PUT", "/v1/threads/" + TAV + "/avatar", b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 40, OWN); check("avatar: owner can replace with webp", s == 200 and json.loads(b)["avatar_version"] != v1, (s, b))
s, b, h = raw("DELETE", "/v1/threads/" + TAV + "/avatar", tok=PB); check("avatar: member cannot delete -> 403", s == 403, s)
s, b, h = raw("DELETE", "/v1/threads/" + TAV + "/avatar", tok=OWN); check("avatar: owner deletes", s == 200, s)
s, b, h = raw("GET", "/v1/threads/" + TAV + "/avatar", tok=PA); check("avatar: gone after delete -> 404", s == 404, s)
sql("insert into smith.smith_audit (actor, action, detail) select 'pk-a', 'thread_avatar_set', jsonb_build_object('thread_id', '" + TAV + "') from generate_series(1, 20)")
s, b, h = raw("PUT", "/v1/threads/" + TAV + "/avatar", PNG, PA); check("avatar: over 20 sets/hour per thread -> 429", s == 429, s)
s, b, h = raw("GET", "/v1/threads/" + T8 + "/avatar", tok=PA); check("avatar: non-member of another thread cannot read", s in (403, 404), s)
# --- malformed path escape and member cap ---
s, r = req("GET", "/v1/threads/%E0/avatar", tok=OWN); check("malformed %-escape in path -> 404, not 500", s == 404, s)
s, thc = req("POST", "/v1/threads", {"name": "cap-t", "member_ids": []}, PA); TCAP = thc["thread_id"]
sql("insert into smith.smith_thread_members (thread_id, agent_id) select '" + TCAP + "', 'fx' || g from generate_series(1, 20) g")
s, r = req("POST", "/v1/threads/" + TCAP + "/members", {"agent_id": "pk-b"}, PA); check("member cap: creator agent at 20 -> 422", s == 422, (s, r))
s, r = req("POST", "/v1/threads/" + TCAP + "/members", {"agent_id": "pk-b"}, OWN); check("member cap: owner is exempt (21st member -> 200)", s == 200, (s, r))
# --- reactions_unseen in peek ---
s, mx = req("POST", "/v1/messages", {"thread_id": TA, "from": "pk-b", "to": "owner", "type": "note", "body": "rx peek"}, PB); MX = mx["id"]
req("GET", "/v1/messages?peek=1", tok=PB)
s, r = req("PUT", "/v1/messages/" + MX + "/reactions", {"emoji": "\u2705"}, OWN)
req("PUT", "/v1/messages/" + MX + "/reactions", {"emoji": "\U0001F44D"}, PB)
s, pk = req("GET", "/v1/messages?peek=1", tok=PB); ru = pk.get("reactions_unseen", [])
check("peek: author sees the owner's reaction on its message", any(x["message_id"] == MX and x["emoji"] == "\u2705" and x["actor"] == "owner" for x in ru), ru)
check("peek: own reactions are not reported back", all(x["actor"] != "pk-b" for x in ru), ru)
s, pk2 = req("GET", "/v1/messages?peek=1", tok=PB); check("peek: reactions are reported once", all(x["message_id"] != MX for x in pk2.get("reactions_unseen", [])), pk2.get("reactions_unseen"))
s, pa2 = req("GET", "/v1/messages?peek=1", tok=PA); check("peek: another agent does not see them", all(x["message_id"] != MX for x in pa2.get("reactions_unseen", [])), pa2.get("reactions_unseen"))
print("ALL PASS" if not fails else f"{fails} FAILED"); sys.exit(1 if fails else 0)
