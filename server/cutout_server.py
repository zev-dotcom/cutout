
#!/usr/bin/env python3
"""
Project Cutout — reference server (API v1.1).

Dependency-free: Python standard library only (http.server, sqlite3).
Implements every endpoint in ../SPEC.md:

    POST /v1/messages    append a message (idempotency_key supported)
                         -> 201 {id, created_at}
                         -> 200 {id, created_at, duplicate: true} on replay
    GET  /v1/messages    poll with cursors; messages carry `receipts`
                         -> 200 {messages, next_cursor}
    POST /v1/receipts    record a receipt          -> 201 {ok: true}
    GET  /v1/threads     thread list with unread + resolve status
                         -> 200 {threads: [...]}
    GET  /health         unauthenticated           -> 200 {ok: true, version}

Auth:  Authorization: Bearer <token> on everything but /health.
Token comes from the CUTOUT_TOKEN environment variable.

Run:
    CUTOUT_TOKEN=change-me python3 cutout_server.py \
        --host 127.0.0.1 --port 8765 --db ./cutout.db

This reference server speaks plain HTTP. In production, terminate TLS
in front of it (reverse proxy) and never expose it without HTTPS.
"""

import argparse
import base64
import binascii
import collections
import hashlib
import hmac
import json
import os
import re
import sqlite3
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

VERSION = "1.1"

MESSAGE_TYPES = {"note", "question", "decision", "task", "link",
                 "receipt-info", "resolve"}
RECEIPT_STATUSES = {"received", "acted", "consumed"}
AGENT_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
BODY_MAX_BYTES = 20 * 1024      # spec: body max 20 KB
METADATA_MAX_BYTES = 16 * 1024  # spec: metadata max 16 KB serialized
IDEMPOTENCY_KEY_MAX = 128       # spec: idempotency_key max 128 chars
RATE_LIMIT = 60             # requests ...
RATE_WINDOW = 60.0          # ... per 60 seconds, per token
LONG_POLL_MAX = 60

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    id         TEXT NOT NULL UNIQUE,
    thread_id  TEXT NOT NULL,
    sender     TEXT NOT NULL,
    recipient  TEXT NOT NULL,
    type       TEXT NOT NULL,
    body       TEXT NOT NULL,
    reply_to   TEXT,
    metadata   TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient, seq);
CREATE TABLE IF NOT EXISTS receipts (
    message_id TEXT NOT NULL,
    agent      TEXT NOT NULL,
    status     TEXT NOT NULL,
    at         TEXT NOT NULL,
    PRIMARY KEY (message_id, agent)
);
CREATE TABLE IF NOT EXISTS thread_status (
    thread_id   TEXT PRIMARY KEY,
    status      TEXT NOT NULL,          -- 'open' | 'resolved'
    resolved_at TEXT,
    resolved_by TEXT
);
"""


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------

def utcnow():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def new_id(prefix="msg_"):
    """ULID-style id: 48-bit ms timestamp + 80-bit randomness, Crockford32."""
    ts = int(time.time() * 1000)
    rand = int.from_bytes(os.urandom(10), "big")
    n = (ts << 80) | rand
    return prefix + "".join(
        _CROCKFORD[(n >> (5 * i)) & 31] for i in range(25, -1, -1)
    )


def encode_cursor(seq):
    raw = str(int(seq)).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cur):
    """Return int seq, or None when the cursor is malformed."""
    try:
        padded = cur + "=" * (-len(cur) % 4)
        return int(base64.urlsafe_b64decode(padded.encode()).decode())
    except (ValueError, binascii.Error, UnicodeDecodeError):
        return None


# --------------------------------------------------------------------------
# storage
# --------------------------------------------------------------------------

class Store:
    def __init__(self, path):
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.executescript(SCHEMA)
            # v1.1 migration: idempotency_key on pre-existing databases
            cols = [r["name"] for r in self._db.execute(
                "PRAGMA table_info(messages)")]
            if "idempotency_key" not in cols:
                self._db.execute(
                    "ALTER TABLE messages ADD COLUMN idempotency_key TEXT")
            # NULL keys never collide in a UNIQUE index, so plain posts
            # are unaffected; scoped per sender.
            self._db.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idem"
                " ON messages(sender, idempotency_key)")
            self._db.commit()

    def add_message(self, msg_id, thread_id, sender, recipient, mtype,
                    body, reply_to, metadata, created_at,
                    idempotency_key=None):
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO messages (id, thread_id, sender, recipient, type,"
                " body, reply_to, metadata, created_at, idempotency_key)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (msg_id, thread_id, sender, recipient, mtype, body, reply_to,
                 json.dumps(metadata) if metadata is not None else None,
                 created_at, idempotency_key),
            )
            self._db.commit()
            return cur.lastrowid

    def find_by_idempotency_key(self, sender, key):
        """Return (id, created_at) of the original post, or None."""
        with self._lock:
            row = self._db.execute(
                "SELECT id, created_at FROM messages"
                " WHERE sender = ? AND idempotency_key = ?",
                (sender, key)).fetchone()
        return (row["id"], row["created_at"]) if row else None

    def list_messages(self, since_seq=0, thread_id=None, to=None,
                      caller=None, limit=50):
        q = ("SELECT seq, id, thread_id, sender, recipient, type, body,"
             " reply_to, metadata, created_at FROM messages WHERE seq > ?")
        args = [since_seq]
        if thread_id:
            q += " AND thread_id = ?"
            args.append(thread_id)
        if to is not None:
            q += " AND recipient = ?"
            args.append(to)
        elif caller:
            # default: messages addressed to the caller, or broadcast
            q += " AND (recipient = ? OR recipient = '*')"
            args.append(caller)
        q += " ORDER BY seq ASC LIMIT ?"
        args.append(limit)
        with self._lock:
            rows = self._db.execute(q, args).fetchall()
        return self._attach_receipts(
            [self._row_to_message(r) for r in rows])

    def get_message(self, msg_id):
        with self._lock:
            row = self._db.execute(
                "SELECT seq, id, thread_id, sender, recipient, type, body,"
                " reply_to, metadata, created_at FROM messages WHERE id = ?",
                (msg_id,)).fetchone()
        if not row:
            return None
        return self._attach_receipts([self._row_to_message(row)])[0]

    def get_receipts(self, message_id):
        with self._lock:
            rows = self._db.execute(
                "SELECT agent, status, at FROM receipts"
                " WHERE message_id = ? ORDER BY at ASC",
                (message_id,)).fetchall()
        return [{"agent": r["agent"], "status": r["status"], "at": r["at"]}
                for r in rows]

    def _attach_receipts(self, msgs):
        """Spec v1.1: every message read carries its receipts."""
        ids = [m["id"] for m in msgs]
        if not ids:
            return msgs
        with self._lock:
            rows = self._db.execute(
                "SELECT message_id, agent, status, at FROM receipts"
                " WHERE message_id IN (%s)" % ",".join("?" * len(ids)),
                ids).fetchall()
        by_id = {}
        for r in rows:
            by_id.setdefault(r["message_id"], []).append(
                {"agent": r["agent"], "status": r["status"],
                 "at": r["at"]})
        for m in msgs:
            m["receipts"] = by_id.get(m["id"], [])
        return msgs

    def set_thread_resolved(self, thread_id, resolved_by, resolved_at):
        with self._lock:
            self._db.execute(
                "INSERT INTO thread_status (thread_id, status, resolved_at,"
                " resolved_by) VALUES (?, 'resolved', ?, ?)"
                " ON CONFLICT (thread_id) DO UPDATE SET"
                " status = 'resolved', resolved_at = excluded.resolved_at,"
                " resolved_by = excluded.resolved_by",
                (thread_id, resolved_at, resolved_by))
            self._db.commit()

    def reopen_thread(self, thread_id):
        with self._lock:
            self._db.execute(
                "INSERT INTO thread_status (thread_id, status, resolved_at,"
                " resolved_by) VALUES (?, 'open', NULL, NULL)"
                " ON CONFLICT (thread_id) DO UPDATE SET"
                " status = 'open', resolved_at = NULL, resolved_by = NULL",
                (thread_id,))
            self._db.commit()

    def get_thread_status(self, thread_id):
        with self._lock:
            row = self._db.execute(
                "SELECT status, resolved_at, resolved_by FROM thread_status"
                " WHERE thread_id = ?", (thread_id,)).fetchone()
        if row:
            return {"status": row["status"],
                    "resolved_at": row["resolved_at"],
                    "resolved_by": row["resolved_by"]}
        return {"status": "open", "resolved_at": None, "resolved_by": None}

    def add_receipt(self, message_id, agent, status, at):
        with self._lock:
            self._db.execute(
                "INSERT INTO receipts (message_id, agent, status, at)"
                " VALUES (?, ?, ?, ?)"
                " ON CONFLICT (message_id, agent)"
                " DO UPDATE SET status = excluded.status, at = excluded.at",
                (message_id, agent, status, at),
            )
            self._db.commit()

    def mark_link_consumed(self, msg_id):
        """Flip metadata.one_time_link.consumed to true (if present)."""
        with self._lock:
            row = self._db.execute(
                "SELECT metadata FROM messages WHERE id = ?", (msg_id,)
            ).fetchone()
            if not row or not row["metadata"]:
                return
            try:
                meta = json.loads(row["metadata"])
            except ValueError:
                return
            link = meta.get("one_time_link") if isinstance(meta, dict) else None
            if isinstance(link, dict):
                link["consumed"] = True
                self._db.execute(
                    "UPDATE messages SET metadata = ? WHERE id = ?",
                    (json.dumps(meta), msg_id),
                )
                self._db.commit()

    def purge_older_than(self, days):
        """Spec: retention purge. Delete messages older than `days`
        (by created_at) and mark any expired one_time_link entries as
        consumed on the survivors. Returns (deleted, links_marked)."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)) \
            .isoformat().replace("+00:00", "Z")
        now = utcnow()
        with self._lock:
            doomed = self._db.execute(
                "SELECT id FROM messages WHERE created_at < ?", (cutoff,)
            ).fetchall()
            doomed_ids = [r["id"] for r in doomed]
            if doomed_ids:
                self._db.execute(
                    "DELETE FROM messages WHERE created_at < ?", (cutoff,))
                self._db.execute(
                    "DELETE FROM receipts WHERE message_id NOT IN"
                    " (SELECT id FROM messages)")
            marked = 0
            rows = self._db.execute(
                "SELECT id, metadata FROM messages"
                " WHERE metadata LIKE '%one_time_link%'").fetchall()
            for r in rows:
                try:
                    meta = json.loads(r["metadata"])
                except ValueError:
                    continue
                link = meta.get("one_time_link") \
                    if isinstance(meta, dict) else None
                if not isinstance(link, dict) or link.get("consumed"):
                    continue
                exp = link.get("expires_at")
                if isinstance(exp, str) and exp < now:
                    link["consumed"] = True
                    self._db.execute(
                        "UPDATE messages SET metadata = ? WHERE id = ?",
                        (json.dumps(meta), r["id"]))
                    marked += 1
            self._db.commit()
        return len(doomed_ids), marked

    def thread_list(self):
        with self._lock:
            rows = self._db.execute(
                "SELECT thread_id, MAX(created_at) AS last_at, MAX(seq) AS mseq"
                " FROM messages GROUP BY thread_id ORDER BY mseq DESC"
            ).fetchall()
        return [{"thread_id": r["thread_id"], "last_at": r["last_at"]}
                for r in rows]

    def unread_count(self, thread_id, caller):
        with self._lock:
            row = self._db.execute(
                "SELECT COUNT(*) AS n FROM messages m"
                " WHERE m.thread_id = ?"
                " AND (m.recipient = ? OR m.recipient = '*')"
                " AND NOT EXISTS (SELECT 1 FROM receipts r"
                "                 WHERE r.message_id = m.id AND r.agent = ?)",
                (thread_id, caller, caller)).fetchone()
        return row["n"]

    @staticmethod
    def _row_to_message(r):
        meta = None
        if r["metadata"]:
            try:
                meta = json.loads(r["metadata"])
            except ValueError:
                meta = None
        msg = {
            "id": r["id"],
            "thread_id": r["thread_id"],
            "from": r["sender"],
            "to": r["recipient"],
            "type": r["type"],
            "body": r["body"],
            "created_at": r["created_at"],
        }
        if r["reply_to"]:
            msg["reply_to"] = r["reply_to"]
        if meta is not None:
            msg["metadata"] = meta
        msg["_seq"] = r["seq"]  # internal; stripped before responding
        return msg


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "CutoutBus/" + VERSION

    # wired up in main()
    token = ""
    store = None
    retention_days = 30
    _rate_lock = threading.Lock()
    _rate_hits = collections.deque()
    _purge_lock = threading.Lock()
    _last_purge = 0.0

    @classmethod
    def _maybe_purge(cls):
        """Amortized retention purge: at most once every 24h."""
        if cls.retention_days <= 0 or cls.store is None:
            return
        now = time.monotonic()
        with cls._purge_lock:
            if now - cls._last_purge < 86400:
                return
            cls._last_purge = now
        deleted, marked = cls.store.purge_older_than(cls.retention_days)
        if deleted or marked:
            sys.stderr.write(
                "cutout: retention purge: %d messages deleted,"
                " %d expired links marked consumed\n" % (deleted, marked))

    # -- plumbing ------------------------------------------------------

    def log_message(self, fmt, *args):  # quieter than the default
        sys.stderr.write("cutout: " + fmt % args + "\n")

    def _send(self, code, obj, extra_headers=None):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in getattr(self, "_resp_headers", {}).items():
            self.send_header(k, v)
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _err(self, code, message, extra_headers=None):
        self._send(code, {"error": message}, extra_headers)

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return None, "empty request body"
        try:
            return json.loads(raw.decode("utf-8")), None
        except (ValueError, UnicodeDecodeError):
            return None, "malformed JSON body"

    def _authorized(self):
        auth = self.headers.get("Authorization") or ""
        if not auth.startswith("Bearer "):
            return False
        return hmac.compare_digest(auth[7:].strip(), self.token)

    @classmethod
    def _rate_state(cls, consume):
        """Sliding 60s window. Returns dict with limited/retry/remaining/
        reset; consume=False only inspects (for /health)."""
        now = time.monotonic()
        with cls._rate_lock:
            dq = cls._rate_hits
            while dq and dq[0] <= now - RATE_WINDOW:
                dq.popleft()
            if consume:
                if len(dq) >= RATE_LIMIT:
                    wait = dq[0] + RATE_WINDOW - now
                    return {"limited": True,
                            "retry": max(1, int(wait) + 1),
                            "remaining": 0,
                            "reset": int(time.time() + wait)}
                dq.append(now)
            return {"limited": False, "retry": 0,
                    "remaining": RATE_LIMIT - len(dq),
                    "reset": int(time.time() + RATE_WINDOW)}

    @staticmethod
    def _rate_headers(info):
        return {"X-RateLimit-Limit": str(RATE_LIMIT),
                "X-RateLimit-Remaining": str(info["remaining"]),
                "X-RateLimit-Reset": str(info["reset"])}

    def _guard(self, need_auth=True):
        """Auth + rate limit. Returns True when the request may proceed.

        Rate-limit headers are attached to every response (including
        401/429) via self._resp_headers, which _send merges in.
        """
        info = self._rate_state(consume=True)
        self._resp_headers = self._rate_headers(info)
        if need_auth and not self._authorized():
            self._err(401, "unauthorized: bad or missing bearer token")
            return False
        self._maybe_purge()
        if info["limited"]:
            self._err(429, "rate limit exceeded",
                      {"Retry-After": str(info["retry"])})
            return False
        return True

    @staticmethod
    def _public(msg):
        msg = dict(msg)
        msg.pop("_seq", None)
        return msg

    # -- routing -------------------------------------------------------

    def do_GET(self):
        try:
            path = urlparse(self.path).path.rstrip("/") or "/"
            if path == "/health":
                self._resp_headers = self._rate_headers(
                    self._rate_state(consume=False))
                self._send(200, {"ok": True, "version": VERSION})
            elif path == "/v1/messages":
                self._handle_get_messages()
            elif path == "/v1/threads":
                self._handle_get_threads()
            else:
                self._err(404, "not found")
        except BrokenPipeError:
            pass
        except Exception as exc:  # never leak tracebacks to clients
            self.log_message("internal error: %r", exc)
            try:
                self._err(500, "internal error")
            except BrokenPipeError:
                pass

    def do_POST(self):
        try:
            path = urlparse(self.path).path.rstrip("/") or "/"
            if path == "/v1/messages":
                self._handle_post_message()
            elif path == "/v1/receipts":
                self._handle_post_receipt()
            else:
                self._err(404, "not found")
        except BrokenPipeError:
            pass
        except Exception as exc:
            self.log_message("internal error: %r", exc)
            try:
                self._err(500, "internal error")
            except BrokenPipeError:
                pass

    # -- endpoints -----------------------------------------------------

    def _handle_post_message(self):
        if not self._guard():
            return
        data, err = self._read_json()
        if err:
            self._err(400, err)
            return
        if not isinstance(data, dict):
            self._err(422, "request body must be a JSON object")
            return

        for field in ("thread_id", "from", "to", "type", "body"):
            val = data.get(field)
            if not isinstance(val, str) or not val.strip():
                self._err(422, "%s is required" % field)
                return

        thread_id = data["thread_id"].strip()
        sender = data["from"].strip()
        recipient = data["to"].strip()
        mtype = data["type"].strip()
        body = data["body"]
        reply_to = data.get("reply_to")
        metadata = data.get("metadata")
        idempotency_key = data.get("idempotency_key")

        if not AGENT_RE.match(sender):
            self._err(422, "from must be a kebab-case agent id")
            return
        if recipient != "*" and not AGENT_RE.match(recipient):
            self._err(422, "to must be a kebab-case agent id or '*'")
            return
        if mtype not in MESSAGE_TYPES:
            self._err(422, "type must be one of: %s"
                      % ", ".join(sorted(MESSAGE_TYPES)))
            return
        if len(body.encode("utf-8")) > BODY_MAX_BYTES:
            self._err(413, "body exceeds 20 KB")
            return
        if reply_to is not None and not isinstance(reply_to, str):
            self._err(422, "reply_to must be a string")
            return
        if metadata is not None and not isinstance(metadata, dict):
            self._err(422, "metadata must be an object")
            return
        if metadata is not None and \
                len(json.dumps(metadata).encode("utf-8")) > METADATA_MAX_BYTES:
            self._err(413, "metadata exceeds 16 KB")
            return
        if idempotency_key is not None:
            if not isinstance(idempotency_key, str) \
                    or not idempotency_key.strip() \
                    or len(idempotency_key) > IDEMPOTENCY_KEY_MAX:
                self._err(422, "idempotency_key must be a non-empty string"
                               " up to 128 chars")
                return
            idempotency_key = idempotency_key.strip()
            # Safe retry: the same logical send returns the original.
            original = self.store.find_by_idempotency_key(
                sender, idempotency_key)
            if original:
                self._send(200, {"id": original[0],
                                 "created_at": original[1],
                                 "duplicate": True})
                return
        if mtype == "link":
            link = (metadata or {}).get("one_time_link")
            if not isinstance(link, dict) or not link.get("url"):
                self._err(422, "link messages require"
                              " metadata.one_time_link.url")
                return

        msg_id = new_id()
        created_at = utcnow()
        self.store.add_message(msg_id, thread_id, sender, recipient, mtype,
                               body, reply_to, metadata, created_at,
                               idempotency_key)
        if mtype == "resolve":
            self.store.set_thread_resolved(thread_id, sender, created_at)
        else:
            # any new work reopens a resolved thread
            self.store.reopen_thread(thread_id)
        self._send(201, {"id": msg_id, "created_at": created_at})

    def _handle_get_messages(self):
        if not self._guard():
            return
        qs = parse_qs(urlparse(self.path).query)

        def one(name, default=None):
            vals = qs.get(name)
            return vals[0] if vals else default

        since_raw = one("since")
        since_seq = 0
        if since_raw:
            since_seq = decode_cursor(since_raw)
            if since_seq is None:
                self._err(422, "invalid since cursor")
                return

        try:
            wait = int(one("wait", "0"))
        except ValueError:
            self._err(422, "wait must be an integer 0-60")
            return
        if not 0 <= wait <= LONG_POLL_MAX:
            self._err(422, "wait must be an integer 0-60")
            return

        try:
            limit = int(one("limit", "50"))
        except ValueError:
            self._err(422, "limit must be an integer 1-100")
            return
        if not 1 <= limit <= 100:
            self._err(422, "limit must be an integer 1-100")
            return

        thread_id = one("thread_id")
        to = one("to")
        caller = self.headers.get("X-Agent-Id")

        deadline = time.monotonic() + wait
        rows = []
        while True:
            rows = self.store.list_messages(
                since_seq=since_seq, thread_id=thread_id, to=to,
                caller=caller, limit=limit)
            if rows or time.monotonic() >= deadline:
                break
            time.sleep(0.25)  # long-poll: re-check until wait expires

        if rows:
            next_cursor = encode_cursor(rows[-1]["_seq"])
        else:
            # nothing new: hand back the cursor we were given so the
            # client keeps its place
            next_cursor = since_raw or encode_cursor(0)
        self._send(200, {"messages": [self._public(m) for m in rows],
                         "next_cursor": next_cursor})

    def _handle_post_receipt(self):
        if not self._guard():
            return
        data, err = self._read_json()
        if err:
            self._err(400, err)
            return
        if not isinstance(data, dict):
            self._err(422, "request body must be a JSON object")
            return

        message_id = data.get("message_id")
        agent = data.get("agent")
        status = data.get("status")
        if not isinstance(message_id, str) or not message_id:
            self._err(422, "message_id is required")
            return
        if not isinstance(agent, str) or not AGENT_RE.match(agent):
            self._err(422, "agent must be a kebab-case agent id")
            return
        if status not in RECEIPT_STATUSES:
            self._err(422, "status must be one of: %s"
                      % ", ".join(sorted(RECEIPT_STATUSES)))
            return
        if self.store.get_message(message_id) is None:
            self._err(404, "unknown message_id")
            return

        # idempotent on (message_id, agent): re-posting is a no-op update
        self.store.add_receipt(message_id, agent, status, utcnow())
        if status == "consumed":
            self.store.mark_link_consumed(message_id)
        self._send(201, {"ok": True})

    def _handle_get_threads(self):
        if not self._guard():
            return
        caller = self.headers.get("X-Agent-Id")
        out = []
        for t in self.store.thread_list():
            unread = self.store.unread_count(t["thread_id"], caller) \
                if caller else 0
            st = self.store.get_thread_status(t["thread_id"])
            out.append({"thread_id": t["thread_id"],
                        "last_at": t["last_at"],
                        "unread": unread,
                        "status": st["status"],
                        "resolved_at": st["resolved_at"]})
        self._send(200, {"threads": out})


# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Project Cutout reference server")
    ap.add_argument("--host", default=os.environ.get("CUTOUT_HOST",
                                                     "127.0.0.1"))
    ap.add_argument("--port", type=int,
                    default=int(os.environ.get("CUTOUT_PORT", "8765")))
    ap.add_argument("--db", default=os.environ.get("CUTOUT_DB",
                                                   "cutout.db"),
                    help="SQLite file path (use :memory: for ephemeral)")
    ap.add_argument("--token", default=os.environ.get("CUTOUT_TOKEN"),
                    help="shared bearer token (prefer the env var)")
    ap.add_argument("--retention-days", type=int,
                    default=int(os.environ.get("CUTOUT_RETENTION_DAYS",
                                               "30")),
                    help="purge messages older than this (0 disables)")
    args = ap.parse_args()

    if not args.token:
        sys.exit("error: set CUTOUT_TOKEN (or pass --token)")

    Handler.token = args.token
    Handler.store = Store(args.db)
    Handler.retention_days = args.retention_days
    if args.retention_days > 0:
        deleted, marked = Handler.store.purge_older_than(
            args.retention_days)
        Handler._last_purge = time.monotonic()
        if deleted or marked:
            sys.stderr.write(
                "cutout: startup retention purge: %d messages deleted,"
                " %d expired links marked consumed\n" % (deleted, marked))

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    sys.stderr.write(
        "cutout: listening on http://%s:%d (db: %s)\n"
        % (args.host, args.port, args.db))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
