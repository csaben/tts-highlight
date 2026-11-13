// Shared by content.js and background.js (importScripts). Splits text into TTS chunks.
// Returns [{start, end}] offsets into the input string. The first chunk is kept short so
// audio starts fast; later chunks are whole sentences (long ones split at commas).
(function (root) {
  const ABBREV = new Set([
    "mr", "mrs", "ms", "dr", "st", "vs", "jr", "sr", "prof", "inc", "ltd", "co", "etc",
    "e.g", "i.e", "fig", "no", "vol", "approx", "dept", "est", "u.s", "a.m", "p.m",
  ]);
  const CLOSERS = "\"'”’)]}»";
  const HAS_WORD = /[\p{L}\p{N}]/u;

  function sentences(s) {
    const out = [];
    let start = 0;
    const push = (a, b) => {
      while (a < b && /\s/.test(s[a])) a++;
      while (b > a && /\s/.test(s[b - 1])) b--;
      if (b > a && HAS_WORD.test(s.slice(a, b))) out.push({ start: a, end: b });
    };
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "\n") { push(start, i); start = i + 1; continue; }
      if (c !== "." && c !== "!" && c !== "?" && c !== "…") continue;
      let j = i + 1;
      while (j < s.length && ".!?…".includes(s[j])) j++;
      while (j < s.length && CLOSERS.includes(s[j])) j++;
      if (j < s.length && !/\s/.test(s[j])) continue; // 3.5, example.com
      if (c === ".") {
        const m = /([\p{L}.]+)$/u.exec(s.slice(Math.max(start, i - 12), i));
        const w = m ? m[1].toLowerCase() : "";
        if (ABBREV.has(w) || /^\p{Lu}$/u.test(m ? m[1] : "")) continue; // Dr. / J. Smith
      }
      push(start, j);
      start = j;
      i = j - 1;
    }
    push(start, s.length);
    return out;
  }

  function splitLong(s, seg, limit) {
    const out = [];
    let { start, end } = seg;
    while (end - start > limit) {
      const window = s.slice(start, start + limit);
      let cut = -1;
      const punct = /[,;:—–)](?=\s)/g;
      let m;
      while ((m = punct.exec(window))) if (m.index > 25) cut = m.index + 1;
      if (cut < 0) cut = window.lastIndexOf(" ");
      if (cut < 15) cut = limit;
      out.push({ start, end: start + cut });
      start += cut;
      while (start < end && /\s/.test(s[start])) start++;
    }
    if (end > start) out.push({ start, end });
    return out;
  }

  function ttsSegments(s, opts = {}) {
    const firstMax = opts.firstMax || 90;
    const maxLen = opts.maxLen || 260;
    const out = [];
    for (const sent of sentences(s)) {
      for (const p of splitLong(s, sent, out.length === 0 ? firstMax : maxLen)) {
        if (out.length === 0 && p.end - p.start > firstMax) {
          out.push(...splitLong(s, p, firstMax));
        } else if (HAS_WORD.test(s.slice(p.start, p.end))) {
          out.push(p);
        }
      }
    }
    return out;
  }

  function ttsClean(t) {
    return t.replace(/\s+/g, " ").trim();
  }

  // ---- pronunciation ----------------------------------------------------------------------
  // "ASI is" reads as "assie"; "A.S.I." reads as letters (checked with whisper on cradle).
  // Acronyms normally said as a word are left alone:
  const KEEP = new Set(["NASA", "NATO", "RAM", "ROM", "SCUBA", "LASER", "RADAR", "FIFA", "GIF",
    "JPEG", "PIN", "OK", "UNESCO", "COVID", "CAPTCHA", "ASAP", "SIM", "WIFI", "LAN", "WAN", "DOS",
    "YOLO", "FOMO", "NAND", "CUDA", "AIDS", "LOL", "ROI"]);

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // One rule per line: "word = say it like this". Lines starting with # are ignored.
  function ttsParseLex(src) {
    const rules = [];
    for (const line of String(src || "").split(/\r?\n/)) {
      const m = /^\s*([^=#][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || !m[1]) continue;
      rules.push({
        re: new RegExp("(?<![\\p{L}\\p{N}])" + esc(m[1]) + "(?![\\p{L}\\p{N}])", "giu"),
        say: m[2],
        key: m[1].toLowerCase(),
      });
    }
    return rules;
  }

  function ttsLex(text, rules = [], auto = true) {
    const own = new Set(rules.map((r) => r.key));
    for (const r of rules) text = text.replace(r.re, () => r.say);
    text = text.replace(/(?<!\.)\.\.(?!\.)/g, "."); // "A.S.A.P.." from a rule at sentence end
    if (!auto) return text;
    const letters = text.replace(/[^\p{L}]/gu, "");
    const caps = letters.replace(/[^\p{Lu}]/gu, "").length;
    if (letters.length > 12 && caps / letters.length > 0.6) return text; // SHOUTED TEXT
    return text.replace(/(?<![\p{L}\p{N}.])(\p{Lu}{2,5})(s?)(?![\p{L}\p{N}])(\.?)/gu, (all, ac, s) => {
      if (KEEP.has(ac) || own.has(ac.toLowerCase()) || own.has((ac + s).toLowerCase())) return all;
      return ac.split("").join(".") + "." + s; // trailing sentence "." is absorbed
    });
  }

  root.ttsParseLex = ttsParseLex;
  root.ttsLex = ttsLex;
  root.ttsSegments = ttsSegments;
  root.ttsClean = ttsClean;
})(typeof self !== "undefined" ? self : this);
