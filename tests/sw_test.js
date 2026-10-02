// Unit test for web/sw.js with a fake service-worker global. Run: node tests/sw_test.js
const fs = require("fs"), vm = require("vm"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "../web/sw.js"), "utf8");
let fails = 0; const check = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };
function run(clientsList) {
  const h = {}, shown = [], opened = [], focused = [], badges = [], msgs = [];
  const self = { addEventListener: (t, f) => { h[t] = f; }, skipWaiting() {}, clients: { claim() { return Promise.resolve(); },
      matchAll: () => Promise.resolve(clientsList.map(c => ({ ...c, focus() { focused.push(c.url); return Promise.resolve(); }, postMessage(m) { msgs.push(m); } }))),
      openWindow: (u) => { opened.push(u); return Promise.resolve(); } },
    registration: { scope: "https://x.example/smith/", showNotification: (t, o) => { shown.push({ t, o }); return Promise.resolve(); } },
    navigator: { setAppBadge: (n) => { badges.push(n); return Promise.resolve(); }, clearAppBadge: () => { badges.push(0); return Promise.resolve(); } } };
  vm.runInNewContext(src, { self, URL, Promise });
  const wait = []; 
  return { h, shown, opened, focused, badges, msgs, push: (d) => { h.push({ data: { json: () => d }, waitUntil: (p) => wait.push(p) }); return Promise.all(wait); },
    click: (data) => { const n = { data, close() {} }; h.notificationclick({ notification: n, waitUntil: (p) => wait.push(p) }); return Promise.all(wait); } };
}
(async () => {
  let r = run([]);
  await r.push({ v: 1, thread_id: "th_1", title: "Deploy", count: 3, total: 7 });
  check("title is chat name", r.shown[0].t === "Smith · Deploy");
  check("body is count only", r.shown[0].o.body === "3 new messages");
  check("one notification per thread (tag)", r.shown[0].o.tag === "th_1");
  check("app badge set to total", r.badges[0] === 7);
  await r.push({ v: 1, thread_id: "th_1", title: "Deploy", count: 1, total: 0 });
  check("singular body + badge cleared", r.shown[1].o.body === "1 new message" && r.badges[1] === 0);
  await r.push({ v: 1, thread_id: "th_1", title: "Deploy", count: 1, total: 1, body: "hello there" });
  check("body shown only when server includes it", r.shown[2].o.body === "hello there");
  await r.push({ test: true, title: "Smith", count: 0, total: 0, body: "Notifications are working." });
  check("test push", r.shown[3].t === "Smith" && r.shown[3].o.body === "Notifications are working.");
  r = run([]); await r.click({ thread_id: "th_9" });
  check("click opens the thread deep link when app is closed", r.opened[0] === "https://x.example/smith/#t=th_9");
  r = run([{ url: "https://x.example/smith/" }]); await r.click({ thread_id: "th_9" });
  check("click focuses the open app and posts open-thread", r.focused.length === 1 && r.msgs[0].type === "open-thread" && r.msgs[0].thread_id === "th_9");
  process.exit(fails ? 1 : 0);
})();
