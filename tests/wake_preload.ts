// Test-only preload (deno run --preload): fakes DNS and outbound fetch for *.test.example
// so wake webhooks can be exercised without touching the network. Never used in production.
const HITS = Deno.env.get("WAKE_HITS_FILE") ?? "/tmp/wake-hits.jsonl";
const dns = { "hooks.test.example": ["93.184.216.34"], "fail.test.example": ["93.184.216.35"],
  "private.test.example": ["10.0.0.5"], "rebind.test.example": ["127.0.0.1"], "push.test.example": ["93.184.216.40"], "gone.test.example": ["93.184.216.41"] };
const realResolve = Deno.resolveDns.bind(Deno);
Deno.resolveDns = async (host, type) => {
  if (host in dns) return type === "A" ? dns[host] : [];
  return realResolve(host, type);
};
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  const u = new URL(url);
  if (u.hostname.endsWith(".test.example")) {
    Deno.writeTextFileSync(HITS, JSON.stringify({ url, headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body instanceof Uint8Array ? "b64:" + btoa(String.fromCharCode(...init.body)) : (init?.body ?? null), redirect: init?.redirect, at: Date.now() }) + "\n", { append: true });
    return new Response("ok", { status: u.hostname.startsWith("fail.") ? 500 : u.hostname.startsWith("gone.") ? 410 : 200 });
  }
  return realFetch(input, init);
};
