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
        ? stackHtml(t.members)
        : avatarHtml(t.members[0] || {display_name: t.name});
      var right = '<div class="tright"><div class="ttime">' +
        esc(t.last_at ? fmtListTime(t.last_at) : "") + "</div>" +
        (t.unread ? '<span class="udot">' + esc(String(t.unread)) + "</span>" : "") + "</div>";
      r.innerHTML = av +
        '<div class="tmeta"><div class="tnm">' + esc(t.name || t.thread_id) + "</div>" +
        '<div class="tsn">' + threadSnippet(t) + "</div></div>" + right;
      r.addEventListener("click", function(){ openThread(t.thread_id); });
      box.appendChild(r);
    });
  }
  section("DIRECT", dms);
  section("GROUPS", groups);
  if (!list.length){
    box.appendChild(el("div", "emptymsgs",
      q ? "No chats match your search." :
          "No chats yet.<br>Pair an agent to start your first conversation."));
  }
}

/* ---------- thread view ---------- */
function memberSubHtml(t){
  var ms = t.members || [];
  if (!ms.length) return "No members yet";
  return ms.map(function(m){
    var nm = esc(m.display_name || m.agent_id);
    var p = m.platform ? ' <span class="plat">' + esc(m.platform.toUpperCase()) + "</span>" : "";
    return "<b>" + nm + "</b>" + p;
  }).join(" · ");
}
function renderThreadHeader(t){
  $("threadName").textContent = t.name || t.thread_id;
  $("threadSub").innerHTML = memberSubHtml(t);
  var ms = t.members || [];
  $("threadAvatar").innerHTML = ms.length > 1 ? stackHtml(ms)
    : avatarHtml(ms[0] || {display_name: t.name});
  var others = ms.filter(function(m){ return m.agent_id !== "owner"; });
  $("composerInput").placeholder = others.length === 1
    ? "Message " + (others[0].display_name || others[0].agent_id) + "…"
    : "Message " + (t.name || "thread") + "…";
}
function receiptLabel(msg){
  // Render ONLY from real receipt events attached to the message.
  var rcs = msg.receipts || [];
  if (!rcs.length) return "";
  var acted = rcs.filter(function(r){ return r.status === "acted"; });
  var recvd = rcs.filter(function(r){ return r.status === "received"; });
  var t = msg.created_at ? fmtClock(msg.created_at) : "";
  if (acted.length) return "✓✓ <b>acted</b> · " + esc(t);
  if (recvd.length) return "✓ <b>received</b> · " + esc(t);
  return "";
}
function isRenameNote(msg){
  return msg && msg.metadata && msg.metadata.x_cutout_thread_rename;
}
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
  if (mine){
    var lbl = receiptLabel(msg);
    return '<div class="msgrow msg-out" data-mid="' + esc(msg.id) + '">' +
      '<div class="bub">' + esc(msg.body || "") + "</div>" +
      (lbl ? '<div class="rcpt">' + lbl + "</div>" : "") + "</div>";
  }
  var nm = esc(agentLabel(msg.from));
  var plat = agentPlat(msg.from);
  var who = '<div class="who">' + nm +
    (plat ? ' <span class="plat">' + esc(String(plat).toUpperCase()) + "</span>" : "") + "</div>";
  return '<div class="msgrow them" data-mid="' + esc(msg.id) + '">' + who +
    '<div class="bub">' + esc(msg.body || "") + "</div></div>";
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
    var day = fmtDay(m.created_at);
    if (day !== lastDay){
      box.insertAdjacentHTML("beforeend", '<div class="day">' + esc(day) + "</div>");
      lastDay = day;
    }
    box.insertAdjacentHTML("beforeend", msgHtml(m));
  });
  box.dataset.lastday = lastDay;
}
function markRead(tid, msgs){
  if (!msgs.length) return;
  var map = loadRead();
  map[tid] = msgs[msgs.length - 1].id;
  saveRead(map);
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
function startThreadPoll(){
  stopThreadPoll();
  state.threadTimer = setInterval(pollThread, 5000);
}
function stopThreadPoll(){
  if (state.threadTimer){ clearInterval(state.threadTimer); state.threadTimer = null; }
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

/* ---------- composer ---------- */
async function sendMessage(){
  var tid = state.currentThread;
  var input = $("composerInput");
  var body = input.value.trim();
  if (!tid || !body) return;
  var t = state.threadById[tid];
  var members = (t && t.members || []).filter(function(m){ return m.agent_id !== "owner"; });
  var to = members.length === 1 ? members[0].agent_id : "*";
  $("sendBtn").disabled = true;
  try {
    await api("POST", "/v1/messages", {
      thread_id: tid,
      from: "owner",
      to: to,
      type: "note",
      body: body,
      idempotency_key: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()))
    });
    input.value = "";
    pollThread(); // fetch our own message right away
  } catch(e){
    toast(e.message); // keep the text; nothing is faked
  } finally {
    $("sendBtn").disabled = false;
  }
}

/* ---------- thread management ---------- */
async function ensureAgents(){
  if (!state.agents.length){
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
  await ensureAgents();
  var have = {};
  (t.members || []).forEach(function(m){ have[m.agent_id] = 1; });
  var cands = state.agents.filter(function(a){ return !have[a.agent_id] && !a.revoked_at; });
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
  await ensureAgents();
  var cands = state.agents.filter(function(a){ return !a.revoked_at; });
  var boxes = cands.map(function(a){
    return '<label style="display:flex;align-items:center;gap:10px;min-height:44px;font-size:14px">' +
      '<input type="checkbox" value="' + esc(a.agent_id) + '" style="width:20px;height:20px"> ' +
      esc(a.display_name || a.agent_id) +
      (a.platform ? ' <span class="plat">' + esc(String(a.platform).toUpperCase()) + "</span>" : "") +
      "</label>";
  }).join("") || '<p class="fine">No agents yet — pair one first.</p>';
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
    if (!state.agents.length){
      box.appendChild(el("p", "fine", "No agents paired yet. Issue a pairing code to add one."));
      return;
    }
    state.agents.forEach(function(a){
      var row = el("div", "accrow");
      var sub = (a.platform ? '<span class="plat">' + esc(String(a.platform).toUpperCase()) + "</span> " : "") +
        '<span style="font-family:ui-monospace,Menlo,monospace">' + esc(a.agent_id) + "</span>";
      row.innerHTML = avatarHtml(a) +
        '<div><div class="anm">' + esc(a.display_name || a.agent_id) + '</div>' +
        '<div class="asub">' + sub + "</div></div>" +
        (a.revoked_at ? '<span class="revoketag">REVOKED</span>'
          : '<button class="revoke">Revoke</button>');
      if (!a.revoked_at){
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
  } catch(e){
    box.innerHTML = '<p class="fine">Could not load agents: ' + esc(e.message) + "</p>";
  }
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
function boot(){
  var cfg = loadCfg();
  var has = cfg && cfg.url && cfg.token;
  $("setup").hidden = !!has;
  $("app").hidden = !has;
  if (!has){
    $("setupUrl").value = "";
    $("setupToken").value = "";
    $("setupKey").value = "";
    $("setupClaim").hidden = true;
    var b = $("setupGo");
    b.disabled = false; b.textContent = "Connect";
    $("setupErr").textContent = "";
    $("setupClaimErr").textContent = "";
    return;
  }
  applyTheme();
  renderSettings();
  showScreen("home");
  loadThreads().catch(function(e){ toast(e.message); });
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
document.querySelectorAll("[data-back]").forEach(function(b){
  b.addEventListener("click", goThreads);
});
$("navAgents").addEventListener("click", function(){ showScreen("agents"); });
$("agentsPairBtn").addEventListener("click", function(){ showScreen("pairing"); });
$("homePairBtn").addEventListener("click", function(){ showScreen("pairing"); });
$("navAudit").addEventListener("click", function(){ showScreen("audit"); });
$("navSettings").addEventListener("click", function(){ showScreen("settings"); });
$("themeToggle").addEventListener("click", toggleTheme);
$("renameBtn").addEventListener("click", renameThread);
$("addMemberBtn").addEventListener("click", addMember);
$("newThreadBtn").addEventListener("click", createThread);
$("issueCodeBtn").addEventListener("click", issuePairing);
$("rotateTokenBtn").addEventListener("click", rotateToken);
$("changeInstanceBtn").addEventListener("click", changeInstance);
$("sendBtn").addEventListener("click", sendMessage);
$("composerInput").addEventListener("keydown", function(e){
  if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); sendMessage(); }
});
$("threadSearch").addEventListener("input", function(e){
  state.search = e.target.value;
  renderThreadList();
});

applyTheme();
boot();
})();
