importScripts("segment.js");
// Server URLs live in config.local.js (gitignored; see config.example.js).
try { importScripts("config.local.js"); } catch {}

const DEFAULTS = {
  voice: "clark",
  rate: 2,
  steps: 16,
  lex: "",
  autoAcronyms: true,
  altToggle: true, // tap Alt = sticky pick mode (content.js)
  cache: true, // reuse audio already synthesized (offscreen.js, IndexedDB)
  servers: {
    clark: "http://localhost:50300",
    baldree: "http://localhost:50301",
    ...(self.TTS_SERVERS || {}),
  },
};
const VOICE_NAMES = { clark: "Clark", baldree: "Baldree" };

async function settings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  s.servers = { ...DEFAULTS.servers, ...(s.servers || {}) };
  return s;
}

async function updateMenu() {
  const s = await settings();
  const title = `Read aloud: ${VOICE_NAMES[s.voice] || s.voice} ${s.rate}×`;
  chrome.contextMenus.update("tts-read", { title }, () => void chrome.runtime.lastError);
  chrome.contextMenus.update("tts-here", { title: `Pick where to read: ${VOICE_NAMES[s.voice] || s.voice} ${s.rate}×` }, () => void chrome.runtime.lastError);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "tts-read", title: "Read aloud", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "tts-here", title: "Pick where to read", contexts: ["page"] });
    updateMenu();
  });
});
chrome.runtime.onStartup.addListener(updateMenu);
chrome.storage.onChanged.addListener((c, area) => {
  if (area === "sync" && (c.voice || c.rate)) updateMenu();
});

// ---- offscreen audio player ------------------------------------------------------------

let creating = null;
async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (ctx.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Plays synthesized speech for selected text.",
      })
      .catch((e) => { if (!String(e).includes("single offscreen")) throw e; })
      .finally(() => (creating = null));
  }
  await creating;
}

async function toOffscreen(msg) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", ...msg });
}

// ---- sessions ---------------------------------------------------------------------------

async function startSession(segments, tabId, frameId, id = crypto.randomUUID()) {
  const s = await settings();
  const lexRules = ttsParseLex(s.lex);
  const spoken = segments.map((t) => ttsLex(t, lexRules, s.autoAcronyms));
  // lastSpoken: what was sent to the voice server (tests + debugging pronunciation)
  await chrome.storage.session.set({ session: { id, tabId, frameId }, lastSpoken: spoken.slice(0, 50) });
  await toOffscreen({
    type: "play",
    id,
    segments: spoken,
    base: s.servers[s.voice],
    voice: s.voice,
    rate: s.rate,
    steps: s.steps,
    cache: s.cache,
  });
  return { id, voice: s.voice, rate: s.rate };
}

async function startFromText(text, tabId) {
  // No content script (PDF viewer, chrome:// pages, ...): play without highlighting.
  const segs = ttsSegments(text).map((p) => ttsClean(text.slice(p.start, p.end)));
  if (segs.length) await startSession(segs, tabId ?? -1, -1);
}

async function readInTab(tab, frameId, text) {
  const msg = { type: "tts-start", text: text || "" };
  const send = () =>
    chrome.tabs.sendMessage(tab.id, msg, frameId == null ? undefined : { frameId });
  try {
    const r = await send();
    if (r && r.ok) return;
  } catch {
    // Tab opened before install: inject and retry once.
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id, allFrames: true }, files: ["highlight.css"] });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["segment.js", "math.js", "content.js"],
      });
      const r = await send();
      if (r && r.ok) return;
    } catch {}
  }
  if (text) await startFromText(text, tab.id);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  if (info.menuItemId === "tts-here") return pickInTab(tab.id, info.frameId ?? 0);
  if (info.menuItemId !== "tts-read") return;
  readInTab(tab, info.frameId ?? 0, info.selectionText);
});

async function pickInTab(tabId, frameId = 0) {
  const send = () => chrome.tabs.sendMessage(tabId, { type: "tts-pick" }, { frameId });
  try { await send(); } catch {
    try { // tab opened before install: inject, then retry
      await chrome.scripting.insertCSS({ target: { tabId, allFrames: true }, files: ["highlight.css"] });
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["segment.js", "math.js", "content.js"] });
      await send();
    } catch {}
  }
}

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd === "pick-block" && tab) return pickInTab(tab.id);
  if (cmd === "stop-reading") return control({ action: "stop" });
  if (cmd === "toggle-pause") return control({ action: "toggle" });
  if (cmd === "read-selection" && tab) readInTab(tab, null, "");
});

async function control(m) {
  if (m.action === "rate") {
    const rate = Math.min(4, Math.max(0.5, Math.round(m.value * 100) / 100));
    await chrome.storage.sync.set({ rate });
    m = { ...m, value: rate };
  }
  if (m.action === "voice") {
    const s = await settings();
    await chrome.storage.sync.set({ voice: m.value });
    m = { ...m, base: s.servers[m.value] };
  }
  const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (!ctx.length) return;
  return chrome.runtime.sendMessage({ ...m, target: "offscreen", type: "control" });
}

async function relay(ev) {
  const { session } = await chrome.storage.session.get("session");
  if (!session || session.id !== ev.id || session.tabId < 0) return;
  const opts = session.frameId >= 0 ? { frameId: session.frameId } : undefined;
  chrome.tabs.sendMessage(session.tabId, { type: "tts-event", ...ev }, opts).catch(() => {});
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { session } = await chrome.storage.session.get("session");
  if (session && session.tabId === tabId) control({ action: "stop" });
});

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m.target === "offscreen") return; // not ours
  if (m.type === "tts-play") {
    startSession(m.segments, sender.tab?.id ?? -1, sender.frameId ?? 0, m.id).then(reply, (e) =>
      reply({ error: String(e) })
    );
    return true;
  }
  if (m.type === "tts-control") {
    control(m).then(() => reply({ ok: true }), (e) => reply({ error: String(e) }));
    return true;
  }
  if (m.type === "tts-event") {
    relay(m);
    return;
  }
  if (m.type === "tts-pick-active") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => t && pickInTab(t.id));
    return;
  }
  if (m.type === "tts-cache") { // popup: stats / clear
    toOffscreen({ type: "cache-" + m.op }).then(reply, (e) => reply({ error: String(e) }));
    return true;
  }
  if (m.type === "tts-settings") {
    settings().then(reply);
    return true;
  }
});

// ---- dev auto-reload (unpacked installs only) ---------------------------------------------
// Unpacked extensions serve their files straight from disk, so the worker can fetch its own
// files, notice an edit, and chrome.runtime.reload() itself. On reload ("update"), the content
// script is re-injected into open tabs, so no tab refresh is needed either.
const WATCH = ["manifest.json", "background.js", "content.js", "segment.js", "math.js", "offscreen.js",
  "offscreen.html", "popup.html", "popup.js", "highlight.css", "config.local.js"];

async function fingerprint() {
  const parts = await Promise.all(WATCH.map((f) =>
    fetch(chrome.runtime.getURL(f), { cache: "no-store" }).then((r) => r.text(), () => "")));
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(parts.join("\0")));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let devPending = null;
async function devCheck() {
  const { devFp } = await chrome.storage.local.get("devFp");
  const fp = await fingerprint();
  if (!devFp) return chrome.storage.local.set({ devFp: fp });
  if (fp === devFp) { devPending = null; return; }
  // wait until the files stop changing (multi-file edits land one by one)
  if (devPending !== fp) { devPending = fp; setTimeout(devCheck, 800); return; }
  await chrome.storage.local.set({ devFp: fp });
  chrome.runtime.reload();
}

async function reinjectTabs() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*", "file:///*"] });
  for (const t of tabs) {
    chrome.scripting.insertCSS({ target: { tabId: t.id, allFrames: true }, files: ["highlight.css"] }).catch(() => {});
    chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ["segment.js", "math.js", "content.js"] }).catch(() => {});
  }
}

chrome.management.getSelf().then(async (self) => {
  if (self.installType !== "development") return;
  chrome.alarms.create("dev-reload", { periodInMinutes: 0.5 }); // wakes a sleeping worker
  chrome.alarms.onAlarm.addListener((a) => a.name === "dev-reload" && devCheck());
  setInterval(devCheck, 1000); // fast path while the worker is awake
  devCheck();
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "update") return;
  await chrome.storage.local.set({ devFp: await fingerprint() });
  reinjectTabs();
});
