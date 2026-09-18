/**
 * The front desk page. One file, no build step, no external resources.
 *
 * Speech in: the browser's Web Speech API (Chrome and Edge), which works on
 * localhost without a certificate. Speech out: speechSynthesis. Both are
 * optional - the text box always works.
 */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Front Desk - __PROJECT__</title>
<style>
  :root { --bg:#0f1115; --panel:#181b22; --line:#2a2f3a; --fg:#e8eaf0; --dim:#9aa1b1; --accent:#4f8cff; --ok:#3ccf7a; --warn:#f0b04a; --bad:#ff5c5c; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, Segoe UI, sans-serif; }
  header { padding:14px 22px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; }
  header b { font-size:18px; } header span { color:var(--dim); font-size:14px; }
  main { display:grid; grid-template-columns: 1fr 380px; gap:18px; padding:18px 22px; min-height:calc(100vh - 60px); }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px; }
  #log { height:52vh; overflow:auto; display:flex; flex-direction:column; gap:10px; }
  .msg { max-width:90%; padding:10px 14px; border-radius:12px; white-space:pre-wrap; }
  .you { align-self:flex-end; background:#22304d; }
  .desk { align-self:flex-start; background:#1f2430; border:1px solid var(--line); }
  .meta { font-size:12px; color:var(--dim); margin-top:4px; }
  #controls { display:flex; gap:10px; margin-top:14px; align-items:center; }
  #mic { width:84px; height:84px; border-radius:50%; border:none; background:var(--accent); color:white; font-size:34px; cursor:pointer; box-shadow:0 6px 24px rgba(79,140,255,.35); }
  #mic.listening { background:var(--bad); animation:pulse 1s infinite; }
  @keyframes pulse { 0%{transform:scale(1)} 50%{transform:scale(1.06)} 100%{transform:scale(1)} }
  #text { flex:1; padding:14px; font-size:16px; border-radius:10px; border:1px solid var(--line); background:#0f1218; color:var(--fg); }
  button.act { padding:10px 14px; border-radius:10px; border:1px solid var(--line); background:#232a38; color:var(--fg); cursor:pointer; font-size:15px; }
  button.act.ok { background:#1d4d33; } button.act.bad { background:#5a2222; } button.act.warn { background:#5a4420; }
  h3 { margin:0 0 10px; font-size:14px; color:var(--dim); text-transform:uppercase; letter-spacing:.06em; }
  .card { border:1px solid var(--line); border-radius:10px; padding:12px; margin-bottom:10px; background:#141821; }
  .card .req { font-weight:600; margin-bottom:6px; }
  .card .nar { font-size:14px; color:var(--dim); }
  .tag { display:inline-block; font-size:12px; padding:2px 8px; border-radius:999px; background:#2a2f3a; margin-right:6px; }
  .tag.plan { background:#3a3320; color:var(--warn);} .tag.review { background:#20334a; color:var(--accent);}
  .tag.completed { background:#1d4d33; color:var(--ok);} .tag.incomplete { background:#5a4420; color:var(--warn);} .tag.rejected,.tag.failed { background:#5a2222; color:var(--bad);}
  #busy { color:var(--warn); font-size:14px; min-height:20px; margin-top:8px; }
  .hint { color:var(--dim); font-size:13px; margin-top:8px; }
</style>
</head>
<body>
<header><div><b>Front Desk</b> &nbsp;<span>project <code>__PROJECT__</code> · deciding as <code>__WHO__</code></span></div><span id="voicestate"></span></header>
<main>
  <section class="panel">
    <div id="log"></div>
    <div id="busy"></div>
    <div id="controls">
      <button id="mic" title="Hold to talk, or click to toggle">🎤</button>
      <input id="text" placeholder="Say what you want, e.g. &quot;fix the giving page categories&quot; - or answer: yes / no / change it so that..." autocomplete="off">
      <button class="act" id="send">Send</button>
    </div>
    <div id="quick" style="display:none; margin-top:12px; gap:8px; flex-wrap:wrap;">
      <button class="act ok" data-say="yes, approve">✔ Approve</button>
      <button class="act warn" data-ask="What should change?">✎ Ask for changes</button>
      <button class="act bad" data-say="no, reject">✖ Reject</button>
      <button class="act" data-say="status">Status</button>
    </div>
    <div class="hint">Your "yes" is the only thing that approves anything. The desk translates; it never decides for you. Mic works in Chrome and Edge.</div>
  </section>
  <aside>
    <div class="panel" style="margin-bottom:18px"><h3>Waiting for you</h3><div id="waiting"><i class="nar">…</i></div></div>
    <div class="panel"><h3>Recent</h3><div id="recent"></div></div>
  </aside>
</main>
<script>
const $ = (s) => document.querySelector(s);
const log = $("#log"), busy = $("#busy"), text = $("#text"), mic = $("#mic"), quick = $("#quick");
let speaking = true;

function add(kind, body, meta) {
  const d = document.createElement("div"); d.className = "msg " + kind; d.textContent = body;
  if (meta) { const m = document.createElement("div"); m.className = "meta"; m.textContent = meta; d.appendChild(m); }
  log.appendChild(d); log.scrollTop = log.scrollHeight;
}
function speak(t) {
  if (!speaking || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(t); u.rate = 1.02; speechSynthesis.speak(u);
}
function render(state) {
  const w = $("#waiting"); w.innerHTML = "";
  if (!state.waiting.length) w.innerHTML = '<div class="nar">Nothing is waiting for you.</div>';
  for (const it of state.waiting) {
    const c = document.createElement("div"); c.className = "card";
    c.innerHTML = '<span class="tag ' + it.gate + '">' + it.gate + ' gate</span><span class="tag">iteration ' + it.iteration + ' of ' + it.limit + '</span>'
      + '<div class="req"></div><div class="nar"></div>';
    c.querySelector(".req").textContent = it.request; c.querySelector(".nar").textContent = it.narration;
    w.appendChild(c);
  }
  quick.style.display = state.waiting.length ? "flex" : "none";
  const r = $("#recent"); r.innerHTML = "";
  for (const it of state.recent) {
    const c = document.createElement("div"); c.className = "card";
    c.innerHTML = '<span class="tag ' + it.status + '">' + it.status + '</span><div class="req"></div><div class="nar"></div>';
    c.querySelector(".req").textContent = it.request; c.querySelector(".nar").textContent = it.narration;
    r.appendChild(c);
  }
}
async function refresh() { try { render(await (await fetch("/api/state")).json()); } catch {} }

async function say(t) {
  t = (t || "").trim(); if (!t) return;
  add("you", t); text.value = ""; busy.textContent = "Working… (the orchestrator may take a while if Claude Code is implementing)";
  try {
    const r = await fetch("/api/say", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: t }) });
    const j = await r.json();
    if (j.error) { add("desk", "Error: " + j.error); }
    else { add("desk", j.say, "understood: " + j.understood); speak(j.say); render(j.state); }
  } catch (e) { add("desk", "The desk is not reachable: " + e); }
  busy.textContent = "";
}
$("#send").onclick = () => say(text.value);
text.addEventListener("keydown", (e) => { if (e.key === "Enter") say(text.value); });
for (const b of quick.querySelectorAll("button")) {
  b.onclick = () => { if (b.dataset.say) say(b.dataset.say); else { text.placeholder = b.dataset.ask; text.focus(); } };
}

// ---- voice in ----
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) { $("#voicestate").textContent = "voice input not supported in this browser - type instead"; mic.disabled = true; }
else {
  const rec = new SR(); rec.lang = "en-US"; rec.interimResults = true; rec.continuous = false;
  let listening = false;
  rec.onresult = (e) => { let s = ""; for (const r of e.results) s += r[0].transcript; text.value = s; if (e.results[e.results.length-1].isFinal) { say(s); } };
  rec.onend = () => { listening = false; mic.classList.remove("listening"); $("#voicestate").textContent = ""; };
  rec.onerror = (e) => { $("#voicestate").textContent = "mic: " + e.error; };
  mic.onclick = () => {
    if (listening) { rec.stop(); return; }
    speechSynthesis.cancel(); listening = true; mic.classList.add("listening"); $("#voicestate").textContent = "listening…"; rec.start();
  };
}
refresh(); setInterval(refresh, 5000);
add("desk", "Hello. Tell me what you want done, or say status.");
</script>
</body>
</html>`;
