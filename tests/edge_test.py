#!/usr/bin/env python3
"""Project Cutout — edge-function tests (supabase/index.ts + SQL).

Runs the Supabase edge function under Deno against a throwaway local
Postgres 16 cluster (initdb/pg_ctl in a temp dir; no Docker, no
Supabase CLI) and checks the delivery-order behavior:

  - a transaction that starts first but commits after a later message
    is still delivered to a poller that follows next_cursor
  - pages cross seq 9/10 and 99/100 in numeric order
  - cursors issued before the commit-order migration keep their place,
    including after their message is purged
  - schema_commit_order.sql can run twice without renumbering anything
  - rollback: the pre-migration function keeps working against the
    migrated schema, including with cursors issued by the new function;
    schema_commit_order_down.sql restores the old schema
  - a long transaction holding the insert-order lock makes a post fail
    fast with 503 + Retry-After, not hang or 500

Needs initdb, pg_ctl, psql (PostgreSQL 16) and deno on PATH; skips
otherwise. The upgrade and rollback tests read the pre-migration
function and schema from git (PRE_SEQ_REF); they skip outside a git
checkout. stdlib only.

Run:  python3 tests/edge_test.py
      CUTOUT_EDGE_DIR=/path/to/supabase python3 tests/edge_test.py
"""

import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EDGE_DIR = os.environ.get("CUTOUT_EDGE_DIR", os.path.join(ROOT, "supabase"))
# Last upstream commit before messages.seq: the function and schema that
# existing installs run today, and the function a rollback redeploys.
PRE_SEQ_REF = os.environ.get("CUTOUT_EDGE_PRE_SEQ_REF",
                             "9f462b03385152b82de2a233e3c5475e5cd17bb9")
TOKEN = "edge-test-token"
POST_BUDGET_S = 3.5  # index.ts post_transaction timeout
TOOLS = ("initdb", "pg_ctl", "psql", "deno")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def request(base, method, path, body=None, params=None, agent="instinct"):
    """Returns (status, headers, parsed_body, seconds)."""
    url = base + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("X-Agent-Id", agent)
    if data:
        req.add_header("Content-Type", "application/json")
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode()
            return resp.status, dict(resp.headers), \
                json.loads(raw) if raw else {}, time.monotonic() - start
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(raw) if raw else {}
        except ValueError:
            parsed = {"_raw": raw}
        return exc.code, dict(exc.headers), parsed, time.monotonic() - start


def post(base, text, to="instinct"):
    return request(base, "POST", "/v1/messages", body={
        "thread_id": "t", "from": "koda", "to": to, "type": "note",
        "body": text})


def poll(base, since=None, limit=None):
    params = {}
    if since:
        params["since"] = since
    if limit:
        params["limit"] = str(limit)
    st, _, body, _ = request(base, "GET", "/v1/messages", params=params)
    return st, body


def bodies(resp_body):
    return [m["body"] for m in resp_body.get("messages", [])]


def git_show(ref, path):
    """File content at ref, or None when git or the ref is unavailable."""
    try:
        out = subprocess.run(["git", "-C", ROOT, "show", "%s:%s" % (ref, path)],
                             capture_output=True, check=True)
    except (OSError, subprocess.CalledProcessError):
        return None
    return out.stdout.decode()


class EdgeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        missing = [t for t in TOOLS if not shutil.which(t)]
        if missing:
            raise unittest.SkipTest("needs %s on PATH" % ", ".join(missing))
        # Short path: the Unix socket path must stay under ~100 bytes.
        cls.tmp = tempfile.mkdtemp(prefix="cutout-edge-", dir="/tmp")
        cls.pgport = free_port()
        data = os.path.join(cls.tmp, "pgdata")
        subprocess.run(["initdb", "-D", data, "-U", "postgres",
                        "--auth=trust"], check=True, capture_output=True)
        subprocess.run(["pg_ctl", "-D", data, "-l",
                        os.path.join(cls.tmp, "pg.log"), "-w", "-o",
                        "-p %d -k %s -c listen_addresses=127.0.0.1"
                        % (cls.pgport, cls.tmp), "start"],
                       check=True, capture_output=True)
        cls.data = data
        cls.psql("postgres", "create role anon nologin;"
                 " create role authenticated nologin;"
                 " create role service_role nologin;")
        cls.dbs = 0
        cls.pre_seq = {}
        for f in ("index.ts", "schema.sql", "schema_v1.1.sql"):
            text = git_show(PRE_SEQ_REF, "supabase/" + f)
            if text is None:
                cls.pre_seq = None
                break
            cls.pre_seq[f] = text
        if cls.pre_seq is not None:
            cls.pre_seq_fn = os.path.join(cls.tmp, "pre_seq_index.ts")
            with open(cls.pre_seq_fn, "w") as fh:
                fh.write(cls.pre_seq["index.ts"])

    @classmethod
    def tearDownClass(cls):
        subprocess.run(["pg_ctl", "-D", cls.data, "-m", "immediate", "stop"],
                       capture_output=True)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # -- helpers ---------------------------------------------------------

    @classmethod
    def psql_cmd(cls, db):
        return ["psql", "-X", "-h", "127.0.0.1", "-p", str(cls.pgport),
                "-U", "postgres", "-d", db, "-qAt", "-v", "ON_ERROR_STOP=1"]

    @classmethod
    def psql(cls, db, sql):
        out = subprocess.run(cls.psql_cmd(db), input=sql.encode(),
                             capture_output=True)
        if out.returncode:
            raise AssertionError("psql failed: %s" % out.stderr.decode())
        return out.stdout.decode().strip()

    def setUp(self):
        type(self).dbs += 1
        self.db = "edge_%d" % self.dbs
        self.psql("postgres", "create database %s;" % self.db)
        self.fn = None
        self.bg = []

    def tearDown(self):
        self.stop_fn()
        for p in self.bg:
            p.kill()
            p.wait()

    def apply(self, sql_text):
        # pg_cron is not available locally: drop the cron tail of schema.sql.
        cut = sql_text.find("create extension if not exists pg_cron")
        self.psql(self.db, sql_text if cut < 0 else sql_text[:cut])

    def read_edge(self, name):
        with open(os.path.join(EDGE_DIR, name)) as fh:
            return fh.read()

    def install_current(self):
        self.apply(self.read_edge("schema.sql"))
        self.apply(self.read_edge("schema_v1.1.sql"))
        if os.path.exists(os.path.join(EDGE_DIR, "schema_commit_order.sql")):
            self.apply(self.read_edge("schema_commit_order.sql"))

    def need_pre_seq(self):
        if self.pre_seq is None:
            self.skipTest("pre-migration files unavailable at %s" % PRE_SEQ_REF)

    def install_pre_seq(self):
        self.apply(self.pre_seq["schema.sql"])
        self.apply(self.pre_seq["schema_v1.1.sql"])

    def migrate(self):
        self.apply(self.read_edge("schema_commit_order.sql"))

    def start_fn(self, index_ts=None):
        self.stop_fn()
        port = free_port()
        self.base = "http://127.0.0.1:%d" % port
        env = dict(os.environ,
                   SUPABASE_DB_URL="postgres://postgres@127.0.0.1:%d/%s"
                   % (self.pgport, self.db),
                   CUTOUT_TOKEN=TOKEN, CUTOUT_RATE_LIMIT="100000",
                   DENO_SERVE_ADDRESS="tcp:127.0.0.1:%d" % port,
                   DENO_NO_UPDATE_CHECK="1")
        env.pop("POOLER_HOST", None)
        log = open(os.path.join(self.tmp, "deno-%s.log" % self.db), "ab")
        self.fn = subprocess.Popen(
            ["deno", "run", "-A", index_ts or os.path.join(EDGE_DIR, "index.ts")],
            env=env, stdout=log, stderr=log)
        log.close()
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(self.base + "/health", timeout=2) as r:
                    if r.status == 200:
                        return
            except Exception:
                pass
            if self.fn.poll() is not None:
                break
            time.sleep(0.2)
        raise RuntimeError("edge function did not start; see %s" % log.name)

    def stop_fn(self):
        if self.fn:
            self.fn.terminate()
            self.fn.wait()
            self.fn = None

    def background_sql(self, sql):
        p = subprocess.Popen(self.psql_cmd(self.db), stdin=subprocess.PIPE,
                             stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        p.stdin.write(sql.encode())
        p.stdin.close()
        self.bg.append(p)
        return p

    def wait_for_sleeper(self):
        """Block until a background transaction is inside pg_sleep, so the
        race does not depend on how fast psql starts."""
        deadline = time.time() + 10
        while time.time() < deadline:
            if self.psql(self.db, "select count(*) from pg_stat_activity"
                         " where query like '%pg_sleep%' and state = 'active'"
                         " and pid <> pg_backend_pid();") != "0":
                return
            time.sleep(0.02)
        self.fail("background transaction never started")

    def insert_sql(self, msg_id, text, to="instinct"):
        return ("insert into cutout.messages (id, thread_id, from_agent,"
                " to_agent, type, body) values ('%s', 't', 'koda', '%s',"
                " 'note', '%s');" % (msg_id, to, text))

    def follow(self, since, limit=None, max_pages=200):
        """Follow next_cursor until an empty page; returns (bodies, cursor)."""
        seen = []
        for _ in range(max_pages):
            st, body = poll(self.base, since=since, limit=limit)
            self.assertEqual(st, 200, body)
            page = bodies(body)
            since = body["next_cursor"]
            if not page:
                return seen, since
            seen += page
        self.fail("cursor never reached an empty page: %r" % seen[-10:])

    # -- delivery order --------------------------------------------------

    def test_01_slow_transaction_is_delivered(self):
        """A write whose transaction starts before, but commits after, a
        message the poller has already received must still be delivered."""
        self.install_current()
        self.start_fn()
        self.assertEqual(post(self.base, "m0")[0], 201)
        _, first = poll(self.base)
        cursor = first["next_cursor"]
        scenarios = [
            # (name, SQL before the insert, SQL after the insert)
            ("late-insert", "select pg_sleep(2);", ""),
            ("slow-commit", "", "select pg_sleep(1.5);"),
        ]
        for name, before, after in scenarios:
            a, b = "A-" + name, "B-" + name
            writer = self.background_sql(
                "begin; %s %s %s commit;"
                % (before, self.insert_sql("msg_" + a.replace("-", "_"), a), after))
            self.wait_for_sleeper()
            self.assertEqual(post(self.base, b)[0], 201)
            st, page1 = poll(self.base, since=cursor)
            self.assertEqual(st, 200)
            writer.wait(timeout=10)
            self.assertEqual(writer.returncode, 0, writer.stderr.read())
            got2, cursor = self.follow(page1["next_cursor"])
            seen = bodies(page1) + got2
            self.assertEqual(sorted(seen), sorted([a, b]),
                             "%s: poll1=%r then %r" % (name, bodies(page1), got2))

    def test_02_pages_cross_digit_boundaries(self):
        """seq 9/10 and 99/100: order and cursors must be numeric."""
        self.install_current()
        # One statement per row (autocommit): distinct created_at, seq 1..105.
        self.psql(self.db, "\n".join(self.insert_sql("msg_D%03d" % i, "d%d" % i)
                                     for i in range(1, 106)))
        self.start_fn()
        want = ["d%d" % i for i in range(1, 106)]
        st, page = poll(self.base, limit=100)
        self.assertEqual(st, 200)
        self.assertEqual(bodies(page), want[:100])
        rest, _ = self.follow(page["next_cursor"], limit=100)
        self.assertEqual(rest, want[100:])
        for limit in (3, 10):
            got, _ = self.follow(None, limit=limit)
            self.assertEqual(got, want, "limit=%d" % limit)

    # -- upgrade ---------------------------------------------------------

    def test_03_old_cursor_survives_upgrade_and_purge(self):
        """A cursor from the pre-migration function resumes in place after
        the migration, also when its message is gone."""
        self.need_pre_seq()
        self.install_pre_seq()
        self.start_fn(self.pre_seq_fn)
        for text in ("m0", "m1", "m2", "m3"):
            self.assertEqual(post(self.base, text)[0], 201)
        st, page = poll(self.base, limit=2)
        self.assertEqual(bodies(page), ["m0", "m1"])
        old_cursor = page["next_cursor"]
        self.migrate()
        self.start_fn()
        self.assertEqual(self.follow(old_cursor)[0], ["m2", "m3"])
        # The cursor's own message is deleted; m0 before it survives.
        self.psql(self.db, "delete from cutout.messages where body = 'm1';")
        self.assertEqual(self.follow(old_cursor)[0], ["m2", "m3"])
        # The retention purge removes everything up to the cursor.
        self.psql(self.db, "update cutout.messages set created_at ="
                  " now() - interval '40 days' where body = 'm0';"
                  " select cutout.purge(30);")
        self.assertEqual(self.psql(self.db, "select count(*) from"
                                   " cutout.messages where body = 'm0';"), "0")
        self.assertEqual(self.follow(old_cursor)[0], ["m2", "m3"])
        self.assertEqual(post(self.base, "m4")[0], 201)
        self.assertEqual(self.follow(old_cursor)[0], ["m2", "m3", "m4"])

    def test_04_migration_runs_twice(self):
        """Re-running the migration renumbers nothing and does not move
        the sequence; on a fresh install it is a no-op."""
        self.need_pre_seq()
        self.install_pre_seq()
        # Three rows in one transaction share created_at; order is then id.
        self.psql(self.db, "begin; %s %s %s commit; %s" % (
            self.insert_sql("msg_B", "b"), self.insert_sql("msg_A", "a"),
            self.insert_sql("msg_C", "c"), self.insert_sql("msg_0", "z")))
        snapshot = ("select string_agg(id || '=' || seq, ',' order by seq)"
                    " || ' last=' || (select last_value from"
                    " cutout.messages_seq) from cutout.messages;")
        self.migrate()
        first = self.psql(self.db, snapshot)
        self.assertEqual(first, "msg_A=1,msg_B=2,msg_C=3,msg_0=4 last=4")
        self.migrate()
        self.assertEqual(self.psql(self.db, snapshot), first)
        self.psql(self.db, self.insert_sql("msg_N", "n"))
        self.assertEqual(self.psql(self.db, "select seq from cutout.messages"
                                   " where id = 'msg_N';"), "5")

        # Fresh install: schema.sql already has seq; the migration is a no-op.
        self.psql("postgres", "drop database %s with (force);"
                  " create database %s;" % (self.db, self.db))
        self.install_current()
        self.psql(self.db, self.insert_sql("msg_F1", "f1")
                  + self.insert_sql("msg_F2", "f2"))
        before = self.psql(self.db, snapshot)
        self.migrate()
        self.migrate()
        self.assertEqual(self.psql(self.db, snapshot), before)

    # -- rollback --------------------------------------------------------

    def test_05_rollback_function_on_migrated_schema(self):
        """Redeploying the pre-migration function after the migration keeps
        posts, polls and cursors issued by the new function working."""
        self.need_pre_seq()
        self.install_pre_seq()
        self.start_fn(self.pre_seq_fn)
        self.assertEqual(post(self.base, "r1")[0], 201)
        self.migrate()
        self.start_fn()
        for text in ("r2", "r3"):
            self.assertEqual(post(self.base, text)[0], 201)
        st, page = poll(self.base, limit=2)
        self.assertEqual(bodies(page), ["r1", "r2"])
        new_cursor = page["next_cursor"]

        self.start_fn(self.pre_seq_fn)  # rollback: old function, new schema
        st, _, created, _ = post(self.base, "r4")
        self.assertEqual(st, 201, created)
        self.assertEqual(self.psql(self.db, "select seq is not null from"
                                   " cutout.messages where body = 'r4';"), "t")
        st, body = poll(self.base, since=new_cursor)
        self.assertEqual(st, 200, body)
        self.assertEqual(bodies(body), ["r3", "r4"])
        old_fn_cursor = body["next_cursor"]
        self.assertEqual(self.follow(None)[0], ["r1", "r2", "r3", "r4"])
        st, _, _, _ = request(self.base, "POST", "/v1/receipts", body={
            "message_id": created["id"], "agent": "instinct",
            "status": "received"})
        self.assertEqual(st, 201)
        self.assertEqual(request(self.base, "GET", "/v1/threads")[0], 200)

        self.start_fn()  # roll forward again
        self.assertEqual(post(self.base, "r5")[0], 201)
        self.assertEqual(self.follow(old_fn_cursor)[0], ["r5"])

    def test_06_schema_rollback(self):
        """schema_commit_order_down.sql restores the pre-migration schema:
        the old function works, and the migration can be applied again."""
        self.need_pre_seq()
        self.install_pre_seq()
        self.migrate()
        self.start_fn()
        self.assertEqual(post(self.base, "s1")[0], 201)
        self.start_fn(self.pre_seq_fn)
        self.apply(self.read_edge("schema_commit_order_down.sql"))
        self.assertEqual(self.psql(self.db, "select count(*) from"
                                   " information_schema.columns where"
                                   " table_schema = 'cutout' and column_name"
                                   " = 'seq';"), "0")
        self.assertEqual(post(self.base, "s2")[0], 201)
        self.assertEqual(self.follow(None)[0], ["s1", "s2"])
        self.migrate()
        self.start_fn()
        self.assertEqual(post(self.base, "s3")[0], 201)
        self.assertEqual(self.follow(None)[0], ["s1", "s2", "s3"])

    # -- insert-order lock -----------------------------------------------

    def test_07_long_transaction_fails_post_fast_with_503(self):
        """Inserts are serialized until commit. A post behind a long
        transaction must come back within the post budget as 503 +
        Retry-After (or succeed), never hang or 500, and store nothing."""
        self.install_current()
        self.start_fn()
        holder = self.background_sql("begin; %s select pg_sleep(6); commit;"
                                     % self.insert_sql("msg_LONG", "long"))
        self.wait_for_sleeper()  # inserted; holds the lock for 6 s
        st, headers, body, took = post(self.base, "blocked")
        self.assertLess(took, POST_BUDGET_S + 0.5, "post took %.1fs" % took)
        serialized = self.psql(self.db, "select count(*) from pg_trigger"
                               " where tgname = 'messages_assign_seq';")
        # Without the trigger there is nothing to wait for (201).
        self.assertEqual(st, 503 if serialized == "1" else 201, body)
        if st == 503:
            self.assertEqual(headers.get("Retry-After"), "1")
        # Readers never take the lock.
        start = time.monotonic()
        self.assertEqual(poll(self.base)[0], 200)
        self.assertLess(time.monotonic() - start, 1.5)
        holder.wait(timeout=15)
        self.assertEqual(holder.returncode, 0, holder.stderr.read())
        stored = self.psql(self.db, "select count(*) from cutout.messages"
                           " where body = 'blocked';")
        self.assertEqual(stored, "1" if st == 201 else "0")
        self.assertEqual(post(self.base, "after")[0], 201)
        got = self.follow(None)[0]
        self.assertEqual(got[-1], "after")
        self.assertIn("long", got)


if __name__ == "__main__":
    unittest.main(verbosity=2)
