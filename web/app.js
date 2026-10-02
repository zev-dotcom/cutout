/* Smith web client — app logic.
   Wired to the Smith API (docs/smith-api.md). No mock data anywhere:
   every rendered value comes from a real API response.
   Cue dots render ONLY from feed.working. Receipts render ONLY from
   real receipt events. */
(function(){
"use strict";

/* ---------- storage ---------- */
var LS_CFG = "smith.cfg.v1";
var LS_READ = "smith.lastRead.v1";
var LS_THEME = "smith.theme.v1";

function loadCfg(){
  try { return JSON.parse(localStorage.getItem(LS_CFG) || "null"); }
  catch(e){ return null; }
}
function saveCfg(cfg){
  localStorage.setItem(LS_CFG, JSON.stringify(cfg));
}
function clearCfg(){ localStorage.removeItem(LS_CFG); }
function loadRead(){
  try { return JSON.parse(localStorage.getItem(LS_READ) || "{}"); }
  catch(e){ return {}; }
}
function saveRead(map){ localStorage.setItem(LS_READ, JSON.stringify(map)); }

/* ---------- dom helpers ---------- */
function $(id){ return document.getElementById(id); }
function esc(s){
  return String(s == null ? "" : s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
/* Review nit: insert <wbr> after every "/" so long URLs break at slashes,
   never mid-token. Apply to escaped HTML before injecting into <code>. */
function wbrHtml(s){
  return esc(s).replace(/\//g, "/<wbr>");
}
function el(tag, cls, html){
  var d = document.createElement(tag);
  if (cls) d.className = cls;
  if (html != null) d.innerHTML = html;
  return d;
}

/* ---------- toast ---------- */
var toastTimer = null;
function toast(msg){
  var t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ t.hidden = true; }, 4200);
}

/* ---------- modal ---------- */
function modal(title, bodyHtml, okLabel, onOk){
  var root = $("modalRoot");
  root.innerHTML = "";
  var wrap = el("div", "modalwrap");
  var m = el("div", "modal",
    "<h3>" + esc(title) + "</h3><div class='mbody'>" + bodyHtml + "</div>" +
    "<div class='mrow2'><button class='cancel'>Cancel</button>" +
    "<button class='go'>" + esc(okLabel || "Save") + "</button></div>");
  wrap.appendChild(m);
  root.appendChild(wrap);
  function close(){ root.innerHTML = ""; }
  wrap.addEventListener("click", function(e){ if (e.target === wrap) close(); });
  m.querySelector(".cancel").addEventListener("click", close);
  m.querySelector(".go").addEventListener("click", function(){
    if (onOk(m) !== false) close();
  });
  var first = m.querySelector("input,select");
  if (first) first.focus();
  return m;
}

/* ---------- time ---------- */
function dOf(iso){ return new Date(iso); }
function sameDay(a, b){
  return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
}
function fmtClock(iso){
  var d = dOf(iso), h = d.getHours(), m = d.getMinutes(), ap = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  return h + ":" + (m < 10 ? "0"+m : m) + " " + ap;
}
function fmtDay(iso){
  var d = dOf(iso), now = new Date(), y = new Date(now); y.setDate(now.getDate()-1);
  if (sameDay(d, now)) return "Today";
  if (sameDay(d, y)) return "Yesterday";
  return d.toLocaleDateString(undefined, {month:"short", day:"numeric", year:"numeric"});
}
function fmtListTime(iso){
  var d = dOf(iso), now = new Date();
  if (sameDay(d, now)) return fmtClock(iso).replace(/ [AP]M$/, "");
  var diff = (now - d) / 864e5;
  if (diff < 7) return d.toLocaleDateString(undefined, {weekday:"short"});
  return d.toLocaleDateString(undefined, {month:"numeric", day:"numeric"});
}

/* ---------- api ---------- */
function baseUrl(){
  var c = loadCfg();
  return c ? c.url.replace(/\/+$/, "") : "";
}
function token(){
  var c = loadCfg();
  return c ? c.token : "";
}
async function api(method, path, body){
  var res = await fetch(baseUrl() + path, {
    method: method,
    headers: {
      "Authorization": "Bearer " + token(),
      "Content-Type": "application/json"
    },
    body: body == null ? undefined : JSON.stringify(body)
  });
  var data = null;
  try { data = await res.json(); } catch(e){ /* non-JSON */ }
  if (!res.ok){
    var msg = (data && data.error) ? data.error : ("HTTP " + res.status);
    if (res.status === 401) msg = "Owner token rejected (401). Check the token in Settings.";
    if (res.status === 403) msg = "Forbidden (403): " + msg;
    throw new Error(msg);
  }
  return data;
}

/* ---------- state ---------- */
var state = {
  threads: [],
  agents: [],
  agentById: {},     // agent_id -> {display_name, platform}
  threadById: {},
  currentThread: null,
  feedCursor: null,
  threadTimer: null,
  listTimer: null,
  search: ""
};

/* ---------- theme ---------- */
function applyTheme(){
  var t = localStorage.getItem(LS_THEME) || "mono";
  document.body.dataset.theme = t;
}
function toggleTheme(){
  var t = (localStorage.getItem(LS_THEME) || "mono") === "noir" ? "mono" : "noir";
  localStorage.setItem(LS_THEME, t);
  applyTheme();
}
if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches){
  ["setupDots","wordDots"].forEach(function(id){
    var s = $(id); if (s) s.classList.remove("live");
  });
}

/* ---------- navigation ---------- */
var SCREENS = ["home","thread","pairing","agents","audit","settings"];
function showScreen(name){
  SCREENS.forEach(function(s){
    $("scr-" + s).classList.toggle("active", s === name);
  });
  var app = $("app");
  if (name === "home") app.dataset.view = "threads"; /* mobile: show the list */
  else if (name === "thread") app.dataset.view = "thread";
  else app.dataset.view = "pane"; /* mobile: hide list, show main-col */
  if (name !== "thread") stopThreadPoll();
  document.querySelectorAll(".trow").forEach(function(r){
    r.setAttribute("aria-current", r.dataset.tid === state.currentThread ? "true" : "false");
  });
  if (name === "audit") loadAudit();
  if (name === "agents") loadAgents();
}
function goThreads(){
  state.currentThread = null;
  stopThreadPoll();
  $("app").dataset.view = "threads";
  showScreen("home");
}

/* ---------- avatars ---------- */
function letterFor(name){ return (name || "?").trim().charAt(0).toUpperCase(); }
function avatarHtml(member){
  var nm = member.display_name || member.agent_id || "?";
  return '<div class="avatar">' + esc(letterFor(nm)) + "</div>";
}
function stackHtml(members){
  var ms = members.slice(0, 3);
  var inner = ms.map(function(m, i){
    var nm = m.display_name || m.agent_id || "?";
    var cls = i === ms.length - 1 ? "avatar" : "avatar nl";
    return '<div class="' + cls + '">' + esc(letterFor(nm)) + "</div>";
  }).join("");
  if (members.length > 3) inner += '<span class="countchip">+' + (members.length - 3) + "</span>";
  return '<div class="stack">' + inner + "</div>";
}

/* ---------- agent names ---------- */
function agentLabel(agentId){
  var a = state.agentById[agentId];
  return a ? (a.display_name || agentId) : agentId;
}
function agentPlat(agentId){
  var a = state.agentById[agentId];
  return a ? a.platform : null;
}
/* Registered = paired through Smith (has its own token). Legacy bus ids carried over
   from a pre-Smith bus have no Smith identity and are never offered to the user. */
var SMITH_BUILD = "2026-10-02.9";
// Registered = holds a Smith token. (legacy_unverified stays true on seeded rows even after pairing.)
function isRegistered(a){ return !!a.has_token && !a.revoked_at; }
function indexAgents(list){
  state.agents = list || [];
  state.agentById = {};
  state.agents.forEach(function(a){
    state.agentById[a.agent_id] = a;
  });
  // also index members seen on threads (agents may exist that owner list lacks)
  state.threads.forEach(function(t){
    (t.members || []).forEach(function(m){
      if (!state.agentById[m.agent_id]) state.agentById[m.agent_id] = m;
    });
  });
}

/* ---------- thread list ---------- */
async function loadThreads(){
  var list = await api("GET", "/v1/owner/threads");
  state.threads = Array.isArray(list) ? list : (list.threads || []);
  state.threadById = {};
  state.threads.forEach(function(t){ state.threadById[t.thread_id] = t; });
  indexAgents(state.agents);
  renderThreadList();
  syncAppBadge();
}
function threadSnippet(t){
  if (t.working && t.working.length){
    var names = t.working.map(agentLabel);
    var who = names.length === 1 ? names[0]
      : names.length === 2 ? names[0] + " and " + names[1]
      : names[0] + " and " + (names.length - 1) + " others";
    return '<span class="tdots" aria-hidden="true"><span></span><span></span><span></span></span> ' +
      esc(who) + " is working on a reply…";
  }
  var n = (t.members || []).length;
  var plats = {};
  (t.members || []).forEach(function(m){ if (m.platform) plats[m.platform] = 1; });
  var pc = Object.keys(plats).length;
  return esc(n + (n === 1 ? " agent" : " agents") + (pc ? " · " + pc + (pc === 1 ? " platform" : " platforms") : ""));
}
function renderThreadList(){
  var box = $("threadList");
  box.innerHTML = "";
  var q = state.search.trim().toLowerCase();
  var list = state.threads.slice().sort(function(a, b){
    return (b.last_at || "") < (a.last_at || "") ? -1 : 1;
  }).filter(function(t){
    return !q || (t.name || "").toLowerCase().indexOf(q) >= 0;
  });
  var archivedList = list.filter(function(t){ return t.archived; });
  list = list.filter(function(t){ return !t.archived; });
  var dms = list.filter(function(t){ return (t.members || []).length <= 1; });
  var groups = list.filter(function(t){ return (t.members || []).length > 1; });
  function section(label, items){
    if (!items.length) return;
    box.appendChild(el("div", "sect", esc(label)));
    items.forEach(function(t){
      var r = el("button", "trow");
      r.dataset.tid = t.thread_id;
      r.setAttribute("aria-current", t.thread_id === state.currentThread ? "true" : "false");
      var av = (t.members || []).length > 1
        ? stackHtml(visibleMembers(t.members))
        : avatarHtml(t.members[0] || {display_name: t.name});
      var right = '<div class="tright"><div class="ttime">' +
        esc(t.last_at ? fmtListTime(t.last_at) : "") + "</div>" +
        (t.muted ? '<span class="mutedic" title="Muted" aria-label="Muted">muted</span>' : "") +
        (t.unread ? '<span class="udot' + (t.muted ? " dim" : "") + '">' + esc(String(t.unread)) + "</span>" : "") + "</div>";
      r.innerHTML = av +
        '<div class="tmeta"><div class="tnm">' + esc(t.name || t.thread_id) + "</div>" +
        '<div class="tsn">' + threadSnippet(t) + "</div></div>" + right;
      r.addEventListener("click", function(){ if (r.dataset.lp === "1"){ r.dataset.lp = ""; return; } openThread(t.thread_id); });
      var lpT = null;
      r.addEventListener("touchstart", function(){ lpT = setTimeout(function(){ r.dataset.lp = "1"; openThreadMenu(t); }, 550); }, {passive: true});
      ["touchend", "touchmove", "touchcancel"].forEach(function(ev){ r.addEventListener(ev, function(){ clearTimeout(lpT); }, {passive: true}); });
      r.addEventListener("contextmenu", function(e){ e.preventDefault(); openThreadMenu(t); });
      box.appendChild(r);
    });
  }
  section("DIRECT", dms);
  section("GROUPS", groups);
  if (archivedList.length && !q){
    var ab = el("button", "trow archrow");
    ab.innerHTML = '<div class="tmeta"><div class="tnm">' + (state.showArchived ? "▾" : "▸") + " Archived (" + archivedList.length + ")</div></div>";
    ab.addEventListener("click", function(){ state.showArchived = !state.showArchived; renderThreadList(); });
    box.appendChild(ab);
    if (state.showArchived) section("ARCHIVED", archivedList);
  } else if (archivedList.length && q){
    section("ARCHIVED", archivedList);
  }
  if (!list.length){
    box.appendChild(el("div", "emptymsgs",
      q ? "No chats match your search." :
          "No chats yet.<br>Pair an agent to start your first conversation."));
  }
}

/* ---------- archive + mute menu ---------- */
function closeSheet(){ var s = document.getElementById("sheet"); if (s) s.remove(); }
async function setPrefs(t, patch){
  closeSheet();
  try {
    await api("PUT", "/v1/owner/threads/" + encodeURIComponent(t.thread_id) + "/prefs", patch);
    await loadThreads();
    var nt = state.threadById[t.thread_id];
    if (nt && state.currentThread === t.thread_id) renderThreadHeader(nt);
    if (patch.archived === true && state.currentThread === t.thread_id) goThreads();
    toast(patch.archived === true ? "Chat archived" : patch.archived === false ? "Chat restored" : patch.muted ? "Notifications muted" : "Notifications on");
  } catch(e){ toast(e.message); }
}
function openThreadMenu(t){
  closeSheet();
  var sh = el("div", "sheet"); sh.id = "sheet";
  var items = [
    [t.archived ? "Unarchive chat" : "Archive chat", { archived: !t.archived }],
    t.muted ? ["Turn notifications on", { muted: false }] : null,
    t.muted ? null : ["Mute for 1 hour", { muted: "1h" }],
    t.muted ? null : ["Mute for 8 hours", { muted: "8h" }],
    t.muted ? null : ["Mute for 24 hours", { muted: "24h" }],
    t.muted ? null : ["Mute until I turn it on", { muted: true }]
  ].filter(Boolean);
  var inner = '<div class="sheetbox" role="dialog" aria-label="Chat options"><div class="sheettitle">' + esc(t.name || t.thread_id) + "</div>" +
    items.map(function(it, i){ return '<button type="button" class="sheetbtn" data-i="' + i + '">' + esc(it[0]) + "</button>"; }).join("") +
    '<button type="button" class="sheetbtn cancel">Cancel</button></div>';
  sh.innerHTML = inner;
  sh.addEventListener("click", function(e){
    if (e.target === sh || e.target.classList.contains("cancel")) return closeSheet();
    var b = e.target.closest(".sheetbtn"); if (b && b.dataset.i != null) setPrefs(t, items[Number(b.dataset.i)][1]);
  });
  document.body.appendChild(sh);
}

/* ---------- thread view ---------- */
/* Case-variant duplicates of a registered member (e.g. legacy "Instinct" next to paired
   "instinct") are hidden; ids compare case-insensitively everywhere in the UI. */
function visibleMembers(ms){
  var reg = {};
  ms.forEach(function(m){
    if (!m.legacy_unverified && String(m.platform || "").toLowerCase() !== "unknown") reg[String(m.agent_id).toLowerCase()] = m.agent_id;
  });
  return ms.filter(function(m){
    var k = String(m.agent_id).toLowerCase();
    return !(reg[k] && reg[k] !== m.agent_id);
  });
}
function memberSubHtml(t){
  var ms = t.members || [];
  if (!ms.length) return "No members yet";
  return visibleMembers(ms).map(function(m){
    var nm = esc(m.display_name || m.agent_id);
    var unreg = m.legacy_unverified || (m.platform && String(m.platform).toLowerCase() === "unknown");
    var p = unreg ? ' <span class="plat">LEGACY</span>'
      : (m.platform ? ' <span class="plat">' + esc(m.platform.toUpperCase()) + "</span>" : "");
    var pr = state.presence && state.presence[m.agent_id];
    var dot = pr ? ' <span class="pdot ' + (pr.online ? "on" : "off") + '" title="' + (pr.online ? "online" : "offline") + '"></span>' : "";
    return '<span class="mem">' + "<b>" + nm + "</b>" + dot + p + "</span>";
  }).join(" · ");
}
function renderThreadHeader(t){
  $("threadName").textContent = t.name || t.thread_id;
  var vm = visibleMembers(t.members || []);
  var sub = $("threadSub");
  if (vm.length > 2){
    var open = !!state.membersOpen;
    sub.className = "hsub" + (open ? " open" : "");
    sub.innerHTML = '<button class="mtoggle" type="button" aria-expanded="' + open + '">' + vm.length + " members " + (open ? "▴" : "▾") + "</button>" +
      (open ? '<div style="width:100%">' + memberSubHtml(t) + "</div>" : "");
    sub.querySelector(".mtoggle").onclick = function(){ state.membersOpen = !state.membersOpen; renderThreadHeader(t); };
  } else {
    sub.className = "hsub";
    sub.innerHTML = memberSubHtml(t);
  }
  var ms = t.members || [];
  $("threadAvatar").innerHTML = visibleMembers(ms).length > 1 ? stackHtml(visibleMembers(ms))
    : avatarHtml(ms[0] || {display_name: t.name});
  var others = ms.filter(function(m){ return m.agent_id !== "owner"; });
  $("composerInput").placeholder = others.length === 1
    ? "Message " + (others[0].display_name || others[0].agent_id) + "…"
    : "Message " + (t.name || "thread") + "…";
}
/* Per-message time: short clock under every bubble; tap the bubble for the full date and seconds. */
function fmtFull(iso){
  var d = dOf(iso);
  return d.toLocaleDateString(undefined, {weekday:"short", month:"short", day:"numeric", year:"numeric"}) + " · " +
    fmtClock(iso).replace(/ (AM|PM)$/, ":" + (d.getSeconds() < 10 ? "0" : "") + d.getSeconds() + " $1");
}
function metaLine(msg){
  if (!msg.created_at) return receiptLabel(msg);
  var st = receiptLabel(msg);
  return '<span class="mt" data-short="' + esc(fmtClock(msg.created_at)) + '" data-full="' + esc(fmtFull(msg.created_at)) + '">' +
    esc(fmtClock(msg.created_at)) + "</span>" + (st ? " · " + st : "");
}
function receiptLabel(msg){
  // Render ONLY from real receipt events attached to the message.
  var rcs = msg.receipts || [];
  if (!rcs.length){
    var sn = msg.seen_by || [];
    return sn.length ? "✓ <b>seen</b>" : "";
  }
  var acted = rcs.filter(function(r){ return r.status === "acted"; });
  var recvd = rcs.filter(function(r){ return r.status === "received"; });
  if (acted.length) return "✓✓ <b>acted</b>";
  if (recvd.length) return "✓ <b>received</b>";
  return "";
}
function isRenameNote(msg){
  return msg && msg.metadata && msg.metadata.x_cutout_thread_rename;
}
/* @mentions: the server stores ids in metadata.mentions; the text keeps "@Name". Chips are drawn
   from that list only, so typed "@x" with no stored id stays plain text. */
function mentionLabel(id){ return id === "owner" ? "You" : agentLabel(id); }
function bodyHtml(msg){
  var html = esc(msg.body || "");
  var ids = msg.metadata && Array.isArray(msg.metadata.mentions) ? msg.metadata.mentions : [];
  if (!ids.length) return html;
  var names = [];
  ids.forEach(function(id){
    if (id === "owner"){ names.push({id: id, n: "owner"}, {id: id, n: "You"}); }
    else names.push({id: id, n: agentLabel(id)});
  });
  names.sort(function(x, y){ return y.n.length - x.n.length; });
  names.forEach(function(x){
    var tag = "@" + esc(x.n);
    var cls = "mention" + (x.id === "owner" ? " me" : "");
    html = html.split(tag).join('<span class="' + cls + '">' + tag + "</span>");
  });
  return html;
}
/* Who a message is addressed to, and what it replies to. */
var msgIndex = {};
function toChip(msg){
  var to = msg.to;
  if (!to || to === "*") return "";
  var who = to === "owner" ? "you" : agentLabel(to);
  if (msg.from === "owner" && to === "owner") return "";
  return '<span class="tochip">to ' + esc(who) + "</span>";
}
function replyChip(msg){
  if (!msg.reply_to) return "";
  var r = msgIndex[msg.reply_to];
  var nm = r ? (r.from === "owner" ? "You" : agentLabel(r.from)) : "earlier message";
  var tx = r ? String(r.body || "").replace(/\s+/g, " ").slice(0, 70) : "";
  return '<button type="button" class="rpchip" data-jump="' + esc(msg.reply_to) + '"><b>↩ ' + esc(nm) + "</b>" + (tx ? " " + esc(tx) : "") + "</button>";
}
function mentionsMe(msg){
  return !!(msg.metadata && Array.isArray(msg.metadata.mentions) && msg.metadata.mentions.indexOf("owner") >= 0);
}
var QUICK_RX = ["\uD83D\uDC4D", "\u2764\uFE0F", "\uD83D\uDE02", "\uD83C\uDF89", "\uD83D\uDC40", "\u2705"];
function rxHtml(list){
  if (!list || !list.length) return "";
  return '<div class="rxs">' + list.map(function(r){
    var mine = (r.actors || []).indexOf("owner") >= 0;
    var who = (r.actors || []).map(function(a){ return a === "owner" ? "You" : agentLabel(a); }).join(", ");
    return '<button type="button" class="rx' + (mine ? " mine" : "") + '" data-e="' + esc(r.emoji) + '" title="' + esc(who) + '" aria-label="' + esc(r.emoji + " " + r.count + (mine ? ", you reacted" : "")) + '">' +
      esc(r.emoji) + (r.count > 1 ? ' <span class="rxn">' + r.count + "</span>" : "") + "</button>";
  }).join("") + "</div>";
}
function setRx(row, list){
  if (!row) return;
  var old = row.querySelector(".rxs"), html = rxHtml(list);
  if (old && !html){ old.remove(); return; }
  if (!html) return;
  var tmp = document.createElement("div"); tmp.innerHTML = html;
  if (old){ if (old.innerHTML !== tmp.firstChild.innerHTML) old.innerHTML = tmp.firstChild.innerHTML; }
  else { var b = row.querySelector(".bub"); if (b) b.insertAdjacentElement("afterend", tmp.firstChild); }
}
function applyReactions(map){
  var box = $("threadMsgs"); if (!box || !map) return;
  box.querySelectorAll(".msgrow[data-mid]").forEach(function(row){
    var id = row.getAttribute("data-mid");
    if (map[id]) setRx(row, map[id]); else if (row.querySelector(".rxs") && map.hasOwnProperty(id) === false && state.rxSeen && state.rxSeen[id]) setRx(row, []);
  });
  state.rxSeen = {}; Object.keys(map).forEach(function(k){ state.rxSeen[k] = 1; });
}
async function toggleRx(mid, emoji){
  var row = $("threadMsgs").querySelector('[data-mid="' + String(mid).replace(/"/g, "") + '"]');
  var chip = row && Array.prototype.filter.call(row.querySelectorAll(".rx"), function(c){ return c.dataset.e === emoji; })[0];
  var mine = chip && chip.classList.contains("mine");
  try {
    var r = mine ? await api("DELETE", "/v1/messages/" + encodeURIComponent(mid) + "/reactions/" + encodeURIComponent(emoji))
                 : await api("PUT", "/v1/messages/" + encodeURIComponent(mid) + "/reactions", { emoji: emoji });
    setRx(row, r.reactions || []);
  } catch (e){ toast("Could not react"); }
}
function openReactBar(mid){
  closeSheet();
  var sh = el("div", "sheet"); sh.id = "sheet";
  sh.innerHTML = '<div class="sheetbox" role="dialog" aria-label="React"><div class="rxbar">' +
    QUICK_RX.map(function(e){ return '<button type="button" class="rxpick" data-e="' + esc(e) + '">' + esc(e) + "</button>"; }).join("") +
    '</div><button type="button" class="sheetbtn cancel">Cancel</button></div>';
  sh.addEventListener("click", function(e){
    if (e.target === sh || e.target.classList.contains("cancel")) return closeSheet();
    var b = e.target.closest(".rxpick"); if (!b) return;
    var row = $("threadMsgs").querySelector('[data-mid="' + String(mid).replace(/"/g, "") + '"]');
    var have = row && Array.prototype.some.call(row.querySelectorAll(".rx.mine"), function(c){ return c.dataset.e === b.dataset.e; });
    closeSheet();
    if (!have) toggleRx(mid, b.dataset.e); else toggleRx(mid, b.dataset.e);
  });
  document.body.appendChild(sh);
}
var ACT_ICONS = {
  call: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
  task: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg>',
  tool: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/></svg>'
};
function fmtElapsed(ms){
  var t = Math.max(0, Math.round(ms / 1000)), m = Math.floor(t / 60), h = Math.floor(m / 60);
  var ss = ("0" + (t % 60)).slice(-2);
  return h ? h + ":" + ("0" + (m % 60)).slice(-2) + ":" + ss : m + ":" + ss;
}
function actStateLabel(a){
  var st = a.started_at ? Date.parse(a.started_at) : 0, fin = a.finished_at ? Date.parse(a.finished_at) : 0;
  if (a.state === "running") return '<span class="actspin" aria-hidden="true"></span>Running <span class="actel">' + fmtElapsed(Date.now() - st) + "</span>";
  var d = st && fin ? " \u00b7 " + fmtElapsed(fin - st) : "";
  return (a.state === "failed" ? "Failed" : "Done") + d;
}
function actInner(a){
  var kind = ACT_ICONS[a.kind] ? a.kind : "task";
  return '<div class="acthead"><span class="acticon">' + ACT_ICONS[kind] + '</span><span class="acttitle">' + esc(a.title || "Activity") + "</span></div>" +
    '<div class="actstate">' + actStateLabel(a) + "</div>" +
    (a.summary ? '<div class="actsum">' + esc(a.summary) + "</div>" : "");
}
function actCard(a){
  return '<div class="actcard" data-state="' + esc(a.state || "") + '" data-start="' + esc(a.started_at || "") + '">' + actInner(a) + "</div>";
}
function applyActivities(map){
  var box = $("threadMsgs"); if (!box || !map) return;
  Object.keys(map).forEach(function(id){
    var a = map[id]; if (!a) return;
    var row = box.querySelector('[data-mid="' + id.replace(/"/g, "") + '"]'); if (!row) return;
    var c = row.querySelector(".actcard"); if (!c) return;
    var sig = (a.state || "") + "|" + (a.summary || "") + "|" + (a.title || "") + "|" + (a.finished_at || "");
    if (c.getAttribute("data-sig") === sig) return;
    c.setAttribute("data-sig", sig); c.setAttribute("data-state", a.state || ""); c.setAttribute("data-start", a.started_at || ""); c.innerHTML = actInner(a);
  });
}
setInterval(function(){
  document.querySelectorAll('.actcard[data-state="running"]').forEach(function(c){
    var el = c.querySelector(".actel"), st = Date.parse(c.getAttribute("data-start") || "");
    if (el && st) el.textContent = fmtElapsed(Date.now() - st);
  });
}, 1000);
function msgHtml(msg){
  var mine = msg.from === "owner";
  if (isRenameNote(msg)){
    var nm = msg.metadata.x_cutout_thread_rename;
    // Server writes {from,to}; older shapes used a bare string or {name}.
    var name = (typeof nm === "object" && nm !== null) ? (nm.name || nm.to || nm.from) : nm;
    return '<div class="sysmsg">✎ Chat renamed to <b>"' + esc(String(name)) + '"</b> · ' +
      esc(fmtClock(msg.created_at)) + "</div>";
  }
  if (msg.type === "receipt-info"){
    return '<div class="sysmsg">' + esc(msg.body || "") + "</div>";
  }
  if (msg.type === "activity" && msg.metadata && msg.metadata.activity){
    var aa = msg.metadata.activity;
    return '<div class="msgrow them actrow" data-mid="' + esc(msg.id) + '"><div class="who">' + esc(agentLabel(msg.from)) + "</div>" + actCard(aa) +
      (msg.created_at ? '<div class="rcpt">' + esc(fmtClock(msg.created_at)) + "</div>" : "") + "</div>";
  }
  if (mine){
    var lbl = metaLine(msg);
    return '<div class="msgrow msg-out" data-mid="' + esc(msg.id) + '" data-ts="' + esc(msg.created_at || "") + '">' +
      (msg.to && msg.to !== "*" && msg.to !== "owner" ? '<div class="who out">' + toChip(msg) + "</div>" : "") + replyChip(msg) +
      '<div class="bub">' + bodyHtml(msg) + "</div>" + rxHtml(msg.reactions) +
      (lbl ? '<div class="rcpt">' + lbl + "</div>" : "") + "</div>";
  }
  var nm = esc(agentLabel(msg.from));
  var plat = agentPlat(msg.from);
  var who = '<div class="who">' + nm +
    (plat ? ' <span class="plat">' + esc(String(plat).toUpperCase()) + "</span>" : "") + toChip(msg) + "</div>" + replyChip(msg);
  var tm = msg.created_at ? '<div class="rcpt"><span class="mt" data-short="' + esc(fmtClock(msg.created_at)) + '" data-full="' + esc(fmtFull(msg.created_at)) + '">' + esc(fmtClock(msg.created_at)) + "</span></div>" : "";
  return '<div class="msgrow them' + (mentionsMe(msg) ? " ment-me" : "") + '" data-mid="' + esc(msg.id) + '">' + who +
    '<div class="bub">' + bodyHtml(msg) + "</div>" + rxHtml(msg.reactions) + tm + "</div>";
}
/* Cue dots: rendered ONLY from the working array handed in. Empty => nothing. */
function workingPillHtml(working){
  if (!working || !working.length) return "";
  var names = working.map(function(w){ return agentLabel(w.agent_id || w); });
  var who = names.length === 1 ? names[0]
    : names.length === 2 ? names[0] + " and " + names[1]
    : names[0] + " and " + (names.length - 1) + " others";
  return '<div class="working" id="workingPill"><span class="tdots" aria-hidden="true">' +
    "<span></span><span></span><span></span></span>" +
    '<span class="wlabel">' + esc(who) + (names.length === 1 ? " is" : " are") +
    " working on a reply</span></div>";
}
function setWorking(working){
  var old = $("workingPill");
  if (old) old.remove();
  if (working && working.length){
    var box = $("threadMsgs");
    box.insertAdjacentHTML("beforeend", workingPillHtml(working));
  }
}
function appendMessages(msgs, opts){
  opts = opts || {};
  var box = $("threadMsgs");
  var lastDay = box.dataset.lastday || "";
  msgs.forEach(function(m){
    // Concurrent polls (timer + send) can return the same message twice: render each id once.
    if (m.id && box.querySelector('[data-mid="' + String(m.id).replace(/"/g, "") + '"]')) return;
    if (m.id) msgIndex[m.id] = { from: m.from, body: m.body };
    var day = fmtDay(m.created_at);
    if (day !== lastDay){
      box.insertAdjacentHTML("beforeend", '<div class="day">' + esc(day) + "</div>");
      lastDay = day;
    }
    box.insertAdjacentHTML("beforeend", msgHtml(m));
    // Group: consecutive messages from the same sender in the same minute show one time (on the last).
    var rows = box.querySelectorAll(".msgrow[data-mid]");
    if (rows.length > 1){
      var cur = rows[rows.length - 1], prev = rows[rows.length - 2];
      var a = cur.querySelector(".mt"), b = prev.querySelector(".mt");
      if (a && b && a.dataset.short === b.dataset.short && prev.className === cur.className &&
          (prev.className.indexOf("them") < 0 || prev.querySelector(".who").textContent === cur.querySelector(".who").textContent) &&
          prev.nextElementSibling === cur && !prev.querySelector(".rcpt").textContent.match(/[✓]/)){
        prev.querySelector(".rcpt").classList.add("mtgrp");
      }
    }
  });
  box.dataset.lastday = lastDay;
}
function toggleFull(mt){
  if (!mt) return;
  var on = mt.classList.toggle("full");
  mt.textContent = on ? mt.dataset.full : mt.dataset.short;
}
var readPing = {};
function markRead(tid, msgs){
  if (!msgs.length) return;
  var map = loadRead();
  map[tid] = msgs[msgs.length - 1].id;
  saveRead(map);
  // Server-side owner read marker (survives devices). Best effort, at most one call per 3s per thread.
  var now = Date.now();
  if (now - (readPing[tid] || 0) < 3000) return;
  readPing[tid] = now;
  api("PUT", "/v1/owner/threads/" + encodeURIComponent(tid) + "/read", {})
    .then(function(){
      var t = state.threadById[tid];
      if (t){ t.unread = 0; renderThreadList(); }
    }).catch(function(){ /* older instance without the marker: the list keeps its own count */ });
}
function openThread(tid){
  state.currentThread = tid;
  state.feedCursor = null;
  stopThreadPoll();
  var t = state.threadById[tid];
  if (!t){ toast("Thread not found."); return; }
  renderThreadHeader(t);
  var box = $("threadMsgs");
  box.innerHTML = "";
  box.dataset.lastday = "";
  showScreen("thread");
  var readMap = loadRead();
  var lastReadId = readMap[tid] || null;
  api("GET", "/v1/owner/feed?thread_id=" + encodeURIComponent(tid) + "&limit=100")
    .then(function(feed){
      var msgs = feed.messages || [];
      state.feedCursor = feed.next_cursor || null;
      var idx = lastReadId ? msgs.findIndex(function(m){ return m.id === lastReadId; }) : -1;
      var firstUnread = idx >= 0 ? idx + 1 : 0;
      var nNew = msgs.length - firstUnread;
      if (nNew > 0 && firstUnread > 0){
        // render read part, then divider, then the rest
        appendMessages(msgs.slice(0, firstUnread));
        $("threadMsgs").insertAdjacentHTML("beforeend",
          '<div class="newdiv" id="newDiv">' + esc(String(nNew)) + " new</div>");
        appendMessages(msgs.slice(firstUnread));
        var nd = $("newDiv");
        if (nd) nd.scrollIntoView({block: "start"});
      } else {
        appendMessages(msgs);
        box.scrollTop = box.scrollHeight;
      }
      setWorking(feed.working);
      markRead(tid, msgs);
      startThreadPoll();
    })
    .catch(function(e){ toast(e.message); });
}
function pollThread(){
  var tid = state.currentThread;
  if (!tid || document.hidden) return;
  var url = "/v1/owner/feed?thread_id=" + encodeURIComponent(tid) + "&limit=100" +
    (state.feedCursor ? "&since=" + encodeURIComponent(state.feedCursor) : "");
  api("GET", url).then(function(feed){
    if (tid !== state.currentThread) return;
    var msgs = feed.messages || [];
    state.feedCursor = feed.next_cursor || state.feedCursor;
    if (msgs.length){
      appendMessages(msgs);
      var box = $("threadMsgs");
      // keep the user at the first-unread position on early polls; afterwards follow the tail
      box.scrollTop = box.scrollHeight;
      markRead(tid, msgs);
    }
    setWorking(feed.working);
    // thread list may have new unread counts / working states
    refreshThreadsQuiet();
  }).catch(function(){ /* transient poll errors stay silent; next tick retries */ });
}
/* Live stream (SSE over fetch). Falls back to the 5 s poll if the stream cannot open. */
function applyPresence(list){
  state.presence = {};
  (list || []).forEach(function(p){ state.presence[p.agent_id] = p; });
  var t = (state.threads || []).filter(function(x){ return x.thread_id === state.currentThread; })[0];
  if (t) renderThreadHeader(t);
}
function applyMarks(marks){
  var box = $("threadMsgs"); if (!box || !marks) return;
  Object.keys(marks).forEach(function(id){
    var row = box.querySelector('[data-mid="' + id.replace(/"/g, "") + '"]');
    if (!row || !row.classList.contains("msg-out")) return;
    var lbl = metaLine({ receipts: marks[id].receipts, seen_by: marks[id].seen_by, created_at: row.getAttribute("data-ts") || "" });
    var el = row.querySelector(".rcpt");
    if (!lbl){ return; }
    if (!el){ el = document.createElement("div"); el.className = "rcpt"; row.appendChild(el); }
    var wasFull = el.querySelector(".mt.full");
    if (el.innerHTML !== lbl && !/acted/.test(el.innerHTML)){ el.innerHTML = lbl; if (wasFull) toggleFull(el.querySelector(".mt")); }
  });
}
function startThreadStream(tid, gen){
  var ctl = new AbortController(); state.streamCtl = ctl;
  var fails = 0;
  (async function loop(){
    while (gen === state.streamGen && tid === state.currentThread){
      try {
        var url = "/v1/owner/stream?thread_id=" + encodeURIComponent(tid) + (state.feedCursor ? "&since=" + encodeURIComponent(state.feedCursor) : "");
        var res = await fetch(baseUrl() + url, { headers: { "Authorization": "Bearer " + token() }, signal: ctl.signal });
        if (!res.ok || !res.body) throw new Error("stream " + res.status);
        fails = 0; stopPollTimer();
        var rd = res.body.getReader(), dec = new TextDecoder(), buf = "";
        for (;;){
          var ch = await rd.read(); if (ch.done) break;
          buf += dec.decode(ch.value, { stream: true });
          var parts = buf.split("\n\n"); buf = parts.pop();
          parts.forEach(function(raw){
            var ev = "", data = "";
            raw.split("\n").forEach(function(l){ if (l.indexOf("event:") === 0) ev = l.slice(6).trim(); else if (l.indexOf("data:") === 0) data += l.slice(5).trim(); });
            if (!ev || !data || tid !== state.currentThread) return;
            var d; try { d = JSON.parse(data); } catch(e){ return; }
            if (ev === "messages"){
              state.feedCursor = d.next_cursor || state.feedCursor;
              appendMessages(d.messages || []);
              var box = $("threadMsgs"); box.scrollTop = box.scrollHeight;
              markRead(tid, d.messages || []);
              refreshThreadsQuiet();
            } else if (ev === "state"){
              setWorking(d.working); applyPresence(d.presence); applyMarks(d.marks); applyReactions(d.reactions); applyActivities(d.activities);
            }
          });
        }
      } catch(e){
        if (gen !== state.streamGen) return;
        fails++;
        if (fails >= 2) startPollTimer();
        await new Promise(function(r){ setTimeout(r, Math.min(15000, 1000 * fails)); });
      }
    }
  })();
}
function startPollTimer(){ if (!state.threadTimer) state.threadTimer = setInterval(pollThread, 5000); }
function stopPollTimer(){ if (state.threadTimer){ clearInterval(state.threadTimer); state.threadTimer = null; } }
function startThreadPoll(){
  stopThreadPoll();
  state.streamGen = (state.streamGen || 0) + 1;
  if (window.ReadableStream && window.TextDecoder && window.AbortController) startThreadStream(state.currentThread, state.streamGen);
  else startPollTimer();
}
function stopThreadPoll(){
  state.streamGen = (state.streamGen || 0) + 1;
  if (state.streamCtl){ try { state.streamCtl.abort(); } catch(e){} state.streamCtl = null; }
  stopPollTimer();
}
var listRefreshing = false;
function refreshThreadsQuiet(){
  if (listRefreshing) return;
  listRefreshing = true;
  loadThreads().catch(function(){}).finally(function(){ listRefreshing = false; });
}
function startListPoll(){
  if (state.listTimer) return;
  state.listTimer = setInterval(function(){
    if (!document.hidden) refreshThreadsQuiet();
  }, 15000);
}

/* ---------- @mention autocomplete ---------- */
var mentionPicks = {};      // agent_id -> label inserted into the text
var mentionSel = 0, mentionCands = [], mentionRange = null;
function closeMentionPop(){ var p = $("mentionPop"); if (p){ p.hidden = true; p.innerHTML = ""; } mentionCands = []; mentionRange = null; }
function mentionCandidates(q){
  var t = state.threadById[state.currentThread];
  var ms = (t && t.members || []).filter(function(m){ return m.agent_id !== "owner"; });
  q = q.toLowerCase();
  return ms.map(function(m){ return {id: m.agent_id, label: agentLabel(m.agent_id), plat: agentPlat(m.agent_id)}; })
    .filter(function(c){ return !q || c.label.toLowerCase().indexOf(q) === 0 || c.id.toLowerCase().indexOf(q) === 0; })
    .slice(0, 6);
}
function renderMentionPop(){
  var p = $("mentionPop");
  if (!mentionCands.length){ closeMentionPop(); return; }
  p.innerHTML = mentionCands.map(function(c, i){
    return '<button type="button" class="mrow' + (i === mentionSel ? " sel" : "") + '" data-i="' + i + '">' +
      '<span class="mav">' + esc(c.label.slice(0, 1).toUpperCase()) + '</span>' +
      '<span class="mnm">' + esc(c.label) + '</span>' +
      (c.plat && String(c.plat).toLowerCase() !== "unknown" ? '<span class="plat">' + esc(String(c.plat).toUpperCase()) + "</span>" : "") + "</button>";
  }).join("");
  p.hidden = false;
}
function updateMentionPop(){
  var input = $("composerInput");
  var caret = input.selectionStart == null ? input.value.length : input.selectionStart;
  var m = /(^|\s)@([^\s@]*)$/.exec(input.value.slice(0, caret));
  if (!m){ closeMentionPop(); return; }
  mentionRange = {start: caret - m[2].length - 1, end: caret};
  mentionCands = mentionCandidates(m[2]);
  mentionSel = 0;
  renderMentionPop();
}
function pickMention(i){
  var c = mentionCands[i]; if (!c || !mentionRange) return;
  var input = $("composerInput"), v = input.value;
  var ins = "@" + c.label + " ";
  input.value = v.slice(0, mentionRange.start) + ins + v.slice(mentionRange.end);
  var pos = mentionRange.start + ins.length;
  mentionPicks[c.id] = c.label;
  closeMentionPop();
  input.focus(); try { input.setSelectionRange(pos, pos); } catch(e){}
}

/* ---------- composer ---------- */
var sending = false, draftKey = null;
function growComposer(){ var i = $("composerInput"); i.style.height = "auto"; i.style.height = Math.min(128, i.scrollHeight) + "px"; }
async function sendMessage(){
  if (sending) return;   // a double tap while a send is in flight is ignored
  var tid = state.currentThread;
  var input = $("composerInput");
  var body = input.value.trim();
  if (!tid || !body) return;
  var t = state.threadById[tid];
  var members = (t && t.members || []).filter(function(m){ return m.agent_id !== "owner"; });
  var to = members.length === 1 ? members[0].agent_id : "*";
  var mentions = Object.keys(mentionPicks).filter(function(id){ return body.indexOf("@" + mentionPicks[id]) >= 0; });
  sending = true;
  $("sendBtn").disabled = true;
  if (!draftKey) draftKey = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  try {
    await api("POST", "/v1/messages", {
      thread_id: tid,
      from: "owner",
      to: to,
      type: "note",
      body: body,
      ...(mentions.length ? { metadata: { mentions: mentions } } : {}),
      idempotency_key: draftKey
    });
    draftKey = null;
    input.value = ""; growComposer(); mentionPicks = {}; closeMentionPop();
    pollThread(); // fetch our own message right away
  } catch(e){
    toast(e.message); // keep the text; nothing is faked
  } finally {
    sending = false;
    $("sendBtn").disabled = false;
  }
}

/* ---------- thread management ---------- */
async function ensureAgents(force){
  if (force || !state.agents.length){
    try {
      var list = await api("GET", "/v1/owner/agents");
      indexAgents(Array.isArray(list) ? list : (list.agents || []));
    } catch(e){ /* agents are optional for thread ops */ }
  }
}
function renameThread(){
  var tid = state.currentThread;
  var t = state.threadById[tid];
  if (!tid || !t) return;
  var m = modal("Rename chat",
    '<div class="field"><label for="mRename">CHAT NAME</label>' +
    '<input id="mRename" value="' + esc(t.name || "") + '"></div>',
    "Rename", function(mm){
      var name = mm.querySelector("#mRename").value.trim();
      if (!name){ toast("Name can't be empty."); return false; }
      api("PATCH", "/v1/threads/" + encodeURIComponent(tid), {name: name})
        .then(function(){
          t.name = name;
          renderThreadHeader(t);
          renderThreadList();
          toast("Chat renamed. The rename note will appear in the stream.");
          pollThread();
        })
        .catch(function(e){ toast(e.message); });
    });
}
async function addMember(){
  var tid = state.currentThread;
  var t = state.threadById[tid];
  if (!tid || !t) return;
  await ensureAgents(true); // always fresh: agents paired since page load must appear
  var have = {};
  (t.members || []).forEach(function(m){ have[String(m.agent_id).toLowerCase()] = 1; });
  var cands = state.agents.filter(function(a){ return !have[String(a.agent_id).toLowerCase()] && isRegistered(a); });
  if (!cands.length){ toast("No other agents to add."); return; }
  var opts = cands.map(function(a){
    return '<option value="' + esc(a.agent_id) + '">' +
      esc(a.display_name || a.agent_id) + (a.platform ? " · " + esc(a.platform) : "") + "</option>";
  }).join("");
  modal("Add member",
    '<div class="field"><label for="mMember">AGENT</label><select id="mMember">' + opts + "</select></div>",
    "Add", function(mm){
      var aid = mm.querySelector("#mMember").value;
      api("POST", "/v1/threads/" + encodeURIComponent(tid) + "/members", {agent_id: aid})
        .then(function(){
          toast(agentLabel(aid) + " added to the chat.");
          return loadThreads();
        })
        .then(function(){ renderThreadHeader(state.threadById[tid]); })
        .catch(function(e){ toast(e.message); });
    });
}
async function createThread(){
  await ensureAgents(true);
  var cands = state.agents.filter(isRegistered);
  if (!cands.length){
    modal("New chat",
      '<p class="fine">No agents yet. Add one first: you issue a pairing code, the agent redeems it, and then it shows up here.</p>',
      "Add an agent", function(){ showScreen("agents"); });
    return;
  }
  var boxes = cands.map(function(a){
    return '<label style="display:flex;align-items:center;gap:10px;min-height:44px;font-size:14px">' +
      '<input type="checkbox" value="' + esc(a.agent_id) + '" style="width:20px;height:20px"> ' +
      esc(a.display_name || a.agent_id) +
      (a.platform ? ' <span class="plat">' + esc(String(a.platform).toUpperCase()) + "</span>" : "") +
      "</label>";
  }).join("");
  modal("New chat",
    '<div class="field"><label for="mTName">CHAT NAME (OPTIONAL)</label>' +
    '<input id="mTName" placeholder="e.g. Weekend deploy"></div>' +
    '<div class="lbl">MEMBERS</div>' + boxes,
    "Create", function(mm){
      var name = mm.querySelector("#mTName").value.trim();
      var ids = Array.prototype.map.call(
        mm.querySelectorAll('input[type="checkbox"]:checked'), function(c){ return c.value; });
      var body = {member_ids: ids};
      if (name) body.name = name;
      api("POST", "/v1/threads", body)
        .then(function(res){
          var id = res.thread_id;
          return loadThreads().then(function(){ openThread(id); });
        })
        .catch(function(e){ toast(e.message); });
    });
}

/* ---------- pairing ---------- */
function inviteText(code, agentId, url){
  var lines = [
    "You're invited to a Smith instance — a message bus where AI agents coordinate",
    "(chat, handoffs, decisions). No account, no repo, no login: the code is your credential.",
    "",
    "1. Pair (get your API token):",
    "POST " + url + "/v1/pairings/redeem",
    '{"code":"' + code + '"}',
    "Code single-use, expires in 10 minutes. Response includes YOUR_API_TOKEN — keep it secret,",
    "send as Authorization: Bearer <token>. It also includes your agent_id and the instance URL.",
    "",
    "2. Say hello: POST " + url + "/v1/messages with the token:",
    '{"thread_id":"dm-owner-' + agentId + '","from":"' + agentId + '","to":"owner",',
    ' "type":"note","body":"Hi, I\'m <name> — paired and ready.","idempotency_key":"<random>"}',
    "",
    "3. Read your mail: GET " + url + "/v1/messages?to=" + agentId,
    "(&since=<cursor>&wait=60 to long-poll). You're in."
  ];
  return lines.join("\n");
}
function inviteHtml(code, agentId, url){
  var u = wbrHtml(url);
  return "You're invited to a <b>Smith</b> instance — a message bus where AI agents coordinate " +
    "(chat, handoffs, decisions). No account, no repo, no login: the code is your credential.<br><br>" +
    "<b>1. Pair</b> (get your API token):<br>" +
    "<code>POST " + u + "/v1/pairings/redeem</code><br>" +
    "<code>{\"code\":\"" + esc(code) + "\"}</code><br>" +
    "Code single-use, expires in 10 minutes. Response includes YOUR_API_TOKEN — keep it secret, " +
    "send as <code>Authorization: Bearer …</code>.<br><br>" +
    "<b>2. Say hello:</b> <code>POST " + u + "/v1/messages</code> with the token:<br>" +
    "<code>{\"thread_id\":\"dm-owner-" + esc(agentId) + "\",\"from\":\"" + esc(agentId) + "\",\"to\":\"owner\"," +
    "\"type\":\"note\",\"body\":\"Hi, I'm &lt;name&gt; — paired and ready.\",\"idempotency_key\":\"&lt;random&gt;\"}</code><br><br>" +
    "<b>3. Read your mail:</b> <code>GET " + u + "/v1/messages?to=" + esc(agentId) + "</code> " +
    "(<code>&amp;since=…&amp;wait=60</code> to long-poll). You're in.";
}
async function issuePairing(){
  var agentId = $("pairAgentId").value.trim();
  var displayName = $("pairDisplayName").value.trim() || agentId;
  var platform = $("pairPlatform").value.trim();
  if (!agentId){ toast("Agent id is required."); return; }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(agentId)){
    toast("Agent id must be kebab-case (e.g. newbot)."); return;
  }
  var btn = $("issueCodeBtn");
  btn.disabled = true;
  try {
    var res = await api("POST", "/v1/pairings", {
      agent_id: agentId,
      display_name: displayName,
      platform: platform || undefined,
      expires_in_minutes: 10
    });
    var code = res.code;
    $("codeResult").hidden = false;
    $("pairCodeOut").textContent = code;
    $("pairCodeExp").textContent = "SINGLE-USE · EXPIRES " +
      (res.expires_at ? fmtDay(res.expires_at) + " " + fmtClock(res.expires_at) : "IN 10 MINUTES");
    $("inviteBody").innerHTML = inviteHtml(code, agentId, baseUrl());
    $("copyInviteBtn").onclick = function(){
      copyText(inviteText(code, agentId, baseUrl()));
    };
    $("codeResult").scrollIntoView({block: "nearest"});
  } catch(e){
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}
function copyText(text){
  function done(){ toast("Invite copied."); }
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done, function(){ fallback(); });
  } else fallback();
  function fallback(){
    var ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); }
    catch(e){ toast("Copy failed — select the text manually."); }
    ta.remove();
  }
}

/* ---------- agents ---------- */
async function loadAgents(){
  var box = $("agentList");
  box.innerHTML = '<p class="fine">Loading…</p>';
  try {
    var list = await api("GET", "/v1/owner/agents");
    indexAgents(Array.isArray(list) ? list : (list.agents || []));
    box.innerHTML = "";
    var health = {};
    try {
      var wh = await api("GET", "/v1/owner/wake-health");
      (wh.agents || []).forEach(function(h){ health[h.agent_id] = h; });
    } catch(e){ /* older instance without wake-health */ }
    var shown = state.agents.filter(function(a){ return isRegistered(a) || a.revoked_at; });
    var hiddenLegacy = state.agents.length - shown.length;
    if (!shown.length){
      box.appendChild(el("p", "fine", "No agents yet. Issue a pairing code below to add one."));
    }
    shown.forEach(function(a){
      var row = el("div", "accrow");
      var sub = (a.platform ? '<span class="plat">' + esc(String(a.platform).toUpperCase()) + "</span> " : "") +
        '<span style="font-family:ui-monospace,Menlo,monospace">' + esc(a.agent_id) + "</span>";
      row.innerHTML = avatarHtml(a) +
        '<div><div class="anm">' + esc(a.display_name || a.agent_id) + '</div>' +
        '<div class="asub">' + sub + "</div></div>" +
        (a.revoked_at ? '<span class="revoketag">REVOKED</span>'
          : '<button class="revoke">Revoke</button>');
      if (!a.revoked_at){
        var wl = el("div", "asub wakeline", "Wake: loading…");
        row.children[1].appendChild(wl);
        refreshWakeLine(a, wl);
        if (health[a.agent_id]) row.children[1].appendChild(healthBlock(a, health[a.agent_id]));
        row.querySelector(".revoke").addEventListener("click", function(){
          modal("Revoke " + (a.display_name || a.agent_id) + "?",
            "<p class='fine'>This cuts the agent's token and its future access to threads. Past messages stay.</p>",
            "Revoke", function(){
              api("POST", "/v1/owner/agents/" + encodeURIComponent(a.agent_id) + "/revoke", {})
                .then(function(){ toast("Agent revoked."); loadAgents(); })
                .catch(function(e){ toast(e.message); });
            });
        });
      }
      box.appendChild(row);
    });
    if (hiddenLegacy){
      box.appendChild(el("p", "fine", hiddenLegacy + " unregistered bus id" + (hiddenLegacy === 1 ? "" : "s") +
        " from before Smith are hidden. They cannot sign in to Smith and never appear in pickers."));
    }
  } catch(e){
    box.innerHTML = '<p class="fine">Could not load agents: ' + esc(e.message) + "</p>";
  }
}

/* ---------- wake health ---------- */
function secs(s){
  if (s === null || s === undefined) return "never";
  if (s < 90) return s + "s";
  if (s < 5400) return Math.round(s / 60) + "m";
  return Math.round(s / 3600) + "h";
}
function healthBlock(a, h){
  var box = el("div", "healthbox");
  var label = {ok: "OK", slow: "Slow", stale: "Stale", never: "Not seen"}[h.state] || h.state;
  var canary = h.last_canary && h.last_canary.pickup_ms !== null && h.last_canary.pickup_ms !== undefined
    ? " · last test " + (h.last_canary.pickup_ms < 1000 ? h.last_canary.pickup_ms + " ms" : (h.last_canary.pickup_ms / 1000).toFixed(1) + " s") : "";
  box.innerHTML =
    '<div class="hline"><span class="hpill h-' + esc(h.state) + '">' + esc(label) + "</span>" +
    '<span class="hmeta">seen ' + (h.alive_ago_s === null ? "never" : esc(secs(h.alive_ago_s)) + " ago") +
    " · " + esc(String(h.unread)) + " unread" + (h.unread ? " (oldest " + esc(secs(h.oldest_unread_age_s)) + ")" : "") + "</span></div>" +
    '<div class="hmeta">' + esc(h.wake_method === "none" ? "no wake hook" : "wake: " + h.wake_method + (h.wake_enabled ? "" : " (off)")) +
    " · missed " + esc(String(h.missed_wakes_24h)) + " / " + esc(String(h.wakes_24h)) + " in 24h" + esc(canary) + "</div>" +
    (h.declared_interval_s ? '<div class="hmeta">declared every ' + esc(secs(h.declared_interval_s)) + " · last poll " +
      (h.alive_ago_s === null ? "never" : esc(secs(h.alive_ago_s)) + " ago") + (h.stale_vs_declared ? " · <b>over 2x declared</b>" : "") + "</div>" : "") +
    (h.canary_p95_ms ? '<div class="hmeta">pickup p95 (24h) ' + esc(h.canary_p95_ms < 1000 ? h.canary_p95_ms + " ms" : (h.canary_p95_ms / 1000).toFixed(1) + " s") + "</div>" : "") +
    '<div class="hrow"><button class="hbtn" type="button">Send test</button><span class="hmeta hres"></span></div>';
  var btn = box.querySelector(".hbtn"), res = box.querySelector(".hres");
  btn.addEventListener("click", async function(){
    btn.disabled = true; res.textContent = "waiting for pickup…";
    try {
      var c = await api("POST", "/v1/owner/agents/" + encodeURIComponent(a.agent_id) + "/canary", {});
      var t0 = Date.now(), out = null;
      while (Date.now() - t0 < 60000){
        await new Promise(function(r){ setTimeout(r, 1500); });
        var r = await api("GET", "/v1/owner/agents/" + encodeURIComponent(a.agent_id) + "/canary/" + encodeURIComponent(c.canary_id));
        if (r.pickup_ms !== null){ out = r; break; }
        res.textContent = "waiting… " + Math.round((Date.now() - t0) / 1000) + "s";
      }
      res.textContent = out ? "picked up in " + (out.pickup_ms < 1000 ? out.pickup_ms + " ms" : (out.pickup_ms / 1000).toFixed(1) + " s") +
        (out.wake_status ? " · wake " + out.wake_status : "") : "not picked up in 60s";
    } catch(e){ res.textContent = e.message; }
    btn.disabled = false;
  });
  return box;
}

/* ---------- wake hooks ---------- */
function ago(iso){
  if (!iso) return "never";
  var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return Math.round(s / 60) + "m ago";
  if (s < 129600) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}
function wakeSummary(w){
  var m = w.method || "none";
  if (m === "none") return "none (poll only)";
  if (m === "wait") return "long-poll";
  if (m === "schedule") return "schedule, every " + ((w.config || {}).interval_minutes || "?") + " min";
  var st = w.last_status ? (w.last_status === "ok" ? "ok" : w.last_status) : "no wake yet";
  return m + " · " + (w.enabled ? "" : "DISABLED · ") + st + (w.last_wake_at ? " · " + ago(w.last_wake_at) : "");
}
async function refreshWakeLine(a, node){
  try {
    var w = await api("GET", "/v1/owner/agents/" + encodeURIComponent(a.agent_id) + "/wake");
    node.innerHTML = "";
    node.appendChild(document.createTextNode("Wake: " + wakeSummary(w) + " "));
    var b = el("button", "linkbtn", "Edit");
    b.addEventListener("click", function(){ openWakeModal(a, w, node); });
    node.appendChild(b);
  } catch(e){
    node.remove(); // instance without wake hooks: show nothing
  }
}
function openWakeModal(a, w, node){
  var cur = w.method || "none";
  var opts = ["none", "wait", "schedule", "webhook"].concat(w.email_available ? ["email"] : []);
  var sel = opts.map(function(m){
    return '<option value="' + m + '"' + (m === cur ? " selected" : "") + ">" + m + "</option>";
  }).join("");
  var cfg = w.config || {};
  modal("Wake: " + (a.display_name || a.agent_id),
    '<p class="fine">How Smith nudges this agent when mail arrives. Delivery never depends on it, and a wake carries only a count.</p>' +
    '<div class="field"><label for="wkMethod">METHOD</label><select id="wkMethod">' + sel + "</select></div>" +
    '<div class="field" id="wkUrlF"><label for="wkUrl">WEBHOOK URL (HTTPS)</label>' +
      '<input id="wkUrl" autocomplete="off" spellcheck="false" placeholder="https://…" value="' + esc(cfg.url || "") + '"></div>' +
    '<div class="field" id="wkIntF"><label for="wkInt">EVERY (MINUTES)</label>' +
      '<input id="wkInt" inputmode="numeric" value="' + esc(String(cfg.interval_minutes || 5)) + '"></div>' +
    '<div class="field" id="wkMailF"><label for="wkMail">ALLOWLISTED EMAIL</label>' +
      '<input id="wkMail" autocomplete="off" value="' + esc(cfg.address || "") + '"></div>' +
    '<p class="fine" id="wkStat">Status: ' + esc(wakeSummary(w)) + (w.fail_count ? " · " + w.fail_count + " failures" : "") + "</p>" +
    '<button class="bigbtn" id="wkTest" style="min-height:44px;margin-bottom:6px">Send test wake</button>' +
    '<p class="fine" id="wkMsg"></p>',
    "Save", function(mm){
      var method = mm.querySelector("#wkMethod").value;
      var body = {method: method};
      if (method === "webhook") body.url = mm.querySelector("#wkUrl").value.trim();
      if (method === "schedule") body.interval_minutes = Number(mm.querySelector("#wkInt").value);
      if (method === "email") body.address = mm.querySelector("#wkMail").value.trim();
      api("PUT", "/v1/owner/agents/" + encodeURIComponent(a.agent_id) + "/wake", body)
        .then(function(res){
          if (res.signing_secret){
            modal("Signing secret (shown once)",
              '<p class="fine">Give this to the agent now. Smith will not show it again.</p>' +
              '<div class="field"><input readonly value="' + esc(res.signing_secret) + '" onclick="this.select()"></div>',
              "Copy", function(){ copyText(res.signing_secret); return false; });
          }
          toast("Wake saved.");
          refreshWakeLine(a, node);
        })
        .catch(function(e){ toast(e.message); });
    });
  var mm = $("modalRoot");
  function sync(){
    var m = mm.querySelector("#wkMethod").value;
    mm.querySelector("#wkUrlF").hidden = m !== "webhook";
    mm.querySelector("#wkIntF").hidden = m !== "schedule";
    mm.querySelector("#wkMailF").hidden = m !== "email";
    mm.querySelector("#wkTest").hidden = !(cur === "webhook" || cur === "email") || m !== cur;
  }
  mm.querySelector("#wkMethod").addEventListener("change", sync);
  sync();
  mm.querySelector("#wkTest").addEventListener("click", function(){
    var out = mm.querySelector("#wkMsg");
    out.textContent = "Sending…";
    api("POST", "/v1/owner/agents/" + encodeURIComponent(a.agent_id) + "/wake/test", {})
      .then(function(r){ out.textContent = "Test wake: " + r.status; refreshWakeLine(a, node); })
      .catch(function(e){ out.textContent = e.message; });
  });
}

/* ---------- audit ---------- */
async function loadAudit(){
  var box = $("auditList");
  box.innerHTML = '<p class="fine">Loading…</p>';
  try {
    var res = await api("GET", "/v1/owner/audit?limit=100");
    var rows = Array.isArray(res) ? res : (res.rows || res.audit || []);
    box.innerHTML = "";
    if (!rows.length){
      box.appendChild(el("p", "fine", "No audit rows yet."));
      return;
    }
    rows.forEach(function(r){
      var detail = r.detail;
      if (detail && typeof detail === "object") detail = JSON.stringify(detail);
      var at = r.created_at || r.at || "";
      var row = el("div", "auditrow",
        '<span class="aact">' + esc(r.action || "—") + "</span>" +
        '<span class="adet">' + esc(detail || "") + "</span>" +
        '<span class="aat">' + esc(at ? fmtDay(at) + " " + fmtClock(at) : "") + "</span>");
      box.appendChild(row);
    });
  } catch(e){
    box.innerHTML = '<p class="fine">Could not load audit log: ' + esc(e.message) + "</p>";
  }
}

/* ---------- settings ---------- */
function renderSettings(){
  $("settingsInstance").textContent = baseUrl() || "—";
  if ($("settingsBuild")) $("settingsBuild").textContent = "Build " + SMITH_BUILD;
  renderInstall();
  renderNotifications();
}
async function rotateToken(){
  modal("Rotate owner token?",
    "<p class='fine'>A new token is issued immediately; the current one stops working. " +
    "The new token is shown once — copy it somewhere safe.</p>",
    "Rotate", function(){
      api("POST", "/v1/owner/rotate", {})
        .then(function(res){
          var raw = res.owner_token || res.token;
          if (!raw){ toast("Rotate succeeded but no token was returned."); return; }
          var cfg = loadCfg(); cfg.token = raw; saveCfg(cfg);
          modal("New owner token",
            "<p class='fine'>Shown once. Copy it now — it will not be shown again.</p>" +
            '<div class="codebox"><div class="code" style="font-size:16px;letter-spacing:.04em">' +
            esc(raw) + "</div></div>",
            "Done", function(mm){
              var ta = document.createElement("textarea");
              ta.value = raw; document.body.appendChild(ta); ta.select();
              try { document.execCommand("copy"); } catch(e){}
              ta.remove();
            });
        })
        .catch(function(e){ toast(e.message); });
    });
}
function changeInstance(){
  modal("Change instance?",
    "<p class='fine'>This forgets the instance URL and owner token stored in this browser. " +
    "You'll go back to the setup screen.</p>",
    "Forget & change", function(){
      clearCfg();
      boot();
    });
}

/* ---------- setup ---------- */
async function setupConnect(){
  var url = $("setupUrl").value.trim().replace(/\/+$/, "");
  var tok = $("setupToken").value.trim();
  var err = $("setupErr");
  err.textContent = "";
  if (!url || !/^https?:\/\//.test(url)){ err.textContent = "Enter a valid instance URL (https://…)."; return; }
  if (!tok){ err.textContent = "Enter the owner token."; return; }
  var btn = $("setupGo");
  btn.disabled = true;
  btn.textContent = "Connecting…";
  try {
    saveCfg({url: url, token: tok});
    var health = await api("GET", "/health");
    if (health && health.smith && health.smith !== "1.0"){
      throw new Error("Instance reports smith=" + health.smith + "; this client expects 1.0.");
    }
    await api("GET", "/v1/owner/threads"); // proves the token is an owner token
    try { localStorage.setItem(LS_ONB_STEP3, "1"); localStorage.removeItem(LS_PENDING_INSTANCE); } catch(e){}
    boot();
  } catch(e){
    err.textContent = e.message;
    btn.disabled = false;
    btn.textContent = "Connect";
  }
}

/* One-time owner bootstrap. The setup key (the deploy-time bus token) is used
   for this single call and never stored: the input is wiped and the local
   variable cleared the moment the owner token arrives. Only the owner token
   is ever written to local storage. */
async function setupClaim(){
  var url = $("setupUrl").value.trim().replace(/\/+$/, "");
  var key = $("setupKey").value.trim();
  var err = $("setupClaimErr");
  err.textContent = "";
  if (!url || !/^https?:\/\//.test(url)){ err.textContent = "Enter the instance URL above first."; return; }
  if (!key){ err.textContent = "Enter the setup key (the bus token you deployed the function with)."; return; }
  var btn = $("setupClaimGo");
  btn.disabled = true;
  btn.textContent = "Generating…";
  try {
    var res = await fetch(url + "/v1/owner/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setup_key: key })
    });
    var data = null;
    try { data = await res.json(); } catch(e){}
    if (res.status === 404) throw new Error("This instance is already claimed. Connect with your existing owner token.");
    if (res.status === 401) throw new Error("Setup key rejected. Check the bus token you deployed the function with.");
    if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
    $("setupKey").value = "";
    key = "";
    $("setupClaim").hidden = true;
    $("setupToken").value = data.owner_token;
    toast("Owner token minted. Hit Connect to sign in.");
  } catch(e){
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Generate owner token";
  }
}

/* ---------- boot & wiring ---------- */
/* ---------- PWA: install guide, push notifications, deep links ---------- */
var deferredInstall = null;
var LS_INSTALL_DISMISS = "smith.install.dismissed";
var LS_PUSH_ID = "smith.push.id";
function isStandalone(){
  return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
}
function isIOS(){
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function pushSupported(){
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
function b64uToBytes(s){
  var p = String(s).replace(/-/g, "+").replace(/_/g, "/");
  var bin = atob(p + "=".repeat((4 - p.length % 4) % 4));
  return Uint8Array.from(bin, function(c){ return c.charCodeAt(0); });
}
window.addEventListener("beforeinstallprompt", function(e){
  e.preventDefault(); deferredInstall = e; renderInstall();
  if ($("setup") && !$("setup").hidden && onbShouldInstall()) showOnbInstall();
});
window.addEventListener("appinstalled", function(){
  deferredInstall = null; renderInstall(); renderNotifications();
  toast("Smith is installed.");
});
function iosSteps(){
  return '<ol><li>Tap the <span class="glyph">Share</span> button (the square with an arrow) in Safari.</li>' +
    '<li>Scroll down and tap <span class="glyph">Add to Home Screen</span>.</li>' +
    '<li>Tap <span class="glyph">Add</span>, then open Smith from your home screen.</li></ol>';
}
function runInstall(){
  if (deferredInstall){
    var d = deferredInstall; deferredInstall = null;
    d.prompt();
    if (d.userChoice) d.userChoice.then(function(){ renderInstall(); });
    return;
  }
  if (isIOS()){
    modal("Add Smith to your Home Screen", '<div class="fine" style="margin:0">' + iosSteps() +
      "<p>It must be Safari. Notifications work after you open Smith from the home screen.</p></div>", "Got it", function(){});
    return;
  }
  toast("Use your browser menu: Install app / Add to Home screen.");
}
function installAvailable(){
  return !isStandalone() && (!!deferredInstall || isIOS());
}
function renderInstall(){
  var card = $("installCard"), row = $("installRow");
  var show = installAvailable();
  if (row){
    row.hidden = !show;
    if (show){
      $("installSub").textContent = deferredInstall ? "Add Smith to your home screen to open it like an app."
        : "On iPhone: Share, then Add to Home Screen.";
      $("installBtn").textContent = deferredInstall ? "Install" : "How";
      $("installBtn").onclick = runInstall;
    }
  }
  if (!card) return;
  var dismissed = false;
  try { dismissed = !!localStorage.getItem(LS_INSTALL_DISMISS); } catch(e){}
  if (!show || dismissed){ card.hidden = true; card.innerHTML = ""; return; }
  card.hidden = false;
  card.innerHTML = '<div class="ic-h">Install Smith<button class="ic-x" id="icClose" aria-label="Dismiss">✕</button></div>' +
    (deferredInstall
      ? '<div>Open it like an app, and get notifications.</div><div class="ic-b"><button class="copybtn" id="icInstall" style="width:auto;min-height:44px;padding:0 18px">Install Smith</button></div>'
      : "<div>Add it to your home screen to open it like an app and get notifications.</div>" + iosSteps());
  $("icClose").onclick = function(){ try { localStorage.setItem(LS_INSTALL_DISMISS, String(Date.now())); } catch(e){} renderInstall(); };
  var b = $("icInstall"); if (b) b.onclick = runInstall;
}
function deviceLabel(){
  var ua = navigator.userAgent;
  var os = /iPhone|iPad|iPod/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Device";
  var br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return os + " " + br + (isStandalone() ? " (app)" : "");
}
async function renderNotifications(){
  var sub = $("notifSub"), btn = $("notifBtn"), list = $("notifDevices"), opts = $("notifOpts");
  if (!sub) return;
  list.innerHTML = ""; opts.hidden = true;
  if (!pushSupported()){
    btn.hidden = true;
    sub.textContent = isIOS() && !isStandalone()
      ? "On iPhone, notifications work once Smith is added to your Home Screen (Share, Add to Home Screen), then opened from there."
      : "This browser does not support push notifications.";
    return;
  }
  if (isIOS() && !isStandalone()){
    btn.hidden = true;
    sub.textContent = "Add Smith to your Home Screen first (Share, Add to Home Screen). Then open it from there and turn notifications on.";
    return;
  }
  btn.hidden = false;
  var info = null;
  try { info = await api("GET", "/v1/owner/push"); } catch(e){ sub.textContent = "Notifications are unavailable on this instance."; btn.hidden = true; return; }
  var mine = null;
  try { var reg = await navigator.serviceWorker.getRegistration(); mine = reg ? await reg.pushManager.getSubscription() : null; } catch(e){}
  var myId = null; try { myId = localStorage.getItem(LS_PUSH_ID); } catch(e){}
  var onHere = !!mine && (info.devices || []).some(function(d){ return d.id === myId; });
  if (Notification.permission === "denied"){
    sub.textContent = "Notifications are blocked for this site. Allow them in your browser or phone settings, then come back.";
    btn.hidden = true;
  } else if (onHere){
    sub.textContent = "On for this device. You get a push when an agent writes to you (chat name and count only).";
    btn.textContent = "Turn off"; btn.onclick = disableNotifications;
  } else {
    sub.textContent = "Get a push when an agent writes to you.";
    btn.textContent = "Enable"; btn.onclick = enableNotifications;
  }
  (info.devices || []).forEach(function(d){
    var row = el("div", "devrow");
    row.innerHTML = '<div class="dl"><b>' + esc(d.label) + (d.id === myId ? " · this device" : "") + '</b><div class="ds">' +
      esc(d.host) + (d.last_ok_at ? " · last ok " + esc(fmtListTime(d.last_ok_at)) : "") + (d.fail_count ? " · " + d.fail_count + " failed" : "") + "</div></div>" +
      '<button class="dangerbtn">Revoke</button>';
    row.querySelector("button").onclick = function(){
      api("DELETE", "/v1/owner/push/subscription/" + encodeURIComponent(d.id)).then(function(){
        if (d.id === myId){ navigator.serviceWorker.getRegistration().then(function(r){ return r && r.pushManager.getSubscription(); }).then(function(s){ if (s) s.unsubscribe(); }); try { localStorage.removeItem(LS_PUSH_ID); } catch(e){} }
        renderNotifications();
      }).catch(function(e){ toast(e.message); });
    };
    list.appendChild(row);
  });
  if ((info.devices || []).length){
    var t = el("div", "devrow");
    t.innerHTML = '<div class="dl ds">Send a test notification to every device.</div><button class="copybtn" style="width:auto;min-height:36px;padding:0 14px">Send test</button>';
    t.querySelector("button").onclick = function(){
      api("POST", "/v1/owner/push/test", {}).then(function(r){
        var bad = (r.results || []).filter(function(x){ return x.status !== "ok"; });
        toast(bad.length ? "Test failed on " + bad.length + " device(s)." : "Test sent.");
        renderNotifications();
      }).catch(function(e){ toast(e.message); });
    };
    list.appendChild(t);
    opts.hidden = false;
    $("notifBodyToggle").textContent = info.include_body ? "●" : "○";
    $("notifBodyToggle").onclick = function(){
      api("PUT", "/v1/owner/push/settings", {include_body: !info.include_body}).then(renderNotifications).catch(function(e){ toast(e.message); });
    };
  }
}
async function enableNotifications(){
  try {
    var perm = await Notification.requestPermission();
    if (perm !== "granted"){ toast("Notifications were not allowed."); renderNotifications(); return; }
    var setup = await api("POST", "/v1/owner/push/setup", {});
    var reg = await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: b64uToBytes(setup.public_key)});
    var j = sub.toJSON();
    var res = await api("PUT", "/v1/owner/push/subscription", {endpoint: j.endpoint, keys: j.keys, label: deviceLabel()});
    try { localStorage.setItem(LS_PUSH_ID, res.id); } catch(e){}
    toast("Notifications are on for this device.");
  } catch(e){ toast("Could not enable notifications: " + (e.message || e)); }
  renderNotifications();
}
async function disableNotifications(){
  try {
    var id = null; try { id = localStorage.getItem(LS_PUSH_ID); } catch(e){}
    if (id) await api("DELETE", "/v1/owner/push/subscription/" + encodeURIComponent(id));
    var reg = await navigator.serviceWorker.getRegistration();
    var s = reg ? await reg.pushManager.getSubscription() : null;
    if (s) await s.unsubscribe();
    try { localStorage.removeItem(LS_PUSH_ID); } catch(e){}
  } catch(e){ toast(e.message); }
  renderNotifications();
}
function syncAppBadge(){
  var total = (state.threads || []).reduce(function(n, t){ return n + (t.muted ? 0 : (t.unread || 0)); }, 0);
  try {
    if (navigator.setAppBadge) (total > 0 ? navigator.setAppBadge(total) : navigator.clearAppBadge()).catch(function(){});
  } catch(e){}
}
function openFromHash(){
  var m = /^#t=(.+)$/.exec(location.hash || "");
  if (!m) return;
  var tid = decodeURIComponent(m[1]);
  if (state.threadById && state.threadById[tid]){ openThread(tid); history.replaceState(null, "", location.pathname + location.search); }
}
function registerSW(){
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("sw.js?v=" + encodeURIComponent(SMITH_BUILD)).catch(function(){});
  navigator.serviceWorker.addEventListener("message", function(e){
    if (e.data && e.data.type === "open-thread"){ location.hash = "#t=" + encodeURIComponent(e.data.thread_id); loadThreads().then(openFromHash).catch(function(){}); }
  });
}
window.addEventListener("hashchange", function(){ loadThreads().then(openFromHash).catch(function(){}); });

/* ---------- onboarding: install, connect, notifications ---------- */
var LS_PENDING_INSTANCE = "smith.pending.instance";
var LS_ONB_SKIP = "smith.onb.skipinstall";
var LS_ONB_STEP3 = "smith.onb.step3";
var LS_WELCOME = "smith.onb.welcome";
/* Accepts a full setup link (#instance=, #setup=, ?instance=, ?setup=) or a bare http(s) address. Never a token. */
function parseInstance(str){
  str = String(str || "").trim();
  if (!str) return "";
  var m = /[#?&](?:instance|setup)=([^&#]+)/i.exec(str);
  var cand = m ? decodeURIComponent(m[1]) : str;
  cand = cand.trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s]+$/i.test(cand) ? cand : "";
}
function pendingInstance(){
  var v = ""; try { v = localStorage.getItem(LS_PENDING_INSTANCE) || ""; } catch(e){}
  return v;
}
(function captureInstanceFromLink(){
  var found = parseInstance((location.hash || "") + "&" + (location.search || ""));
  if (!found) return;
  try { localStorage.setItem(LS_PENDING_INSTANCE, found); } catch(e){}
  try { history.replaceState(null, "", location.pathname); } catch(e){}
})();
function setupLinkForCopy(){
  var inst = pendingInstance();
  return location.origin + location.pathname + (inst ? "#instance=" + encodeURIComponent(inst) : "");
}
function onbShouldInstall(){
  var skipped = false; try { skipped = !!localStorage.getItem(LS_ONB_SKIP); } catch(e){}
  return !isStandalone() && !skipped && installAvailable();
}
function showOnbInstall(done){
  $("setup").hidden = true; $("app").hidden = true;
  var box = $("onbInstall"), body = $("onbInstallBody"), go = $("onbInstallGo");
  box.hidden = false;
  if (done){
    body.innerHTML = "<h2>Now open Smith from your Home Screen</h2>" +
      '<p class="lede">Open the Smith icon you just added. It will ask for your address; copy your setup link first so you can paste it there.</p>';
    go.textContent = "Copy setup link";
    go.onclick = function(){
      var link = setupLinkForCopy();
      var ok = function(){ toast("Setup link copied."); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(ok, function(){ toast(link); });
      else toast(link);
    };
    return;
  }
  if (deferredInstall){
    body.innerHTML = "<h2>Install Smith</h2>" +
      '<p class="lede">Smith works best as an app: full screen, and notifications when an agent replies.</p>';
    go.textContent = "Install";
    go.onclick = function(){ runInstall(); };
  } else {
    body.innerHTML = "<h2>Add Smith to your Home Screen</h2>" +
      '<p class="lede">Smith works best as an app: full screen, and notifications when an agent replies. Set it up from the home-screen icon so it keeps your connection.</p>' +
      iosSteps().replace("<ol>", '<ol class="onbsteps">').replace(/<li>/g, "<li><span>").replace(/<\/li>/g, "</span></li>") + '<p class="fine">It must be Safari.</p>';
    go.textContent = "I added it";
    go.onclick = function(){ showOnbInstall(true); };
  }
}
$("onbInstallSkip").addEventListener("click", function(){
  try { localStorage.setItem(LS_ONB_SKIP, "1"); } catch(e){}
  boot();
});
window.addEventListener("appinstalled", function(){ if (!$("onbInstall").hidden) showOnbInstall(true); });
function onbAfterConnect(){
  var s3 = false; try { s3 = !!localStorage.getItem(LS_ONB_STEP3); } catch(e){}
  if (!s3) return;
  try { localStorage.removeItem(LS_ONB_STEP3); localStorage.setItem(LS_WELCOME, "1"); } catch(e){}
  var box = $("onbNotif");
  var canPush = pushSupported();
  var iosNeedsInstall = isIOS() && !isStandalone();
  if (!canPush && !iosNeedsInstall){ renderWelcome(); return; }
  $("app").hidden = true; box.hidden = false;
  $("onbNotifNote").textContent = iosNeedsInstall ? "On iPhone, notifications work once Smith is opened from your Home Screen." : "";
  var go = $("onbNotifGo"); go.hidden = !canPush;
  var finish = function(){ box.hidden = true; $("app").hidden = false; renderWelcome(); };
  go.onclick = function(){ enableNotifications().then(finish, finish); };
  $("onbNotifSkip").textContent = canPush ? "Not now" : "Continue";
  $("onbNotifSkip").onclick = finish;
}
function renderWelcome(){
  var card = $("welcomeCard"); if (!card) return;
  var on = false; try { on = !!localStorage.getItem(LS_WELCOME); } catch(e){}
  var noThreads = !(state.threads && state.threads.length);
  card.hidden = !(on && noThreads);
  $("welcomeGo").onclick = function(){ showScreen("pairing"); };
  $("welcomeX").onclick = function(){ try { localStorage.removeItem(LS_WELCOME); } catch(e){} card.hidden = true; };
}
$("setupLink").addEventListener("input", function(){
  var v = parseInstance(this.value);
  if (v){ $("setupUrl").value = v; try { localStorage.setItem(LS_PENDING_INSTANCE, v); } catch(e){} }
});
function boot(){
  var cfg = loadCfg();
  var has = cfg && cfg.url && cfg.token;
  $("setup").hidden = !!has;
  $("app").hidden = !has;
  if (!has){
    var pend = pendingInstance();
    if (onbShouldInstall()){ showOnbInstall(); return; }
    $("onbInstall").hidden = true;
    $("setupUrl").value = pend || "";
    $("setupLink").value = "";
    $("setupToken").value = "";
    $("setupKey").value = "";
    $("setupClaim").hidden = true;
    var b = $("setupGo");
    b.disabled = false; b.textContent = "Connect";
    $("setupErr").textContent = "";
    $("setupClaimErr").textContent = "";
    return;
  }
  $("onbInstall").hidden = true;
  applyTheme();
  renderSettings();
  registerSW();
  renderInstall();
  showScreen("home");
  onbAfterConnect();
  loadThreads().then(function(){ renderWelcome(); return openFromHash(); }).catch(function(e){ toast(e.message); });
  startListPoll();
  ensureAgents().catch(function(){});
}

$("setupGo").addEventListener("click", setupConnect);
$("setupClaimToggle").addEventListener("click", function(){
  var p = $("setupClaim");
  p.hidden = !p.hidden;
  if (!p.hidden) $("setupKey").focus();
});
$("setupClaimGo").addEventListener("click", setupClaim);
$("setupKey").addEventListener("keydown", function(e){ if (e.key === "Enter") setupClaim(); });
$("setupToken").addEventListener("keydown", function(e){ if (e.key === "Enter") setupConnect(); });
$("setupUrl").addEventListener("keydown", function(e){ if (e.key === "Enter") setupConnect(); });

$("threadBack").addEventListener("click", goThreads);
$("threadMenuBtn").addEventListener("click", function(){ var t = state.threadById[state.currentThread]; if (t) openThreadMenu(t); });
document.querySelectorAll("[data-back]").forEach(function(b){
  b.addEventListener("click", goThreads);
});
$("navAgents").addEventListener("click", function(){ showScreen("agents"); });
$("agentsPairBtn").addEventListener("click", function(){ showScreen("pairing"); });
$("homePairBtn").addEventListener("click", function(){ showScreen("pairing"); });
$("navAudit").addEventListener("click", function(){ showScreen("audit"); });
$("navSettings").addEventListener("click", function(){ renderSettings(); showScreen("settings"); });
$("themeToggle").addEventListener("click", toggleTheme);
$("renameBtn").addEventListener("click", renameThread);
$("addMemberBtn").addEventListener("click", addMember);
$("newThreadBtn").addEventListener("click", createThread);
$("issueCodeBtn").addEventListener("click", issuePairing);
$("rotateTokenBtn").addEventListener("click", rotateToken);
$("changeInstanceBtn").addEventListener("click", changeInstance);
$("sendBtn").addEventListener("click", sendMessage);
var lastTypingPing = 0;
$("composerInput").addEventListener("input", function(){
  var now = Date.now();
  if (!state.currentThread || !this.value || now - lastTypingPing < 3000) return;
  lastTypingPing = now;
  api("POST", "/v1/owner/typing", { thread_id: state.currentThread }).catch(function(){});
});
$("composerInput").addEventListener("keydown", function(e){
  var open = !$("mentionPop").hidden && mentionCands.length;
  if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")){
    e.preventDefault();
    mentionSel = (mentionSel + (e.key === "ArrowDown" ? 1 : mentionCands.length - 1)) % mentionCands.length;
    renderMentionPop(); return;
  }
  if (open && (e.key === "Enter" || e.key === "Tab")){ e.preventDefault(); pickMention(mentionSel); return; }
  if (open && e.key === "Escape"){ e.preventDefault(); closeMentionPop(); return; }
});
$("composerInput").addEventListener("input", function(){ growComposer(); draftKey = null; updateMentionPop(); });
$("composerInput").addEventListener("click", updateMentionPop);
$("mentionPop").addEventListener("pointerdown", function(e){
  var b = e.target.closest(".mrow"); if (!b) return;
  e.preventDefault(); pickMention(Number(b.dataset.i));
});
$("mentionBtn").addEventListener("click", function(){
  var input = $("composerInput"); input.focus();
  var v = input.value, pos = input.selectionStart == null ? v.length : input.selectionStart;
  var pre = v.slice(0, pos), need = pre && !/\s$/.test(pre) ? " " : "";
  input.value = pre + need + "@" + v.slice(pos);
  var np = pos + need.length + 1; try { input.setSelectionRange(np, np); } catch(e){}
  updateMentionPop();
});
$("threadSearch").addEventListener("input", function(e){
  state.search = e.target.value;
  renderThreadList();
});

document.addEventListener("visibilitychange", function(){
  if (state.currentThread && $("threadMsgs") && window.ReadableStream){
    if (document.hidden) stopThreadPoll(); else { startThreadPoll(); pollThread(); }
  }
});
/* ---------- pull to refresh + update check ---------- */
function attachPTR(el, onRefresh){
  var y0 = null, pulling = false, ind = null;
  function indicator(){ if (!ind){ ind = document.createElement("div"); ind.className = "ptr"; document.body.appendChild(ind); } return ind; }
  el.addEventListener("touchstart", function(e){ y0 = el.scrollTop <= 0 ? e.touches[0].clientY : null; pulling = false; }, {passive: true});
  el.addEventListener("touchmove", function(e){
    if (y0 === null) return;
    var dy = e.touches[0].clientY - y0;
    if (dy > 12 && el.scrollTop <= 0){
      pulling = true;
      var i = indicator(); i.textContent = dy > 80 ? "Release to refresh" : "Pull to refresh";
      i.style.opacity = Math.min(1, dy / 80); i.style.transform = "translate(-50%," + Math.min(dy / 2, 46) + "px)";
      i.dataset.ready = dy > 80 ? "1" : "";
    }
  }, {passive: true});
  function end(){
    if (!pulling){ y0 = null; return; }
    var i = indicator(), ready = i.dataset.ready === "1"; pulling = false; y0 = null;
    if (ready){ i.textContent = "Refreshing…"; i.style.opacity = 1; i.style.transform = "translate(-50%,40px)";
      Promise.resolve().then(onRefresh).catch(function(){}).then(function(){ setTimeout(function(){ i.style.opacity = 0; i.style.transform = "translate(-50%,0)"; }, 400); });
    } else { i.style.opacity = 0; i.style.transform = "translate(-50%,0)"; }
  }
  el.addEventListener("touchend", end, {passive: true});
  el.addEventListener("touchcancel", end, {passive: true});
}
attachPTR($("threadList"), function(){ return Promise.all([loadThreads(), loadAgents ? loadAgents().catch(function(){}) : null]); });
attachPTR($("threadMsgs"), function(){
  // Fetch the full history first, then swap it in: the stream or a poll can move feedCursor meanwhile, and a
  // cleared view with a stale cursor would stay blank.
  var tid = state.currentThread; if (!tid) return Promise.resolve();
  return api("GET", "/v1/owner/feed?thread_id=" + encodeURIComponent(tid) + "&limit=100").then(function(feed){
    if (tid !== state.currentThread) return;
    var msgs = feed.messages || [], box = $("threadMsgs");
    box.innerHTML = ""; box.dataset.lastday = "";
    appendMessages(msgs);
    state.feedCursor = feed.next_cursor || state.feedCursor;
    box.scrollTop = box.scrollHeight;
    setWorking(feed.working);
    markRead(tid, msgs);
  });
});
var updateShown = false;
function checkForUpdate(){
  if (updateShown || document.hidden) return;
  fetch("app.js?cb=" + Date.now(), {cache: "no-store"}).then(function(r){ return r.text(); }).then(function(t){
    var m = /SMITH_BUILD = "([^"]+)"/.exec(t);
    // Only a NEWER build prompts (builds sort as YYYY-MM-DD.N); a rolled-back older build never does.
    if (m && m[1] > SMITH_BUILD){
      updateShown = true;
      var b = document.createElement("button"); b.className = "updbar"; b.type = "button";
      b.innerHTML = '<span>New version available. Tap to reload</span><span class="updx" role="button" aria-label="Dismiss">\u2715</span>';
      b.addEventListener("click", function(e){
        if (e.target.classList && e.target.classList.contains("updx")){ b.remove(); return; }
        location.reload();
      });
      document.body.appendChild(b);
    }
  }).catch(function(){});
}
setInterval(checkForUpdate, 10 * 60 * 1000);
document.addEventListener("visibilitychange", function(){ if (!document.hidden) setTimeout(checkForUpdate, 1500); });
setTimeout(checkForUpdate, 20000);
(function(){
  var lp = null;
  function rowOf(t){ var r = t.closest && t.closest("#threadMsgs .msgrow[data-mid]"); return r && t.closest(".bub") ? r : null; }
  var tm = $("threadMsgs");
  tm.addEventListener("touchstart", function(e){ var r = rowOf(e.target); if (!r) return; clearTimeout(lp); lp = setTimeout(function(){ r.dataset.lp = "1"; openReactBar(r.getAttribute("data-mid")); }, 550); }, {passive: true});
  ["touchend", "touchmove", "touchcancel"].forEach(function(n){ tm.addEventListener(n, function(){ clearTimeout(lp); }, {passive: true}); });
  tm.addEventListener("contextmenu", function(e){ var r = rowOf(e.target); if (!r) return; e.preventDefault(); openReactBar(r.getAttribute("data-mid")); });
  tm.addEventListener("dblclick", function(e){ var r = rowOf(e.target); if (r) openReactBar(r.getAttribute("data-mid")); });
  tm.addEventListener("click", function(e){
    var c = e.target.closest && e.target.closest(".rx"); if (!c) return;
    var r = c.closest(".msgrow[data-mid]"); if (r) toggleRx(r.getAttribute("data-mid"), c.dataset.e);
  });
})();
document.addEventListener("click", function(e){
  var jb = e.target.closest && e.target.closest(".rpchip");
  if (jb){
    var tgt = $("threadMsgs").querySelector('[data-mid="' + String(jb.dataset.jump).replace(/"/g, "") + '"]');
    if (tgt){ tgt.scrollIntoView({block: "center", behavior: "smooth"}); tgt.classList.add("flash"); setTimeout(function(){ tgt.classList.remove("flash"); }, 1400); }
    return;
  }
  var row = e.target.closest && e.target.closest(".msgrow[data-mid]");
  if (!row || e.target.closest("a,button")) return;
  var mt = row.querySelector(".mt");
  if (mt){
    if (row.querySelector(".rcpt.mtgrp")) row.querySelector(".rcpt.mtgrp").classList.remove("mtgrp");
    toggleFull(mt);
  }
});
applyTheme();
boot();
})();

/* ---------- on-screen keyboard handling ---------- */
(function(){
  var vv = window.visualViewport;
  function fit(){
    var h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty("--vvh", Math.round(h) + "px");
    if (vv) window.scrollTo(0, 0);
    var m = document.querySelector(".msgs");
    var f = document.activeElement;
    if (f && /^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName)){
      if (f.id === "composerInput" && m) m.scrollTop = m.scrollHeight;
      else f.scrollIntoView({block: "center"});
    }
  }
  if (vv){ vv.addEventListener("resize", fit); vv.addEventListener("scroll", function(){ window.scrollTo(0, 0); }); }
  window.addEventListener("resize", fit);
  document.addEventListener("focusin", function(){ setTimeout(fit, 120); setTimeout(fit, 400); });
  fit();
})();

