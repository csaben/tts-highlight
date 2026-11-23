// Fetches per-segment audio from the voice server (sequentially, a few segments ahead,
// since the server runs one synthesis at a time) and plays it gaplessly-ish at `rate`.
const LOOKAHEAD = 3;
let S = null;

// ---- audio cache ------------------------------------------------------------------------
// Audio already synthesized, keyed by server + steps + exact spoken text, so starting again
// from another block (or re-reading a page later) plays those sentences instantly instead of
// re-synthesizing. Stored in IndexedDB, because Chrome closes an audio offscreen document
// after ~30 s of silence (and on restart). Least recently used goes first past CACHE_MAX.
const CACHE_MAX = 500 * 1024 * 1024;
const keyOf = (sess, i) => sess.base + "|" + sess.steps + "|" + sess.segments[i];
let dbP = null, cacheBytes = -1;
const req = (r) => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
function db() {
  if (!dbP) {
    const r = indexedDB.open("tts-audio", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("a", { keyPath: "k" }).createIndex("used", "used");
    dbP = req(r).catch((e) => { dbP = null; throw e; });
  }
  return dbP;
}
async function cacheGet(k) {
  try {
    const st = (await db()).transaction("a", "readwrite").objectStore("a");
    const v = await req(st.get(k));
    if (!v) return null;
    v.used = Date.now();
    st.put(v); // touch for LRU
    return { blob: v.blob, dur: v.dur };
  } catch { return null; }
}
async function cachePut(k, v) {
  try {
    const d = await db();
    if (cacheBytes < 0) { // first write since startup: total up what's stored
      cacheBytes = 0;
      const all = await req(d.transaction("a").objectStore("a").getAll());
      for (const e of all) cacheBytes += e.size;
    }
    const st = d.transaction("a", "readwrite").objectStore("a");
    const old = await req(st.get(k));
    if (old) cacheBytes -= old.size;
    await req(st.put({ k, blob: v.blob, dur: v.dur, size: v.blob.size, used: Date.now() }));
    cacheBytes += v.blob.size;
    if (cacheBytes <= CACHE_MAX) return;
    const ev = d.transaction("a", "readwrite").objectStore("a");
    const cur = ev.index("used").openCursor();
    await new Promise((ok) => {
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c || cacheBytes <= CACHE_MAX * 0.9) return ok();
        cacheBytes -= c.value.size; c.delete(); c.continue();
      };
      cur.onerror = ok;
    });
  } catch {}
}
async function cacheStats() {
  try {
    const all = await req((await db()).transaction("a").objectStore("a").getAll());
    return { entries: all.length, bytes: all.reduce((n, e) => n + e.size, 0) };
  } catch (e) { return { error: String(e) }; }
}
async function cacheClear() {
  try { await req((await db()).transaction("a", "readwrite").objectStore("a").clear()); cacheBytes = 0; } catch {}
}

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
      const v = { blob: await r.blob(), dur: parseFloat(r.headers.get("x-audio-duration")) || 0 };
      if (sess.useCache) cachePut(keyOf(sess, i), v);
      return v;
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
    // cached sentences skip the server queue; misses join the sequential fetch chain
    const p = (sess.useCache ? cacheGet(keyOf(sess, i)) : Promise.resolve(null)).then((hit) => {
      if (hit) { sess.hits++; return hit; }
      const f = sess.chain.catch(() => {}).then(() => doFetch(sess, i, signal));
      sess.chain = f;
      return f;
    });
    p.catch(() => {});
    sess.cache[i] = p;
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
  let res;
  try {
    res = await sess.cache[sess.idx];
  } catch (e) {
    if (sess !== S || sess.tok !== tok) return;
    if (e.message === "skipped") { sess.cache[sess.idx] = null; return playIdx(sess.idx); }
    emit("error", { message: String(e.message || e) });
    return;
  }
  if (sess !== S || sess.tok !== tok) return; // skipped / stopped meanwhile
  sess.durs[sess.idx] = res.dur;
  if (sess.url) URL.revokeObjectURL(sess.url);
  sess.url = URL.createObjectURL(res.blob);
  const a = new Audio(sess.url);
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
    sess.cache[k] = null;
  }
}

function resetFetches() {
  S.ctrl.abort();
  S.ctrl = new AbortController();
  S.chain = Promise.resolve();
  S.cache = [];
}

function cleanup() {
  if (!S) return;
  if (S.audio) { S.audio.onended = null; S.audio.pause(); }
  S.ctrl.abort();
  if (S.url) URL.revokeObjectURL(S.url);
  S = null;
}

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m.target !== "offscreen") return;
  if (m.type === "play") {
    if (S) { emit("stopped"); cleanup(); }
    S = {
      id: m.id, segments: m.segments, base: m.base, voice: m.voice, rate: m.rate, steps: m.steps,
      idx: 0, cache: [], durs: [], chain: Promise.resolve(), ctrl: new AbortController(),
      audio: null, paused: false, url: null, useCache: m.cache !== false, hits: 0,
    };
    playIdx(0);
    return;
  }
  if (m.type === "cache-stats") { cacheStats().then((s) => reply({ ...s, hits: S ? S.hits : -1 })); return true; }
  if (m.type === "cache-clear") { cacheClear().then(() => reply({ ok: true })); return true; }
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
