// Maps the current selection to DOM ranges, asks the background to read it, and paints
// sentence + estimated-word highlights (CSS Custom Highlight API, no DOM mutation) while
// the offscreen player reports progress. Also hosts the floating mini player.
(() => {
  // A reloaded extension re-injects this script into open tabs. The DOM event tells the
  // previous (now orphaned) copy to tear itself down; events cross isolated worlds.
  document.dispatchEvent(new CustomEvent("tts-read-aloud-reset"));
  const life = new AbortController();
  const sig = { capture: true, signal: life.signal };
  // After a reload this copy's chrome.* calls throw "Extension context invalidated".
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  // Sweep leftovers from older copies that predate the reset event (player + highlights).
  for (const el of document.documentElement.children) {
    if (el.dataset && el.dataset.ttsPlayer !== undefined) el.remove();
    else if (el.shadowRoot && el.shadowRoot.querySelector("button.voice[title='Switch voice']")) el.remove();
  }
  if (typeof CSS !== "undefined" && CSS.highlights) {
    for (const n of ["tts-sentence", "tts-word", "tts-indexed", "tts-preview"]) CSS.highlights.delete(n);
  }

  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION", "TEMPLATE"]);
  const INLINE = new Set(["inline", "inline-block", "inline-flex", "contents", "ruby", "inline-grid"]);
  // page index skips chrome around the article and code blocks
  const PAGE_SKIP = "nav, footer, aside, pre, code, [role=navigation], [aria-hidden=true], [contenteditable=true]";
  // Sites where the page index reads only the post text, so a thread plays as one stream without
  // names, handles, timestamps or reply/like/view counts in between.
  const SITE_ONLY = [
    [/(^|\.)(x|twitter)\.com$/, '[data-testid="tweetText"]'],
  ];
  const PAGE_ONLY = (SITE_ONLY.find(([re]) => re.test(location.hostname)) || [])[1] || null;
  const hasHL = typeof Highlight !== "undefined" && CSS.highlights;

  let doc = null; // {full, pieces, segs:[{start,end,words:[{start,end,w}]}]}
  let sessionId = null;
  let state = null; // last "seg" event
  let raf = 0;
  let lastWord = -1, lastSeg = -1;

  // ---- selection -> flat text with DOM mapping --------------------------------------------

  function blockOf(el, cache) {
    let e = el;
    while (e && e !== document.body) {
      let d = cache.get(e);
      if (d === undefined) { d = getComputedStyle(e).display; cache.set(e, d); }
      if (!INLINE.has(d)) return e;
      e = e.parentElement;
    }
    return document.body;
  }

  function collect(range, page = false) {
    let root = range.commonAncestorContainer;
    if (root.nodeType !== 1) root = root.parentNode;
    const pieces = [];
    let full = "";
    let prevBlock = null;
    const cache = new Map();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!range.intersectsNode(n)) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (page && p.closest(PAGE_SKIP)) return NodeFilter.FILTER_REJECT;
        if (page && PAGE_ONLY && !p.closest(PAGE_ONLY)) return NodeFilter.FILTER_REJECT;
        if (p.checkVisibility && !p.checkVisibility()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let curMath = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      // A formula (KaTeX / MathJax / <math>) becomes one piece whose text is its spoken
      // form; its other text nodes (visual spans + hidden MathML copy) are skipped.
      const mathEl = mathOf(n.parentElement);
      if (mathEl) {
        if (mathEl === curMath) continue;
        curMath = mathEl;
        const said = speakMath(mathEl);
        if (!said) continue;
        const block = blockOf(mathEl.parentElement || mathEl, cache);
        if (prevBlock && block !== prevBlock) full += "\n";
        else if (full && !/\s$/.test(full)) full += " ";
        prevBlock = block;
        pieces.push({ node: n, nodeStart: 0, start: full.length, end: full.length + said.length, block, math: mathEl });
        full += said + " ";
        continue;
      }
      const a = n === range.startContainer ? range.startOffset : 0;
      const b = n === range.endContainer ? range.endOffset : n.data.length;
      if (b <= a) continue;
      const block = blockOf(n.parentElement, cache);
      if (prevBlock && (block !== prevBlock || afterBr(n, block))) full += "\n";
      prevBlock = block;
      pieces.push({ node: n, nodeStart: a, start: full.length, end: full.length + (b - a), block });
      full += n.data.slice(a, b);
    }
    return { full, pieces };
  }

  // a <br> right before this text (possibly at an ancestor level within the block) = line break
  function afterBr(n, block) {
    for (let e = n; e && e !== block; e = e.parentNode) {
      let s = e.previousSibling;
      while (s && s.nodeType === 3 && !s.data.trim()) s = s.previousSibling;
      if (s) return s.nodeName === "BR";
    }
    return false;
  }

  const MATH_ROOTS = [".katex", "mjx-container", "math"];
  function mathOf(el) {
    if (!el) return null;
    for (const s of MATH_ROOTS) { const m = el.closest(s); if (m) return m; }
    return null;
  }
  function speakMath(el) {
    const ml = el.localName === "math" ? el : el.querySelector("math");
    let said = "";
    try { if (ml && typeof ttsMathSpeech === "function") said = ttsMathSpeech(ml); } catch {}
    return (said || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function domAt(pieces, pos, isEnd) {
    // binary search: first piece whose end > pos (start) / >= pos (end)
    let lo = 0, hi = pieces.length - 1, ans = pieces.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (isEnd ? pieces[mid].end >= pos : pieces[mid].end > pos) { ans = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    const p = pieces[ans];
    if (p.math) return isEnd ? [p.math, p.math.childNodes.length] : [p.math, 0]; // whole formula
    const off = Math.min(Math.max(pos, p.start), p.end) - p.start;
    return [p.node, p.nodeStart + off];
  }

  function makeRange(start, end) {
    try {
      const r = document.createRange();
      const [sn, so] = domAt(doc.pieces, start, false);
      const [en, eo] = domAt(doc.pieces, end, true);
      r.setStart(sn, so);
      r.setEnd(en, eo);
      return r;
    } catch { return null; }
  }

  function buildDoc(full, pieces) {
    const segs = ttsSegments(full).map((p) => {
      const words = [];
      const re = /\S+/g;
      const t = full.slice(p.start, p.end);
      let m, total = 0;
      while ((m = re.exec(t))) {
        // crude duration weight: letters + a pause bonus after punctuation
        let w = m[0].length + 2;
        if (/[,;:]$/.test(m[0])) w += 4;
        if (/[.!?…]["'”’)]*$/.test(m[0])) w += 7;
        words.push({ start: p.start + m.index, end: p.start + m.index + m[0].length, w, at: total });
        total += w;
      }
      for (const w of words) w.at /= total || 1;
      return { start: p.start, end: p.end, text: ttsClean(t), words };
    });
    return { full, pieces, segs };
  }

  function grabSelection(fallbackText) {
    const ae = document.activeElement;
    if (ae && (ae.tagName === "TEXTAREA" || (ae.tagName === "INPUT" && /^(text|search|url|email)?$/i.test(ae.type)))) {
      const t = ae.value.slice(ae.selectionStart, ae.selectionEnd);
      if (t.trim()) return buildDoc(t, null);
    }
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const { full, pieces } = collect(sel.getRangeAt(0));
      if (full.trim() && pieces.length) return buildDoc(full, pieces);
    }
    if (fallbackText && fallbackText.trim()) return buildDoc(fallbackText, null);
    return null;
  }

  // ---- highlighting -----------------------------------------------------------------------

  function clearHL() {
    if (hasHL) { CSS.highlights.delete("tts-sentence"); CSS.highlights.delete("tts-word"); }
    lastWord = lastSeg = -1;
  }

  function scrollIntoViewIfNeeded(r) {
    const b = r.getBoundingClientRect();
    if (!b.width && !b.height) return;
    const vh = window.innerHeight;
    if (b.top < 60 || b.bottom > vh - 90) {
      const el = r.startContainer.parentElement;
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function tick() {
    raf = 0;
    if (!state || !doc) return;
    const seg = doc.segs[state.index];
    if (!seg || !doc.pieces || !hasHL) return;
    if (lastSeg !== state.index) {
      const r = makeRange(seg.start, seg.end);
      if (r) { CSS.highlights.set("tts-sentence", new Highlight(r)); scrollIntoViewIfNeeded(r); }
      lastSeg = state.index;
      lastWord = -1;
    }
    let t = state.t;
    if (state.playing) t += ((Date.now() - state.at) / 1000) * state.rate;
    // ~0.15 s of lead-in/out silence in each clip
    const dur = Math.max(0.3, (state.dur || 1) - 0.3);
    const frac = Math.min(0.999, Math.max(0, (t - 0.15) / dur));
    let wi = 0;
    while (wi + 1 < seg.words.length && seg.words[wi + 1].at <= frac) wi++;
    if (wi !== lastWord && seg.words[wi]) {
      const w = seg.words[wi];
      const r = makeRange(w.start, w.end);
      if (r) CSS.highlights.set("tts-word", new Highlight(r));
      lastWord = wi;
    }
    if (state.playing) raf = requestAnimationFrame(tick);
  }

  // ---- mini player ------------------------------------------------------------------------

  let ui = null;
  function player(anchor) {
    if (ui) return ui;
    const host = document.createElement("div");
    host.dataset.ttsPlayer = "";
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:18px;bottom:18px;";
    if (anchor && anchor.side) {
      // read-from-here: park at the right edge, level with the click, out of the text
      host.style.top = Math.min(window.innerHeight - 50, Math.max(8, anchor.y - 18)) + "px";
      host.style.bottom = "auto";
    } else if (anchor && (anchor.width || anchor.height)) {
      // just right of / below where the selection ended, clamped into the viewport
      const x = Math.min(window.innerWidth - 330, Math.max(8, anchor.right + 10));
      const y = Math.min(window.innerHeight - 50, Math.max(8, anchor.bottom + 8));
      host.style.left = x + "px"; host.style.top = y + "px";
      host.style.right = host.style.bottom = "auto";
    }
    const sh = host.attachShadow({ mode: "open" });
    sh.innerHTML = `
      <style>
        .p{font:13px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;display:flex;align-items:center;gap:4px;cursor:grab;touch-action:none;
           background:#16161a;color:#f2f2f2;border-radius:999px;padding:5px 8px;box-shadow:0 6px 24px #0006;
           user-select:none}
        button{all:unset;cursor:pointer;min-width:26px;height:26px;border-radius:999px;display:grid;place-items:center;
           color:inherit;font-size:13px;padding:0 4px}
        button:hover{background:#ffffff1c}
        .rate{min-width:38px;text-align:center;font-variant-numeric:tabular-nums;font-weight:600}
        .voice{font-weight:600;color:#ffcf4a;padding:0 8px}
        .st{color:#aaa;min-width:44px;font-variant-numeric:tabular-nums;padding-right:4px}
        .err{color:#ff8080;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      </style>
      <div class="p">
        <button class="voice" title="Switch voice"></button>
        <button data-a="prev" title="Previous sentence">⏮</button>
        <button data-a="toggle" class="pp" title="Pause / resume (Alt+Shift+P)">⏸</button>
        <button data-a="next" title="Next sentence">⏭</button>
        <button data-a="slower" title="Slower">−</button>
        <span class="rate"></span>
        <button data-a="faster" title="Faster">+</button>
        <span class="st"></span>
        <button data-a="stop" title="Stop (Alt+Shift+X)">✕</button>
      </div>`;
    const $ = (s) => sh.querySelector(s);
    let rate = 2, voice = "clark";
    let dragged = false;
    sh.addEventListener("click", (e) => {
      if (dragged) { dragged = false; return; }
      const b = e.target.closest("button");
      if (!b) return;
      const a = b.dataset.a;
      if (b.classList.contains("voice")) {
        voice = voice === "clark" ? "baldree" : "clark";
        $(".voice").textContent = voice === "clark" ? "Clark" : "Baldree";
        return send({ action: "voice", value: voice });
      }
      if (a === "slower" || a === "faster") {
        rate = Math.round((rate + (a === "faster" ? 0.25 : -0.25)) * 100) / 100;
        rate = Math.min(4, Math.max(0.5, rate));
        $(".rate").textContent = rate + "×";
        return send({ action: "rate", value: rate });
      }
      send({ action: a });
    });
    document.documentElement.appendChild(host);
    // drag from anywhere on the pill (buttons included) once the pointer moves a few px
    const pill = $(".p");
    pill.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const b = host.getBoundingClientRect();
      const x0 = e.clientX, y0 = e.clientY;
      const dx = x0 - b.left, dy = y0 - b.top;
      let moving = false;
      dragged = false;
      const move = (ev) => {
        if (!moving) {
          if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
          moving = dragged = true;
          pill.style.cursor = "grabbing";
        }
        host.style.left = Math.min(window.innerWidth - b.width, Math.max(0, ev.clientX - dx)) + "px";
        host.style.top = Math.min(window.innerHeight - b.height, Math.max(0, ev.clientY - dy)) + "px";
        host.style.right = host.style.bottom = "auto";
      };
      // window-level so a fast first move that leaves the pill still drags
      const up = () => {
        pill.style.cursor = "";
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", up, true);
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", up, true);
      e.preventDefault(); // no text selection / native drag while moving
    });
    ui = {
      set(o) {
        if (o.rate != null) { rate = o.rate; $(".rate").textContent = rate + "×"; }
        if (o.voice) { voice = o.voice; $(".voice").textContent = voice === "clark" ? "Clark" : "Baldree"; }
        if (o.playing != null) $(".pp").textContent = o.playing ? "⏸" : "▶";
        if (o.status != null) { const st = $(".st"); st.textContent = o.status; st.className = o.error ? "st err" : "st"; st.title = o.status; }
      },
      remove() { host.remove(); ui = null; },
    };
    return ui;
  }

  function send(m) {
    if (!alive()) return teardown();
    try { return chrome.runtime.sendMessage({ type: "tts-control", ...m }).catch(() => {}); }
    catch { teardown(); }
  }

  function finish() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    clearHL();
    state = null;
    doc = null;
    sessionId = null;
    if (ui) ui.remove();
  }

  // ---- messages ---------------------------------------------------------------------------

  // ---- page index: built eagerly on idle, synthesis stays lazy (offscreen fetches 3 ahead) ----

  let pageIdx = null, pageDirty = true, idxTimer = 0;
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 50));

  function indexPage() {
    if (!document.body) return;
    const r = document.createRange();
    r.selectNodeContents(document.body);
    const { full, pieces } = collect(r, true);
    pageIdx = full.trim() && pieces.length ? buildDoc(full, pieces) : null;
    if (pageIdx) {
      // group sentences into blocks (paragraph / heading / list item ...)
      const blocks = [];
      const nodeIdx = new Map(pieces.map((p, i) => [p.math || p.node, i])); // formulas keyed by element
      let pi = 0;
      pageIdx.segs.forEach((s, i) => {
        while (pi + 1 < pieces.length && pieces[pi].end <= s.start) pi++;
        const el = pieces[pi].block;
        const last = blocks[blocks.length - 1];
        if (last && last.el === el) { last.last = i; last.end = s.end; }
        else blocks.push({ el, first: i, last: i, start: s.start, end: s.end });
        s.block = blocks.length - 1;
      });
      pageIdx.blocks = blocks;
      pageIdx.nodeIdx = nodeIdx;
    }
    pageDirty = false;
    if (previewOn) paintIndexed();
  }
  function scheduleIndex() {
    pageDirty = true;
    clearTimeout(idxTimer);
    idxTimer = setTimeout(() => idle(indexPage, { timeout: 3000 }), 1000);
  }
  let pageObserver = null;
  if (document.body) {
    scheduleIndex();
    pageObserver = new MutationObserver(scheduleIndex);
    pageObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      const c = document.caretPositionFromPoint(x, y);
      return c ? [c.offsetNode, c.offset] : null;
    }
    const r = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
    return r ? [r.startContainer, r.startOffset] : null;
  }

  // index of first piece at/after (node, offset) in document order
  function pieceAt(pieces, node, offset) {
    let lo = 0, hi = pieces.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1, pn = pieces[mid].node;
      const after = pn === node ? false : !!(node.compareDocumentPosition(pn) & Node.DOCUMENT_POSITION_PRECEDING);
      if (after) lo = mid + 1; else hi = mid;
    }
    const p = pieces[lo];
    if (!p) return -1;
    return p.node === node ? p.start + Math.max(0, Math.min(offset - p.nodeStart, p.end - p.start)) : p.start;
  }

  // block under a screen point, or -1 (only real indexed text counts, not nav/code/gaps)
  function blockAt(x, y) {
    if (pageDirty || !pageIdx) indexPage();
    if (!pageIdx) return -1;
    const c = caretAt(x, y);
    if (!c) return -1;
    let [node, off] = c;
    if (node.nodeType !== 3) { node = node.childNodes[off] || node; off = 0; }
    const me = mathOf(node.nodeType === 1 ? node : node.parentElement);
    const pi = pageIdx.nodeIdx.get(me || node);
    if (pi === undefined) return -1;
    // the caret snaps to the nearest text even in margins: require the point to be on the block
    const p = pageIdx.pieces[pi];
    const r = p.block.getBoundingClientRect();
    if (x < r.left - 4 || x > r.right + 4 || y < r.top - 4 || y > r.bottom + 4) return -1;
    const pos = p.math ? p.start : p.start + Math.max(0, Math.min(off - p.nodeStart, p.end - p.start));
    let lo = 0, hi = pageIdx.segs.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (pageIdx.segs[m].end < pos) lo = m + 1; else hi = m; }
    return pageIdx.segs[lo] ? pageIdx.segs[lo].block : -1;
  }

  async function readBlock(b, y) {
    const blk = pageIdx.blocks[b];
    await startDoc({ ...pageIdx, segs: pageIdx.segs.slice(blk.first) }, { side: true, y });
    return true;
  }

  async function readFrom(x, y) {
    const b = blockAt(x, y);
    return b < 0 ? false : readBlock(b, y);
  }

  // ---- Alt preview: hold Alt to see what's indexed + which block a click would start at ----

  let previewOn = false, altTimer = 0, hoverBlock = -1, mouse = [0, 0], hoverRaf = 0;

  function paintIndexed() {
    if (!hasHL || !pageIdx) return;
    const rs = [];
    for (const b of pageIdx.blocks) { const r = makeRangeIn(pageIdx, b.start, b.end); if (r) rs.push(r); }
    CSS.highlights.set("tts-indexed", new Highlight(...rs));
  }
  function makeRangeIn(d, start, end) {
    const saved = doc; doc = d;
    try { return makeRange(start, end); } finally { doc = saved; }
  }
  function paintHover() {
    hoverRaf = 0;
    if (!previewOn || !hasHL) return;
    const b = blockAt(mouse[0], mouse[1]);
    if (b === hoverBlock) return;
    hoverBlock = b;
    document.documentElement.style.cursor = b >= 0 ? "pointer" : "";
    if (b < 0) { CSS.highlights.delete("tts-preview"); return; }
    const blk = pageIdx.blocks[b];
    const r = makeRangeIn(pageIdx, blk.start, blk.end);
    if (r) CSS.highlights.set("tts-preview", new Highlight(r));
  }
  function showPreview() {
    if (previewOn || !document.body) return;
    previewOn = true;
    if (pageDirty || !pageIdx) indexPage();
    paintIndexed();
    hoverBlock = -2;
    paintHover();
  }
  function hidePreview(force) {
    clearTimeout(altTimer);
    if (!previewOn || (pickMode && force !== true)) return; // pick mode stays up until Esc / pick
    if (pickMode) endPick();
    previewOn = false;
    hoverBlock = -1;
    document.documentElement.style.cursor = "";
    if (hasHL) { CSS.highlights.delete("tts-indexed"); CSS.highlights.delete("tts-preview"); }
  }

  // ---- pick mode: same preview, but it stays on and a plain click starts reading ----------

  // sticky = opened by tapping Alt: clicking a block reads from there and the mode stays up,
  // so you can jump around; tap Alt again (or Esc / ✕) to close.
  let pickMode = false, pickSticky = false, banner = null;
  function startPick(sticky = false) {
    if (!document.body) return;
    if (pickMode && pickSticky !== sticky) endPick(); // rebuild banner with the right text
    pickMode = true;
    pickSticky = sticky;
    previewOn = false; // force a fresh paint
    showPreview();
    if (!banner) {
      banner = document.createElement("div");
      banner.dataset.ttsPlayer = "";
      banner.style.cssText = "all:initial;position:fixed;z-index:2147483647;top:14px;left:50%;transform:translateX(-50%);";
      const sh = banner.attachShadow({ mode: "open" });
      sh.innerHTML = `<style>
          .b{font:13px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;display:flex;align-items:center;gap:10px;
             background:#16161a;color:#f2f2f2;border-radius:999px;padding:7px 8px 7px 14px;box-shadow:0 6px 24px #0006}
          i{font-style:normal;color:#7fb2ff;font-weight:600}
          button{all:unset;cursor:pointer;width:24px;height:24px;border-radius:999px;display:grid;place-items:center}
          button:hover{background:#ffffff1c}
        </style>
        <div class="b"><span><i>Click a highlighted block</i> to read from there · ${sticky ? "Alt or Esc to close" : "Esc to cancel"}</span>
          <button title="Cancel (Esc)">✕</button></div>`;
      sh.querySelector("button").addEventListener("click", () => hidePreview(true));
      document.documentElement.appendChild(banner);
    }
    if (pageIdx && !pageIdx.blocks.length) banner.shadowRoot.querySelector("span").textContent = "Nothing readable found on this page";
  }
  function endPick() {
    pickMode = pickSticky = false;
    if (banner) { banner.remove(); banner = null; }
  }

  document.addEventListener("pointermove", (e) => {
    mouse = [e.clientX, e.clientY];
    if (previewOn && !hoverRaf) hoverRaf = requestAnimationFrame(paintHover);
  }, sig);
  // the block under a still mouse changes as the page scrolls
  window.addEventListener("scroll", () => {
    if (previewOn && !hoverRaf) hoverRaf = requestAnimationFrame(paintHover);
  }, sig);
  // Alt: hold to preview (Alt+click reads); a quick tap on its own toggles sticky pick mode
  // (popup setting "Tap Alt to toggle", on by default).
  const ALT_TAP_MS = 400;
  let altToggle = true, altAt = 0, altClean = false;
  try {
    chrome.storage.sync.get({ altToggle: true }, (s) => { if (s) altToggle = s.altToggle; });
    chrome.storage.onChanged.addListener((c, area) => {
      if (area === "sync" && c.altToggle && alive()) altToggle = c.altToggle.newValue !== false;
    });
  } catch {}
  window.addEventListener("keydown", (e) => {
    if (!alive()) return teardown();
    const bareAlt = e.key === "Alt" && !e.ctrlKey && !e.shiftKey && !e.metaKey;
    if (bareAlt && !e.repeat) { altAt = Date.now(); altClean = true; }
    else if (e.key !== "Alt") altClean = false;
    if (pickMode) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hidePreview(true); }
      return; // scrolling keys etc. keep pick mode up
    }
    if (bareAlt && !e.repeat) {
      clearTimeout(altTimer);
      altTimer = setTimeout(showPreview, 150); // a quick Alt+Shift+R etc. never flashes it
    } else if (e.key !== "Alt") hidePreview();
  }, sig);
  window.addEventListener("keyup", (e) => {
    if (e.key !== "Alt") return;
    if (altToggle && altClean && Date.now() - altAt < ALT_TAP_MS) {
      altClean = false;
      e.preventDefault(); // keep Windows from moving focus to the browser menu
      if (pickMode) hidePreview(true); else startPick(true);
      return;
    }
    hidePreview();
  }, sig);
  document.addEventListener("pointerdown", () => (altClean = false), { capture: true, ...sig });
  window.addEventListener("blur", () => hidePreview(), sig);

  let lastCtx = null;
  document.addEventListener("contextmenu", (e) => (lastCtx = [e.clientX, e.clientY]), sig);
  // Click a block in pick mode (or Alt+click any time): read from the start of that block on
  document.addEventListener("click", (e) => {
    if (!(e.altKey || pickMode) || e.shiftKey || e.ctrlKey || e.metaKey || e.button !== 0) return;
    if (!alive()) return teardown(); // let the click through untouched
    const t = e.target;
    if (t && t.dataset && t.dataset.ttsPlayer !== undefined) return; // our banner / player
    if (t && t.closest && t.closest("input, textarea, select, [contenteditable=true]")) return;
    const b = blockAt(e.clientX, e.clientY);
    if (b < 0) return;
    e.preventDefault(); // a link click would otherwise navigate / Alt+click download
    e.stopPropagation();
    if (!pickSticky) hidePreview(true); // sticky mode stays up for the next jump
    readBlock(b, e.clientY);
  }, sig);

  async function start(text) {
    const d = grabSelection(text);
    let anchor = null;
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && !sel.isCollapsed) {
        const rects = sel.getRangeAt(0).getClientRects();
        anchor = rects.length ? rects[rects.length - 1] : sel.getRangeAt(0).getBoundingClientRect();
      } else if (document.activeElement) anchor = document.activeElement.getBoundingClientRect();
    } catch {}
    if (!d || !d.segs.length) return false;
    await startDoc(d, anchor);
    return true;
  }

  async function startDoc(d, anchor) {
    if (!alive()) return teardown();
    finish();
    doc = d;
    const p = player(anchor);
    p.set({ status: "…", playing: true });
    sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const r = await chrome.runtime.sendMessage({ type: "tts-play", id: sessionId, segments: d.segs.map((s) => s.text) });
    if (!r || r.error) { p.set({ status: r ? r.error : "no response", error: true }); return true; }
    p.set({ rate: r.rate, voice: r.voice });
    window.getSelection()?.removeAllRanges();
  }

  function onMessage(m, sender, reply) {
    if (m.type === "tts-start") {
      const sel = window.getSelection();
      const ae = document.activeElement;
      const hasSel = (sel && !sel.isCollapsed) ||
        (ae && "selectionStart" in ae && ae.selectionEnd > ae.selectionStart);
      // command (no text) goes to every frame; only the one with a selection answers
      if (!hasSel && !m.text) return false;
      if (!m.text && !document.hasFocus()) return false;
      start(m.text).then((ok) => reply({ ok }), (e) => { console.error("[tts]", e); reply({ ok: false, error: String(e) }); });
      return true;
    }
    if (m.type === "tts-pick") {
      startPick();
      reply({ ok: true });
      return;
    }
    if (m.type === "tts-start-here") {
      if (!lastCtx || !document.hasFocus()) return false;
      readFrom(lastCtx[0], lastCtx[1]).then((ok) => reply({ ok }), () => reply({ ok: false }));
      return true;
    }
    if (m.type !== "tts-event" || m.id !== sessionId) return;
    const p = ui || player();
    if (m.ev === "seg") {
      state = m;
      p.set({ playing: m.playing, status: `${m.index + 1}/${m.total}`, rate: m.rate, voice: m.voice });
      if (raf) cancelAnimationFrame(raf);
      tick();
    } else if (m.ev === "loading") {
      if (state) state.playing = false;
      p.set({ status: `${m.index + 1}/${m.total} …`, voice: m.voice, playing: !m.paused });
    } else if (m.ev === "error") {
      p.set({ status: m.message, error: true, playing: false });
    } else if (m.ev === "done" || m.ev === "stopped") {
      finish();
    }
  }
  chrome.runtime.onMessage.addListener(onMessage);

  function teardown() {
    if (life.signal.aborted) return;
    life.abort();
    if (pageObserver) pageObserver.disconnect();
    clearTimeout(idxTimer);
    hidePreview(true);
    finish();
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
  }
  document.addEventListener("tts-read-aloud-reset", teardown, { signal: life.signal });
})();
