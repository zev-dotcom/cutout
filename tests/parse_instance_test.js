// parseInstance must never throw and never accept credentials. Run: node tests/parse_instance_test.js
const fs = require("fs");
const s = fs.readFileSync(__dirname + "/../web/app.js", "utf8");
const a = s.indexOf("function parseInstance"), b = s.indexOf("function pendingInstance");
eval(s.slice(a, b));
const c = s.indexOf("function buildNewer"); eval(s.slice(c, s.indexOf("function checkForUpdate", c)));
let bad = 0;
const eq = (n, got, want) => { if (got !== want) { bad++; console.log("FAIL", n, JSON.stringify(got)); } else console.log("PASS", n); };
eq("malformed escape", parseInstance("#instance=%E0"), "");
eq("encoded https", parseInstance("#instance=https%3A%2F%2Fx.example.co%2F"), "https://x.example.co");
eq("bare with token", parseInstance("https://a.b/?token=abc"), "");
eq("bare with key in hash", parseInstance("https://a.b/#api_key=1"), "");
eq("bare strips query", parseInstance("https://a.b/?x=1#k"), "https://a.b");
eq("userinfo", parseInstance("https://u:p@a.b"), "");
eq("js scheme", parseInstance("javascript:alert(1)"), "");
eq("setup= form", parseInstance("#setup=https://h.io"), "https://h.io");
eq("numeric compare", buildNewer("2026-10-02.10", "2026-10-02.9"), true);
eq("older not newer", buildNewer("2026-10-02.9", "2026-10-02.10"), false);
process.exit(bad ? 1 : 0);
