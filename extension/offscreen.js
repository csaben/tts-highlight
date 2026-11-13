// Fetches per-segment audio from the voice server (sequentially, a few segments ahead,
// since the server runs one synthesis at a time) and plays it gaplessly-ish at `rate`.
const LOOKAHEAD = 3;
let S = null;

function emit(type, extra = {}) {
  if (!S) return;
  chrome.runtime.sendMessage({ type: "tts-event", ev: type, id: S.id, ...extra }).catch(() => {});
}

function segEvent() {
  const a = S && S.audio;
  if (!a) return;
  emit("seg", {
    index: S.idx,
    total: S.segments.length,
    dur: a.duration || S.durs[S.idx] || 0,
    t: a.currentTime,
    rate: a.playbackRate,
    playing: !a.paused,
    at: Date.now(),
    voice: S.voice,
  });
}

async function doFetch(sess, i, signal) {
  if (signal.aborted || sess !== S) throw new Error("aborted");
  if (i < sess.idx) throw new Error("skipped"); // user jumped past it while queued
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(sess.base + "/synthesize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: sess.segments[i], format: "wav", num_steps: sess.steps }),
        signal,
      });
      if (!r.ok) throw new Error(`server ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const blob = await r.blob();
      sess.durs[i] = parseFloat(r.headers.get("x-audio-duration")) || 0;
      return URL.createObjectURL(blob);
    } catch (e) {
      lastErr = e;
      if (signal.aborted) throw e;
    }
  }
  throw lastErr;
}

function pump() {
  const sess = S;
  if (!sess) return;
  for (let i = sess.idx; i < Math.min(sess.segments.length, sess.idx + LOOKAHEAD); i++) {
    if (sess.cache[i]) continue;
    const signal = sess.ctrl.signal;
    const p = sess.chain.catch(() => {}).then(() => doFetch(sess, i, signal));
    p.catch(() => {});
    sess.cache[i] = sess.chain = p;
  }
}

async function playIdx(i) {
  const sess = S;
  if (!sess) return;
  if (sess.audio) { sess.audio.onended = null; sess.audio.pause(); sess.audio = null; }
  if (i >= sess.segments.length) { emit("done"); cleanup(); return; }
  sess.idx = Math.max(0, i);
  const tok = (sess.tok = (sess.tok || 0) + 1);
  pump();
  emit("loading", { index: sess.idx, total: sess.segments.length, voice: sess.voice });
  let url;
  try {
    url = await sess.cache[sess.idx];
  } catch (e) {
    if (sess !== S || sess.tok !== tok) return;
    if (e.message === "skipped") { sess.cache[sess.idx] = null; return playIdx(sess.idx); }
    emit("error", { message: String(e.message || e) });
    return;
  }
  if (sess !== S || sess.tok !== tok) return; // skipped / stopped meanwhile
  const a = new Audio(url);
  a.preservesPitch = true;
  a.playbackRate = sess.rate;
  sess.audio = a;
  a.onended = () => playIdx(sess.idx + 1);
  a.onplaying = segEvent;
  a.onpause = segEvent;
  a.onratechange = segEvent;
  a.onseeked = segEvent;
  try {
    if (!sess.paused) await a.play();
  } catch (e) {
    emit("error", { message: "playback: " + e.message });
  }
  if (sess.paused) segEvent();
  // drop audio we will not need again (keep one behind for "previous")
  for (let k = 0; k < sess.idx - 1; k++) {
    if (sess.cache[k]) { sess.cache[k].then((u) => URL.revokeObjectURL(u), () => {}); sess.cache[k] = null; }
  }
}

function resetFetches() {
  S.ctrl.abort();
  S.ctrl = new AbortController();
  S.chain = Promise.resolve();
  for (const c of S.cache) if (c) c.then((u) => URL.revokeObjectURL(u), () => {});
  S.cache = [];
}

function cleanup() {
  if (!S) return;
  if (S.audio) { S.audio.onended = null; S.audio.pause(); }
  S.ctrl.abort();
  for (const c of S.cache) if (c) c.then((u) => URL.revokeObjectURL(u), () => {});
  S = null;
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.target !== "offscreen") return;
  if (m.type === "play") {
    if (S) { emit("stopped"); cleanup(); }
    S = {
      id: m.id, segments: m.segments, base: m.base, voice: m.voice, rate: m.rate, steps: m.steps,
      idx: 0, cache: [], durs: [], chain: Promise.resolve(), ctrl: new AbortController(),
      audio: null, paused: false,
    };
    playIdx(0);
    return;
  }
  if (m.type !== "control" || !S) return;
  switch (m.action) {
    case "stop":
      emit("stopped");
      cleanup();
      break;
    case "toggle":
      S.paused = !S.paused;
      if (S.audio) S.paused ? S.audio.pause() : S.audio.play();
      else emit("loading", { index: S.idx, total: S.segments.length, voice: S.voice, paused: S.paused });
      break;
    case "next":
      playIdx(S.idx + 1);
      break;
    case "prev":
      if (S.audio && S.audio.currentTime > 1.5) { S.audio.currentTime = 0; break; }
      playIdx(Math.max(0, S.idx - 1));
      break;
    case "rate":
      S.rate = m.value;
      if (S.audio) S.audio.playbackRate = m.value;
      break;
    case "voice":
      if (m.base && m.base !== S.base) {
        S.base = m.base;
        S.voice = m.value;
        resetFetches();
        playIdx(S.idx);
      }
      break;
  }
});
