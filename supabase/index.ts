// Cutout Bus - Supabase Edge Function port of the SPEC v1.1 reference server.
// Wire-compatible with SPEC.md v1.1: same endpoints, fields, status codes.
// Config via env only (no secrets in code): CUTOUT_TOKEN, SUPABASE_DB_URL (auto).
import postgres from "npm:postgres@3.4.5";

const DB_URL = Deno.env.get("SUPABASE_DB_URL")!;
const BUS_TOKEN = Deno.env.get("CUTOUT_TOKEN") ?? "";
const RETENTION_DAYS = 30;
const RATE_LIMIT_PER_MIN = 60;
const MAX_BODY_BYTES = 20 * 1024;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_IDEMPOTENCY_KEY = 128;
const VERSION = "1.1";
const TYPES = ["note", "question", "decision", "task", "link", "receipt-info", "resolve"];
const RECEIPT_STATUSES = ["received", "acted", "consumed"];

// Route through the Supavisor transaction pooler: the direct connection's
// slots are limited and shared with the app's other traffic. Host overridable
// via POOLER_HOST (public hostname, not a secret).
function poolerUrl(direct: string): string {
  const host = Deno.env.get("POOLER_HOST");
  if (!host) return direct;
  const u = new URL(direct);
  const ref = u.hostname.replace(/^db\./, "").split(".")[0]; // db.<ref>.supabase.co -> <ref>
  u.hostname = host;
  u.port = "6543";
  u.username = `postgres.${ref}`;
  return u.toString();
}
const sql = postgres(poolerUrl(DB_URL), { prepare: false, max: 2 });

// SPEC: purge runs at startup (cold start here) and at least daily (pg_cron job).
const startupPurge = sql`select cutout.purge(${RETENTION_DAYS})`.catch((e) =>
  console.error("startup purge failed", e)
);

// ---- ULID (Crockford base32, 48-bit time + 80-bit random) -------------------
const C32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(now = Date.now()): string {
  let time = now; let out = "";
  for (let i = 0; i < 10; i++) { out = C32[time % 32] + out; time = Math.floor(time / 32); }
  const buf = new Uint8Array(80); crypto.getRandomValues(buf);
  for (let i = 0; i < 16; i++) out += C32[buf[i] & 31];
  return out;
}

// ---- helpers ----------------------------------------------------------------
function jres(status: number, obj: unknown, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}
const iso = (d: unknown) => new Date(d as string).toISOString();

// Cursor payload: "<created_at as epoch microseconds>|<id>". Numeric microseconds
// avoid timestamp-typed parameter serialization (which drops sub-millisecond
// precision and would re-include the boundary row).
function encodeCursor(createdUs: number, id: string): string {
  return "cursor_" + btoa(`${createdUs}|${id}`).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function decodeCursor(c: string): { us: number; id: string } | null {
  if (!c.startsWith("cursor_")) return null;
  try {
    const raw = atob(c.slice(7).replaceAll("-", "+").replaceAll("_", "/"));
    const i = raw.indexOf("|");
    if (i < 0) return null;
    const usStr = raw.slice(0, i), id = raw.slice(i + 1);
    if (!/^\d{10,17}$/.test(usStr) || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
    return { us: Number(usStr), id };
  } catch { return null; }
}

function serialize(m: Record<string, unknown>) {
  return {
    id: m.id, thread_id: m.thread_id, from: m.from_agent, to: m.to_agent,
    type: m.type, body: m.body, reply_to: m.reply_to ?? null,
    created_at: iso(m.created_at), metadata: m.metadata ?? {},
  };
}

// Sliding 60s window over rate_log. rateState() reads the window without
// consuming a slot (used for /health and pre-auth errors); rateLimit() records
// the request first, then reads. Every response carries the X-RateLimit-* headers.
type RateState = { count: number; oldestEpoch: number | null };
async function rateState(): Promise<RateState> {
  const rows = await sql`
    select count(*)::int as c, extract(epoch from min(at))::float8 as oldest
    from cutout.rate_log where at > now() - interval '1 minute'`;
  return { count: rows[0].c as number, oldestEpoch: rows[0].oldest === null ? null : Number(rows[0].oldest) };
}
function rateHeaders(s: RateState): Record<string, string> {
  const nowS = Date.now() / 1000;
  const reset = s.oldestEpoch === null ? Math.ceil(nowS) : Math.ceil(s.oldestEpoch + 60);
  return {
    "X-RateLimit-Limit": String(RATE_LIMIT_PER_MIN),
    "X-RateLimit-Remaining": String(Math.max(0, RATE_LIMIT_PER_MIN - s.count)),
    "X-RateLimit-Reset": String(reset),
  };
}
async function rateLimit(): Promise<{ limited: Response | null; state: RateState }> {
  await sql`insert into cutout.rate_log (at) values (now())`;
  const state = await rateState();
  if (state.count > RATE_LIMIT_PER_MIN) {
    const nowS = Date.now() / 1000;
    const retryAfter = state.oldestEpoch === null ? 1 : Math.max(1, Math.ceil(state.oldestEpoch + 60 - nowS));
    return { limited: jres(429, { error: "rate limit exceeded" }, { "Retry-After": String(retryAfter) }), state };
  }
  return { limited: null, state };
}

function validAttachments(a: unknown): string | null {
  if (!Array.isArray(a)) return "metadata.attachments must be an array";
  for (const [i, x] of a.entries()) {
    if (typeof x !== "object" || x === null || Array.isArray(x)) return `attachments[${i}] must be an object`;
    const o = x as Record<string, unknown>;
    if (typeof o.name !== "string" || o.name.length === 0) return `attachments[${i}].name is required`;
    if (typeof o.url !== "string") return `attachments[${i}].url is required`;
    try {
      const p = new URL(o.url).protocol;
      if (p !== "https:" && p !== "http:") return `attachments[${i}].url must be http(s)`;
    } catch { return `attachments[${i}].url must be a valid URL`; }
    if (o.mime !== undefined && o.mime !== null && typeof o.mime !== "string") return `attachments[${i}].mime must be a string`;
    if (o.size !== undefined && o.size !== null && !(Number.isInteger(o.size) && (o.size as number) >= 0)) {
      return `attachments[${i}].size must be a non-negative integer`;
    }
  }
  return null;
}

// ---- handlers ---------------------------------------------------------------
async function postMessage(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return jres(400, { error: "invalid JSON" }); }
  for (const f of ["thread_id", "from", "to", "type", "body"]) {
    if (typeof body[f] !== "string" || (body[f] as string).length === 0) {
      return jres(422, { error: `${f} is required` });
    }
  }
  if (!TYPES.includes(body.type as string)) {
    return jres(422, { error: `type must be one of ${TYPES.join(", ")}` });
  }
  if (new TextEncoder().encode(body.body as string).length > MAX_BODY_BYTES) {
    return jres(413, { error: "body exceeds 20 KB" });
  }
  if (body.reply_to !== undefined && body.reply_to !== null && typeof body.reply_to !== "string") {
    return jres(422, { error: "reply_to must be a string" });
  }
  if (body.metadata !== undefined && (typeof body.metadata !== "object" || body.metadata === null || Array.isArray(body.metadata))) {
    return jres(422, { error: "metadata must be an object" });
  }
  const metadata = (body.metadata as Record<string, unknown>) ?? {};
  if (new TextEncoder().encode(JSON.stringify(metadata)).length > MAX_METADATA_BYTES) {
    return jres(413, { error: "metadata exceeds 16 KB" });
  }
  if (metadata.attachments !== undefined) {
    const err = validAttachments(metadata.attachments);
    if (err) return jres(422, { error: err });
  }
  let idemKey: string | null = null;
  if (body.idempotency_key !== undefined && body.idempotency_key !== null) {
    if (typeof body.idempotency_key !== "string" || body.idempotency_key.length === 0 ||
        body.idempotency_key.length > MAX_IDEMPOTENCY_KEY) {
      return jres(422, { error: `idempotency_key must be a non-empty string of at most ${MAX_IDEMPOTENCY_KEY} characters` });
    }
    idemKey = body.idempotency_key;
  }
  const from = body.from as string;
  const findDup = async () => idemKey === null ? [] : await sql`
    select m.id, m.created_at from cutout.idempotency_keys k
    join cutout.messages m on m.id = k.message_id
    where k.from_agent = ${from} and k.idem_key = ${idemKey}`;
  // Keys are honored for the retention window: the key row cascades away with
  // its message when the purge removes it.
  const dup = await findDup();
  if (dup.length) return jres(200, { id: dup[0].id, created_at: iso(dup[0].created_at), duplicate: true });
  const id = "msg_" + ulid();
  try {
    const rows = await sql.begin(async (tx) => {
      const r = await tx`
        insert into cutout.messages (id, thread_id, from_agent, to_agent, type, body, reply_to, metadata)
        values (${id}, ${body.thread_id as string}, ${from}, ${body.to as string},
                ${body.type as string}, ${body.body as string},
                ${(body.reply_to as string) ?? null}, ${sql.json(metadata)})
        returning id, created_at`;
      if (idemKey !== null) {
        await tx`insert into cutout.idempotency_keys (from_agent, idem_key, message_id)
                 values (${from}, ${idemKey}, ${id})`;
      }
      return r;
    });
    return jres(201, { id: rows[0].id, created_at: iso(rows[0].created_at) });
  } catch (e) {
    // Concurrent re-post of the same key lost the race: return the winner.
    if ((e as { code?: string }).code === "23505" && idemKey !== null) {
      const d = await findDup();
      if (d.length) return jres(200, { id: d[0].id, created_at: iso(d[0].created_at), duplicate: true });
    }
    throw e;
  }
}

async function getMessages(req: Request): Promise<Response> {
  const u = new URL(req.url);
  const since = u.searchParams.get("since");
  const threadId = u.searchParams.get("thread_id");
  const to = u.searchParams.get("to");
  const agentId = req.headers.get("X-Agent-Id");
  let wait = 0, limit = 50;
  if (u.searchParams.has("wait")) {
    wait = Number(u.searchParams.get("wait"));
    if (!Number.isFinite(wait) || wait < 0 || wait > 60) return jres(422, { error: "wait must be between 0 and 60" });
  }
  if (u.searchParams.has("limit")) {
    limit = Number(u.searchParams.get("limit"));
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return jres(422, { error: "limit must be between 1 and 100" });
  }
  let cursor: { us: number; id: string } | null = null;
  if (since) {
    cursor = decodeCursor(since);
    if (!cursor) return jres(422, { error: "invalid since cursor" });
  }
  const queryOnce = async () => {
    const q = sql`
      select id, thread_id, from_agent, to_agent, type, body, reply_to, created_at,
             (extract(epoch from created_at) * 1000000)::bigint as created_us, metadata
      from cutout.messages
      where true
      ${cursor ? sql`and ((extract(epoch from created_at) * 1000000)::bigint > ${cursor.us} or ((extract(epoch from created_at) * 1000000)::bigint = ${cursor.us} and id > ${cursor.id}))` : sql``}
      ${threadId ? sql`and thread_id = ${threadId}` : sql``}
      ${to ? sql`and to_agent = ${to}` : (agentId ? sql`and (to_agent = ${agentId} or to_agent = '*')` : sql``)}
      order by created_at asc, id asc
      limit ${limit}`;
    return await q;
  };
  const deadline = Date.now() + wait * 1000;
  let rows = await queryOnce();
  while (rows.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    rows = await queryOnce();
  }
  const receiptsBy = new Map<string, unknown[]>();
  if (rows.length) {
    const ids = rows.map((r) => r.id as string);
    const rc = await sql`
      select message_id, agent, status, at from cutout.receipts
      where message_id = any(${ids}) order by at asc, agent asc`;
    for (const r of rc) {
      const list = receiptsBy.get(r.message_id as string) ?? [];
      list.push({ agent: r.agent, status: r.status, at: iso(r.at) });
      receiptsBy.set(r.message_id as string, list);
    }
  }
  const nextCursor = rows.length
    ? encodeCursor(Number(rows[rows.length - 1].created_us), rows[rows.length - 1].id)
    : (since ?? null);
  return jres(200, {
    messages: rows.map((r) => ({ ...serialize(r), receipts: receiptsBy.get(r.id as string) ?? [] })),
    next_cursor: nextCursor,
  });
}

async function postReceipt(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return jres(400, { error: "invalid JSON" }); }
  for (const f of ["message_id", "agent", "status"]) {
    if (typeof body[f] !== "string" || (body[f] as string).length === 0) {
      return jres(422, { error: `${f} is required` });
    }
  }
  if (!RECEIPT_STATUSES.includes(body.status as string)) {
    return jres(422, { error: `status must be one of ${RECEIPT_STATUSES.join(", ")}` });
  }
  let at = new Date();
  if (body.at !== undefined && body.at !== null) {
    at = new Date(body.at as string);
    if (Number.isNaN(at.getTime())) return jres(422, { error: "at must be an ISO 8601 timestamp" });
  }
  const mid = body.message_id as string, agent = body.agent as string, status = body.status as string;
  const exists = await sql`select metadata from cutout.messages where id = ${mid}`;
  if (exists.length === 0) return jres(404, { error: "message not found" });
  await sql`
    insert into cutout.receipts (message_id, agent, status, at) values (${mid}, ${agent}, ${status}, ${at.toISOString()})
    on conflict (message_id, agent) do update set status = excluded.status, at = excluded.at`;
  if (status === "consumed" && exists[0].metadata?.one_time_link) {
    await sql`update cutout.messages
              set metadata = jsonb_set(metadata, '{one_time_link,consumed}', 'true'::jsonb, false)
              where id = ${mid}`;
  }
  return jres(201, { ok: true });
}

async function getThreads(req: Request): Promise<Response> {
  const agentId = req.headers.get("X-Agent-Id");
  const rows = await sql`
    select m.thread_id, max(m.created_at) as last_at,
      (array_agg(m.type order by m.created_at desc, m.id desc))[1] as last_type,
      ${agentId ? sql`count(*) filter (
        where (m.to_agent = ${agentId} or m.to_agent = '*')
          and not exists (select 1 from cutout.receipts r where r.message_id = m.id and r.agent = ${agentId})
      )::int` : sql`0`} as unread
    from cutout.messages m
    group by m.thread_id
    order by last_at desc`;
  return jres(200, {
    // Resolved iff the latest message is a resolve; any later non-resolve message reopens.
    threads: rows.map((r) => ({
      thread_id: r.thread_id, last_at: iso(r.last_at), unread: r.unread,
      status: r.last_type === "resolve" ? "resolved" : "open",
      resolved_at: r.last_type === "resolve" ? iso(r.last_at) : null,
    })),
  });
}

// ---- router -----------------------------------------------------------------
async function route(req: Request): Promise<{ res: Response; state: RateState | null }> {
  let path = new URL(req.url).pathname;
  path = path.replace(/^\/cutout(?=\/|$)/, ""); // strip function slug prefix
  if (path === "/health" && req.method === "GET") {
    return { res: jres(200, { ok: true, version: VERSION }), state: null };
  }
  if (!path.startsWith("/v1/")) return { res: jres(404, { error: "not found" }), state: null };
  const auth = req.headers.get("Authorization") ?? "";
  if (!BUS_TOKEN || auth !== `Bearer ${BUS_TOKEN}`) return { res: jres(401, { error: "unauthorized" }), state: null };
  const { limited, state } = await rateLimit();
  if (limited) return { res: limited, state };
  if (path === "/v1/messages" && req.method === "POST") return { res: await postMessage(req), state };
  if (path === "/v1/messages" && req.method === "GET") return { res: await getMessages(req), state };
  if (path === "/v1/receipts" && req.method === "POST") return { res: await postReceipt(req), state };
  if (path === "/v1/threads" && req.method === "GET") return { res: await getThreads(req), state };
  return { res: jres(404, { error: "not found" }), state };
}

Deno.serve(async (req: Request) => {
  await startupPurge;
  let res: Response;
  let state: RateState | null = null;
  try {
    ({ res, state } = await route(req));
  } catch (e) {
    console.error(e);
    res = jres(500, { error: "internal error" });
  }
  // Rate-limit headers on every response, including errors and /health.
  try {
    const h = rateHeaders(state ?? await rateState());
    for (const [k, v] of Object.entries(h)) res.headers.set(k, v);
  } catch (e) {
    console.error("rate header read failed", e);
  }
  return res;
});
