
"""Project Cutout — minimal Python client (stdlib only).

Usage:
    from cutout import Client

    bus = Client(agent_id="koda")  # reads CUTOUT_URL / CUTOUT_TOKEN
    msg = bus.post_message(thread_id="demo-thread", from_="koda",
                           to="instinct", type="question",
                           body="Retest passed 7/7. Ready to ship?",
                           idempotency_key="qa-handoff-001")
    batch = bus.get_messages(wait=30)          # long-poll for replies
    bus.post_receipt(msg["id"], agent="koda", status="acted")
    bus.resolve_thread(thread_id="demo-thread", from_="koda")
"""

import json
import os
import urllib.parse
import urllib.request


class CutoutError(Exception):
    def __init__(self, status, body):
        self.status = status
        self.body = body
        super().__init__("cutout: HTTP %s: %s" % (status, body))


class Client:
    def __init__(self, base_url=None, token=None, agent_id=None,
                 timeout=75):
        self.base_url = (base_url or os.environ.get(
            "CUTOUT_URL", "http://127.0.0.1:8765")).rstrip("/")
        self.token = token or os.environ.get("CUTOUT_TOKEN")
        if not self.token:
            raise CutoutError(0, "set CUTOUT_TOKEN")
        self.agent_id = agent_id or os.environ.get("CUTOUT_AGENT_ID")
        self.timeout = timeout

    def _request(self, method, path, body=None, params=None, timeout=None):
        url = self.base_url + path
        if params:
            url += "?" + urllib.parse.urlencode(
                {k: v for k, v in params.items() if v is not None})
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", "Bearer " + self.token)
        if self.agent_id:
            req.add_header("X-Agent-Id", self.agent_id)
        if data:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(
                    req, timeout=timeout or self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            raise CutoutError(exc.code, exc.read().decode("utf-8",
                                                               "replace"))

    # -- API -----------------------------------------------------------

    def post_message(self, thread_id, from_, to, type, body,
                     reply_to=None, metadata=None, idempotency_key=None):
        payload = {"thread_id": thread_id, "from": from_, "to": to,
                   "type": type, "body": body}
        if reply_to:
            payload["reply_to"] = reply_to
        if metadata is not None:
            payload["metadata"] = metadata
        if idempotency_key:
            # safe to retry: the server returns the original message
            # with "duplicate": true instead of appending again
            payload["idempotency_key"] = idempotency_key
        return self._request("POST", "/v1/messages", body=payload)

    def resolve_thread(self, thread_id, from_, to="*", body="Resolved.",
                       metadata=None):
        """Mark a thread resolved (reopened by any later message)."""
        return self.post_message(thread_id, from_, to, "resolve", body,
                                 metadata=metadata)

    def get_messages(self, since=None, thread_id=None, to=None,
                     wait=0, limit=50):
        # long-poll: allow the server up to `wait` seconds plus headroom
        timeout = self.timeout if wait == 0 else wait + 15
        return self._request("GET", "/v1/messages",
                             params={"since": since, "thread_id": thread_id,
                                     "to": to, "wait": wait, "limit": limit},
                             timeout=timeout)

    def post_receipt(self, message_id, agent, status):
        return self._request("POST", "/v1/receipts",
                             body={"message_id": message_id,
                                   "agent": agent, "status": status})

    def get_threads(self):
        return self._request("GET", "/v1/threads")
