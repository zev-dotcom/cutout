// Cutout Bus - Supabase Edge Function port of the SPEC v1.1 reference server.
// Wire-compatible with SPEC.md v1.1: same endpoints, fields, status codes.
// Config via env only (no secrets in code): CUTOUT_TOKEN, SUPABASE_DB_URL (auto).
import postgres from "npm:postgres@3.4.5";
const DB_URL = Deno.env.get("SUPABASE_DB_URL");
const BUS_TOKEN = Deno.env.get("CUTOUT_TOKEN") ?? "";
const RETENTION_DAYS = 30;
// Requests per minute per token; CUTOUT_RATE_LIMIT overrides (default 60).
const RATE_LIMIT_ENV = Number(Deno.env.get("CUTOUT_RATE_LIMIT") ?? "60");
const RATE_LIMIT_PER_MIN = Number.isInteger(RATE_LIMIT_ENV) && RATE_LIMIT_ENV >= 1 ? RATE_LIMIT_ENV : 60;
const MAX_BODY_BYTES = 20 * 1024;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_IDEMPOTENCY_KEY = 128;
const VERSION = "1.1";
const TYPES = [
  "note",
  "question",
  "decision",
  "task",
  "link",
  "receipt-info",
  "resolve"
];
const RECEIPT_STATUSES = [
  "received",
  "acted",
  "consumed"
];
// Edge clients and intermediary proxies can drop silent requests well before the platform idle limit.
// Keep a response budget for database operations and network transit after the hold.
const MAX_HOLD_SECONDS = 10;
const HOLD_MARGIN_MS = 2000;
const QUERY_TIMEOUT_MS = 1500;
// Route through the Supavisor transaction pooler: the direct connection's
// slots are limited and shared with the app's other traffic. Host overridable
// via POOLER_HOST (public hostname, not a secret).
function poolerUrl(direct) {
  const host = Deno.env.get("POOLER_HOST");
  if (!host) return direct;
  const u = new URL(direct);
  const ref = u.hostname.replace(/^db\./, "").split(".")[0]; // db.<ref>.supabase.co -> <ref>
  u.hostname = host;
  u.port = "6543";
  u.username = `postgres.${ref}`;
  return u.toString();
}
const DB_OPTIONS = {
  prepare: false,
  max: 2,
  connect_timeout: 2,
  idle_timeout: 20
};
let sql = postgres(poolerUrl(DB_URL), DB_OPTIONS);
function recycleDb(client) {
  if (sql !== client) return;
  sql = postgres(poolerUrl(DB_URL), DB_OPTIONS);
  // Destroy suspect connections rather than waiting for a hung PostgreSQL socket.
  client.end({
    timeout: 0
  }).catch((e)=>console.error("db recycle failed", e));
}
async function timedQuery(query, label, timeoutMs = QUERY_TIMEOUT_MS) {
  const start = Date.now();
  const client = sql;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(query),
      new Promise((_, reject)=>{
        timer = setTimeout(()=>reject(new Error(`db ${label} timed out`)), timeoutMs);
      })
    ]);
  } catch (e) {
    if (String(e).includes(`db ${label} timed out`) || e?.code === "CONNECT_TIMEOUT") recycleDb(client);
    throw e;
  } finally{
    clearTimeout(timer);
    console.log(`cutout ${label}_ms=${Date.now() - start}`);
  }
}
// SPEC: purge runs at startup (cold start here) and at least daily (pg_cron job).
const startupPurge = timedQuery(sql`select cutout.purge(${RETENTION_DAYS})`, "startup_purge", 2000).catch((e)=>console.error("startup purge failed", e));
// ---- ULID (Crockford base32, 48-bit time + 80-bit random) -------------------
const C32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(now = Date.now()) {
  let time = now;
  let out = "";
  for(let i = 0; i < 10; i++){
    out = C32[time % 32] + out;
    time = Math.floor(time / 32);
  }
  const buf = new Uint8Array(80);
  crypto.getRandomValues(buf);
  for(let i = 0; i < 16; i++)out += C32[buf[i] & 31];
  return out;
}
// ---- helpers ----------------------------------------------------------------
function jres(status, obj, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      ...extraHeaders
    }
  });
}
const iso = (d)=>new Date(d).toISOString();
// Cursor payload: "<created_at as epoch microseconds>|<id>". Numeric microseconds
// avoid timestamp-typed parameter serialization (which drops sub-millisecond
// precision and would re-include the boundary row).
function encodeCursor(createdUs, id) {
  return "cursor_" + btoa(`${createdUs}|${id}`).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function decodeCursor(c) {
  if (!c.startsWith("cursor_")) return null;
  try {
    const raw = atob(c.slice(7).replaceAll("-", "+").replaceAll("_", "/"));
    const i = raw.indexOf("|");
    if (i < 0) return null;
    const usStr = raw.slice(0, i), id = raw.slice(i + 1);
    if (!/^\d{10,17}$/.test(usStr) || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
    return {
      us: Number(usStr),
      id
    };
  } catch  {
    return null;
  }
}
function serialize(m) {
  return {
    id: m.id,
    thread_id: m.thread_id,
    from: m.from_agent,
    to: m.to_agent,
    type: m.type,
    body: m.body,
    reply_to: m.reply_to ?? null,
    created_at: iso(m.created_at),
    metadata: m.metadata ?? {}
  };
}
async function rateState() {
  const rows = await timedQuery(sql`
    select count(*)::int as c, extract(epoch from min(at))::float8 as oldest
    from cutout.rate_log where at > now() - interval '1 minute'`, "rate_state");
  return {
    count: rows[0].c,
    oldestEpoch: rows[0].oldest === null ? null : Number(rows[0].oldest)
  };
}
function rateHeaders(s) {
  const nowS = Date.now() / 1000;
  const reset = s.oldestEpoch === null ? Math.ceil(nowS) : Math.ceil(s.oldestEpoch + 60);
  return {
    "X-RateLimit-Limit": String(RATE_LIMIT_PER_MIN),
    "X-RateLimit-Remaining": String(Math.max(0, RATE_LIMIT_PER_MIN - s.count)),
    "X-RateLimit-Reset": String(reset)
  };
}
async function rateLimit() {
  // Log only admitted requests: a rejected (429) request is not counted, so
  // retrying while limited does not extend the lockout.
  const admitted = await timedQuery(sql`
    insert into cutout.rate_log (at)
    select now()
    where (select count(*) from cutout.rate_log where at > now() - interval '1 minute') < ${RATE_LIMIT_PER_MIN}
    returning at`, "rate_limit_insert");
  const state = await rateState();
  if (admitted.length === 0) {
    const nowS = Date.now() / 1000;
    const retryAfter = state.oldestEpoch === null ? 1 : Math.max(1, Math.ceil(state.oldestEpoch + 60 - nowS));
    return {
      limited: jres(429, {
        error: "rate limit exceeded"
      }, {
        "Retry-After": String(retryAfter)
      }),
      state
    };
  }
  return {
    limited: null,
    state
  };
}
function validAttachments(a) {
  if (!Array.isArray(a)) return "metadata.attachments must be an array";
  for (const [i, x] of a.entries()){
    if (typeof x !== "object" || x === null || Array.isArray(x)) return `attachments[${i}] must be an object`;
    const o = x;
    if (typeof o.name !== "string" || o.name.length === 0) return `attachments[${i}].name is required`;
    if (typeof o.url !== "string") return `attachments[${i}].url is required`;
    try {
      const p = new URL(o.url).protocol;
      if (p !== "https:" && p !== "http:") return `attachments[${i}].url must be http(s)`;
    } catch  {
      return `attachments[${i}].url must be a valid URL`;
    }
    if (o.mime !== undefined && o.mime !== null && typeof o.mime !== "string") return `attachments[${i}].mime must be a string`;
    if (o.size !== undefined && o.size !== null && !(Number.isInteger(o.size) && o.size >= 0)) {
      return `attachments[${i}].size must be a non-negative integer`;
    }
  }
  return null;
}
// A consumed or expired one-time link keeps no URL (SPEC: never re-share).
const REDACTED_LINK = {
  consumed: true,
  url: null,
  url_redacted: true
};
const LINK_SKEW_MS = 5 * 60 * 1000; // SPEC: clock skew tolerance for expiry checks
function staleLink(link: unknown) {
  if (typeof link !== "object" || link === null || Array.isArray(link)) return false;
  const l = link as Record<string, unknown>;
  if (l.url_redacted) return false;
  if (l.consumed) return true;
  const exp = typeof l.expires_at === "string" ? Date.parse(l.expires_at) : NaN;
  return exp < Date.now() - LINK_SKEW_MS; // unparseable -> NaN -> false
}
async function redactLinks(ids: string[], label: string) {
  await timedQuery(sql`update cutout.messages
    set metadata = jsonb_set(metadata, '{one_time_link}',
                             (metadata->'one_time_link')
                               || '{"consumed": true, "url": null, "url_redacted": true}'::jsonb, false)
    where id = any(${ids}) and jsonb_typeof(metadata->'one_time_link') = 'object'`, label);
}
// RFC 3339 timestamp with an explicit offset, checked field by field so every
// accepted value also casts cleanly to timestamptz in the retention purge.
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-](0\d|1[0-4]):[0-5]\d)$/i;
function validTimestamp(s: unknown) {
  const m = typeof s === "string" ? TIMESTAMP_RE.exec(s) : null;
  if (!m) return false;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return y >= 1 && days !== undefined && d >= 1 && d <= days && h <= 23 && mi <= 59 && sec <= 59;
}
function validOneTimeLink(link: unknown) {
  if (typeof link !== "object" || link === null || Array.isArray(link)) return null;
  const o = link as Record<string, unknown>;
  if (o.expires_at !== undefined && o.expires_at !== null && !validTimestamp(o.expires_at)) {
    return "metadata.one_time_link.expires_at must be an ISO 8601 timestamp with a timezone";
  }
  if (o.consumed !== undefined && o.consumed !== null && typeof o.consumed !== "boolean") {
    return "metadata.one_time_link.consumed must be a boolean";
  }
  return null;
}
// ---- handlers ---------------------------------------------------------------
async function postMessage(req, auth) {
  let body;
  try {
    body = await req.json();
  } catch  {
    return jres(400, {
      error: "invalid JSON"
    });
  }
  for (const f of [
    "thread_id",
    "from",
    "to",
    "type",
    "body"
  ]){
    if (typeof body[f] !== "string" || body[f].length === 0) {
      return jres(422, {
        error: `${f} is required`
      });
    }
  }
  if (!TYPES.includes(body.type)) {
    return jres(422, {
      error: `type must be one of ${TYPES.join(", ")}`
    });
  }
  if (new TextEncoder().encode(body.body).length > MAX_BODY_BYTES) {
    return jres(413, {
      error: "body exceeds 20 KB"
    });
  }
  if (body.reply_to !== undefined && body.reply_to !== null && typeof body.reply_to !== "string") {
    return jres(422, {
      error: "reply_to must be a string"
    });
  }
  if (body.metadata !== undefined && (typeof body.metadata !== "object" || body.metadata === null || Array.isArray(body.metadata))) {
    return jres(422, {
      error: "metadata must be an object"
    });
  }
  const metadata = body.metadata ?? {};
  if (new TextEncoder().encode(JSON.stringify(metadata)).length > MAX_METADATA_BYTES) {
    return jres(413, {
      error: "metadata exceeds 16 KB"
    });
  }
  if (metadata.attachments !== undefined) {
    const err = validAttachments(metadata.attachments);
    if (err) return jres(422, {
      error: err
    });
  }
  const linkErr = validOneTimeLink(metadata.one_time_link);
  if (linkErr) return jres(422, {
    error: linkErr
  });
  // Smith: identity binding + thread membership. Legacy callers keep v1.1 semantics.
  if (auth.kind === "owner") {
    if (body.from !== OWNER_ID) return jres(403, {
      error: "from must match authenticated agent"
    });
  } else if (auth.kind === "agent") {
    if (body.from !== auth.agentId) return jres(403, {
      error: "from must match authenticated agent"
    });
  } else if (auth.agentId && body.from !== auth.agentId) {
    return jres(403, {
      error: "from must match authenticated agent"
    });
  }
  if (await isManagedThread(body.thread_id)) {
    if (auth.kind === "legacy") {
      // God token: full access with identity. Only the no-identity case is
      // denied on managed threads (nothing to attribute the write to).
      if (!auth.agentId) return jres(403, {
        error: "not a thread member"
      });
    } else if (!await isThreadMember(auth, body.thread_id)) {
      return jres(403, {
        error: "not a thread member"
      });
    }
  } else if (auth.kind === "agent") {
    // Agents write only threads they belong to; new threads are born via POST /v1/threads.
    return jres(403, {
      error: "not a thread member"
    });
  }
  let idemKey = null;
  if (body.idempotency_key !== undefined && body.idempotency_key !== null) {
    if (typeof body.idempotency_key !== "string" || body.idempotency_key.length === 0 || body.idempotency_key.length > MAX_IDEMPOTENCY_KEY) {
      return jres(422, {
        error: `idempotency_key must be a non-empty string of at most ${MAX_IDEMPOTENCY_KEY} characters`
      });
    }
    idemKey = body.idempotency_key;
  }
  const from = body.from;
  const findDup = async ()=>idemKey === null ? [] : await sql`
    select m.id, m.created_at from cutout.idempotency_keys k
    join cutout.messages m on m.id = k.message_id
    where k.from_agent = ${from} and k.idem_key = ${idemKey}`;
  // Keys are honored for the retention window: the key row cascades away with
  // its message when the purge removes it.
  const dup = await timedQuery(findDup(), "find_duplicate");
  if (dup.length) return jres(200, {
    id: dup[0].id,
    created_at: iso(dup[0].created_at),
    duplicate: true
  });
  const id = "msg_" + ulid();
  try {
    const rows = await timedQuery(sql.begin(async (tx)=>{
      const r = await tx`
        insert into cutout.messages (id, thread_id, from_agent, to_agent, type, body, reply_to, metadata)
        values (${id}, ${body.thread_id}, ${from}, ${body.to},
                ${body.type}, ${body.body},
                ${body.reply_to ?? null}, ${sql.json(metadata)})
        returning id, created_at`;
      if (idemKey !== null) {
        await tx`insert into cutout.idempotency_keys (from_agent, idem_key, message_id)
                 values (${from}, ${idemKey}, ${id})`;
      }
      if (auth.kind === "owner") {
        await tx`insert into smith_audit (actor, action, detail)
                 values ('owner', 'send_message', ${sql.json({ thread_id: body.thread_id })})`;
      }
      return r;
    }), "post_transaction", 3500);
    return jres(201, {
      id: rows[0].id,
      created_at: iso(rows[0].created_at)
    });
  } catch (e) {
    // Concurrent re-post of the same key lost the race: return the winner.
    if (e.code === "23505" && idemKey !== null) {
      const d = await timedQuery(findDup(), "find_duplicate_retry");
      if (d.length) return jres(200, {
        id: d[0].id,
        created_at: iso(d[0].created_at),
        duplicate: true
      });
    }
    throw e;
  }
}
async function getMessages(req, arrivedAt, auth) {
  const u = new URL(req.url);
  const since = u.searchParams.get("since");
  const threadId = u.searchParams.get("thread_id");
  const to = u.searchParams.get("to");
  const agentId = req.headers.get("X-Agent-Id");
  // Smith: the owner never reads through the agent route; agent-token callers
  // see only threads they belong to, with identity from the token, never the header.
  if (auth.kind === "owner") return jres(403, {
    error: "owner reads must use /v1/owner/*"
  });
  const scopeAgent = auth.kind === "agent" ? auth.agentId : agentId;
  if (threadId && auth.kind === "agent") {
    if (!await isManagedThread(threadId) || !await isThreadMember(auth, threadId)) {
      return jres(403, {
        error: "not a thread member"
      });
    }
  }
  let wait = 0, limit = 50;
  if (u.searchParams.has("wait")) {
    wait = Number(u.searchParams.get("wait"));
    if (!Number.isFinite(wait) || wait < 0 || wait > 60) return jres(422, {
      error: "wait must be between 0 and 60"
    });
  }
  if (u.searchParams.has("limit")) {
    limit = Number(u.searchParams.get("limit"));
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return jres(422, {
      error: "limit must be between 1 and 100"
    });
  }
  let cursor = null;
  if (since) {
    cursor = decodeCursor(since);
    if (!cursor) return jres(422, {
      error: "invalid since cursor"
    });
  }
  const queryOnce = async ()=>{
    const q = sql`
      select id, thread_id, from_agent, to_agent, type, body, reply_to, created_at,
             (extract(epoch from created_at) * 1000000)::bigint as created_us, metadata
      from cutout.messages
      where true
      ${cursor ? sql`and ((extract(epoch from created_at) * 1000000)::bigint > ${cursor.us} or ((extract(epoch from created_at) * 1000000)::bigint = ${cursor.us} and id > ${cursor.id}))` : sql``}
      ${threadId ? sql`and thread_id = ${threadId}` : sql``}
      ${to ? sql`and to_agent = ${to}` : scopeAgent ? sql`and (to_agent = ${scopeAgent} or to_agent = '*')` : sql``}
      ${auth.kind === "agent" ? sql`and thread_id in (select thread_id from smith_thread_members where agent_id = ${auth.agentId})` : sql``}
      order by created_at asc, id asc
      limit ${limit}`;
    return await timedQuery(q, "query_once");
  };
  // Deadline counts from request arrival (before auth/rate-limit DB work).
  // Margin is 2s, but never more than 20% of the hold, so short waits keep
  // roughly their requested length.
  const holdMs = Math.min(wait, MAX_HOLD_SECONDS) * 1000;
  const deadline = arrivedAt + holdMs - Math.min(HOLD_MARGIN_MS, holdMs * 0.2);
  const holdStarted = Date.now();
  let rows = await queryOnce();
  while(rows.length === 0 && Date.now() < deadline){
    await new Promise((r)=>setTimeout(r, Math.max(0, Math.min(1000, deadline - Date.now()))));
    rows = await queryOnce();
  }
  console.log(`cutout poll_hold_ms=${Date.now() - holdStarted} requested_wait=${wait} effective_wait=${Math.min(wait, MAX_HOLD_SECONDS)}`);
  return getMessagesTail(rows, since);
}
// Shared by GET /v1/messages and the Smith thread feeds: stale one-time-link
// redaction plus per-message receipts. Behavior is identical everywhere it is used.
async function enrichMessages(rows, redactLabel) {
  const staleIds = [];
  for (const r of rows){
    if (!staleLink(r.metadata?.one_time_link)) continue;
    Object.assign(r.metadata.one_time_link, REDACTED_LINK);
    staleIds.push(r.id);
  }
  if (staleIds.length) await redactLinks(staleIds, redactLabel);
  const receiptsBy = new Map();
  if (rows.length) {
    const ids = rows.map((r)=>r.id);
    const rc = await timedQuery(sql`
      select message_id, agent, status, at from cutout.receipts
      where message_id = any(${ids}) order by at asc, agent asc`, "receipts");
    for (const r of rc){
      const list = receiptsBy.get(r.message_id) ?? [];
      list.push({
        agent: r.agent,
        status: r.status,
        at: iso(r.at)
      });
      receiptsBy.set(r.message_id, list);
    }
  }
  return rows.map((r)=>({
      ...serialize(r),
      receipts: receiptsBy.get(r.id) ?? []
    }));
}
async function getMessagesTail(rows, since) {
  const messages = await enrichMessages(rows, "redact_stale_links");
  const nextCursor = rows.length ? encodeCursor(Number(rows[rows.length - 1].created_us), rows[rows.length - 1].id) : since ?? null;
  return jres(200, {
    messages,
    next_cursor: nextCursor
  });
}
async function postReceipt(req, auth) {
  let body;
  try {
    body = await req.json();
  } catch  {
    return jres(400, {
      error: "invalid JSON"
    });
  }
  for (const f of [
    "message_id",
    "agent",
    "status"
  ]){
    if (typeof body[f] !== "string" || body[f].length === 0) {
      return jres(422, {
        error: `${f} is required`
      });
    }
  }
  if (!RECEIPT_STATUSES.includes(body.status)) {
    return jres(422, {
      error: `status must be one of ${RECEIPT_STATUSES.join(", ")}`
    });
  }
  let at = new Date();
  if (body.at !== undefined && body.at !== null) {
    at = new Date(body.at);
    if (Number.isNaN(at.getTime())) return jres(422, {
      error: "at must be an ISO 8601 timestamp"
    });
  }
  const mid = body.message_id, agent = body.agent, status = body.status;
  // Smith: receipts are written only for the authenticated identity. No writing
  // receipts for someone else. Legacy callers without an agent id keep v1.1 semantics.
  if (auth.kind === "owner") {
    if (agent !== OWNER_ID) return jres(403, {
      error: "agent must match authenticated agent"
    });
  } else if (auth.kind === "agent") {
    if (agent !== auth.agentId) return jres(403, {
      error: "agent must match authenticated agent"
    });
  } else if (auth.agentId && agent !== auth.agentId) {
    return jres(403, {
      error: "agent must match authenticated agent"
    });
  }
  const exists = await timedQuery(sql`select metadata from cutout.messages where id = ${mid}`, "receipt_exists");
  if (exists.length === 0) return jres(404, {
    error: "message not found"
  });
  await timedQuery(sql`
    insert into cutout.receipts (message_id, agent, status, at) values (${mid}, ${agent}, ${status}, ${at.toISOString()})
    on conflict (message_id, agent) do update set status = excluded.status, at = excluded.at`, "receipt_write");
  if (status === "consumed" && exists[0].metadata?.one_time_link) {
    await redactLinks([
      mid
    ], "consumed_update");
  }
  return jres(201, {
    ok: true
  });
}
async function getThreads(req) {
  const agentId = req.headers.get("X-Agent-Id");
  const rows = await timedQuery(sql`
    select m.thread_id, max(m.created_at) as last_at,
      (array_agg(m.type order by m.created_at desc, m.id desc))[1] as last_type,
      ${agentId ? sql`count(*) filter (
        where (m.to_agent = ${agentId} or m.to_agent = '*')
          and not exists (select 1 from cutout.receipts r where r.message_id = m.id and r.agent = ${agentId})
      )::int` : sql`0`} as unread
    from cutout.messages m
    group by m.thread_id
    order by last_at desc`, "threads");
  return jres(200, {
    // Resolved iff the latest message is a resolve; any later non-resolve message reopens.
    threads: rows.map((r)=>({
        thread_id: r.thread_id,
        last_at: iso(r.last_at),
        unread: r.unread,
        status: r.last_type === "resolve" ? "resolved" : "open",
        resolved_at: r.last_type === "resolve" ? iso(r.last_at) : null
      }))
  });
}
// ---- Smith v1 (additive) ------------------------------------------------------
// Identity, pairing, thread ACLs, working-on-reply activity, owner audit.
// Additive on SPEC v1.1: every v1.1 route keeps its path, fields, and status
// codes for legacy callers. New routes live under the same /v1/ prefix.
const SMITH_VERSION = "1.0";
const OWNER_ID = "owner";
const PAIRING_CODE_LEN = 6;
const PAIRING_DEFAULT_HOURS = 24;
const PAIRING_MAX_HOURS = 720; // 30 days
const ACTIVITY_TTL_SECONDS = 30;
const REDEEM_LIMIT_PER_MIN = 10;
const MAX_THREAD_NAME = 200;
const RESERVED_AGENT_RE = /^owner$/i;

async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b)=>b.toString(16).padStart(2, "0")).join("");
}
function randomHexBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b).map((x)=>x.toString(16).padStart(2, "0")).join("");
}
// 6 chars from the Crockford set (C32), displayed as XXXX-XX. The stored hash
// covers the 6 raw chars; redeem normalizes input (case, hyphen) before hashing.
function newPairingCode() {
  const b = new Uint8Array(PAIRING_CODE_LEN);
  crypto.getRandomValues(b);
  let raw = "";
  for (let i = 0; i < PAIRING_CODE_LEN; i++)raw += C32[b[i] & 31];
  return {
    raw,
    display: raw.slice(0, 4) + "-" + raw.slice(4)
  };
}
// Auth resolution order per request: sm_own_ -> owner (hash in smith_owner),
// sm_agt_ -> bound agent_id (reject revoked), else the legacy bus token with
// agent identity from X-Agent-Id when present, else null (caller sends 401).
// A recognized prefix that fails its lookup is 401, never a legacy fallthrough.
async function resolveAuth(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.get("Authorization") ?? "");
  if (!m) return null;
  const token = m[1];
  if (token.startsWith("sm_own_")) {
    const rows = await timedQuery(sql`select 1 from smith_owner where token_hash = ${await sha256Hex(token)}`, "auth_owner");
    return rows.length ? {
      kind: "owner",
      agentId: OWNER_ID
    } : null;
  }
  if (token.startsWith("sm_agt_")) {
    const rows = await timedQuery(sql`select agent_id, revoked_at from smith_agents where token_hash = ${await sha256Hex(token)}`, "auth_agent");
    if (!rows.length || rows[0].revoked_at !== null) return null;
    return {
      kind: "agent",
      agentId: rows[0].agent_id
    };
  }
  if (BUS_TOKEN && token === BUS_TOKEN) {
    const hid = req.headers.get("X-Agent-Id");
    return {
      kind: "legacy",
      agentId: hid && hid.length ? hid : null
    };
  }
  return null;
}
async function audit(actor, action, detail) {
  await timedQuery(sql`insert into smith_audit (actor, action, detail) values (${actor}, ${action}, ${sql.json(detail ?? {})})`, "audit_append");
}
async function isManagedThread(threadId) {
  const rows = await timedQuery(sql`select 1 from smith_threads where thread_id = ${threadId}`, "thread_managed");
  return rows.length > 0;
}
async function isThreadMember(auth, threadId) {
  if (auth.kind === "owner") return true; // implicit member of every thread
  if (!auth.agentId) return false;
  const rows = await timedQuery(sql`select 1 from smith_thread_members where thread_id = ${threadId} and agent_id = ${auth.agentId}`, "member_check");
  return rows.length > 0;
}
// 404 when the thread is unmanaged, 403 when the caller is not a member, else null.
// Legacy callers keep the god token: full access with an agent identity; only
// the no-identity case is denied on managed threads.
async function threadAccess(auth, threadId) {
  if (!await isManagedThread(threadId)) return jres(404, {
    error: "thread not found"
  });
  if (auth.kind === "legacy") {
    return auth.agentId ? null : jres(403, {
      error: "not a thread member"
    });
  }
  if (!await isThreadMember(auth, threadId)) return jres(403, {
    error: "not a thread member"
  });
  return null;
}
async function memberObjects(threadId) {
  const rows = await timedQuery(sql`
    select tm.agent_id, a.display_name, a.platform from smith_thread_members tm
    left join smith_agents a on a.agent_id = tm.agent_id
    where tm.thread_id = ${threadId} order by tm.agent_id asc`, "thread_members");
  return rows.map((r)=>({
      agent_id: r.agent_id,
      display_name: r.display_name ?? r.agent_id,
      platform: r.platform ?? "unknown"
    }));
}
// ---- threads ----------------------------------------------------------------
async function postThread(req, auth) {
  let body;
  try {
    body = await req.json();
  } catch  {
    return jres(400, {
      error: "invalid JSON"
    });
  }
  let name = null;
  if (body.name !== undefined && body.name !== null) {
    if (typeof body.name !== "string" || body.name.length === 0 || body.name.length > MAX_THREAD_NAME) {
      return jres(422, {
        error: `name must be a non-empty string of at most ${MAX_THREAD_NAME} characters`
      });
    }
    name = body.name;
  }
  let memberIds = [];
  if (body.member_ids !== undefined && body.member_ids !== null) {
    if (!Array.isArray(body.member_ids) || body.member_ids.some((x)=>typeof x !== "string" || x.length === 0)) {
      return jres(422, {
        error: "member_ids must be an array of agent id strings"
      });
    }
    memberIds = [...new Set(body.member_ids)];
  }
  for (const mid of memberIds){
    if (RESERVED_AGENT_RE.test(mid)) return jres(422, {
      error: "agent_id 'owner' is reserved"
    });
  }
  let tid;
  if (body.thread_id !== undefined && body.thread_id !== null) {
    if (typeof body.thread_id !== "string" || !/^x_cutout_thread/.test(body.thread_id)) {
      return jres(422, {
        error: "thread_id must be an x_cutout_thread-style id"
      });
    }
    tid = body.thread_id;
  } else {
    tid = "th_" + ulid();
  }
  const dup = await timedQuery(sql`select 1 from smith_threads where thread_id = ${tid}`, "thread_exists");
  if (dup.length) return jres(409, {
    error: "thread already exists"
  });
  // Agent creators may only name existing, non-revoked agents. Owner creators
  // may name unknown ids; they become stub rows (known id, no Smith token yet).
  const known = await timedQuery(sql`select agent_id, revoked_at from smith_agents where agent_id = any(${memberIds})`, "members_known");
  const knownMap = new Map(known.map((r)=>[
      r.agent_id,
      r.revoked_at
    ]));
  for (const mid of memberIds){
    const rev = knownMap.get(mid);
    if (auth.kind === "owner") {
      if (rev === undefined) {
        await timedQuery(sql`insert into smith_agents (agent_id, display_name, platform) values (${mid}, ${mid}, 'unknown') on conflict (agent_id) do nothing`, "member_stub");
      } else if (rev !== null) {
        return jres(422, {
          error: `agent is revoked: ${mid}`
        });
      }
    } else if (rev === undefined || rev !== null) {
      return jres(422, {
        error: `unknown or revoked agent: ${mid}`
      });
    }
  }
  await timedQuery(sql.begin(async (tx)=>{
    await tx`insert into smith_threads (thread_id, name, created_by) values (${tid}, ${name}, ${auth.agentId})`;
    // Adopt pre-existing legacy messages on this id, if any.
    await tx`insert into smith_thread_members (thread_id, agent_id)
             select ${tid}, from_agent from cutout.messages
             where thread_id = ${tid} and from_agent is not null and from_agent <> '*'
             on conflict do nothing`;
    await tx`insert into smith_thread_members (thread_id, agent_id)
             select ${tid}, to_agent from cutout.messages
             where thread_id = ${tid} and to_agent is not null and to_agent <> '*'
             on conflict do nothing`;
    const all = auth.kind === "owner" ? memberIds : [
      auth.agentId,
      ...memberIds
    ];
    for (const mid of all){
      await tx`insert into smith_thread_members (thread_id, agent_id) values (${tid}, ${mid}) on conflict do nothing`;
    }
  }), "thread_create", 3500);
  return jres(201, {
    thread_id: tid,
    name,
    members: await memberObjects(tid)
  });
}
async function listThreadsSmith(auth) {
  const aid = auth.agentId;
  const scope = auth.kind === "owner" ? sql`` : sql`where t.thread_id in (select thread_id from smith_thread_members where agent_id = ${aid})`;
  const threads = await timedQuery(sql`
    select t.thread_id, t.name, max(m.created_at) as last_at,
      count(*) filter (where (m.to_agent = ${aid} or m.to_agent = '*')
        and not exists (select 1 from cutout.receipts r where r.message_id = m.id and r.agent = ${aid}))::int as unread
    from smith_threads t
    left join cutout.messages m on m.thread_id = t.thread_id
    ${scope}
    group by t.thread_id, t.name
    order by last_at desc nulls last`, "smith_thread_list");
  const tids = threads.map((t)=>t.thread_id);
  const membersBy = new Map(), workingBy = new Map();
  if (tids.length) {
    const mrows = await timedQuery(sql`
      select tm.thread_id, tm.agent_id, a.display_name, a.platform
      from smith_thread_members tm left join smith_agents a on a.agent_id = tm.agent_id
      where tm.thread_id = any(${tids}) order by tm.thread_id asc, tm.agent_id asc`, "smith_thread_members");
    for (const r of mrows){
      const list = membersBy.get(r.thread_id) ?? [];
      list.push({
        agent_id: r.agent_id,
        display_name: r.display_name ?? r.agent_id,
        platform: r.platform ?? "unknown"
      });
      membersBy.set(r.thread_id, list);
    }
    const wrows = await timedQuery(sql`
      select thread_id, agent_id from smith_activity
      where thread_id = any(${tids}) and expires_at > now() order by thread_id asc, agent_id asc`, "smith_thread_working");
    for (const r of wrows){
      const list = workingBy.get(r.thread_id) ?? [];
      list.push(r.agent_id);
      workingBy.set(r.thread_id, list);
    }
  }
  return {
    threads: threads.map((t)=>({
        thread_id: t.thread_id,
        name: t.name,
        last_at: t.last_at ? iso(t.last_at) : null,
        unread: t.unread,
        members: membersBy.get(t.thread_id) ?? [],
        working: workingBy.get(t.thread_id) ?? []
      }))
  };
}
async function renameThread(req, auth, threadId) {
  const denied = await threadAccess(auth, threadId);
  if (denied) return denied;
  let body;
  try {
    body = await req.json();
  } catch  {
    return jres(400, {
      error: "invalid JSON"
    });
  }
  if (typeof body.name !== "string" || body.name.length === 0 || body.name.length > MAX_THREAD_NAME) {
    return jres(422, {
      error: `name must be a non-empty string of at most ${MAX_THREAD_NAME} characters`
    });
  }
  const cur = await timedQuery(sql`select name from smith_threads where thread_id = ${threadId}`, "thread_name");
  const oldName = cur.length ? cur[0].name : null;
  const noteId = "msg_" + ulid();
  await timedQuery(sql.begin(async (tx)=>{
    await tx`update smith_threads set name = ${body.name} where thread_id = ${threadId}`;
    // Renames are data, not message edits: append a note message carrying the
    // compat key, matching the UI contract.
    await tx`insert into cutout.messages (id, thread_id, from_agent, to_agent, type, body, metadata)
             values (${noteId}, ${threadId}, ${auth.agentId}, '*', 'note',
                     ${"Chat renamed to \"" + body.name + "\""},
                     ${sql.json({ x_cutout_thread_rename: { from: oldName, to: body.name } })})`;
  }), "thread_rename", 3500);
  return jres(200, {
    thread_id: threadId,
    name: body.name
  });
}
async function addMember(req, auth, threadId) {
  const denied = await threadAccess(auth, threadId);
  if (denied) return denied;
  let body;
  try {
    body = await req.json();
  } catch  {
    return jres(400, {
      error: "invalid JSON"
    });
  }
  const aid = body.agent_id;
  if (typeof aid !== "string" || aid.length === 0) return jres(422, {
    error: "agent_id is required"
  });
  if (RESERVED_AGENT_RE.test(aid)) return jres(422, {
    error: "agent_id 'owner' is reserved"
  });
  const rows = await timedQuery(sql`select revoked_at from smith_agents where agent_id = ${aid}`, "member_agent");
  if (!rows.length || rows[0].revoked_at !== null) return jres(422, {
    error: `unknown or revoked agent: ${aid}`
  });
  await timedQuery(sql`insert into smith_thread_members (thread_id, agent_id) values (${threadId}, ${aid}) on conflict do nothing`, "member_add");
  return jres(200, {
    thread_id: threadId,
    agent_id: aid
  });
}
// ---- thread feed (client's one-call view) -------------------------------------
function parseFeedQuery(req) {
  const u = new URL(req.url);
  let limit = 50;
  if (u.searchParams.has("limit")) {
    limit = Number(u.searchParams.get("limit"));
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return {
      error: jres(422, {
        error: "limit must be between 1 and 100"
      })
    };
  }
  let cursor = null;
  const since = u.searchParams.get("since");
  if (since) {
    cursor = decodeCursor(since);
    if (!cursor) return {
      error: jres(422, {
        error: "invalid since cursor"
      })
    };
  }
  return {
    limit,
    cursor,
    since
  };
}
async function feedMessages(threadId, cursor, limit) {
  return await timedQuery(sql`
    select id, thread_id, from_agent, to_agent, type, body, reply_to, created_at,
           (extract(epoch from created_at) * 1000000)::bigint as created_us, metadata
    from cutout.messages
    where thread_id = ${threadId}
    ${cursor ? sql`and ((extract(epoch from created_at) * 1000000)::bigint > ${cursor.us} or ((extract(epoch from created_at) * 1000000)::bigint = ${cursor.us} and id > ${cursor.id}))` : sql``}
    order by created_at asc, id asc
    limit ${limit}`, "feed_query");
}
async function buildFeed(threadId, q, redactLabel) {
  const rows = await feedMessages(threadId, q.cursor, q.limit);
  const messages = await enrichMessages(rows, redactLabel);
  // Working state is evaluated on read (expires_at > now()): a crashed agent's
  // dots clear within the TTL with no client timer to trust.
  const wrows = await timedQuery(sql`select agent_id, started_at from smith_activity where thread_id = ${threadId} and expires_at > now() order by agent_id asc`, "feed_working");
  return {
    messages,
    next_cursor: rows.length ? encodeCursor(Number(rows[rows.length - 1].created_us), rows[rows.length - 1].id) : q.since ?? null,
    working: wrows.map((r)=>({
        agent_id: r.agent_id,
        started_at: iso(r.started_at)
      }))
  };
}
async function threadFeed(req, auth, threadId) {
  const denied = await threadAccess(auth, threadId);
  if (denied) return denied;
  const q = parseFeedQuery(req);
  if (q.error) return q.error;
  return jres(200, await buildFeed(threadId, q, "feed_redact"));
}
// ---- working-on-reply activity (the cue dots) -----------------------------------
async function postActivity(req, auth) {
  const aid = auth.kind === "agent" ? auth.agentId : auth.kind === "legacy" ? auth.agentId : null;
  if (!aid) {
    return jres(403, {
      error: auth.kind === "owner" ? "owner cannot post activity" : "agent identity required"
    });
  }
  let body;
  try {
    body = await req.json();
  } catch  {
    return jres(400, {
      error: "invalid JSON"
    });
  }
  if (typeof body.thread_id !== "string" || body.thread_id.length === 0) return jres(422, {
    error: "thread_id is required"
  });
  if (body.state !== "working" && body.state !== "idle") return jres(422, {
    error: "state must be working or idle"
  });
  const denied = await threadAccess(auth, body.thread_id);
  if (denied) return denied;
  if (body.state === "working") {
    await timedQuery(sql`
      insert into smith_activity (thread_id, agent_id, started_at, expires_at)
      values (${body.thread_id}, ${aid}, now(), now() + (${ACTIVITY_TTL_SECONDS} * interval '1 second'))
      on conflict (thread_id, agent_id) do update set expires_at = excluded.expires_at`, "activity_working");
  } else {
    await timedQuery(sql`delete from smith_activity where thread_id = ${body.thread_id} and agent_id = ${aid}`, "activity_idle");
  }
  return jres(200, {
    ok: true
  });
}
// ---- pairing (owner issues, agent redeems) ---------------------------------------
async function issuePairing(req, auth) {
  if (auth.kind !== "owner") return jres(403, {
    error: "owner token required"
  });
  let body;
  try {
    body = await req.json();
  } catch  {
    return jres(400, {
      error: "invalid JSON"
    });
  }
  const aid = body.agent_id;
  if (typeof aid !== "string" || aid.length === 0) return jres(422, {
    error: "agent_id is required"
  });
  if (RESERVED_AGENT_RE.test(aid)) return jres(422, {
    error: "agent_id 'owner' is reserved"
  });
  if (typeof body.display_name !== "string" || body.display_name.length === 0) {
    return jres(422, {
      error: "display_name is required"
    });
  }
  const platform = body.platform === undefined || body.platform === null ? "unknown" : body.platform;
  if (typeof platform !== "string" || platform.length === 0) return jres(422, {
    error: "platform must be a string"
  });
  let hours = PAIRING_DEFAULT_HOURS;
  if (body.expires_in_hours !== undefined && body.expires_in_hours !== null) {
    hours = Number(body.expires_in_hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > PAIRING_MAX_HOURS) {
      return jres(422, {
        error: `expires_in_hours must be greater than 0 and at most ${PAIRING_MAX_HOURS}`
      });
    }
  }
  const existing = await timedQuery(sql`select revoked_at from smith_agents where agent_id = ${aid}`, "pairing_agent");
  if (existing.length && existing[0].revoked_at === null) return jres(409, {
    error: "agent already paired"
  });
  const code = newPairingCode();
  const pid = "pg_" + ulid();
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000);
  await timedQuery(sql.begin(async (tx)=>{
    if (existing.length) {
      await tx`update smith_agents set display_name = ${body.display_name}, platform = ${platform} where agent_id = ${aid}`;
    } else {
      await tx`insert into smith_agents (agent_id, display_name, platform) values (${aid}, ${body.display_name}, ${platform})`;
    }
    await tx`insert into smith_pairings (id, code_hash, agent_id, expires_at)
             values (${pid}, ${await sha256Hex(code.raw)}, ${aid}, ${expiresAt.toISOString()})`;
  }), "pairing_issue", 3500);
  await audit(OWNER_ID, "issue_pairing", {
    pairing_id: pid,
    agent_id: aid
  });
  return jres(201, {
    pairing_id: pid,
    code: code.display,
    agent_id: aid,
    expires_at: expiresAt.toISOString()
  });
}
// 10 attempts/minute per IP, tracked in memory per isolate. Guards the two
// unauthenticated routes (pairing redeem, owner claim); the code / setup key
// is the credential.
const redeemHits = new Map();
function redeemAllowed(ip) {
  const now = Date.now();
  const arr = (redeemHits.get(ip) ?? []).filter((t)=>now - t < 60000);
  if (arr.length >= REDEEM_LIMIT_PER_MIN) {
    redeemHits.set(ip, arr);
    return false;
  }
  arr.push(now);
  redeemHits.set(ip, arr);
  return true;
}
function clientIp(req) {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
async function redeemPairing(req) {
  let body;
  try {
    body = await req.json();
  } catch  {
    return jres(400, {
      error: "invalid JSON"
    });
  }
  // Normalize before hashing so "xxxx-xx", "XXXXXX", etc. all match. The
  // format check feeds the same 404 as a wrong code: no oracle.
  const raw = typeof body.code === "string" ? body.code.toUpperCase().replace(/[^0-9A-Z]/g, "") : "";
  const lookup = /^[0-9A-HJKMNP-TV-Z]{6}$/.test(raw) ? await timedQuery(sql`select id, agent_id, expires_at, redeemed_at from smith_pairings where code_hash = ${await sha256Hex(raw)}`, "pairing_lookup") : [];
  const bad = ()=>jres(404, {
      error: "invalid or expired pairing code"
    });
  if (!lookup.length) return bad();
  const p = lookup[0];
  if (p.redeemed_at !== null || new Date(p.expires_at).getTime() <= Date.now()) return bad();
  const token = "sm_agt_" + randomHexBytes(32);
  await timedQuery(sql.begin(async (tx)=>{
    // Redeeming rotates the token and un-revokes a re-paired agent.
    await tx`update smith_agents set token_hash = ${await sha256Hex(token)}, revoked_at = null where agent_id = ${p.agent_id}`;
    await tx`update smith_pairings set redeemed_at = now() where id = ${p.id}`;
  }), "pairing_redeem", 3500);
  const u = new URL(req.url);
  const instanceUrl = u.origin + u.pathname.replace(/\/v1\/.*$/, "").replace(/\/cutout$/, "");
  return jres(200, {
    agent_token: token,
    agent_id: p.agent_id,
    instance_url: instanceUrl
  });
}
// One-time owner bootstrap: mints the instance's first owner token. Gated by
// the deploy-time bus token (the setup key), which only the deployer knows.
// Single-use: once smith_owner has a row the route is gone (404). The setup
// key is checked in memory and never persisted; only the SHA-256 of the new
// owner token is stored. Rate-limited per IP like redeem.
async function claimOwner(req) {
  let body;
  try {
    body = await req.json();
  } catch  {
    return jres(400, {
      error: "invalid JSON"
    });
  }
  const existing = await timedQuery(sql`select 1 from smith_owner`, "claim_exists");
  if (existing.length) return jres(404, {
    error: "instance already claimed"
  });
  if (!BUS_TOKEN || body.setup_key !== BUS_TOKEN) {
    return jres(401, {
      error: "invalid setup key"
    });
  }
  const token = "sm_own_" + randomHexBytes(32);
  await timedQuery(sql.begin(async (tx)=>{
    await tx`insert into smith_owner (token_hash) values (${await sha256Hex(token)})`;
    await tx`insert into smith_audit (actor, action, detail) values ('owner', 'claim_owner', ${sql.json({})})`;
  }), "owner_claim", 3500);
  return jres(201, {
    owner_token: token
  });
}
// ---- owner ----------------------------------------------------------------------
function requireOwner(auth) {
  return auth.kind === "owner" ? null : jres(403, {
    error: "owner token required"
  });
}
async function ownerAgents(req, auth) {
  const denied = requireOwner(auth);
  if (denied) return denied;
  const rows = await timedQuery(sql`select agent_id, display_name, platform, created_at, revoked_at, (token_hash is not null) as has_token from smith_agents order by agent_id asc`, "owner_agents");
  return jres(200, {
    agents: rows.map((r)=>({
        agent_id: r.agent_id,
        display_name: r.display_name,
        platform: r.platform,
        created_at: iso(r.created_at),
        revoked_at: r.revoked_at ? iso(r.revoked_at) : null,
        has_token: r.has_token
      }))
  });
}
async function revokeAgent(req, auth, aid) {
  const denied = requireOwner(auth);
  if (denied) return denied;
  const rows = await timedQuery(sql`select 1 from smith_agents where agent_id = ${aid}`, "revoke_exists");
  if (!rows.length) return jres(404, {
    error: "agent not found"
  });
  await timedQuery(sql.begin(async (tx)=>{
    await tx`update smith_agents set revoked_at = now(), token_hash = null where agent_id = ${aid}`;
    await tx`delete from smith_thread_members where agent_id = ${aid}`;
    await tx`delete from smith_activity where agent_id = ${aid}`;
    // Kill outstanding pairing codes too: redeeming one would otherwise un-revoke.
    await tx`update smith_pairings set redeemed_at = now() where agent_id = ${aid} and redeemed_at is null`;
  }), "agent_revoke", 3500);
  await audit(OWNER_ID, "revoke_agent", {
    agent_id: aid
  });
  return jres(200, {
    ok: true
  });
}
async function rotateOwner(req, auth) {
  const denied = requireOwner(auth);
  if (denied) return denied;
  const token = "sm_own_" + randomHexBytes(32);
  await timedQuery(sql`update smith_owner set token_hash = ${await sha256Hex(token)} where id = 1`, "owner_rotate");
  await audit(OWNER_ID, "rotate_owner", {});
  return jres(200, {
    owner_token: token
  });
}
async function ownerFeed(req, auth, threadId) {
  const denied = requireOwner(auth);
  if (denied) return denied;
  if (!threadId) return jres(422, {
    error: "thread_id is required"
  });
  if (!await isManagedThread(threadId)) return jres(404, {
    error: "thread not found"
  });
  const q = parseFeedQuery(req);
  if (q.error) return q.error;
  const feed = await buildFeed(threadId, q, "owner_feed_redact");
  await audit(OWNER_ID, "read_thread", {
    thread_id: threadId
  });
  return jres(200, feed);
}
async function ownerThreads(req, auth) {
  const denied = requireOwner(auth);
  if (denied) return denied;
  const out = await listThreadsSmith(auth);
  await audit(OWNER_ID, "list_threads", {});
  return jres(200, out);
}
async function ownerAudit(req, auth) {
  const denied = requireOwner(auth);
  if (denied) return denied;
  const u = new URL(req.url);
  let limit = 50;
  if (u.searchParams.has("limit")) {
    limit = Number(u.searchParams.get("limit"));
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return jres(422, {
      error: "limit must be between 1 and 100"
    });
  }
  let sinceId = null;
  if (u.searchParams.has("since")) {
    sinceId = Number(u.searchParams.get("since"));
    if (!Number.isInteger(sinceId) || sinceId < 0) return jres(422, {
      error: "since must be an audit row id"
    });
  }
  const rows = await timedQuery(sql`
    select id, at, actor, action, detail from smith_audit
    ${sinceId !== null ? sql`where id > ${sinceId}` : sql``}
    order by id desc limit ${limit}`, "owner_audit");
  return jres(200, {
    audit: rows.map((r)=>({
        id: Number(r.id),
        at: iso(r.at),
        actor: r.actor,
        action: r.action,
        detail: r.detail ?? {}
      }))
  });
}
// ---- router -----------------------------------------------------------------
async function route(req, arrivedAt) {
  let path = new URL(req.url).pathname;
  path = path.replace(/^\/cutout(?=\/|$)/, ""); // strip function slug prefix
  if (path === "/health" && req.method === "GET") {
    return {
      res: jres(200, {
        ok: true,
        version: VERSION,
        smith: SMITH_VERSION
      }),
      state: null
    };
  }
  if (!path.startsWith("/v1/")) return {
    res: jres(404, {
      error: "not found"
    }),
    state: null
  };
  // Pairing redeem and owner claim are the only unauthenticated routes: the
  // code / setup key is the credential. Both are per-IP rate-limited.
  if (path === "/v1/pairings/redeem" && req.method === "POST") {
    if (!redeemAllowed(clientIp(req))) {
      return {
        res: jres(429, {
          error: "rate limit exceeded"
        }, {
          "Retry-After": "60"
        }),
        state: null
      };
    }
    return {
      res: await redeemPairing(req),
      state: null
    };
  }
  if (path === "/v1/owner/claim" && req.method === "POST") {
    if (!redeemAllowed(clientIp(req))) {
      return {
        res: jres(429, {
          error: "rate limit exceeded"
        }, {
          "Retry-After": "60"
        }),
        state: null
      };
    }
    return {
      res: await claimOwner(req),
      state: null
    };
  }
  // Smith credential classes, resolved in order: sm_own_ -> owner, sm_agt_ ->
  // bound agent, else the legacy bus token (+ optional X-Agent-Id), else 401.
  // A recognized sm_ prefix that fails its lookup never falls through to legacy.
  const auth = await resolveAuth(req);
  if (!auth) return {
    res: jres(401, {
      error: "unauthorized"
    }),
    state: null
  };
  const { limited, state } = await rateLimit();
  if (limited) return {
    res: limited,
    state
  };
  const done = (res)=>({
      res,
      state
    });
  if (path === "/v1/messages" && req.method === "POST") return done(await postMessage(req, auth));
  if (path === "/v1/messages" && req.method === "GET") return done(await getMessages(req, arrivedAt, auth));
  if (path === "/v1/receipts" && req.method === "POST") return done(await postReceipt(req, auth));
  if (path === "/v1/threads" && req.method === "GET") {
    // Same path, class-dispatched: legacy keeps the exact v1.1 shape and
    // semantics; Smith callers get the ACL-aware shape.
    return done(auth.kind === "legacy" ? await getThreads(req) : jres(200, await listThreadsSmith(auth)));
  }
  if (path === "/v1/threads" && req.method === "POST") {
    if (auth.kind === "legacy") return done(jres(403, {
      error: "agent or owner token required"
    }));
    return done(await postThread(req, auth));
  }
  if (path === "/v1/activity" && req.method === "POST") return done(await postActivity(req, auth));
  if (path === "/v1/pairings" && req.method === "POST") return done(await issuePairing(req, auth));
  if (path === "/v1/owner/rotate" && req.method === "POST") return done(await rotateOwner(req, auth));
  if (path === "/v1/owner/feed" && req.method === "GET") {
    return done(await ownerFeed(req, auth, new URL(req.url).searchParams.get("thread_id")));
  }
  if (path === "/v1/owner/threads" && req.method === "GET") return done(await ownerThreads(req, auth));
  if (path === "/v1/owner/audit" && req.method === "GET") return done(await ownerAudit(req, auth));
  let segs;
  try {
    segs = path.split("/").filter((s)=>s.length).map((s)=>decodeURIComponent(s));
  } catch  {
    return done(jres(400, {
      error: "invalid path encoding"
    }));
  }
  if (segs[0] === "v1" && segs[1] === "threads" && segs.length >= 3) {
    const tid = segs[2];
    if (segs.length === 4 && segs[3] === "feed" && req.method === "GET") return done(await threadFeed(req, auth, tid));
    if (segs.length === 4 && segs[3] === "members" && req.method === "POST") return done(await addMember(req, auth, tid));
    if (segs.length === 3 && req.method === "PATCH") return done(await renameThread(req, auth, tid));
  }
  if (segs[0] === "v1" && segs[1] === "owner" && segs[2] === "agents") {
    if (segs.length === 3 && req.method === "GET") return done(await ownerAgents(req, auth));
    if (segs.length === 5 && segs[4] === "revoke" && req.method === "POST") return done(await revokeAgent(req, auth, segs[3]));
  }
  return done(jres(404, {
    error: "not found"
  }));
}
Deno.serve(async (req)=>{
  const arrivedAt = Date.now();
  const startupAt = Date.now();
  await startupPurge;
  console.log(`cutout startup_wait_ms=${Date.now() - startupAt}`);
  let res;
  let state = null;
  try {
    const routeAt = Date.now();
    ({ res, state } = await route(req, arrivedAt));
    console.log(`cutout route_ms=${Date.now() - routeAt}`);
  } catch (e) {
    console.error(e);
    res = jres(500, {
      error: "internal error"
    });
  }
  // Rate-limit headers on every response, including errors and /health.
  try {
    const headerAt = Date.now();
    const h = rateHeaders(state ?? await rateState());
    for (const [k, v] of Object.entries(h))res.headers.set(k, v);
    console.log(`cutout rate_headers_ms=${Date.now() - headerAt}`);
  } catch (e) {
    console.error("rate header read failed", e);
  }
  console.log(`cutout response_ms=${Date.now() - arrivedAt} status=${res.status}`);
  return res;
});
