
#!/usr/bin/env python3
"""Project Cutout — smoke test.

Starts the reference server on a free port with a throwaway SQLite db,
then exercises every endpoint and asserts the key behaviors:

  - /health needs no auth
  - 401 without / with a bad token
  - 422 validation (missing fields, bad type, oversize body, bad cursor)
  - cursor pagination + cursor echo on empty polls
  - long-poll (?wait=N) returns early when a message arrives
  - receipt idempotency + receipts visible on message reads
  - consumed receipt flips metadata.one_time_link.consumed
  - idempotency keys: replay returns the original, no double-post
  - resolve/reopen thread lifecycle
  - rate-limit headers on API responses
  - 413 on oversize body / metadata
  - default `to` filtering via X-Agent-Id
  - thread list with per-agent unread counts
  - 429 + Retry-After under the rate limit (runs LAST)

Run:  python3 tests/smoke_test.py
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SERVER = os.path.join(ROOT, "server", "cutout_server.py")
sys.path.insert(0, os.path.join(ROOT, "clients", "python"))
from cutout import Client, CutoutError  # noqa: E402

TOKEN = "smoke-test-token"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def raw_request(base_url, method, path, token="unset", agent_id=None,
                body=None, params=None):
    """Low-level request returning (status, headers, parsed_body)."""
    url = base_url + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if token != "unset":
        req.add_header("Authorization", "Bearer " + token)
    if agent_id:
        req.add_header("X-Agent-Id", agent_id)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode()
            return resp.status, dict(resp.headers), \
                json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(raw) if raw else {}
        except ValueError:
            parsed = {"_raw": raw}
        return exc.code, dict(exc.headers), parsed


class SmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        cls.base_url = "http://127.0.0.1:%d" % cls.port
        cls.tmp = tempfile.TemporaryDirectory()
        db = os.path.join(cls.tmp.name, "smoke.db")
        env = dict(os.environ, CUTOUT_TOKEN=TOKEN)
        cls.proc = subprocess.Popen(
            [sys.executable, SERVER, "--port", str(cls.port), "--db", db],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                st, _, _ = raw_request(cls.base_url, "GET", "/health")
                if st == 200:
                    break
            except Exception:
                pass
            time.sleep(0.2)
        else:
            raise RuntimeError("server did not start")
        cls.koda = Client(base_url=cls.base_url, token=TOKEN,
                          agent_id="koda")
        cls.instinct = Client(base_url=cls.base_url, token=TOKEN,
                              agent_id="instinct")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait()
        cls.tmp.cleanup()

    # -- health & auth -------------------------------------------------

    def test_01_health_no_auth(self):
        st, _, body = raw_request(self.base_url, "GET", "/health",
                                  token="unset")
        self.assertEqual(st, 200)
        self.assertEqual(body, {"ok": True, "version": "1.1"})

    def test_02_unauthorized(self):
        st, _, body = raw_request(self.base_url, "GET", "/v1/messages",
                                  token="unset")
        self.assertEqual(st, 401)
        st, _, _ = raw_request(self.base_url, "GET", "/v1/messages",
                               token="wrong-token")
        self.assertEqual(st, 401)
        with self.assertRaises(CutoutError) as ctx:
            Client(base_url=self.base_url, token="wrong-token",
                   agent_id="koda").get_threads()
        self.assertEqual(ctx.exception.status, 401)

    # -- validation ----------------------------------------------------

    def test_03_post_validation(self):
        # missing thread_id
        with self.assertRaises(CutoutError) as ctx:
            self.koda.post_message(thread_id="", from_="koda", to="instinct",
                                   type="note", body="x")
        self.assertEqual(ctx.exception.status, 422)
        # bad type
        with self.assertRaises(CutoutError) as ctx:
            self.koda.post_message(thread_id="t", from_="koda",
                                   to="instinct", type="shout", body="x")
        self.assertEqual(ctx.exception.status, 422)
        # bad agent id
        with self.assertRaises(CutoutError) as ctx:
            self.koda.post_message(thread_id="t", from_="Not Kebab",
                                   to="instinct", type="note", body="x")
        self.assertEqual(ctx.exception.status, 422)
        # oversize body -> 413
        with self.assertRaises(CutoutError) as ctx:
            self.koda.post_message(thread_id="t", from_="koda",
                                   to="instinct", type="note",
                                   body="x" * (20 * 1024 + 1))
        self.assertEqual(ctx.exception.status, 413)
        # oversize metadata -> 413
        with self.assertRaises(CutoutError) as ctx:
            self.koda.post_message(thread_id="t", from_="koda",
                                   to="instinct", type="note", body="x",
                                   metadata={"pad": "x" * (16 * 1024)})
        self.assertEqual(ctx.exception.status, 413)
        # link type without a URL in metadata
        with self.assertRaises(CutoutError) as ctx:
            self.koda.post_message(thread_id="t", from_="koda",
                                   to="instinct", type="link",
                                   body="a link with nowhere to go")
        self.assertEqual(ctx.exception.status, 422)
        # bad query params
        with self.assertRaises(CutoutError) as ctx:
            self.koda.get_messages(since="not-a-cursor")
        self.assertEqual(ctx.exception.status, 422)
        with self.assertRaises(CutoutError) as ctx:
            self.koda.get_messages(limit=101)
        self.assertEqual(ctx.exception.status, 422)
        with self.assertRaises(CutoutError) as ctx:
            self.koda.get_messages(wait=61)
        self.assertEqual(ctx.exception.status, 422)

    # -- happy path: post + poll ---------------------------------------

    def test_04_post_and_poll(self):
        r = self.koda.post_message(thread_id="smoke-basic", from_="koda",
                                   to="instinct", type="note",
                                   body="hello from the smoke test")
        self.assertTrue(r["id"].startswith("msg_"))
        self.assertIn("created_at", r)
        batch = self.instinct.get_messages(thread_id="smoke-basic")
        self.assertEqual(len(batch["messages"]), 1)
        m = batch["messages"][0]
        self.assertEqual(m["from"], "koda")
        self.assertEqual(m["to"], "instinct")
        self.assertNotIn("_seq", m)  # internal field must not leak

    def test_05_cursor_pagination(self):
        for i in range(3):
            self.koda.post_message(thread_id="smoke-pages", from_="koda",
                                   to="*", type="note",
                                   body="page msg %d" % i)
        page1 = self.koda.get_messages(thread_id="smoke-pages", limit=2)
        self.assertEqual(len(page1["messages"]), 2)
        cursor = page1["next_cursor"]
        page2 = self.koda.get_messages(thread_id="smoke-pages",
                                       since=cursor, limit=2)
        self.assertEqual(len(page2["messages"]), 1)
        self.assertEqual(page2["messages"][0]["body"], "page msg 2")
        # empty poll echoes the cursor back so the client keeps its place
        page3 = self.koda.get_messages(thread_id="smoke-pages",
                                       since=page2["next_cursor"])
        self.assertEqual(page3["messages"], [])
        self.assertEqual(page3["next_cursor"], page2["next_cursor"])

    def test_06_to_filter_defaults(self):
        self.koda.post_message(thread_id="smoke-to", from_="koda",
                               to="koda", type="note", body="for koda only")
        self.koda.post_message(thread_id="smoke-to", from_="koda",
                               to="*", type="note", body="broadcast")
        as_instinct = self.instinct.get_messages(thread_id="smoke-to")
        bodies = [m["body"] for m in as_instinct["messages"]]
        self.assertEqual(bodies, ["broadcast"])  # default: to me or *
        as_koda = self.koda.get_messages(thread_id="smoke-to")
        self.assertEqual(len(as_koda["messages"]), 2)
        # explicit `to` overrides the default
        explicit = self.instinct.get_messages(thread_id="smoke-to",
                                              to="koda")
        self.assertEqual(len(explicit["messages"]), 1)

    def test_07_long_poll(self):
        received = {}

        def poll():
            received["batch"] = self.instinct.get_messages(
                thread_id="smoke-wait", wait=8)

        t = threading.Thread(target=poll)
        start = time.monotonic()
        t.start()
        time.sleep(1.0)  # let the long-poll park on the server
        posted = self.koda.post_message(thread_id="smoke-wait",
                                        from_="koda", to="instinct",
                                        type="note", body="wake up")
        t.join(timeout=10)
        elapsed = time.monotonic() - start
        self.assertFalse(t.is_alive(), "long-poll did not return")
        self.assertLess(elapsed, 8, "long-poll waited the full timeout")
        msgs = received["batch"]["messages"]
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["id"], posted["id"])

    # -- receipts ------------------------------------------------------

    def test_08_receipt_idempotent(self):
        r = self.koda.post_message(thread_id="smoke-rcpt", from_="koda",
                                   to="instinct", type="task",
                                   body="please confirm")
        mid = r["id"]
        self.assertEqual(
            self.instinct.post_receipt(mid, "instinct", "received"),
            {"ok": True})
        # re-posting the same receipt is a safe no-op
        self.assertEqual(
            self.instinct.post_receipt(mid, "instinct", "received"),
            {"ok": True})
        self.assertEqual(
            self.instinct.post_receipt(mid, "instinct", "acted"),
            {"ok": True})
        # unread drops to zero once a receipt exists
        threads = self.instinct.get_threads()["threads"]
        t = [x for x in threads if x["thread_id"] == "smoke-rcpt"][0]
        self.assertEqual(t["unread"], 0)

    def test_09_consumed_flips_link_flag(self):
        r = self.koda.post_message(
            thread_id="smoke-link", from_="koda", to="instinct",
            type="link", body="one-time link inside",
            metadata={"one_time_link": {
                "url": "https://example.invalid/auth?token=smoke",
                "expires_at": "2030-01-01T00:00:00Z",
                "consumed": False}})
        mid = r["id"]
        # read back as the addressee (koda's default `to` filter hides
        # messages addressed to instinct)
        before = self.instinct.get_messages(thread_id="smoke-link")["messages"]
        link_msg = [m for m in before if m["id"] == mid][0]
        self.assertFalse(link_msg["metadata"]["one_time_link"]["consumed"])
        self.assertEqual(
            self.instinct.post_receipt(mid, "instinct", "consumed"),
            {"ok": True})
        after = self.instinct.get_messages(thread_id="smoke-link")["messages"]
        link_msg = [m for m in after if m["id"] == mid][0]
        self.assertTrue(link_msg["metadata"]["one_time_link"]["consumed"])
        # receipt for an unknown message is a 404
        with self.assertRaises(CutoutError) as ctx:
            self.instinct.post_receipt("msg_doesnotexist", "instinct",
                                       "received")
        self.assertEqual(ctx.exception.status, 404)

    def test_10_threads_unread(self):
        self.koda.post_message(thread_id="smoke-unread", from_="koda",
                               to="instinct", type="note", body="unread me")
        threads = self.instinct.get_threads()["threads"]
        t = [x for x in threads if x["thread_id"] == "smoke-unread"][0]
        self.assertEqual(t["unread"], 1)
        self.assertIn("last_at", t)
        self.assertEqual(t["status"], "open")
        self.assertIsNone(t["resolved_at"])

    @staticmethod
    def _thread(thread_id, client):
        threads = client.get_threads()["threads"]
        return [x for x in threads if x["thread_id"] == thread_id][0]

    # -- v1.1 ----------------------------------------------------------

    def test_11_idempotent_post(self):
        key = "smoke-idem-001"
        r1 = self.koda.post_message(thread_id="smoke-idem", from_="koda",
                                    to="instinct", type="note",
                                    body="exactly once",
                                    idempotency_key=key)
        self.assertNotIn("duplicate", r1)
        # replaying the same key returns the original, appends nothing
        r2 = self.koda.post_message(thread_id="smoke-idem", from_="koda",
                                    to="instinct", type="note",
                                    body="exactly once",
                                    idempotency_key=key)
        self.assertEqual(r2["id"], r1["id"])
        self.assertTrue(r2["duplicate"])
        msgs = self.instinct.get_messages(thread_id="smoke-idem")["messages"]
        self.assertEqual(len(msgs), 1)
        # the same key from a different agent is a different logical send
        r3 = self.instinct.post_message(thread_id="smoke-idem",
                                        from_="instinct", to="koda",
                                        type="note", body="mine",
                                        idempotency_key=key)
        self.assertNotIn("duplicate", r3)
        self.assertNotEqual(r3["id"], r1["id"])
        # empty keys are rejected
        with self.assertRaises(CutoutError) as ctx:
            self.koda.post_message(thread_id="smoke-idem", from_="koda",
                                   to="instinct", type="note", body="x",
                                   idempotency_key="  ")
        self.assertEqual(ctx.exception.status, 422)

    def test_12_receipts_visible(self):
        r = self.koda.post_message(thread_id="smoke-rcptvis", from_="koda",
                                   to="instinct", type="note", body="track me")
        mid = r["id"]
        before = self.instinct.get_messages(
            thread_id="smoke-rcptvis")["messages"]
        m = [x for x in before if x["id"] == mid][0]
        self.assertEqual(m["receipts"], [])
        self.instinct.post_receipt(mid, "instinct", "received")
        after = self.instinct.get_messages(
            thread_id="smoke-rcptvis")["messages"]
        m = [x for x in after if x["id"] == mid][0]
        self.assertEqual(len(m["receipts"]), 1)
        self.assertEqual(m["receipts"][0]["agent"], "instinct")
        self.assertEqual(m["receipts"][0]["status"], "received")
        self.assertIn("at", m["receipts"][0])

    def test_13_resolve_reopen(self):
        self.koda.post_message(thread_id="smoke-resolve", from_="koda",
                               to="instinct", type="question", body="open?")
        t = self._thread("smoke-resolve", self.koda)
        self.assertEqual(t["status"], "open")
        self.assertIsNone(t["resolved_at"])
        self.koda.resolve_thread(thread_id="smoke-resolve", from_="koda",
                                 body="answered, closing")
        t = self._thread("smoke-resolve", self.koda)
        self.assertEqual(t["status"], "resolved")
        self.assertIsNotNone(t["resolved_at"])
        # new work reopens the thread
        self.instinct.post_message(thread_id="smoke-resolve",
                                   from_="instinct", to="koda",
                                   type="note", body="one more thing")
        t = self._thread("smoke-resolve", self.koda)
        self.assertEqual(t["status"], "open")
        self.assertIsNone(t["resolved_at"])

    def test_14_rate_limit_headers(self):
        st, headers, _ = raw_request(self.base_url, "GET", "/v1/threads",
                                     token=TOKEN, agent_id="koda")
        self.assertEqual(st, 200)
        h = {k.lower(): v for k, v in headers.items()}
        self.assertEqual(h.get("x-ratelimit-limit"), "60")
        self.assertIn("x-ratelimit-remaining", h)
        self.assertIn("x-ratelimit-reset", h)
        self.assertGreaterEqual(int(h["x-ratelimit-remaining"]), 0)
        # also present on the unauthenticated health check
        st, headers, _ = raw_request(self.base_url, "GET", "/health",
                                     token="unset")
        self.assertEqual(st, 200)
        h = {k.lower(): v for k, v in headers.items()}
        self.assertEqual(h.get("x-ratelimit-limit"), "60")

    # -- rate limit (LAST: it burns the test token's budget) ------------

    def test_99_rate_limit(self):
        seen_429 = False
        retry_after = None
        for _ in range(70):
            st, headers, _ = raw_request(self.base_url, "GET",
                                         "/v1/messages", token=TOKEN,
                                         agent_id="koda")
            if st == 429:
                seen_429 = True
                retry_after = headers.get("Retry-After")
                break
        self.assertTrue(seen_429, "expected a 429 under burst load")
        self.assertIsNotNone(retry_after)
        self.assertGreaterEqual(int(retry_after), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
