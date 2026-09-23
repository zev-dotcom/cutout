
#!/usr/bin/env python3
"""Project Cutout — two-agent QA handoff demo.

Replays a sample QA thread between two agents ("koda" and
"instinct") against a throwaway local server:

  1. koda posts a question in a thread
  2. instinct reads it (receipt: received), answers with reply_to
     (receipt: acted)
  3. koda shares a one-time sign-in link (type: link, URL in metadata)
  4. instinct consumes it and posts receipt: consumed
  5. thread summary with per-agent unread counts

The server is started automatically on a free localhost port with an
ephemeral in-memory database. No real credentials are used anywhere.

Run:  python3 examples/qa_handoff.py
"""

import os
import socket
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SERVER = os.path.join(ROOT, "server", "cutout_server.py")
sys.path.insert(0, os.path.join(ROOT, "clients", "python"))
from cutout import Client  # noqa: E402

TOKEN = "demo-bus-token"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_for_health(base_url, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(base_url + "/health",
                                       timeout=2) as r:
                if r.status == 200:
                    return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("server did not come up")


def step(n, text):
    print("\n=== %d. %s" % (n, text))


def main():
    port = free_port()
    base_url = "http://127.0.0.1:%d" % port
    env = dict(os.environ, CUTOUT_TOKEN=TOKEN)
    proc = subprocess.Popen(
        [sys.executable, SERVER, "--port", str(port), "--db", ":memory:"],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_for_health(base_url)
        print("bus up at %s (ephemeral db)" % base_url)

        koda = Client(base_url=base_url, token=TOKEN, agent_id="koda")
        instinct = Client(base_url=base_url, token=TOKEN, agent_id="instinct")
        thread = "demo-thread-qa"

        step(1, "koda asks a question")
        q = koda.post_message(thread_id=thread, from_="koda", to="instinct",
                              type="question",
                              body="Motion retest passed 7/7 on the current "
                                   "drafts. Ready to ship?")
        print("posted:", q["id"])

        step(2, "instinct reads it and answers")
        inbox = instinct.get_messages()
        print("instinct sees %d message(s)" % len(inbox["messages"]))
        instinct.post_receipt(q["id"], agent="instinct", status="received")
        a = instinct.post_message(thread_id=thread, from_="instinct",
                                  to="koda", type="note",
                                  body="Ship it. Motion batch is green.",
                                  reply_to=q["id"])
        instinct.post_receipt(q["id"], agent="instinct", status="acted")
        print("answered:", a["id"], "(reply_to=%s)" % q["id"])

        step(3, "koda shares a one-time sign-in link")
        link = koda.post_message(
            thread_id=thread, from_="koda", to="instinct", type="link",
            body="Fresh staging sign-in link (single-use, expires soon).",
            metadata={"one_time_link": {
                "url": "https://example.invalid/auth/verify"
                       "?token=single-use-demo",
                "expires_at": "2030-01-01T00:30:00Z",
                "consumed": False}})
        print("posted:", link["id"])

        step(4, "instinct consumes the link")
        instinct.post_receipt(link["id"], agent="instinct",
                              status="consumed")
        seen = instinct.get_messages(thread_id=thread)
        got = [m for m in seen["messages"] if m["id"] == link["id"]][0]
        print("link consumed flag on server:",
              got["metadata"]["one_time_link"]["consumed"])
        assert got["metadata"]["one_time_link"]["consumed"] is True

        step(5, "thread summary")
        for agent_client, name in ((koda, "koda"), (instinct, "instinct")):
            threads = agent_client.get_threads()["threads"]
            t = [x for x in threads if x["thread_id"] == thread][0]
            print("%s: thread=%s last_at=%s unread=%d"
                  % (name, t["thread_id"], t["last_at"], t["unread"]))

        print("\nDemo complete: question -> answer -> one-time link -> "
              "consumed, all over the bus.")
    finally:
        proc.terminate()
        proc.wait()


if __name__ == "__main__":
    main()
