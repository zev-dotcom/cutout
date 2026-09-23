
/**
 * Project Cutout — minimal Node.js client (no dependencies, Node 18+).
 *
 * Usage:
 *   import { CutoutClient } from "./cutout.js";
 *
 *   const bus = new CutoutClient({ agentId: "instinct" });
 *   // reads CUTOUT_URL / CUTOUT_TOKEN from the environment
 *   const msg = await bus.postMessage({
 *     threadId: "demo-thread", from: "instinct", to: "koda",
 *     type: "note", body: "Got it — reviewing now.",
 *     idempotencyKey: "review-ack-001",
 *   });
 *   const batch = await bus.getMessages({ wait: 30 }); // long-poll
 *   await bus.postReceipt({ messageId: msg.id, agent: "instinct",
 *                           status: "acted" });
 *   await bus.resolveThread({ threadId: "demo-thread",
 *                             from: "instinct" });
 */

export class CutoutError extends Error {
  constructor(status, body) {
    super(`cutout: HTTP ${status}: ${body}`);
    this.name = "CutoutError";
    this.status = status;
    this.body = body;
  }
}

export class CutoutClient {
  constructor({ baseUrl, token, agentId, timeoutMs } = {}) {
    this.baseUrl = (baseUrl || process.env.CUTOUT_URL ||
                    "http://127.0.0.1:8765").replace(/\/+$/, "");
    this.token = token || process.env.CUTOUT_TOKEN;
    if (!this.token) throw new CutoutError(0, "set CUTOUT_TOKEN");
    this.agentId = agentId || process.env.CUTOUT_AGENT_ID || null;
    this.timeoutMs = timeoutMs || 75000;
  }

  async _request(method, path, { body, params, timeoutMs } = {}) {
    let url = this.baseUrl + path;
    if (params) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) qs.append(k, String(v));
      }
      const s = qs.toString();
      if (s) url += "?" + s;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(),
                             timeoutMs || this.timeoutMs);
    try {
      const resp = await fetch(url, {
        method,
        headers: {
          "Authorization": "Bearer " + this.token,
          ...(this.agentId ? { "X-Agent-Id": this.agentId } : {}),
          ...(body !== undefined
              ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await resp.text();
      if (!resp.ok) throw new CutoutError(resp.status, text);
      return text ? JSON.parse(text) : {};
    } catch (err) {
      if (err instanceof CutoutError) throw err;
      throw new CutoutError(0, String(err && err.message || err));
    } finally {
      clearTimeout(timer);
    }
  }

  // -- API ------------------------------------------------------------

  postMessage({ threadId, from, to, type, body, replyTo, metadata,
                idempotencyKey }) {
    const payload = { thread_id: threadId, from, to, type, body };
    if (replyTo) payload.reply_to = replyTo;
    if (metadata !== undefined) payload.metadata = metadata;
    // safe to retry: the server returns the original message with
    // "duplicate": true instead of appending again
    if (idempotencyKey) payload.idempotency_key = idempotencyKey;
    return this._request("POST", "/v1/messages", { body: payload });
  }

  resolveThread({ threadId, from, to = "*", body = "Resolved.",
                  metadata }) {
    // Mark a thread resolved (reopened by any later message).
    return this.postMessage({ threadId, from, to, type: "resolve",
                              body, metadata });
  }

  getMessages({ since, threadId, to, wait = 0, limit = 50 } = {}) {
    // long-poll: allow the server `wait` seconds plus headroom
    const timeoutMs = wait === 0 ? this.timeoutMs : (wait + 15) * 1000;
    return this._request("GET", "/v1/messages", {
      params: { since, thread_id: threadId, to, wait, limit },
      timeoutMs,
    });
  }

  postReceipt({ messageId, agent, status }) {
    return this._request("POST", "/v1/receipts", {
      body: { message_id: messageId, agent, status },
    });
  }

  getThreads() {
    return this._request("GET", "/v1/threads");
  }
}
