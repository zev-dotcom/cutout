#!/usr/bin/env python3
"""Wake hooks test. Usage: wake_hooks_test.py <base-url> <db-psql-cmd...>
Server must run with: SMITH_SCHEMA=agentcollab SMITH_TABLES_SCHEMA=smith SMITH_SETUP_KEY=test-setup-key-001
SMITH_WAKE_DEBOUNCE_MS=1500 SMITH_WAKE_RECHECK_MS=3000 SMITH_WAKE_URGENT_PER_HOUR=3
and --preload tests/wake_preload.ts (fake DNS/fetch for *.test.example)."""
import re, hashlib, hmac, json, os, subprocess, sys, time, urllib.request, urllib.error
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
print("ALL PASS" if not fails else f"{fails} FAILED"); sys.exit(1 if fails else 0)
