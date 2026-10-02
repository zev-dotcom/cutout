// Cutout Bus - Supabase Edge Function port of the SPEC v1.1 reference server.
// Wire-compatible with SPEC.md v1.1: same endpoints, fields, status codes.
// Config via env only (no secrets in code): AGENTCOLLAB_TOKEN (preferred) or
// CUTOUT_TOKEN, SUPABASE_DB_URL (auto), SMITH_SCHEMA (default "cutout").
import postgres from "npm:postgres@3.4.5";
const DB_URL = Deno.env.get("SUPABASE_DB_URL");
const BUS_TOKEN = Deno.env.get("AGENTCOLLAB_TOKEN") ?? Deno.env.get("CUTOUT_TOKEN") ?? "";
const RETENTION_DAYS = 30;
// Requests per minute per token; CUTOUT_RATE_LIMIT overrides (default 60).
const RATE_LIMIT_ENV = Number(Deno.env.get("CUTOUT_RATE_LIMIT") ?? "60");
const RATE_LIMIT_PER_MIN = Number.isInteger(RATE_LIMIT_ENV) && RATE_LIMIT_ENV >= 1 ? RATE_LIMIT_ENV : 60;
// P2-D: global ceiling across all identities so one looping credential cannot
// starve everyone else. Defaults to 10x the per-identity budget.
const RATE_LIMIT_GLOBAL_ENV = Number(Deno.env.get("CUTOUT_RATE_LIMIT_GLOBAL") ?? "600");
const RATE_LIMIT_GLOBAL = Number.isInteger(RATE_LIMIT_GLOBAL_ENV) && RATE_LIMIT_GLOBAL_ENV >= 1 ? RATE_LIMIT_GLOBAL_ENV : 600;
// Advisory-lock key (int8) serializing the rate-limit check-and-insert.
const RATE_LIMIT_LOCK_KEY = 8291746213;
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
// Option A (deploy-compat): the bus-table schema is selectable. Default
// "cutout" (self-host); set SMITH_SCHEMA=agentcollab for the live deploy.
// Smith-owned tables live in a second selectable schema so a shared or
// PostgREST-exposed database (the live project, where `public` is the app
// schema) never sees them. Default "public" (self-host); set
// SMITH_TABLES_SCHEMA=smith for the live deploy. Both are validated as bare
// identifiers at startup (fail closed); table names are hardcoded in T()/S().
// I2 hardening: pg_* / information_schema are never valid here, and the bus
// schema may not be "public".
function validSchema(s, allowPublic) {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) return false;
  if (s.startsWith("pg_") || s === "information_schema") return false;
  if (s === "public" && !allowPublic) return false;
  return true;
}
const SCHEMA = Deno.env.get("SMITH_SCHEMA") ?? "cutout";
if (!validSchema(SCHEMA, false)) throw new Error(`bad SMITH_SCHEMA: ${SCHEMA}`);
const TABLES_SCHEMA = Deno.env.get("SMITH_TABLES_SCHEMA") ?? "public";
if (!validSchema(TABLES_SCHEMA, true)) throw new Error(`bad SMITH_TABLES_SCHEMA: ${TABLES_SCHEMA}`);
const T = (name)=>sql.unsafe(`${SCHEMA}.${name}`);
const S = (name)=>sql.unsafe(`${TABLES_SCHEMA}.${name}`);
// I2 hardening (c): when targeting the live bus schema, the live token must
// be set explicitly; silently falling back to a leftover CUTOUT_TOKEN would
// make the wrong credential the live one.
if (SCHEMA === "agentcollab" && !Deno.env.get("AGENTCOLLAB_TOKEN")) {
  throw new Error("SMITH_SCHEMA=agentcollab requires AGENTCOLLAB_TOKEN");
}
console.log(`smith schema=${SCHEMA} tables_schema=${TABLES_SCHEMA} token=${Deno.env.get("AGENTCOLLAB_TOKEN") ? "agentcollab" : "cutout"}`);
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
const startupPurge = timedQuery(sql`select ${T("purge")}(${RETENTION_DAYS})`, "startup_purge", 2000).catch((e)=>console.error("startup purge failed", e));
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
async function rateState(ident) {
  const rows = await timedQuery(sql`
    select count(*)::int as c, extract(epoch from min(at))::float8 as oldest
    from ${T("rate_log")} where at > now() - interval '1 minute' and identity = ${ident}`, "rate_state");
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
function rateIdentity(auth) {
  // Failed-auth traffic shares one fixed bucket: it is limited before the
  // auth check, so junk-token floods cannot skip the limiter (each would
  // otherwise cost a hash plus a DB lookup with no budget).
  if (!auth) return "unauthenticated";
  if (auth.kind === "agent") return `agent:${auth.agentId}`;
  if (auth.kind === "owner") return "owner";
  // Legacy: X-Agent-Id is client-chosen, so a legacy caller could rotate the
  // header to dodge a per-id bucket. All legacy traffic shares one bucket;
  // only the global ceiling bounds it further.
  return "legacy";
}
async function rateLimit(auth) {
  // P2-D: per-identity bucket plus a global ceiling. The check-and-insert runs
  // inside one transaction under an advisory lock, so concurrent requests
  // cannot both observe a below-limit count and overshoot the budget.
  // The single global lock serializes every request's rate check; at this
  // scale (tens of requests per second worst case, one tiny insert per
  // request) the serialization cost is negligible — no sharding needed.
  // Log only admitted requests: a rejected (429) request is not counted, so
  // retrying while limited does not extend the lockout.
  const ident = rateIdentity(auth);
  const admitted = await sql.begin(async (tx)=>{
    await tx`select pg_advisory_xact_lock(${RATE_LIMIT_LOCK_KEY})`;
    return await tx`
      insert into ${T("rate_log")} (at, identity)
      select now(), ${ident}
      where (select count(*) from ${T("rate_log")} where at > now() - interval '1 minute') < ${RATE_LIMIT_GLOBAL}
        and (select count(*) from ${T("rate_log")} where at > now() - interval '1 minute' and identity = ${ident}) < ${RATE_LIMIT_PER_MIN}
      returning at`;
  });
  const state = await rateState(ident);
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
  await timedQuery(sql`update ${T("messages")}
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
  // P2-E: reply_to must reference a message in the same thread, so a reply
  // cannot be used to smuggle a cross-thread reference.
  // Note (round-3 review item 6): the existence check is NOT subject to the
  // added_at history rule — a late joiner can probe message ids from before
  // their join (the message body stays hidden; only existence leaks, and the
  // attacker must already know the id). Accepted as low risk; revisit if
  // message ids ever become enumerable.
  if (body.reply_to) {
    const rt = await timedQuery(sql`select 1 from ${T("messages")} where id = ${body.reply_to} and thread_id = ${body.thread_id}`, "reply_to_check");
    if (!rt.length) return jres(422, {
      error: "reply_to must reference a message in the same thread"
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
  if (metadata.mentions !== undefined) {
    // @mentions: structured list of thread members. Anything that is not a member is dropped.
    if (!Array.isArray(metadata.mentions) || metadata.mentions.some((m)=>typeof m !== "string")) return jres(422, {
      error: "metadata.mentions must be an array of agent ids"
    });
    const want = [...new Set(metadata.mentions)].slice(0, 10);
    let ok = [];
    if (want.length) {
      const mem = await timedQuery(sql`select agent_id from ${S("smith_thread_members")} where thread_id = ${body.thread_id} and agent_id = any(${want})`, "mention_members");
      const have = new Set(mem.map((r)=>r.agent_id));
      ok = want.filter((m)=> m === OWNER_ID || have.has(m));
    }
    // Per-sender cap on mentions of the owner (they drive push labels): over the cap, the owner id
    // is dropped (the message still posts and the normal push rules apply).
    if (ok.includes(OWNER_ID) && body.from !== OWNER_ID) {
      const cnt = await timedQuery(sql`select count(*)::int as n from ${S("smith_audit")} where action = 'owner_mention' and actor = ${body.from} and at > now() - interval '1 hour'`, "mention_rate");
      if (cnt[0].n >= MENTION_OWNER_PER_HOUR) {
        ok = ok.filter((m)=> m !== OWNER_ID);
        await audit(body.from, "owner_mention_limited", { thread_id: body.thread_id });
      } else {
        await audit(body.from, "owner_mention", { thread_id: body.thread_id });
      }
    }
    metadata.mentions = ok;
  }
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
  // P2-b: legacy callers without X-Agent-Id have no bound identity, so `from`
  // is unchecked above -- but reserved identities are never claimable.
  // (Unmanaged legacy threads have no sender authenticity by design; see
  // docs/smith-api.md.) I2-5: trim before testing so "owner " cannot slip by.
  if (auth.kind === "legacy" && RESERVED_AGENT_RE.test(String(body.from || "").trim())) {
    return jres(403, {
      error: "from is reserved"
    });
  }
  if (await isManagedThread(body.thread_id)) {
    if (auth.kind === "legacy") {
      // Strict mode (default): the shared legacy token is refused on managed
      // threads entirely — otherwise anyone holding it could read or write
      // any managed thread as any identity. Relax SMITH_LEGACY_STRICT only
      // during a legacy migration window.
      if (LEGACY_STRICT) return jres(403, {
        error: "legacy credentials not accepted on managed threads"
      });
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
  // P2-E: idempotency is scoped to (from, key, thread): a reused key in a
  // different thread is a new message, not a duplicate of the old one.
  const findDup = async ()=>idemKey === null ? [] : await sql`
    select m.id, m.created_at from ${T("idempotency_keys")} k
    join ${T("messages")} m on m.id = k.message_id
    where k.from_agent = ${from} and k.idem_key = ${idemKey} and k.thread_id = ${body.thread_id}`;
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
        insert into ${T("messages")} (id, thread_id, from_agent, to_agent, type, body, reply_to, metadata)
        values (${id}, ${body.thread_id}, ${from}, ${body.to},
                ${body.type}, ${body.body},
                ${body.reply_to ?? null}, ${sql.json(metadata)})
        returning id, created_at`;
      if (idemKey !== null) {
        await tx`insert into ${T("idempotency_keys")} (from_agent, idem_key, thread_id, message_id)
                 values (${from}, ${idemKey}, ${body.thread_id}, ${id})`;
      }
      if (auth.kind === "owner") {
        await tx`insert into ${S("smith_audit")} (actor, action, detail)
                 values ('owner', 'send_message', ${sql.json({ thread_id: body.thread_id })})`;
      }
      return r;
    }), "post_transaction", 3500);
    // Wake hooks: nudge recipients after the message is durable. Never blocks or fails the post.
    let urgentFlag;
    if (auth.kind === "agent" || auth.kind === "owner") {
      urgentFlag = false;
      try { urgentFlag = await urgentDecision(from, body.thread_id, body.to, body.urgent === true); } catch (e) { console.error("urgent decision failed", e); }
      afterPostWake(body.thread_id, from, body.to, urgentFlag, body.body, metadata.mentions);
    }
    return jres(201, {
      id: rows[0].id,
      created_at: iso(rows[0].created_at),
      ...(body.urgent !== undefined && urgentFlag !== undefined ? { urgent: urgentFlag } : {})
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
async function getMessagesInner(req, arrivedAt, auth) {
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
  if (threadId && auth.kind === "legacy" && LEGACY_STRICT && await isManagedThread(threadId)) {
    // Strict mode: the shared legacy token cannot scope reads on managed
    // threads (it carries no verifiable membership). Use /v1/threads/:id/feed.
    return jres(403, {
      error: "legacy credentials not accepted on managed threads"
    });
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
      from ${T("messages")}
      where true
      ${cursor ? sql`and ((extract(epoch from created_at) * 1000000)::bigint > ${cursor.us} or ((extract(epoch from created_at) * 1000000)::bigint = ${cursor.us} and id > ${cursor.id}))` : sql``}
      ${threadId ? sql`and thread_id = ${threadId}` : sql``}
      ${to ? sql`and to_agent = ${to}` : scopeAgent ? sql`and (to_agent = ${scopeAgent} or to_agent = '*' or jsonb_exists(metadata->'mentions', ${scopeAgent}))` : sql``}
      ${auth.kind === "agent" ? sql`and exists (
        select 1 from ${S("smith_thread_members")} tm
        where tm.thread_id = ${T("messages")}.thread_id
          and tm.agent_id = ${auth.agentId}
          and tm.legacy_unverified = false
          and ${T("messages")}.created_at >= tm.added_at
      )` : sql``}
      ${auth.kind === "legacy" && LEGACY_STRICT ? sql`and not exists (select 1 from ${S("smith_threads")} s where s.thread_id = ${T("messages")}.thread_id)` : sql``}
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
  if (auth.kind === "agent") markCanariesPicked(rows).catch(()=>{});
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
      select message_id, agent, status, at from ${T("receipts")}
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
  // P1-B: an agent may only write receipts on messages it can actually read
  // (verified membership of the message's thread, honoring the added_at history
  // rule). The same 404 covers "not found" and "not yours": no existence oracle.
  let exists;
  if (auth.kind === "agent") {
    exists = await timedQuery(sql`
      select m.thread_id, m.metadata from ${T("messages")} m
      join ${S("smith_thread_members")} tm on tm.thread_id = m.thread_id
        and tm.agent_id = ${auth.agentId}
        and tm.legacy_unverified = false
      where m.id = ${mid} and m.created_at >= tm.added_at`, "receipt_readable");
    if (exists.length === 0) return jres(404, {
      error: "message not found"
    });
  } else {
    exists = await timedQuery(sql`select thread_id, metadata from ${T("messages")} where id = ${mid}`, "receipt_exists");
    if (exists.length === 0) return jres(404, {
      error: "message not found"
    });
  }
  if (auth.kind === "legacy" && LEGACY_STRICT && await isManagedThread(exists[0].thread_id)) {
    return jres(403, {
      error: "legacy credentials not accepted on managed threads"
    });
  }
  await timedQuery(sql`
    insert into ${T("receipts")} (message_id, agent, status, at) values (${mid}, ${agent}, ${status}, ${at.toISOString()})
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
          and not exists (select 1 from ${T("receipts")} r where r.message_id = m.id and r.agent = ${agentId})
      )::int` : sql`0`} as unread
    from ${T("messages")} m
    ${LEGACY_STRICT ? sql`where not exists (select 1 from ${S("smith_threads")} s where s.thread_id = m.thread_id)` : sql``}
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
const WAKECHECK_LIKE = "th\\_wakecheck\\_%"; // canary threads: never listed, counted or pushed for the owner
const MENTION_OWNER_PER_HOUR = Number(Deno.env.get("SMITH_MENTION_OWNER_PER_HOUR") ?? 20);
const PAIRING_CODE_LEN = 6;
// Pairing codes default to 10 minutes (short-lived, single-use). The owner
// may explicitly request longer, up to 30 days.
const PAIRING_DEFAULT_MINUTES = 10;
const PAIRING_MAX_MINUTES = 43200; // 30 days
const ACTIVITY_TTL_SECONDS = 30;
const MAX_THREAD_NAME = 200;
const RESERVED_AGENT_RE = /^owner$/i;
// Owner bootstrap: a dedicated setup key, separate from the bus token agents
// hold. SMITH_SETUP_KEY is REQUIRED at deploy time. Fail closed (P1-4): when
// it is unset, /v1/owner/claim is disabled entirely — there is no fallback to
// CUTOUT_TOKEN, which would reintroduce the original P0 by misconfiguration.
const SETUP_KEY = Deno.env.get("SMITH_SETUP_KEY") ?? "";
if (!SETUP_KEY) console.error("smith: SMITH_SETUP_KEY unset — /v1/owner/claim is DISABLED");
// Strict legacy mode (default on): the legacy bus token (+ X-Agent-Id) is
// refused on managed-thread routes. Relax only during a legacy migration.
// P2-a (fail closed): only explicit "0"/"false" disables; any other value
// (including malformed) keeps strict ON with a loud warning.
const LEGACY_STRICT = (()=>{
  const raw = Deno.env.get("SMITH_LEGACY_STRICT");
  if (raw === undefined) return true;
  const v = raw.toLowerCase();
  if (v === "0" || v === "false") {
    // I2-5 item 3: loud boot warning for the explicit off case, not just
    // the unrecognized case — strict-off is a deliberate security downgrade.
    console.error("smith: WARNING — SMITH_LEGACY_STRICT is OFF; legacy credentials are accepted on managed threads");
    return false;
  }
  if (v !== "1" && v !== "true") {
    console.error(`smith: unrecognized SMITH_LEGACY_STRICT=${JSON.stringify(raw)} — failing closed (strict ON)`);
  }
  return true;
})();
// Brute-force budgets for the unauthenticated routes, enforced globally per
// instance (never keyed on client-supplied X-Forwarded-For). Env-overridable
// for tests; the defaults assume ~30-bit pairing codes with 10-minute life.
function intEnv(name, dflt) {
  const v = Number(Deno.env.get(name));
  return Number.isInteger(v) && v >= 1 ? v : dflt;
}
const REDEEM_BUDGET_PER_HOUR = intEnv("SMITH_REDEEM_BUDGET_PER_HOUR", 120);
const REDEEM_CODE_LOCKOUT_AFTER = intEnv("SMITH_REDEEM_CODE_LOCKOUT_AFTER", 10);
const CLAIM_BUDGET_PER_HOUR = intEnv("SMITH_CLAIM_BUDGET_PER_HOUR", 20);
// P2-10: optional pinned instance URL (SMITH_INSTANCE_URL); the request origin
// is attacker-influenced behind a proxy, so config wins when set.
const CONFIG_INSTANCE_URL = Deno.env.get("SMITH_INSTANCE_URL") ?? "";

async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b)=>b.toString(16).padStart(2, "0")).join("");
}
// P2-10: constant-time comparison for the legacy bus token (finding 11).
function constantTimeEqual(a, b) {
  const ab = new TextEncoder().encode(a), bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
// P1-5: failed-auth audit writes are deduped per credential class (one row per
// minute max). Without this, an unauthenticated caller could grow the
// append-only audit table without bound, since resolveAuth runs before
// rateLimit(). The actor is always the fixed string "unauthenticated" — never
// a client-supplied header value. Best-effort and in-memory; a restart resets
// the window.
const lastFailedAuthAudit = new Map();
async function auditFailedAuth(klass, detail) {
  const now = Date.now();
  if (now - (lastFailedAuthAudit.get(klass) ?? 0) < 60000) return;
  lastFailedAuthAudit.set(klass, now);
  try {
    await audit("unauthenticated", "auth_failed", {
      credential_class: klass,
      ...(detail ?? {})
    });
  } catch  {}
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
    const rows = await timedQuery(sql`select 1 from ${S("smith_owner")} where token_hash = ${await sha256Hex(token)}`, "auth_owner");
    if (rows.length) return {
      kind: "owner",
      agentId: OWNER_ID
    };
    // Failed owner auth attempt: audited (deduped, fixed actor), then deny.
    await auditFailedAuth("owner");
    return null;
  }
  if (token.startsWith("sm_agt_")) {
    const rows = await timedQuery(sql`select agent_id, revoked_at from ${S("smith_agents")} where token_hash = ${await sha256Hex(token)}`, "auth_agent");
    if (!rows.length || rows[0].revoked_at !== null) {
      // Consistent with owner failures: audited (deduped, fixed actor), then deny.
      await auditFailedAuth("agent", rows.length ? {
        reason: "revoked"
      } : {
        reason: "unknown_token"
      });
      return null;
    }
    return {
      kind: "agent",
      agentId: rows[0].agent_id
    };
  }
  if (BUS_TOKEN && constantTimeEqual(token, BUS_TOKEN)) {
    const hid = req.headers.get("X-Agent-Id");
    const aid = hid && hid.length ? hid : null;
    if (aid) {
      // P2-b: reserved identities cannot be claimed via the legacy header.
      // I2-5: trim before testing so "owner " cannot slip by.
      if (RESERVED_AGENT_RE.test(aid.trim())) {
        await auditFailedAuth("legacy", {
          reason: "reserved_id",
          agent_id: aid
        });
        return null;
      }
      // Revocation applies to every credential class, including the legacy
      // bus-token path: a revoked identity cannot return through it.
      const rows = await timedQuery(sql`select revoked_at from ${S("smith_agents")} where agent_id = ${aid}`, "auth_legacy_revoked");
      if (rows.length && rows[0].revoked_at !== null) {
        await auditFailedAuth("legacy", {
          reason: "revoked",
          agent_id: aid
        });
        return null;
      }
    }
    return {
      kind: "legacy",
      agentId: aid
    };
  }
  return null;
}
async function audit(actor, action, detail) {
  await timedQuery(sql`insert into ${S("smith_audit")} (actor, action, detail) values (${actor}, ${action}, ${sql.json(detail ?? {})})`, "audit_append");
}
async function isManagedThread(threadId) {
  const rows = await timedQuery(sql`select 1 from ${S("smith_threads")} where thread_id = ${threadId}`, "thread_managed");
  return rows.length > 0;
}
async function isThreadMember(auth, threadId) {
  if (auth.kind === "owner") return true; // implicit member of every thread
  if (!auth.agentId) return false;
  const rows = await timedQuery(sql`select legacy_unverified from ${S("smith_thread_members")} where thread_id = ${threadId} and agent_id = ${auth.agentId}`, "member_check");
  if (!rows.length) return false;
  // P1-2 strict: memberships seeded from unverified legacy sender fields grant
  // no access until the owner verifies them (verify_member route).
  if (rows[0].legacy_unverified === true) return false;
  return true;
}
// 404 when the thread is unmanaged, 403 when the caller is not a member, else null.
// In strict mode (default) the legacy bus token (+ X-Agent-Id) is refused on
// managed threads entirely: while agents still hold the shared legacy token,
// the thread-isolation guarantee would not hold otherwise. Relax
// SMITH_LEGACY_STRICT only during a legacy migration window.
async function threadAccess(auth, threadId) {
  if (!await isManagedThread(threadId)) return jres(404, {
    error: "thread not found"
  });
  if (auth.kind === "legacy") {
    if (LEGACY_STRICT) return jres(403, {
      error: "legacy credentials not accepted on managed threads"
    });
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
    select tm.agent_id, tm.legacy_unverified, a.display_name, a.platform from ${S("smith_thread_members")} tm
    left join ${S("smith_agents")} a on a.agent_id = tm.agent_id
    where tm.thread_id = ${threadId} order by tm.agent_id asc`, "thread_members");
  return rows.map((r)=>({
      agent_id: r.agent_id,
      display_name: r.display_name ?? r.agent_id,
      platform: r.platform ?? "unknown",
      legacy_unverified: r.legacy_unverified === true
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
  const suppliedTid = body.thread_id !== undefined && body.thread_id !== null;
  if (suppliedTid) {
    if (typeof body.thread_id !== "string" || !/^x_cutout_thread/.test(body.thread_id)) {
      return jres(422, {
        error: "thread_id must be an x_cutout_thread-style id"
      });
    }
    tid = body.thread_id;
  } else {
    tid = "th_" + ulid();
  }
  const dup = await timedQuery(sql`select 1 from ${S("smith_threads")} where thread_id = ${tid}`, "thread_exists");
  if (dup.length) return jres(409, {
    error: "thread already exists"
  });
  // Agent creators may only name existing, non-revoked agents. Owner creators
  // may name unknown ids; they become stub rows (known id, no Smith token yet).
  const known = await timedQuery(sql`select agent_id, revoked_at from ${S("smith_agents")} where agent_id = any(${memberIds})`, "members_known");
  const knownMap = new Map(known.map((r)=>[
      r.agent_id,
      r.revoked_at
    ]));
  for (const mid of memberIds){
    const rev = knownMap.get(mid);
    if (auth.kind === "owner") {
      if (rev === undefined) {
        await timedQuery(sql`insert into ${S("smith_agents")} (agent_id, display_name, platform) values (${mid}, ${mid}, 'unknown') on conflict (agent_id) do nothing`, "member_stub");
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
  // P0-1: an agent must not take over someone else's legacy thread by naming
  // its id. Agents may only name an id with zero existing legacy history;
  // adopting a legacy thread (seeding its members) is owner-only and audited.
  // The history check runs inside the create transaction so a racing message
  // cannot slip between check and insert.
  const TAKEOVER = "__takeover__";
  try {
    await timedQuery(sql.begin(async (tx)=>{
      await tx`insert into ${S("smith_threads")} (thread_id, name, created_by) values (${tid}, ${name}, ${auth.agentId})`;
      if (auth.kind === "owner") {
        // Owner-only legacy adoption: seed members from pre-existing legacy
        // messages, marked unverified (strict P1-2: no access until verified).
        const s1 = await tx`insert into ${S("smith_thread_members")} (thread_id, agent_id, legacy_unverified, added_at)
                 select ${tid}, from_agent, true, '-infinity'::timestamptz from ${T("messages")}
                 where thread_id = ${tid} and from_agent is not null and from_agent <> '*'
                 on conflict do nothing returning agent_id`;
        const s2 = await tx`insert into ${S("smith_thread_members")} (thread_id, agent_id, legacy_unverified, added_at)
                 select ${tid}, to_agent, true, '-infinity'::timestamptz from ${T("messages")}
                 where thread_id = ${tid} and to_agent is not null and to_agent <> '*'
                 on conflict do nothing returning agent_id`;
        const seeded = [...s1, ...s2].map((r)=>r.agent_id);
        if (seeded.length) await audit(OWNER_ID, "thread_adopt", {
          thread_id: tid,
          seeded_members: seeded
        });
      } else if (suppliedTid) {
        const existing = await tx`select 1 from ${T("messages")} where thread_id = ${tid} limit 1`;
        if (existing.length) throw new Error(TAKEOVER);
      }
      const all = auth.kind === "owner" ? memberIds : [
        auth.agentId,
        ...memberIds
      ];
      for (const mid of all){
        await tx`insert into ${S("smith_thread_members")} (thread_id, agent_id) values (${tid}, ${mid}) on conflict do nothing`;
      }
    }), "thread_create", 3500);
  } catch (e) {
    if (e && e.message === TAKEOVER) {
      return jres(403, {
        error: "thread id has existing history; only the owner can adopt it"
      });
    }
    throw e;
  }
  return jres(201, {
    thread_id: tid,
    name,
    members: await memberObjects(tid)
  });
}
async function listThreadsSmith(auth) {
  const aid = auth.agentId;
  const scope = auth.kind === "owner" ? sql`where t.thread_id not like ${WAKECHECK_LIKE}` : sql`where t.thread_id in (select thread_id from ${S("smith_thread_members")} where agent_id = ${aid})`;
  const threads = await timedQuery(sql`
    select t.thread_id, t.name, max(m.created_at) as last_at,
      ${auth.kind === "owner"
        ? sql`count(*) filter (where m.from_agent <> ${OWNER_ID} and m.created_at > coalesce(orr.last_read_at, 'epoch'::timestamptz))::int`
        : sql`count(*) filter (where (m.to_agent = ${aid} or m.to_agent = '*')
        and not exists (select 1 from ${T("receipts")} r where r.message_id = m.id and r.agent = ${aid}))::int`} as unread
    from ${S("smith_threads")} t
    left join ${T("messages")} m on m.thread_id = t.thread_id
    left join ${S("smith_owner_reads")} orr on orr.thread_id = t.thread_id
    ${scope}
    group by t.thread_id, t.name, orr.last_read_at
    order by last_at desc nulls last`, "smith_thread_list");
  const tids = threads.map((t)=>t.thread_id);
  const membersBy = new Map(), workingBy = new Map();
  if (tids.length) {
    const mrows = await timedQuery(sql`
      select tm.thread_id, tm.agent_id, tm.legacy_unverified, a.display_name, a.platform
      from ${S("smith_thread_members")} tm left join ${S("smith_agents")} a on a.agent_id = tm.agent_id
      where tm.thread_id = any(${tids}) order by tm.thread_id asc, tm.agent_id asc`, "smith_thread_members");
    for (const r of mrows){
      const list = membersBy.get(r.thread_id) ?? [];
      list.push({
        agent_id: r.agent_id,
        display_name: r.display_name ?? r.agent_id,
        platform: r.platform ?? "unknown",
        legacy_unverified: r.legacy_unverified === true
      });
      membersBy.set(r.thread_id, list);
    }
    const wrows = await timedQuery(sql`
      select thread_id, agent_id from ${S("smith_activity")}
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
  const cur = await timedQuery(sql`select name from ${S("smith_threads")} where thread_id = ${threadId}`, "thread_name");
  const oldName = cur.length ? cur[0].name : null;
  const noteId = "msg_" + ulid();
  await timedQuery(sql.begin(async (tx)=>{
    await tx`update ${S("smith_threads")} set name = ${body.name} where thread_id = ${threadId}`;
    // Renames are data, not message edits: append a note message carrying the
    // compat key, matching the UI contract.
    await tx`insert into ${T("messages")} (id, thread_id, from_agent, to_agent, type, body, metadata)
             values (${noteId}, ${threadId}, ${auth.agentId}, '*', 'note',
                     ${"Chat renamed to \"" + body.name + "\""},
                     ${sql.json({ x_cutout_thread_rename: { from: oldName, to: body.name } })})`;
  }), "thread_rename", 3500);
  // P2-9: renames carry raw user-supplied text (clients must render as text
  // only); the rename itself gets a proper audit row for owner oversight.
  await audit(auth.agentId, "thread_rename", {
    thread_id: threadId,
    from: oldName,
    to: body.name
  });
  return jres(200, {
    thread_id: threadId,
    name: body.name
  });
}
async function addMember(req, auth, threadId) {
  // Owner-only: any member could otherwise expose full thread history to
  // another agent. The add is audited; the new member's added_at is set to
  // now, so the feed shows them history from here (P1-3).
  // Note (round-3 review item 5): the insert uses on conflict do nothing, so
  // re-adding an existing member keeps their original added_at. That is the
  // intended semantic today (no member-remove route exists, so there is no
  // re-join scenario). If a remove route is ever added, define the re-add
  // semantic explicitly — e.g. refresh added_at on re-add — before shipping it.
  const denied = requireOwner(auth);
  if (denied) return denied;
  if (!await isManagedThread(threadId)) return jres(404, {
    error: "thread not found"
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
  const rows = await timedQuery(sql`select revoked_at, legacy_unverified, (token_hash is not null) as has_token from ${S("smith_agents")} where agent_id = ${aid}`, "member_agent");
  if (rows.length && rows[0].legacy_unverified === true && !rows[0].has_token) return jres(422, {
    error: `unregistered legacy agent id: ${aid} (pair it first)`
  });
  if (!rows.length || rows[0].revoked_at !== null) return jres(422, {
    error: `unknown or revoked agent: ${aid}`
  });
  await timedQuery(sql`insert into ${S("smith_thread_members")} (thread_id, agent_id) values (${threadId}, ${aid}) on conflict do nothing`, "member_add");
  await audit(OWNER_ID, "add_member", {
    thread_id: threadId,
    agent_id: aid
  });
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
async function feedMessages(threadId, cursor, limit, agentId) {
  return await timedQuery(sql`
    select id, thread_id, from_agent, to_agent, type, body, reply_to, created_at,
           (extract(epoch from created_at) * 1000000)::bigint as created_us, metadata
    from ${T("messages")} m
    where m.thread_id = ${threadId}
    ${agentId ? sql`and m.created_at >= coalesce((select tm.added_at from ${S("smith_thread_members")} tm where tm.thread_id = ${threadId} and tm.agent_id = ${agentId}), 'infinity'::timestamptz)` : sql``}
    ${cursor ? sql`and (((extract(epoch from m.created_at) * 1000000)::bigint > ${cursor.us}) or (((extract(epoch from m.created_at) * 1000000)::bigint = ${cursor.us}) and m.id > ${cursor.id}))` : sql``}
    order by m.created_at asc, m.id asc
    limit ${limit}`, "feed_query");
}
async function buildFeed(threadId, q, redactLabel, agentId) {
  const rows = await feedMessages(threadId, q.cursor, q.limit, agentId);
  const messages = await enrichMessages(rows, redactLabel);
  // Working state is evaluated on read (expires_at > now()): a crashed agent's
  // dots clear within the TTL with no client timer to trust.
  const wrows = await timedQuery(sql`select agent_id, started_at from ${S("smith_activity")} where thread_id = ${threadId} and expires_at > now() order by agent_id asc`, "feed_working");
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
  // P1-3: a member sees history from their join time (added_at). Seeded
  // pre-existing participants have added_at '-infinity': full history. A
  // missing member row defaults to 'infinity' (see nothing): fail-closed, so
  // any future caller that reaches this filter without a threadAccess check
  // leaks nothing. The filter stays in SQL so driver date parsing never sees
  // '-infinity'.
  const q = parseFeedQuery(req);
  if (q.error) return q.error;
  return jres(200, await buildFeed(threadId, q, "feed_redact", auth.kind === "owner" ? null : auth.agentId));
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
      insert into ${S("smith_activity")} (thread_id, agent_id, started_at, expires_at)
      values (${body.thread_id}, ${aid}, now(), now() + (${ACTIVITY_TTL_SECONDS} * interval '1 second'))
      on conflict (thread_id, agent_id) do update set expires_at = excluded.expires_at`, "activity_working");
  } else {
    await timedQuery(sql`delete from ${S("smith_activity")} where thread_id = ${body.thread_id} and agent_id = ${aid}`, "activity_idle");
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
  let minutes = PAIRING_DEFAULT_MINUTES;
  if (body.expires_in_minutes !== undefined && body.expires_in_minutes !== null) {
    minutes = Number(body.expires_in_minutes);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > PAIRING_MAX_MINUTES) {
      return jres(422, {
        error: `expires_in_minutes must be greater than 0 and at most ${PAIRING_MAX_MINUTES}`
      });
    }
  }
  const existing = await timedQuery(sql`select revoked_at, token_hash from ${S("smith_agents")} where agent_id = ${aid}`, "pairing_agent");
  // "Already paired" means an active Smith token exists. Seeded legacy rows
  // (token_hash null) and revoked rows may be paired: issuing rotates in.
  if (existing.length && existing[0].revoked_at === null && existing[0].token_hash !== null) return jres(409, {
    error: "agent already paired"
  });
  const code = newPairingCode();
  const pid = "pg_" + ulid();
  const expiresAt = new Date(Date.now() + minutes * 60 * 1000);
  await timedQuery(sql.begin(async (tx)=>{
    if (existing.length) {
      await tx`update ${S("smith_agents")} set display_name = ${body.display_name}, platform = ${platform} where agent_id = ${aid}`;
    } else {
      await tx`insert into ${S("smith_agents")} (agent_id, display_name, platform) values (${aid}, ${body.display_name}, ${platform})`;
    }
    // P2-8: at most one live code per agent; re-issuing expires earlier ones.
    await tx`update ${S("smith_pairings")} set expires_at = now()
             where agent_id = ${aid} and redeemed_at is null and expires_at > now()`;
    await tx`insert into ${S("smith_pairings")} (id, code_hash, agent_id, expires_at)
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
// Brute-force defense for the unauthenticated routes (pairing redeem, owner
// claim): a global per-instance attempt budget plus per-code lockout, tracked
// in smith_auth_attempts. Deliberately NOT keyed on client-supplied
// X-Forwarded-For, which an attacker controls. Rows older than an hour are
// pruned on each attempt, so the table stays tiny.
async function authAttemptPrune(kind) {
  await timedQuery(sql`delete from ${S("smith_auth_attempts")} where kind = ${kind} and at < now() - interval '1 hour'`, "attempt_prune");
}
async function authBudgetExceeded(kind, budget) {
  const rows = await timedQuery(sql`select count(*)::int as c from ${S("smith_auth_attempts")} where kind = ${kind} and at > now() - interval '1 hour'`, "attempt_count");
  return rows[0].c >= budget;
}
async function recordAuthFailure(kind, codeHash) {
  await timedQuery(sql`insert into ${S("smith_auth_attempts")} (kind, code_hash) values (${kind}, ${codeHash})`, "attempt_fail");
}
async function lockCodeIfNeeded(codeHash) {
  const rows = await timedQuery(sql`select count(*)::int as c from ${S("smith_auth_attempts")} where kind = 'redeem' and code_hash = ${codeHash} and at > now() - interval '1 hour'`, "attempt_code");
  if (rows[0].c >= REDEEM_CODE_LOCKOUT_AFTER) {
    await timedQuery(sql`update ${S("smith_pairings")} set locked_at = now() where code_hash = ${codeHash} and locked_at is null`, "pairing_lock");
  }
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
  await authAttemptPrune("redeem");
  if (await authBudgetExceeded("redeem", REDEEM_BUDGET_PER_HOUR)) {
    return jres(429, {
      error: "rate limit exceeded"
    }, {
      "Retry-After": "3600"
    });
  }
  // Normalize before hashing so "xxxx-xx", "XXXXXX", etc. all match. The
  // format check feeds the same 404 as a wrong code: no oracle.
  const raw = typeof body.code === "string" ? body.code.toUpperCase().replace(/[^0-9A-Z]/g, "") : "";
  const codeHash = /^[0-9A-HJKMNP-TV-Z]{6}$/.test(raw) ? await sha256Hex(raw) : null;
  const bad = async ()=>{
    await recordAuthFailure("redeem", codeHash);
    if (codeHash) await lockCodeIfNeeded(codeHash);
    return jres(404, {
      error: "invalid or expired pairing code"
    });
  };
  if (!codeHash) return bad();
  const token = "sm_agt_" + randomHexBytes(32);
  const tokenHash = await sha256Hex(token);
  // Atomic redemption: a single conditional UPDATE claims the code. Two
  // concurrent redeems cannot both win; the loser's update matches zero rows.
  const INVALID_CODE = Symbol("invalid_code");
  let redeemed = null;
  try {
    await timedQuery(sql.begin(async (tx)=>{
      const rows = await tx`update ${S("smith_pairings")} set redeemed_at = now()
        where code_hash = ${codeHash} and redeemed_at is null and locked_at is null and expires_at > now()
        returning id, agent_id`;
      if (!rows.length) throw INVALID_CODE;
      redeemed = rows[0];
      // Redeeming rotates the token and un-revokes a re-paired agent.
      await tx`update ${S("smith_agents")} set token_hash = ${tokenHash}, revoked_at = null where agent_id = ${redeemed.agent_id}`;
    }), "pairing_redeem", 3500);
  } catch (e) {
    if (e === INVALID_CODE) return bad();
    throw e;
  }
  await audit(redeemed.agent_id, "redeem_pairing", {
    pairing_id: redeemed.id
  });
  const u = new URL(req.url);
  // P2-10: prefer a pinned instance URL from config; the request origin is
  // attacker-influenced behind a proxy (Host header), so it is only a fallback.
  // Default derivation: behind Supabase the function sees http://<ref>.supabase.co/<slug>/v1/...;
  // the public URL is https://<ref>.supabase.co/functions/v1/<slug>.
  const slugMatch = u.pathname.match(/^\/([^/]+)\/v1\//);
  const derived = u.hostname.endsWith(".supabase.co")
    ? `https://${u.hostname}/functions/v1/${slugMatch ? slugMatch[1] : "agentcollab"}`
    : u.origin + u.pathname.replace(/\/v1\/.*$/, "").replace(/\/(cutout|agentcollab)$/, "");
  const instanceUrl = CONFIG_INSTANCE_URL || derived;
  return jres(200, {
    agent_token: token,
    agent_id: redeemed.agent_id,
    instance_url: instanceUrl
  });
}
// One-time owner bootstrap: mints the instance's first owner token. Gated by
// the dedicated setup key SMITH_SETUP_KEY (checked first); when the key is
// unset the endpoint is disabled entirely (fail closed, P1-4) — never the bus
// token agents hold. Both failure modes (wrong key, already claimed) return
// the identical 404, so unauthenticated callers cannot oracle claimed/unclaimed
// state. The setup key is checked in memory and never persisted; only the
// SHA-256 of the new owner token is stored.
async function claimOwner(req) {
  let body;
  try {
    body = await req.json();
  } catch  {
    return jres(400, {
      error: "invalid JSON"
    });
  }
  await authAttemptPrune("claim");
  if (await authBudgetExceeded("claim", CLAIM_BUDGET_PER_HOUR)) {
    return jres(429, {
      error: "rate limit exceeded"
    }, {
      "Retry-After": "3600"
    });
  }
  const gone = async ()=>{
    await recordAuthFailure("claim", null);
    return jres(404, {
      error: "not found"
    });
  };
  if (!SETUP_KEY || body.setup_key !== SETUP_KEY) return gone();
  const existing = await timedQuery(sql`select 1 from ${S("smith_owner")}`, "claim_exists");
  if (existing.length) return gone();
  const token = "sm_own_" + randomHexBytes(32);
  await timedQuery(sql.begin(async (tx)=>{
    await tx`insert into ${S("smith_owner")} (token_hash) values (${await sha256Hex(token)})`;
    await tx`insert into ${S("smith_audit")} (actor, action, detail) values ('owner', 'claim_owner', ${sql.json({})})`;
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
  const rows = await timedQuery(sql`select agent_id, display_name, platform, created_at, revoked_at, legacy_unverified, (token_hash is not null) as has_token from ${S("smith_agents")} order by agent_id asc`, "owner_agents");
  return jres(200, {
    agents: rows.map((r)=>({
        agent_id: r.agent_id,
        display_name: r.display_name,
        platform: r.platform,
        created_at: iso(r.created_at),
        revoked_at: r.revoked_at ? iso(r.revoked_at) : null,
        legacy_unverified: r.legacy_unverified === true,
        has_token: r.has_token
      }))
  });
}
async function revokeAgent(req, auth, aid) {
  const denied = requireOwner(auth);
  if (denied) return denied;
  const rows = await timedQuery(sql`select 1 from ${S("smith_agents")} where agent_id = ${aid}`, "revoke_exists");
  if (!rows.length) return jres(404, {
    error: "agent not found"
  });
  await timedQuery(sql.begin(async (tx)=>{
    await tx`update ${S("smith_agents")} set revoked_at = now(), token_hash = null where agent_id = ${aid}`;
    await tx`delete from ${S("smith_thread_members")} where agent_id = ${aid}`;
    await tx`delete from ${S("smith_activity")} where agent_id = ${aid}`;
    // Kill outstanding pairing codes too: redeeming one would otherwise un-revoke.
    await tx`update ${S("smith_pairings")} set redeemed_at = now() where agent_id = ${aid} and redeemed_at is null`;
  }), "agent_revoke", 3500);
  await audit(OWNER_ID, "revoke_agent", {
    agent_id: aid
  });
  return jres(200, {
    ok: true
  });
}
// Owner review of seeded (legacy-unverified) membership: clears the flag once
// the owner has confirmed the membership is legitimate. Audited.
async function verifyMember(req, auth, threadId, aid) {
  const denied = requireOwner(auth);
  if (denied) return denied;
  if (!await isManagedThread(threadId)) return jres(404, {
    error: "thread not found"
  });
  // P2-d: check state before mutating. Verifying an already-verified member
  // is a no-op (idempotent 200); verifying a non-member is a 404.
  const cur = await timedQuery(sql`select legacy_unverified, added_at from ${S("smith_thread_members")} where thread_id = ${threadId} and agent_id = ${aid}`, "member_verify_state");
  if (!cur.length) return jres(404, {
    error: "member not found"
  });
  // P2-d: audit the member's message count so the owner sees what history
  // they are granting access to. I2-5: also the thread's total message count
  // and distinct sender count, since the grant covers the whole thread.
  const mc = await timedQuery(sql`select count(*)::int as c from ${T("messages")} where thread_id = ${threadId} and from_agent = ${aid}`, "member_verify_msgcount");
  const msgCount = mc[0].c;
  const tc = await timedQuery(sql`select count(*)::int as total, count(distinct from_agent)::int as senders from ${T("messages")} where thread_id = ${threadId}`, "member_verify_threadcount");
  const threadTotal = tc[0].total, threadSenders = tc[0].senders;
  const auditDetail = {
    thread_id: threadId,
    agent_id: aid,
    message_count: msgCount,
    thread_message_count: threadTotal,
    thread_sender_count: threadSenders,
    member_since: cur[0].added_at ? String(cur[0].added_at) : null
  };
  if (!cur[0].legacy_unverified) {
    await audit(OWNER_ID, "verify_member", {
      ...auditDetail,
      already_verified: true
    });
    return jres(200, {
      ok: true,
      already_verified: true
    });
  }
  // I2-5 item 1: the grant (UPDATE) and its audit row commit atomically.
  // If the audit insert fails, the verification rolls back too — never grant
  // access without the audit trail (fail-closed, mirroring owner reads).
  const updated = await sql.begin(async (tx)=>{
    const u = await tx`update ${S("smith_thread_members")} set legacy_unverified = false where thread_id = ${threadId} and agent_id = ${aid} returning 1`;
    if (!u.length) return false;
    await tx`insert into ${S("smith_audit")} (actor, action, detail) values (${OWNER_ID}, ${"verify_member"}, ${sql.json(auditDetail)})`;
    return true;
  });
  if (!updated) return jres(404, {
    error: "member not found"
  });
  return jres(200, {
    ok: true
  });
}
// P1-6: the global brute-force budgets are a deliberate v1 availability
// tradeoff (anyone can burn the hour's budget with junk). The owner can reset
// them here; the reset itself is audited.
async function resetAuthBudgets(req, auth) {
  const denied = requireOwner(auth);
  if (denied) return denied;
  await timedQuery(sql`delete from ${S("smith_auth_attempts")}`, "budget_reset");
  await audit(OWNER_ID, "budget_reset", {});
  return jres(200, {
    ok: true
  });
}
async function rotateOwner(req, auth) {  const denied = requireOwner(auth);
  if (denied) return denied;
  const token = "sm_own_" + randomHexBytes(32);
  await timedQuery(sql`update ${S("smith_owner")} set token_hash = ${await sha256Hex(token)} where id = 1`, "owner_rotate");
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
  // Fail-closed audit: the audit row is written BEFORE the read, and the read
  // is denied if the audit write fails. No owner read may happen unaudited.
  try {
    await audit(OWNER_ID, "read_thread", {
      thread_id: threadId
    });
  } catch  {
    return jres(500, {
      error: "audit unavailable"
    });
  }
  const feed = await buildFeed(threadId, q, "owner_feed_redact");
  return jres(200, feed);
}
async function ownerThreads(req, auth) {
  const denied = requireOwner(auth);
  if (denied) return denied;
  const out = await listThreadsSmith(auth);
  try {
    await audit(OWNER_ID, "list_threads", {});
  } catch  {
    return jres(500, {
      error: "audit unavailable"
    });
  }
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
  // Fail-closed: audit the read before performing it.
  try {
    await audit(OWNER_ID, "read_audit", {
      limit
    });
  } catch  {
    return jres(500, {
      error: "audit unavailable"
    });
  }
  const rows = await timedQuery(sql`
    select id, at, actor, action, detail from ${S("smith_audit")}
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
  path = path.replace(/^\/(cutout|agentcollab)(?=\/|$)/, ""); // strip function slug prefix (either deploy name)
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
    state: null,
    ident: "unknown"
  };
  // Pairing redeem and owner claim are the only unauthenticated routes: the
  // code / setup key is the credential. Brute-force budgets are enforced
  // globally per instance inside each handler (never on X-Forwarded-For).
  if (path === "/v1/pairings/redeem" && req.method === "POST") {
    return {
      res: await redeemPairing(req),
      state: null,
      ident: "unknown"
    };
  }
  if (path === "/v1/owner/claim" && req.method === "POST") {
    return {
      res: await claimOwner(req),
      state: null,
      ident: "unknown"
    };
  }
  // Smith credential classes, resolved in order: sm_own_ -> owner, sm_agt_ ->
  // bound agent, else the legacy bus token (+ optional X-Agent-Id), else 401.
  // A recognized sm_ prefix that fails its lookup never falls through to legacy.
  // The rate limiter runs BEFORE the auth check: failed-auth traffic counts
  // against the fixed 'unauthenticated' bucket instead of skipping the
  // limiter entirely.
  const auth = await resolveAuth(req);
  const { limited, state } = await rateLimit(auth);
  if (limited) return {
    res: limited,
    state,
    ident: rateIdentity(auth)
  };
  if (!auth) return {
    res: jres(401, {
      error: "unauthorized"
    }),
    state,
    ident: rateIdentity(auth)
  };
  const done = (res)=>({
      res,
      state,
      ident: rateIdentity(auth)
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
  if (segs[0] === "v1" && segs[1] === "owner" && segs[2] === "push") return done(await pushRoutes(req, auth, segs));
  // Owner read marker: the badge on the thread list counts others' messages after this.
  if (segs[0] === "v1" && segs[1] === "owner" && segs[2] === "threads" && segs.length === 5 && segs[4] === "read" && req.method === "PUT") {
    const denied = requireOwner(auth);
    if (denied) return done(denied);
    const known = await timedQuery(sql`select 1 from ${S("smith_threads")} where thread_id = ${segs[3]}`, "read_thread_known");
    if (!known.length) return done(jres(404, { error: "thread not found" }));
    await timedQuery(sql`insert into ${S("smith_owner_reads")} (thread_id, last_read_at) values (${segs[3]}, now())
      on conflict (thread_id) do update set last_read_at = greatest(${S("smith_owner_reads")}.last_read_at, excluded.last_read_at)`, "owner_read_mark");
    return done(jres(200, { thread_id: segs[3], read: true }));
  }
  if (segs[0] === "v1" && segs[1] === "threads" && segs.length >= 3) {
    const tid = segs[2];
    if (segs.length === 4 && segs[3] === "feed" && req.method === "GET") return done(await threadFeed(req, auth, tid));
    if (segs.length === 4 && segs[3] === "members" && req.method === "POST") return done(await addMember(req, auth, tid));
    if (segs.length === 3 && req.method === "PATCH") return done(await renameThread(req, auth, tid));
  }
  if (segs[0] === "v1" && segs[1] === "agents" && segs[2] === "me" && segs[3] === "wake" && segs.length === 4 && auth.kind === "agent") {
    if (req.method === "GET") return done(await getWake(auth, auth.agentId));
    if (req.method === "PUT") return done(await putWake(req, auth, auth.agentId));
  }
  if (segs[0] === "v1" && segs[1] === "agents" && segs[2] === "me" && auth.kind === "agent") {
    if (segs.length === 4 && segs[3] === "ack" && req.method === "POST") return done(await ackMessages(req, auth));
    if (segs.length === 4 && segs[3] === "selftest" && req.method === "POST") {
      return done(await makeCanary(auth.agentId, auth.agentId));
    }
    if (segs.length === 5 && segs[3] === "selftest" && req.method === "GET") return done(await canaryResult(auth.agentId, segs[4]));
  }
  if (segs[0] === "v1" && segs[1] === "owner" && segs[2] === "wake-health" && segs.length === 3 && req.method === "GET") return done(await wakeHealth(auth));
  if (segs[0] === "v1" && segs[1] === "owner" && segs[2] === "agents" && segs[4] === "canary") {
    if (auth.kind !== "owner") return done(jres(403, { error: "owner token required" }));
    if (segs.length === 5 && req.method === "POST") return done(await makeCanary(segs[3], OWNER_ID));
    if (segs.length === 5 && req.method === "GET") return done(await canaryResult(segs[3], null));
    if (segs.length === 6 && req.method === "GET") return done(await canaryResult(segs[3], segs[5]));
  }
  if (segs[0] === "v1" && segs[1] === "owner" && segs[2] === "agents" && segs[4] === "wake") {
    if (auth.kind !== "owner") return done(jres(403, { error: "owner token required" }));
    if (segs.length === 5 && req.method === "GET") return done(await getWake(auth, segs[3]));
    if (segs.length === 5 && req.method === "PUT") return done(await putWake(req, auth, segs[3]));
    if (segs.length === 6 && segs[5] === "test" && req.method === "POST") return done(await testWake(auth, segs[3]));
  }
  if (segs[0] === "v1" && segs[1] === "owner" && segs[2] === "agents") {
    if (segs.length === 3 && req.method === "GET") return done(await ownerAgents(req, auth));
    if (segs.length === 5 && segs[4] === "revoke" && req.method === "POST") return done(await revokeAgent(req, auth, segs[3]));
  }
  if (segs[0] === "v1" && segs[1] === "owner" && segs[2] === "threads" && segs.length === 7 && segs[4] === "members" && segs[6] === "verify" && req.method === "POST") {
    return done(await verifyMember(req, auth, segs[3], segs[5]));
  }
  if (segs[0] === "v1" && segs[1] === "owner" && segs[2] === "security" && segs.length === 4 && segs[3] === "reset-budgets" && req.method === "POST") {
    return done(await resetAuthBudgets(req, auth));
  }
  return done(jres(404, {
    error: "not found"
  }));
}
// ---- wake hooks -----------------------------------------------------------------
// Per-agent "nudge" settings, Tincan-style. Delivery NEVER depends on wake: a message is
// durable the moment it is posted; wake only tells the agent to go and poll. The payload
// carries a count and a thread id, never message content.
const WAKE_DEBOUNCE_MS = Number(Deno.env.get("SMITH_WAKE_DEBOUNCE_MS") ?? 10000);
const WAKE_RECHECK_MS = Number(Deno.env.get("SMITH_WAKE_RECHECK_MS") ?? 30000);
const WAKE_URGENT_PER_HOUR = Number(Deno.env.get("SMITH_WAKE_URGENT_PER_HOUR") ?? 6);
const WAKE_FAIL_DISABLE_AFTER = Number(Deno.env.get("SMITH_WAKE_FAIL_DISABLE_AFTER") ?? 20);
const WAKE_TEST_PER_HOUR = 10;
const WAKE_WEBHOOK_PER_HOUR = Number(Deno.env.get("SMITH_WAKE_WEBHOOK_PER_HOUR") ?? 60);
const WAKE_EMAIL_PER_HOUR = Number(Deno.env.get("SMITH_WAKE_EMAIL_PER_HOUR") ?? 12);
const WAKE_METHODS = ["none", "wait", "schedule", "webhook", "email"];
// Email wake is OFF unless all of these are set. Allowlist is exact addresses, no domains.
const WAKE_EMAIL_ENABLED = Deno.env.get("SMITH_WAKE_EMAIL_ENABLED") === "1";
const WAKE_EMAIL_ENDPOINT = Deno.env.get("SMITH_WAKE_EMAIL_ENDPOINT") ?? "";
const WAKE_EMAIL_KEY = Deno.env.get("SMITH_WAKE_EMAIL_KEY") ?? "";
const WAKE_EMAIL_FROM = Deno.env.get("SMITH_WAKE_EMAIL_FROM") ?? "";
const WAKE_EMAIL_ALLOW = (Deno.env.get("SMITH_WAKE_EMAIL_ALLOW") ?? "").split(",").map((s)=>s.trim().toLowerCase()).filter(Boolean);
const pollingAgents = new Map(); // agent_id -> open long-polls (best effort, per isolate)
const trailing = new Set(); // agent_ids with a pending trailing-edge wake
const pollTouch = new Map(); // agent_id -> last last_poll_at write (ms)
const sleep = (ms)=>new Promise((r)=>setTimeout(r, ms));

function ipv4Private(h) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function ipv6Private(h) {
  const x = h.toLowerCase().replace(/^\[|\]$/g, "");
  if (!x.includes(":")) return false;
  if (x === "::" || x === "::1") return true;
  if (/^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff")) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  return mapped ? ipv4Private(mapped[1]) : false;
}
// Syntactic URL policy, applied when the hook is set and again at send time.
function webhookUrlError(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return "url is not a valid URL"; }
  if (u.protocol !== "https:") return "url must be https";
  if (u.username || u.password) return "url must not contain credentials";
  if (u.port && u.port !== "443") return "url must use port 443";
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") && !h.includes(":")) return "url host must be a public hostname";
  if (/(^|\.)(localhost|local|internal|localdomain|home|lan|corp)$/.test(h)) return "url host must be a public hostname";
  // IP literals are refused outright (also closes IPv4-mapped / NAT64 IPv6 forms that URL normalizes).
  if (h.includes(":") || h.startsWith("[") || /^[\d.]+$/.test(h) || /^0x[0-9a-f]+$/i.test(h)) return "url host must be a DNS name, not an IP address";
  if (ipv4Private(h) || ipv6Private(h)) return "url host must not be a private or loopback address";
  if (String(raw).length > 500) return "url too long";
  return null;
}
// Resolve and refuse private targets (SSRF). Fails closed.
async function assertPublicHost(host) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    if (ipv4Private(host) || ipv6Private(host)) throw new Error("blocked_private_host");
    return;
  }
  let addrs = [];
  for (const t of ["A", "AAAA"]) {
    try { addrs = addrs.concat(await Deno.resolveDns(host, t)); } catch { /* no records of this type */ }
  }
  if (!addrs.length) throw new Error("dns_unresolved");
  for (const a of addrs) if (ipv4Private(a) || ipv6Private(a)) throw new Error("blocked_private_host");
}
async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
  return Array.from(sig).map((b)=>b.toString(16).padStart(2, "0")).join("");
}
async function sendWebhook(url, secret, payload, agentId) {
  const err = webhookUrlError(url);
  if (err) throw new Error("blocked_url");
  if (agentId) {
    const sentW = await timedQuery(sql`select count(*)::int as n from ${S("smith_audit")} where action = 'wake_sent' and detail->>'method' = 'webhook' and detail->>'agent_id' = ${agentId} and at > now() - interval '1 hour'`, "wake_webhook_rate");
    if (sentW[0].n >= WAKE_WEBHOOK_PER_HOUR) throw new Error("webhook_rate_limited");
  }
  await assertPublicHost(new URL(url).hostname);
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = secret ? await hmacHex(secret, `${ts}.${body}`) : "";
  const res = await fetch(url, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(3000),
    headers: { "content-type": "application/json", "user-agent": "smith-wake/1", "x-smith-timestamp": ts, "x-smith-signature": "sha256=" + sig },
    body
  });
  await res.body?.cancel();
  return res.status;
}
async function sendWakeEmail(address, payload) {
  if (!WAKE_EMAIL_ENABLED || !WAKE_EMAIL_ENDPOINT || !WAKE_EMAIL_KEY || !WAKE_EMAIL_FROM) throw new Error("email_disabled");
  if (!WAKE_EMAIL_ALLOW.includes(String(address).toLowerCase())) throw new Error("email_not_allowlisted");
  const sent = await timedQuery(sql`select count(*)::int as n from ${S("smith_audit")} where action = 'wake_sent' and detail->>'method' = 'email' and at > now() - interval '1 hour'`, "wake_email_rate");
  if (sent[0].n >= WAKE_EMAIL_PER_HOUR) throw new Error("email_rate_limited");
  // Ping only: a count and a thread id. No message content, ever.
  const text = `Smith: ${payload.unread} new message${payload.unread === 1 ? "" : "s"}${payload.thread_id ? " (thread " + payload.thread_id + ")" : ""}. Poll your Smith inbox to read.`;
  const res = await fetch(WAKE_EMAIL_ENDPOINT, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
    headers: { "content-type": "application/json", authorization: "Bearer " + WAKE_EMAIL_KEY },
    body: JSON.stringify({ from: WAKE_EMAIL_FROM, to: address, subject: "Smith wake", text })
  });
  await res.body?.cancel();
  return res.status;
}
async function wakeUnread(agentId) {
  const r = await timedQuery(sql`
    select count(*)::int as n
    from ${T("messages")} m
    join ${S("smith_thread_members")} tm on tm.thread_id = m.thread_id and tm.agent_id = ${agentId} and tm.legacy_unverified = false and m.created_at >= tm.added_at
    join ${S("smith_wake_hooks")} h on h.agent_id = ${agentId}
    where (m.to_agent = ${agentId} or m.to_agent = '*' or jsonb_exists(m.metadata->'mentions', ${agentId})) and m.from_agent <> ${agentId}
      and m.created_at > coalesce(h.last_poll_at, h.updated_at)`, "wake_unread");
  return r[0].n;
}
// Atomic claim of the debounce slot. Only one isolate wins per window.
async function wakeClaim(agentId, bypass) {
  const rows = await timedQuery(sql`
    update ${S("smith_wake_hooks")} set last_wake_at = now()
    where agent_id = ${agentId} and enabled and method in ('webhook','email')
      and (${bypass} or last_wake_at is null or last_wake_at < now() - make_interval(secs => ${WAKE_DEBOUNCE_MS / 1000}))
    returning agent_id, method, config, signing_secret`, "wake_claim");
  return rows[0] ?? null;
}
async function wakeDeliver(h, payload) {
  let status = "ok";
  try {
    const code = h.method === "email" ? await sendWakeEmail(h.config?.address, payload) : await sendWebhook(h.config?.url, h.signing_secret, payload, h.agent_id);
    if (code < 200 || code >= 300) status = "http_" + code;
  } catch (e) {
    status = "error:" + String(e?.message ?? e).slice(0, 60);
  }
  const ok = status === "ok";
  await timedQuery(sql`
    update ${S("smith_wake_hooks")} set last_status = ${status},
      fail_count = ${ok ? 0 : sql`fail_count + 1`},
      enabled = ${ok ? sql`enabled` : sql`enabled and fail_count + 1 < ${WAKE_FAIL_DISABLE_AFTER}`}
    where agent_id = ${h.agent_id}`, "wake_status");
  await audit("system", ok ? "wake_sent" : "wake_failed", { agent_id: h.agent_id, method: h.method, status, unread: payload.unread, urgent: !!payload.urgent });
  if (payload.event === "wake") {
    try {
      await sql`insert into ${S("smith_wake_log")} (agent_id, method, status, thread_id) values (${h.agent_id}, ${h.method}, ${status}, ${payload.thread_id ?? null})`;
      if (Math.random() < 0.02) await sql`delete from ${S("smith_wake_log")} where at < now() - interval '7 days'`;
    } catch { /* table absent */ }
  }
  return status;
}
async function wakeAttempt(agentId, threadId, urgent, bypass) {
  if (!urgent && (pollingAgents.get(agentId) ?? 0) > 0) return "skipped_polling";
  const h = await wakeClaim(agentId, bypass || urgent);
  if (!h) return "debounced";
  const unread = await wakeUnread(agentId);
  if (unread <= 0 && !urgent) return "nothing_unread";
  await wakeDeliver(h, { event: "wake", agent_id: agentId, unread, thread_id: threadId ?? null, urgent: !!urgent, ts: new Date().toISOString() });
  return "sent";
}
async function wakeFlow(agentId, threadId, urgent) {
  const first = await wakeAttempt(agentId, threadId, urgent, false);
  if (first === "debounced" && !trailing.has(agentId)) {
    // Trailing edge: one coalesced wake once the window passes.
    trailing.add(agentId);
    try {
      await sleep(WAKE_DEBOUNCE_MS + 250);
      await wakeAttempt(agentId, threadId, false, false);
    } finally { trailing.delete(agentId); }
    return;
  }
  if (first === "sent") {
    // 30s recheck: still unread and the agent has not polled since? One more nudge.
    await sleep(WAKE_RECHECK_MS);
    if ((pollingAgents.get(agentId) ?? 0) === 0) {
      const still = await wakeUnread(agentId);
      if (still > 0) await wakeAttempt(agentId, threadId, false, true);
    }
  }
}
// Decides (and audits) whether an urgent request is honored: rate-limited per sender.
async function urgentDecision(from, threadId, to, requested) {
  if (!requested) return false;
  const n = await timedQuery(sql`select count(*)::int as n from ${S("smith_audit")} where action = 'urgent_wake' and actor = ${from} and at > now() - interval '1 hour'`, "urgent_rate");
  if (n[0].n < WAKE_URGENT_PER_HOUR) {
    await audit(from, "urgent_wake", { thread_id: threadId, to });
    return true;
  }
  await audit(from, "urgent_wake_limited", { thread_id: threadId, to });
  return false;
}
async function wakeAfterPost(threadId, from, to, urgentRequested, mentions) {
  const ment = Array.isArray(mentions) ? mentions : [];
  const recips = await timedQuery(sql`
    select h.agent_id from ${S("smith_wake_hooks")} h
    join ${S("smith_agents")} a on a.agent_id = h.agent_id and a.revoked_at is null and a.token_hash is not null
    join ${S("smith_thread_members")} tm on tm.thread_id = ${threadId} and tm.agent_id = h.agent_id and tm.legacy_unverified = false
    where h.enabled and h.method in ('webhook','email') and h.agent_id <> ${from}
      and (${to} = '*' or h.agent_id = ${to} or h.agent_id = any(${ment}))`, "wake_recipients");
  if (!recips.length) return { urgent: false };
  const urgent = urgentRequested === true;
  await Promise.allSettled(recips.map((r)=>wakeFlow(r.agent_id, threadId, urgent)));
  return { urgent };
}
// ---- Web Push (owner devices) ----------------------------------------------
// Per-instance VAPID keys live in smith_push_config (RLS-locked, never returned). Payloads are
// encrypted per RFC 8291 (aes128gcm) with WebCrypto; no third-party service or dependency.
const PUSH_DEBOUNCE_MS = Number(Deno.env.get("SMITH_PUSH_DEBOUNCE_MS") ?? 10000);
const PUSH_PER_HOUR = Number(Deno.env.get("SMITH_PUSH_PER_HOUR") ?? 60);
const PUSH_MAX_DEVICES = 10;
const b64u = (u8)=>btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s)=>{
  const p = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(p + "=".repeat((4 - p.length % 4) % 4));
  return Uint8Array.from(bin, (c)=>c.charCodeAt(0));
};
const cat = (...a)=>{ const o = new Uint8Array(a.reduce((n, x)=>n + x.length, 0)); let i = 0; for (const x of a){ o.set(x, i); i += x.length; } return o; };
async function pushConfig(create) {
  let rows = await timedQuery(sql`select public_key, private_jwk, contact, include_body from ${S("smith_push_config")} where id = 1`, "push_cfg");
  if (!rows.length && create) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    await timedQuery(sql`insert into ${S("smith_push_config")} (id, public_key, private_jwk) values (1, ${b64u(pub)}, ${sql.json(jwk)}) on conflict (id) do nothing`, "push_cfg_create");
    rows = await timedQuery(sql`select public_key, private_jwk, contact, include_body from ${S("smith_push_config")} where id = 1`, "push_cfg2");
  }
  return rows[0] ?? null;
}
async function vapidAuth(cfg, endpoint) {
  const aud = new URL(endpoint).origin;
  const enc = (o)=>b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ typ: "JWT", alg: "ES256" }) + "." + enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: cfg.contact });
  const key = await crypto.subtle.importKey("jwk", cfg.private_jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned)));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${cfg.public_key}`;
}
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}
// RFC 8291 aes128gcm content coding for one record.
async function pushEncrypt(p256dh, authSecret, plaintext) {
  const uaPub = unb64u(p256dh), auth = unb64u(authSecret);
  if (uaPub.length !== 65 || uaPub[0] !== 4 || auth.length !== 16) throw new Error("bad_subscription_keys");
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const te = new TextEncoder();
  const ikm = await hkdf(auth, shared, cat(te.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, cat(plaintext, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return cat(salt, rs, new Uint8Array([65]), asPub, ct);
}
// Browsers hand out endpoints on their vendor push services. Only those hosts are accepted
// by default. Set SMITH_PUSH_HOSTS (comma list, "*.example.com" suffix patterns, or "*" for any
// public host) for other push services.
const PUSH_HOSTS = (Deno.env.get("SMITH_PUSH_HOSTS") ?? "fcm.googleapis.com,updates.push.services.mozilla.com,*.push.services.mozilla.com,*.push.apple.com,*.notify.windows.com").split(",").map((x)=>x.trim().toLowerCase()).filter(Boolean);
function pushHostAllowed(host) {
  const h = String(host).toLowerCase();
  return PUSH_HOSTS.some((p)=> p === "*" || (p.startsWith("*.") ? h.endsWith(p.slice(1)) : h === p));
}
function pushEndpointError(raw) {
  const e = webhookUrlError(raw);
  if (e) return e.replace("url", "endpoint");
  try { if (!pushHostAllowed(new URL(raw).hostname)) return "endpoint host is not a known push service"; } catch { return "invalid endpoint"; }
  return null;
}
async function sendPush(cfg, sub, payloadObj) {
  const err = pushEndpointError(sub.endpoint);
  if (err) throw new Error("blocked_endpoint");
  await assertPublicHost(new URL(sub.endpoint).hostname);
  const body = await pushEncrypt(sub.p256dh, sub.auth, new TextEncoder().encode(JSON.stringify(payloadObj)));
  const res = await fetch(sub.endpoint, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000),
    headers: { Authorization: await vapidAuth(cfg, sub.endpoint), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "3600", Urgency: "normal" },
    body
  });
  await res.body?.cancel();
  return res.status;
}
async function ownerUnreadTotals(threadId) {
  const r = await timedQuery(sql`
    select
      (select count(*)::int from ${T("messages")} m left join ${S("smith_owner_reads")} orr on orr.thread_id = m.thread_id
        where m.thread_id = ${threadId} and m.from_agent <> ${OWNER_ID} and m.created_at > coalesce(orr.last_read_at, 'epoch'::timestamptz)) as thread_unread,
      (select count(*)::int from ${T("messages")} m join ${S("smith_threads")} t on t.thread_id = m.thread_id
        left join ${S("smith_owner_reads")} orr on orr.thread_id = m.thread_id
        where m.from_agent <> ${OWNER_ID} and m.thread_id not like ${WAKECHECK_LIKE} and m.created_at > coalesce(orr.last_read_at, 'epoch'::timestamptz)) as total_unread,
      (select count(*)::int from ${T("messages")} m left join ${S("smith_owner_reads")} orr on orr.thread_id = m.thread_id
        where m.thread_id = ${threadId} and m.from_agent <> ${OWNER_ID} and jsonb_exists(m.metadata->'mentions', ${OWNER_ID}) and m.created_at > coalesce(orr.last_read_at, 'epoch'::timestamptz)) as mention_unread,
      (select name from ${S("smith_threads")} where thread_id = ${threadId}) as name`, "push_unread");
  return r[0];
}
const pushTrailing = new Set();
async function pushNotifyOwner(threadId, msgBody, force) {
  const cfg = await pushConfig(false);
  if (!cfg) return "not_configured";
  const subs = await timedQuery(sql`select id from ${S("smith_push_subs")}`, "push_subs_any");
  if (!subs.length) return "no_devices";
  // Debounce per device: claim atomically, or one trailing send per thread after the window.
  const claimed = await timedQuery(sql`
    update ${S("smith_push_subs")} set last_push_at = now()
    where (last_push_at is null or last_push_at < now() - make_interval(secs => ${PUSH_DEBOUNCE_MS / 1000}))
    returning id, endpoint, p256dh, auth`, "push_claim");
  const skipped = claimed.length < subs.length;
  if (skipped && !pushTrailing.has(threadId)) {
    pushTrailing.add(threadId);
    (async ()=>{ try { await sleep(PUSH_DEBOUNCE_MS + 300); await pushNotifyOwner(threadId, msgBody, false); } finally { pushTrailing.delete(threadId); } })().catch(()=>{});
  }
  if (!claimed.length) return "debounced";
  const u = await ownerUnreadTotals(threadId);
  if (!u || u.thread_unread <= 0) return "nothing_unread";
  const payload = {
    v: 1, thread_id: threadId, title: u.name || "Smith", count: u.thread_unread, total: u.total_unread, ...(u.mention_unread > 0 ? { mention: true } : {}),
    ...(cfg.include_body && msgBody ? { body: String(msgBody).slice(0, 140) } : {})
  };
  for (const s of claimed){
    const n = await timedQuery(sql`select count(*)::int as n from ${S("smith_audit")} where action = 'push_sent' and detail->>'sub_id' = ${s.id} and at > now() - interval '1 hour'`, "push_rate");
    if (n[0].n >= PUSH_PER_HOUR) continue;
    let status = "ok";
    try {
      const code = await sendPush(cfg, s, payload);
      if (code === 404 || code === 410) {
        await timedQuery(sql`delete from ${S("smith_push_subs")} where id = ${s.id}`, "push_gone");
        status = "gone";
      } else if (code < 200 || code >= 300) status = "http_" + code;
    } catch (e) { status = "error:" + String(e?.message ?? e).slice(0, 60); }
    if (status === "ok") await timedQuery(sql`update ${S("smith_push_subs")} set last_ok_at = now(), fail_count = 0 where id = ${s.id}`, "push_ok");
    else if (status !== "gone") await timedQuery(sql`update ${S("smith_push_subs")} set fail_count = fail_count + 1 where id = ${s.id}`, "push_fail");
    await audit("system", status === "ok" ? "push_sent" : "push_failed", { sub_id: s.id, status, thread_id: threadId, count: payload.count });
  }
  await timedQuery(sql`delete from ${S("smith_push_subs")} where fail_count >= 20`, "push_prune");
  return "sent";
}
function pushView(r) { return { id: r.id, label: r.label, host: new URL(r.endpoint).hostname, created_at: iso(r.created_at), last_ok_at: r.last_ok_at ? iso(r.last_ok_at) : null, fail_count: r.fail_count }; }
async function pushRoutes(req, auth, segs) {
  const denied = requireOwner(auth);
  if (denied) return denied;
  const method = req.method;
  const sub = segs[3];
  if (segs.length === 3 && method === "GET") {
    const cfg = await pushConfig(false);
    const devs = cfg ? await timedQuery(sql`select id, label, endpoint, created_at, last_ok_at, fail_count from ${S("smith_push_subs")} order by created_at asc`, "push_list") : [];
    return jres(200, { enabled: !!cfg, public_key: cfg?.public_key ?? null, include_body: !!cfg?.include_body, contact: cfg?.contact ?? null, devices: devs.map(pushView) });
  }
  if (segs.length === 4 && sub === "setup" && method === "POST") {
    const had = !!await pushConfig(false);
    const cfg = await pushConfig(true);
    if (!had) await audit(OWNER_ID, "push_setup", {});
    return jres(200, { enabled: true, public_key: cfg.public_key });
  }
  let body = {};
  if (method === "PUT" || method === "POST") { try { body = await req.json(); } catch { body = {}; } }
  if (segs.length === 4 && sub === "settings" && method === "PUT") {
    const cfg = await pushConfig(false);
    if (!cfg) return jres(409, { error: "push is not set up" });
    const contact = body.contact === undefined ? cfg.contact : String(body.contact);
    if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(contact) || contact.length > 200) return jres(422, { error: "contact must be a mailto: or https: URL" });
    const ib = body.include_body === undefined ? cfg.include_body : body.include_body === true;
    await timedQuery(sql`update ${S("smith_push_config")} set contact = ${contact}, include_body = ${ib} where id = 1`, "push_settings");
    await audit(OWNER_ID, "push_settings", { include_body: ib });
    return jres(200, { include_body: ib, contact });
  }
  if (segs.length === 4 && sub === "subscription" && method === "PUT") {
    const cfg = await pushConfig(false);
    if (!cfg) return jres(409, { error: "push is not set up" });
    const ep = String(body.endpoint ?? ""), p = String(body.keys?.p256dh ?? ""), a = String(body.keys?.auth ?? "");
    const e = pushEndpointError(ep);
    if (e) return jres(422, { error: e });
    if (ep.length > 800) return jres(422, { error: "endpoint too long" });
    try { await pushEncrypt(p, a, new Uint8Array([1])); } catch { return jres(422, { error: "invalid subscription keys" }); }
    const label = String(body.label ?? "device").slice(0, 60) || "device";
    const cnt = await timedQuery(sql`select count(*)::int as n from ${S("smith_push_subs")} where endpoint <> ${ep}`, "push_count");
    if (cnt[0].n >= PUSH_MAX_DEVICES) return jres(409, { error: `device limit reached (${PUSH_MAX_DEVICES}); remove one first` });
    const id = "ps_" + randomHexBytes(8);
    const row = (await timedQuery(sql`insert into ${S("smith_push_subs")} (id, endpoint, p256dh, auth, label) values (${id}, ${ep}, ${p}, ${a}, ${label})
      on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, fail_count = 0
      returning id, label, endpoint, created_at, last_ok_at, fail_count`, "push_sub_put"))[0];
    await audit(OWNER_ID, "push_subscribe", { sub_id: row.id, host: new URL(ep).hostname });
    return jres(200, pushView(row));
  }
  if (segs.length === 5 && sub === "subscription" && method === "DELETE") {
    const r = await timedQuery(sql`delete from ${S("smith_push_subs")} where id = ${segs[4]} returning id`, "push_del");
    if (!r.length) return jres(404, { error: "device not found" });
    await audit(OWNER_ID, "push_unsubscribe", { sub_id: segs[4] });
    return jres(200, { id: segs[4], removed: true });
  }
  if (segs.length === 4 && sub === "test" && method === "POST") {
    const cfg = await pushConfig(false);
    if (!cfg) return jres(409, { error: "push is not set up" });
    const subs = await timedQuery(sql`select id, endpoint, p256dh, auth from ${S("smith_push_subs")}`, "push_test_subs");
    if (!subs.length) return jres(409, { error: "no devices subscribed" });
    const out = [];
    for (const s of subs){
      let status = "ok";
      try { const code = await sendPush(cfg, s, { v: 1, test: true, title: "Smith", count: 0, total: 0, body: "Notifications are working." }); if (code === 404 || code === 410) { await timedQuery(sql`delete from ${S("smith_push_subs")} where id = ${s.id}`, "push_gone_t"); status = "gone"; } else if (code < 200 || code >= 300) status = "http_" + code; }
      catch (e) { status = "error:" + String(e?.message ?? e).slice(0, 60); }
      out.push({ id: s.id, status });
    }
    return jres(200, { results: out });
  }
  return jres(404, { error: "not found" });
}
function afterPostWake(threadId, from, to, urgentRequested, pushBodyHint, mentions) {
  const p = wakeAfterPost(threadId, from, to, urgentRequested, mentions).catch((e)=>console.error("wake failed", e));
  try { globalThis.EdgeRuntime?.waitUntil?.(p); } catch { /* local runs just let it float */ }
  if (from !== OWNER_ID && !String(threadId).startsWith("th_wakecheck_")) {
    const q = pushNotifyOwner(threadId, pushBodyHint, false).catch((e)=>console.error("push failed", e));
    try { globalThis.EdgeRuntime?.waitUntil?.(q); } catch { /* local */ }
  }
}
function markPolling(agentId, d) {
  const n = (pollingAgents.get(agentId) ?? 0) + d;
  if (n <= 0) pollingAgents.delete(agentId); else pollingAgents.set(agentId, n);
}
async function touchPoll(agentId) {
  const now = Date.now();
  if (now - (pollTouch.get(agentId) ?? 0) < 3000) return;
  pollTouch.set(agentId, now);
  try { await sql`update ${S("smith_wake_hooks")} set last_poll_at = now() where agent_id = ${agentId}`; } catch { /* hooks table absent: wake not installed */ }
  markWakeAnswered(agentId).catch(()=>{});
}
// A poll, peek or ack after a wake means the agent answered it.
async function markWakeAnswered(agentId) {
  try { await sql`update ${S("smith_wake_log")} set polled_at = now() where agent_id = ${agentId} and polled_at is null and at > now() - interval '10 minutes'`; } catch { /* table absent */ }
}
// Canary pickup: first time the target agent's poll returns the canary message.
async function markCanariesPicked(rows) {
  const ids = rows.filter((r)=> r.metadata && r.metadata.canary).map((r)=> r.id);
  if (!ids.length) return;
  try { await sql`update ${S("smith_canaries")} set picked_at = now() where msg_id = any(${ids}) and picked_at is null`; } catch { /* table absent */ }
}
async function agentUnreadState(agentId) {
  const r = await timedQuery(sql`
    with base as (
      select coalesce(c.acked_at, h.last_poll_at, a.created_at) as since
      from ${S("smith_agents")} a
      left join ${S("smith_agent_cursor")} c on c.agent_id = a.agent_id
      left join ${S("smith_wake_hooks")} h on h.agent_id = a.agent_id
      where a.agent_id = ${agentId})
    select
      (select count(*)::int from ${T("messages")} m join ${S("smith_thread_members")} tm on tm.thread_id = m.thread_id and tm.agent_id = ${agentId} and tm.legacy_unverified = false and m.created_at >= tm.added_at, base
        where (m.to_agent = ${agentId} or m.to_agent = '*' or jsonb_exists(m.metadata->'mentions', ${agentId})) and m.from_agent <> ${agentId} and m.created_at > base.since) as unread,
      (select extract(epoch from now() - min(m.created_at))::int from ${T("messages")} m join ${S("smith_thread_members")} tm on tm.thread_id = m.thread_id and tm.agent_id = ${agentId} and tm.legacy_unverified = false and m.created_at >= tm.added_at, base
        where (m.to_agent = ${agentId} or m.to_agent = '*' or jsonb_exists(m.metadata->'mentions', ${agentId})) and m.from_agent <> ${agentId} and m.created_at > base.since) as oldest_age_s,
      (select m.id from ${T("messages")} m join ${S("smith_thread_members")} tm on tm.thread_id = m.thread_id and tm.agent_id = ${agentId} and tm.legacy_unverified = false and m.created_at >= tm.added_at
        where (m.to_agent = ${agentId} or m.to_agent = '*' or jsonb_exists(m.metadata->'mentions', ${agentId})) and m.from_agent <> ${agentId} order by m.created_at desc, m.id desc limit 1) as newest_id`, "agent_unread_state");
  return r[0];
}
async function unreadStatesFor(ids) {
  const rows = await timedQuery(sql`
    select a.agent_id, count(m.id)::int as unread, (extract(epoch from now() - min(m.created_at)))::int as oldest_age_s
    from ${S("smith_agents")} a
    left join ${S("smith_agent_cursor")} c on c.agent_id = a.agent_id
    left join ${S("smith_wake_hooks")} h on h.agent_id = a.agent_id
    left join ${S("smith_thread_members")} tm on tm.agent_id = a.agent_id and tm.legacy_unverified = false
    left join ${T("messages")} m on m.thread_id = tm.thread_id and m.created_at >= tm.added_at and m.from_agent <> a.agent_id
      and (m.to_agent = a.agent_id or m.to_agent = '*' or jsonb_exists(m.metadata->'mentions', a.agent_id))
      and m.created_at > coalesce(c.acked_at, h.last_poll_at, a.created_at)
    where a.agent_id = any(${ids}) group by a.agent_id`, "unread_states");
  return new Map(rows.map((r)=>[r.agent_id, r]));
}
async function peekMessages(auth) {
  // Peek writes are throttled: one upsert per agent per 5 s.
  const touched = await timedQuery(sql`insert into ${S("smith_agent_cursor")} (agent_id, last_peek_at) values (${auth.agentId}, now())
    on conflict (agent_id) do update set last_peek_at = now() where ${S("smith_agent_cursor")}.last_peek_at is null or ${S("smith_agent_cursor")}.last_peek_at < now() - interval '5 seconds' returning agent_id`, "peek_touch");
  if (touched.length) markWakeAnswered(auth.agentId).catch(()=>{});
  const st = await agentUnreadState(auth.agentId);
  const cur = await timedQuery(sql`select acked_id, acked_at from ${S("smith_agent_cursor")} where agent_id = ${auth.agentId}`, "peek_cursor");
  return jres(200, { unread: st.unread, oldest_unread_age_s: st.oldest_age_s ?? 0, newest_id: st.newest_id ?? null, cursor: cur[0]?.acked_id ? { acked_id: cur[0].acked_id, acked_at: iso(cur[0].acked_at) } : null });
}
async function ackMessages(req, auth) {
  let body; try { body = await req.json(); } catch { return jres(400, { error: "invalid JSON" }); }
  const mid = body?.through_id;
  if (typeof mid !== "string" || !mid) return jres(422, { error: "through_id required" });
  const m = await timedQuery(sql`
    select m.id, m.created_at from ${T("messages")} m join ${S("smith_thread_members")} tm on tm.thread_id = m.thread_id and tm.agent_id = ${auth.agentId} and tm.legacy_unverified = false and m.created_at >= tm.added_at
    where m.id = ${mid}`, "ack_find");
  if (!m.length) return jres(404, { error: "message not found for this agent" });
  // created_at is copied inside the database: a JS Date would truncate the microseconds.
  await timedQuery(sql`
    insert into ${S("smith_agent_cursor")} (agent_id, acked_id, acked_at)
    select ${auth.agentId}, m.id, m.created_at from ${T("messages")} m where m.id = ${m[0].id}
    on conflict (agent_id) do update set acked_id = case when ${S("smith_agent_cursor")}.acked_at is null or excluded.acked_at > ${S("smith_agent_cursor")}.acked_at then excluded.acked_id else ${S("smith_agent_cursor")}.acked_id end,
                                         acked_at = greatest(${S("smith_agent_cursor")}.acked_at, excluded.acked_at)`, "ack_upsert");
  await timedQuery(sql`update ${S("smith_canaries")} set acked_at = now() where agent_id = ${auth.agentId} and acked_at is null and picked_at is not null and msg_id in (select c2.id from ${T("messages")} c2 where c2.created_at <= (select created_at from ${T("messages")} where id = ${m[0].id}))`, "ack_canary");
  markWakeAnswered(auth.agentId).catch(()=>{});
  return jres(200, { ok: true, acked_id: m[0].id });
}
const CANARY_PER_HOUR = 30;
const SELFTEST_PER_HOUR = 12;
async function makeCanary(agentId, actor) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) return jres(422, { error: "bad agent id" });
  const a = await timedQuery(sql`select 1 from ${S("smith_agents")} where agent_id = ${agentId} and revoked_at is null and token_hash is not null`, "canary_agent");
  if (!a.length) return jres(404, { error: "agent not registered" });
  const src = actor === OWNER_ID ? "owner" : "agent";
  const n = await timedQuery(sql`select count(*)::int as n from ${S("smith_canaries")} where agent_id = ${agentId} and source = ${src} and created_at > now() - interval '1 hour'`, "canary_rate");
  if (n[0].n >= (src === "owner" ? CANARY_PER_HOUR : SELFTEST_PER_HOUR)) return jres(429, { error: "canary limit reached" }, { "Retry-After": "600" });
  const tid = "th_wakecheck_" + agentId;
  const cid = "cn_" + ulid(), mid = "msg_" + ulid();
  await timedQuery(sql.begin(async (tx)=>{
    await tx`insert into ${S("smith_threads")} (thread_id, name, created_by) values (${tid}, ${"Wake check · " + agentId}, ${OWNER_ID}) on conflict do nothing`;
    await tx`insert into ${S("smith_thread_members")} (thread_id, agent_id) values (${tid}, ${agentId}) on conflict do nothing`;
    await tx`insert into ${T("messages")} (id, thread_id, from_agent, to_agent, type, body, metadata)
             values (${mid}, ${tid}, ${OWNER_ID}, ${agentId}, 'note', 'Wake check. No action needed beyond a short reply or an ack.', ${sql.json({ canary: cid })})`;
    await tx`insert into ${S("smith_canaries")} (id, agent_id, thread_id, msg_id, source) values (${cid}, ${agentId}, ${tid}, ${mid}, ${src})`;
  }), "canary_create", 3500);
  await audit(actor, "canary", { agent_id: agentId, canary_id: cid });
  // Same wake path as any owner message; owner pushes never fire for owner posts.
  afterPostWake(tid, OWNER_ID, agentId, false, null, []);
  return jres(201, { canary_id: cid, thread_id: tid, message_id: mid });
}
async function canaryResult(agentId, cid) {
  const r = await timedQuery(sql`select c.*, (select status from ${S("smith_wake_log")} w where w.agent_id = c.agent_id and w.at >= c.created_at order by w.at asc limit 1) as wake_status,
      (select extract(epoch from w.at - c.created_at) * 1000 from ${S("smith_wake_log")} w where w.agent_id = c.agent_id and w.at >= c.created_at order by w.at asc limit 1)::int as wake_sent_ms
    from ${S("smith_canaries")} c where c.agent_id = ${agentId} ${cid ? sql`and c.id = ${cid}` : sql``} order by c.created_at desc limit 1`, "canary_result");
  if (!r.length) return jres(404, { error: "no canary" });
  const c = r[0];
  return jres(200, {
    canary_id: c.id, agent_id: c.agent_id, created_at: iso(c.created_at),
    picked_at: c.picked_at ? iso(c.picked_at) : null,
    pickup_ms: c.picked_at ? Math.round(new Date(c.picked_at).getTime() - new Date(c.created_at).getTime()) : null,
    acked_at: c.acked_at ? iso(c.acked_at) : null,
    wake_status: c.wake_status ?? null, wake_sent_ms: c.wake_sent_ms ?? null
  });
}
async function wakeHealth(auth) {
  const denied = requireOwner(auth);
  if (denied) return denied;
  const rows = await timedQuery(sql`
    select a.agent_id, a.display_name, a.platform,
      h.method, h.enabled, h.last_wake_at, h.last_poll_at, h.last_status, h.fail_count,
      c.last_peek_at, c.acked_at,
      (select max(at) from ${S("smith_wake_log")} w where w.agent_id = a.agent_id and w.status = 'ok') as last_wake_ok_at,
      (select count(*)::int from ${S("smith_wake_log")} w where w.agent_id = a.agent_id and w.at > now() - interval '24 hours') as wakes_24h,
      (select count(*)::int from ${S("smith_wake_log")} w where w.agent_id = a.agent_id and w.at > now() - interval '24 hours' and w.at < now() - interval '90 seconds'
         and (w.status <> 'ok' or w.polled_at is null or w.polled_at - w.at > interval '90 seconds')) as missed_24h,
      (select jsonb_build_object('at', k.created_at, 'pickup_ms', (extract(epoch from k.picked_at - k.created_at) * 1000)::int) from ${S("smith_canaries")} k where k.agent_id = a.agent_id order by k.created_at desc limit 1) as canary
    from ${S("smith_agents")} a
    left join ${S("smith_wake_hooks")} h on h.agent_id = a.agent_id
    left join ${S("smith_agent_cursor")} c on c.agent_id = a.agent_id
    where a.revoked_at is null and a.token_hash is not null
    order by a.agent_id asc`, "wake_health");
  const out = [];
  const states = await unreadStatesFor(rows.map((r)=>r.agent_id));
  for (const r of rows) {
    const st = states.get(r.agent_id) ?? { unread: 0, oldest_age_s: 0 };
    const alive = [r.last_poll_at, r.last_peek_at].filter(Boolean).map((x)=> new Date(x).getTime()).sort((x, y)=> y - x)[0] ?? null;
    const aliveAgo = alive ? Math.round((Date.now() - alive) / 1000) : null;
    const oldest = st.oldest_age_s ?? 0;
    let state = "ok";
    const hooked = r.enabled === true && (r.method === "webhook" || r.method === "email");
    if (alive === null && hooked) state = r.missed_24h > 0 ? "slow" : "ok"; // reachable by webhook, never needs to poll
    else if (alive === null) state = "never";
    else if (st.unread > 0 && oldest > 180 && aliveAgo > 120) state = "stale";
    else if (oldest > 60 || (r.canary && r.canary.pickup_ms !== null && r.canary.pickup_ms > 30000) || r.missed_24h > 0) state = "slow";
    out.push({
      agent_id: r.agent_id, display_name: r.display_name, platform: r.platform, state,
      wake_method: r.method ?? "none", wake_enabled: r.enabled ?? false, wake_fail_count: r.fail_count ?? 0, wake_last_status: r.last_status ?? null,
      last_poll_at: r.last_poll_at ? iso(r.last_poll_at) : null, last_peek_at: r.last_peek_at ? iso(r.last_peek_at) : null,
      alive_ago_s: aliveAgo, last_wake_at: r.last_wake_at ? iso(r.last_wake_at) : null, last_wake_ok_at: r.last_wake_ok_at ? iso(r.last_wake_ok_at) : null,
      wakes_24h: r.wakes_24h, missed_wakes_24h: r.missed_24h, unread: st.unread, oldest_unread_age_s: oldest,
      acked_at: r.acked_at ? iso(r.acked_at) : null,
      last_canary: r.canary ? { at: iso(r.canary.at), pickup_ms: r.canary.pickup_ms } : null
    });
  }
  return jres(200, { agents: out, generated_at: new Date().toISOString() });
}
async function getMessages(req, arrivedAt, auth) {
  if (auth.kind === "agent" && new URL(req.url).searchParams.get("peek") === "1") return await peekMessages(auth);
  if (auth.kind !== "agent") return await getMessagesInner(req, arrivedAt, auth);
  markPolling(auth.agentId, 1);
  touchPoll(auth.agentId).catch(()=>{});
  try {
    return await getMessagesInner(req, arrivedAt, auth);
  } finally {
    markPolling(auth.agentId, -1);
    pollTouch.delete(auth.agentId);
    touchPoll(auth.agentId).catch(()=>{});
  }
}
function wakeView(row) {
  if (!row) return { method: "none", enabled: true, config: {}, has_secret: false, last_wake_at: null, last_status: null, fail_count: 0, email_available: WAKE_EMAIL_ENABLED };
  return {
    method: row.method, enabled: row.enabled, config: row.config ?? {}, has_secret: !!row.signing_secret,
    last_wake_at: row.last_wake_at ? iso(row.last_wake_at) : null, last_poll_at: row.last_poll_at ? iso(row.last_poll_at) : null,
    last_status: row.last_status, fail_count: row.fail_count, updated_at: iso(row.updated_at), email_available: WAKE_EMAIL_ENABLED
  };
}
async function wakeAgentOk(agentId) {
  const a = await timedQuery(sql`select 1 from ${S("smith_agents")} where agent_id = ${agentId} and revoked_at is null and token_hash is not null`, "wake_agent");
  return a.length > 0;
}
async function getWake(auth, agentId) {
  if (auth.kind === "agent" && auth.agentId !== agentId) return jres(403, { error: "not your agent" });
  if (auth.kind !== "agent" && auth.kind !== "owner") return jres(403, { error: "agent or owner token required" });
  if (!await wakeAgentOk(agentId)) return jres(404, { error: "agent not found" });
  const r = await timedQuery(sql`select * from ${S("smith_wake_hooks")} where agent_id = ${agentId}`, "wake_get");
  return jres(200, wakeView(r[0]));
}
async function putWake(req, auth, agentId) {
  if (auth.kind === "agent" && auth.agentId !== agentId) return jres(403, { error: "not your agent" });
  if (auth.kind !== "agent" && auth.kind !== "owner") return jres(403, { error: "agent or owner token required" });
  let body;
  try { body = await req.json(); } catch { return jres(400, { error: "invalid JSON" }); }
  if (!await wakeAgentOk(agentId)) return jres(404, { error: "agent not found" });
  const method = body.method;
  if (!WAKE_METHODS.includes(method)) return jres(422, { error: `method must be one of ${WAKE_METHODS.join(", ")}` });
  const cur = (await timedQuery(sql`select * from ${S("smith_wake_hooks")} where agent_id = ${agentId}`, "wake_cur"))[0];
  let config = {};
  let secret = cur?.signing_secret ?? null;
  let secretOut = null;
  if (method === "webhook") {
    if (auth.kind !== "owner") return jres(403, { error: "only the owner can set a webhook URL" });
    const e = webhookUrlError(body.url);
    if (e) return jres(422, { error: e });
    config = { url: String(body.url) };
    if (!secret || body.rotate_secret === true) {
      secretOut = "whsec_" + randomHexBytes(24);
      secret = secretOut;
    }
  } else if (method === "schedule") {
    const n = Number(body.interval_minutes);
    if (!Number.isInteger(n) || n < 1 || n > 1440) return jres(422, { error: "interval_minutes must be an integer from 1 to 1440" });
    config = { interval_minutes: n };
  } else if (method === "email") {
    if (auth.kind !== "owner") return jres(403, { error: "only the owner can set an email wake" });
    if (!WAKE_EMAIL_ENABLED) return jres(409, { error: "email wake is disabled on this instance" });
    const addr = String(body.address ?? "").trim().toLowerCase();
    if (!WAKE_EMAIL_ALLOW.includes(addr)) return jres(422, { error: "address is not on this instance's email allowlist" });
    config = { address: addr };
  }
  if (method !== "webhook") secret = null; // never keep an HMAC key for a hook that is not a webhook
  const enabled = body.enabled === false ? false : true;
  await timedQuery(sql`
    insert into ${S("smith_wake_hooks")} (agent_id, method, config, signing_secret, enabled, updated_at)
    values (${agentId}, ${method}, ${sql.json(config)}, ${secret}, ${enabled}, now())
    on conflict (agent_id) do update set method = excluded.method, config = excluded.config,
      signing_secret = excluded.signing_secret, enabled = excluded.enabled, fail_count = 0, updated_at = now()`, "wake_put");
  const host = config.url ? new URL(config.url).hostname : config.address ? "email" : null;
  await audit(auth.kind === "owner" ? OWNER_ID : auth.agentId, "set_wake", { agent_id: agentId, method, host, enabled, rotated_secret: secretOut !== null });
  const r = (await timedQuery(sql`select * from ${S("smith_wake_hooks")} where agent_id = ${agentId}`, "wake_get2"))[0];
  const out = wakeView(r);
  if (secretOut) out.signing_secret = secretOut; // shown once
  return jres(200, out);
}
async function testWake(auth, agentId) {
  const denied = requireOwner(auth);
  if (denied) return denied;
  const r = (await timedQuery(sql`select * from ${S("smith_wake_hooks")} where agent_id = ${agentId}`, "wake_t"))[0];
  if (!r || !r.enabled || !["webhook", "email"].includes(r.method)) return jres(409, { error: "no enabled webhook or email wake for this agent" });
  const n = await timedQuery(sql`select count(*)::int as n from ${S("smith_audit")} where action = 'wake_test' and detail->>'agent_id' = ${agentId} and at > now() - interval '1 hour'`, "wake_test_rate");
  if (n[0].n >= WAKE_TEST_PER_HOUR) return jres(429, { error: "wake test limit reached" }, { "Retry-After": "600" });
  await audit(OWNER_ID, "wake_test", { agent_id: agentId, method: r.method });
  const status = await wakeDeliver(r, { event: "wake_test", agent_id: agentId, unread: 0, thread_id: null, urgent: false, ts: new Date().toISOString() });
  return jres(200, { status });
}

// CORS: exact-origin allowlist for the hosted Smith web client. No wildcard.
// SMITH_CORS_ORIGINS (comma list of exact https origins) adds your own hosted client; the default keeps the public one.
const CORS_ORIGINS = (Deno.env.get("SMITH_CORS_ORIGINS") ?? Deno.env.get("SMITH_CORS_ORIGIN") ?? "https://zev-dotcom.github.io")
  .split(",").map((x)=>x.trim()).filter((x)=>/^https?:\/\/[^/*\s]+$/.test(x));
function corsHeaders(req) {
  const o = req.headers.get("origin");
  if (!o || !CORS_ORIGINS.includes(o)) return null;
  return {
    "access-control-allow-origin": o,
    "access-control-allow-headers": "Authorization, X-Agent-Id, Content-Type",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-max-age": "600",
    "vary": "Origin"
  };
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") {
    const ch = corsHeaders(req);
    return ch ? new Response(null, { status: 204, headers: ch }) : jres(404, { error: "not found" });
  }
  const arrivedAt = Date.now();
  const startupAt = Date.now();
  await startupPurge;
  console.log(`cutout startup_wait_ms=${Date.now() - startupAt}`);
  let res;
  let state = null;
  let ident = "unknown";
  try {
    const routeAt = Date.now();
    ({ res, state, ident } = await route(req, arrivedAt));
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
    const h = rateHeaders(state ?? await rateState(ident));
    for (const [k, v] of Object.entries(h))res.headers.set(k, v);
    console.log(`cutout rate_headers_ms=${Date.now() - headerAt}`);
  } catch (e) {
    console.error("rate header read failed", e);
  }
  console.log(`cutout response_ms=${Date.now() - arrivedAt} status=${res.status}`);
  const ch = corsHeaders(req);
  if (ch) for (const [k, v] of Object.entries(ch)) res.headers.set(k, v);
  return res;
});
