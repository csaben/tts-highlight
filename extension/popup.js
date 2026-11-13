const $ = (s) => document.querySelector(s);

async function load() {
  const s = await chrome.runtime.sendMessage({ type: "tts-settings" });
  for (const b of document.querySelectorAll(".seg button")) b.classList.toggle("on", b.dataset.v === s.voice);
  $("#rate").value = s.rate;
  $("#rv").textContent = s.rate + "×";
  $("#steps").value = s.steps;
  $("#stv").textContent = s.steps;
  $("#s-clark").value = s.servers.clark;
  $("#s-baldree").value = s.servers.baldree;
  $("#auto").checked = s.autoAcronyms;
  if (document.activeElement !== $("#lex")) $("#lex").value = s.lex;
  if (s.lex) $("#pron").open = true;
  for (const v of ["clark", "baldree"]) health(v, s.servers[v]);
  return s;
}

async function health(v, base) {
  const dot = $("#h-" + v);
  dot.className = "dot";
  try {
    const r = await fetch(base + "/health", { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    dot.className = "dot " + (j.loaded ? "ok" : "warm");
    dot.title = j.loaded ? (j.busy ? "ready (busy)" : "ready") : "loading model…";
  } catch {
    dot.className = "dot bad";
    dot.title = "unreachable (tailnet?)";
  }
}

let cur;
load().then((s) => (cur = s));

for (const b of document.querySelectorAll(".seg button")) {
  b.onclick = async () => {
    await chrome.storage.sync.set({ voice: b.dataset.v });
    chrome.runtime.sendMessage({ type: "tts-control", action: "voice", value: b.dataset.v });
    load();
  };
}
$("#rate").oninput = (e) => ($("#rv").textContent = e.target.value + "×");
$("#rate").onchange = (e) =>
  chrome.runtime.sendMessage({ type: "tts-control", action: "rate", value: +e.target.value });
$("#steps").oninput = (e) => ($("#stv").textContent = e.target.value);
$("#steps").onchange = (e) => chrome.storage.sync.set({ steps: +e.target.value });
for (const v of ["clark", "baldree"]) {
  $("#s-" + v).onchange = async (e) => {
    const servers = { ...cur.servers, [v]: e.target.value.trim().replace(/\/+$/, "") };
    await chrome.storage.sync.set({ servers });
    cur = await load();
  };
}
$("#lex").onchange = (e) => chrome.storage.sync.set({ lex: e.target.value });
$("#auto").onchange = (e) => chrome.storage.sync.set({ autoAcronyms: e.target.checked });
let lexTimer;
$("#lex").oninput = (e) => {
  clearTimeout(lexTimer);
  lexTimer = setTimeout(() => chrome.storage.sync.set({ lex: e.target.value }), 300);
};
$("#stop").onclick = () => chrome.runtime.sendMessage({ type: "tts-control", action: "stop" });
