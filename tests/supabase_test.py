#!/usr/bin/env python3
"""Project Cutout — edge function + SQL test (optional, local only).

Starts a throwaway PostgreSQL cluster on a free port, applies
supabase/schema.sql (pg_cron statements removed) and schema_v1.1.sql,
serves supabase/index.ts with Deno, and holds both to the same
one-time link cases the reference server meets in tests/smoke_test.py:

  - one_time_link.expires_at / consumed validated on write (422)
  - cutout.purge() keeps running past malformed stored links, skips
    them, and marks expired links with offsets consumed

Needs initdb, pg_ctl, psql (PostgreSQL 14+) and deno on PATH; skips
with a reason otherwise. The first run lets Deno fetch npm:postgres.

Run:  python3 tests/supabase_test.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from smoke_test import (  # noqa: E402
    LINK_CONSUMED_REJECTED, LINK_EXPIRY_ACCEPTED, LINK_EXPIRY_REJECTED,
    ROOT, TOKEN, free_port, iso_at, link_purge_cases, raw_request)

TOOLS = ("initdb", "pg_ctl", "psql", "deno")
CRON_MARKER = "-- Daily purge via pg_cron"


def sql_literal(text):
    return "'%s'" % text.replace("'", "''")


class EdgeFunctionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        missing = [t for t in TOOLS if not shutil.which(t)]
        if missing:
            raise unittest.SkipTest("needs %s on PATH" % ", ".join(missing))
        cls.tmp = tempfile.TemporaryDirectory()
        cls.pgdata = os.path.join(cls.tmp.name, "pg")
        cls.pgport = free_port()
        cls.deno = None
        subprocess.run(["initdb", "-D", cls.pgdata, "-U", "postgres",
                        "--auth=trust", "--no-sync"], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(
            ["pg_ctl", "-D", cls.pgdata, "-l",
             os.path.join(cls.tmp.name, "pg.log"), "-w", "-o",
             "-p %d -c listen_addresses=127.0.0.1 "
             "-c unix_socket_directories='' -c fsync=off" % cls.pgport,
             "start"], check=True, stdout=subprocess.DEVNULL)
        try:
            cls._load_schema()
            cls._start_edge()
        except BaseException:
            cls.tearDownClass()
            raise

    @classmethod
    def tearDownClass(cls):
        if cls.deno:
            cls.deno.terminate()
            cls.deno.wait()
        subprocess.run(["pg_ctl", "-D", cls.pgdata, "-m", "immediate",
                        "stop"], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)
        cls.tmp.cleanup()

    @classmethod
    def psql(cls, sql):
        proc = subprocess.run(
            ["psql", "-h", "127.0.0.1", "-p", str(cls.pgport), "-U",
             "postgres", "-qAtX", "-v", "ON_ERROR_STOP=1", "-c", sql],
            capture_output=True, text=True)
        if proc.returncode != 0:
            raise AssertionError("psql: %s" % proc.stderr.strip())
        return proc.stdout.strip()

    @classmethod
    def _load_schema(cls):
        # roles that hosted Supabase provides, so GRANTs run unchanged
        for role in ("anon", "authenticated", "service_role"):
            cls.psql("create role %s nologin" % role)
        with open(os.path.join(ROOT, "supabase", "schema.sql")) as fh:
            base = fh.read()
        # pg_cron is not available locally; it is the last block
        if CRON_MARKER not in base:
            raise AssertionError("pg_cron block not found in schema.sql")
        base = base[:base.index(CRON_MARKER)]
        assert "cron." not in base, "pg_cron left in schema.sql"
        with open(os.path.join(ROOT, "supabase", "schema_v1.1.sql")) as fh:
            migration = fh.read()
        for sql in (base, migration):
            path = os.path.join(cls.tmp.name, "schema.sql")
            with open(path, "w") as fh:
                fh.write(sql)
            cls.psql("\\i " + path)

    @classmethod
    def _start_edge(cls):
        port = free_port()
        cls.base_url = "http://127.0.0.1:%d" % port
        env = dict(os.environ, CUTOUT_TOKEN=TOKEN, CUTOUT_RATE_LIMIT="1000",
                   DENO_SERVE_ADDRESS="tcp:127.0.0.1:%d" % port,
                   SUPABASE_DB_URL="postgres://postgres@127.0.0.1:%d/postgres"
                   % cls.pgport)
        cls.deno = subprocess.Popen(
            ["deno", "run", "--allow-net", "--allow-env", "--allow-read",
             "--allow-sys", os.path.join(ROOT, "supabase", "index.ts")],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 120  # first run downloads npm:postgres
        while time.time() < deadline:
            if cls.deno.poll() is not None:
                raise RuntimeError("deno exited with %s" % cls.deno.returncode)
            try:
                if raw_request(cls.base_url, "GET", "/health")[0] == 200:
                    return
            except Exception:
                pass
            time.sleep(0.5)
        raise RuntimeError("edge function did not start")

    # -- same cases as smoke_test.test_16 --------------------------------

    def test_one_time_link_fields_validated(self):
        def post(link):
            return raw_request(
                self.base_url, "POST", "/v1/messages", token=TOKEN,
                agent_id="koda", body={
                    "thread_id": "edge-link-fields", "from": "koda",
                    "to": "instinct", "type": "link",
                    "body": "one-time link inside",
                    "metadata": {"one_time_link": dict(
                        {"url": "https://example.com/auth?token=edge"},
                        **link)}})[0]
        for value in LINK_EXPIRY_ACCEPTED:
            self.assertEqual(post({"expires_at": value, "consumed": False}),
                             201, repr(value))
        for value in LINK_EXPIRY_REJECTED:
            self.assertEqual(post({"expires_at": value}), 422, repr(value))
        for value in LINK_CONSUMED_REJECTED:
            self.assertEqual(post({"consumed": value}), 422, repr(value))

    # -- same cases as smoke_test.test_17 --------------------------------

    def test_sql_purge_skips_malformed_stored_links(self):
        cases = link_purge_cases()
        for name, link, _ in cases:
            meta = {"one_time_link": dict(
                {"url": "https://example.invalid/auth"}, **link)}
            self.psql(
                "insert into cutout.messages (id, thread_id, from_agent,"
                " to_agent, type, body, metadata, created_at) values"
                " (%s, 'edge-link-purge', 'koda', 'instinct', 'link',"
                " 'stored by an older server', %s::jsonb, %s)"
                % (sql_literal("purge-" + name), sql_literal(json.dumps(meta)),
                   sql_literal(iso_at(0))))
        result = json.loads(self.psql("select cutout.purge(30)"))
        for name, link, expired in cases:
            with self.subTest(name, expires_at=link["expires_at"]):
                got = self.psql(
                    "select metadata->'one_time_link'->'consumed' from"
                    " cutout.messages where id = %s"
                    % sql_literal("purge-" + name))
                self.assertEqual(got == "true", expired, got)
        self.assertEqual(result["links_marked_consumed"],
                         sum(1 for c in cases if c[2]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
