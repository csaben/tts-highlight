importScripts("segment.js");

const DEFAULTS = {
  voice: "clark",
  rate: 2,
  steps: 16,
  lex: "",
  autoAcronyms: true,
  servers: {
    clark: "http://localhost:50300",
    baldree: "http://localhost:50301",
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
  chrome.contextMenus.update("tts-here", { title: `Read from here: ${VOICE_NAMES[s.voice] || s.voice} ${s.rate}×` }, () => void chrome.runtime.lastError);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "tts-read", title: "Read aloud", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "tts-here", title: "Read from here", contexts: ["page"] });
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
  await chrome.storage.session.set({ session: { id, tabId, frameId } });
  await toOffscreen({
    type: "play",
    id,
    segments: segments.map((t) => ttsLex(t, lexRules, s.autoAcronyms)),
    base: s.servers[s.voice],
    voice: s.voice,
    rate: s.rate,
    steps: s.steps,
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
        files: ["segment.js", "content.js"],
      });
      const r = await send();
      if (r && r.ok) return;
    } catch {}
  }
  if (text) await startFromText(text, tab.id);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  if (info.menuItemId === "tts-here") {
    chrome.tabs.sendMessage(tab.id, { type: "tts-start-here" }, { frameId: info.frameId ?? 0 }).catch(() => {});
    return;
  }
  if (info.menuItemId !== "tts-read") return;
  readInTab(tab, info.frameId ?? 0, info.selectionText);
});

chrome.commands.onCommand.addListener(async (cmd, tab) => {
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
  if (m.type === "tts-settings") {
    settings().then(reply);
    return true;
  }
});
