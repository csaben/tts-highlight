// MathML -> spoken English. KaTeX, MathJax (assistive MML) and native <math> all carry a
// MathML tree, so reading that instead of the visual spans gives "2 to the minus 10" rather
// than "2 − 10", and each formula is read once instead of twice (visual + hidden copy).
(function (root) {
  const LETTER = {
    a: "ay", b: "bee", c: "see", d: "dee", e: "ee", f: "eff", g: "gee", h: "aitch", i: "eye",
    j: "jay", k: "kay", l: "el", m: "em", n: "en", o: "oh", p: "pee", q: "cue", r: "ar",
    s: "ess", t: "tee", u: "you", v: "vee", w: "double you", x: "ex", y: "why", z: "zee",
  };
  const GREEK = {
    "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "ε": "epsilon", "ϵ": "epsilon",
    "ζ": "zeta", "η": "eta", "θ": "theta", "ι": "iota", "κ": "kappa", "λ": "lambda", "μ": "mu",
    "ν": "nu", "ξ": "xi", "π": "pi", "ρ": "rho", "σ": "sigma", "τ": "tau", "υ": "upsilon",
    "φ": "phi", "ϕ": "phi", "χ": "chi", "ψ": "psi", "ω": "omega", "Γ": "gamma", "Δ": "delta",
    "Θ": "theta", "Λ": "lambda", "Ξ": "xi", "Π": "pi", "Σ": "sigma", "Φ": "phi", "Ψ": "psi",
    "Ω": "omega", "∇": "nabla", "∂": "partial", "ℓ": "ell", "∞": "infinity",
  };
  const OPS = {
    "=": "equals", "+": "plus", "−": "minus", "-": "minus", "×": "times", "⋅": "times",
    "·": "times", "∗": "times", "*": "times", "÷": "divided by", "/": "over",
    "±": "plus or minus", "∓": "minus or plus", "<": "is less than", ">": "is greater than",
    "≤": "is less than or equal to", "≥": "is greater than or equal to", "≈": "is approximately",
    "≠": "is not equal to", "≡": "is equivalent to", "∼": "is distributed as", "∝": "is proportional to",
    "→": "goes to", "↦": "maps to", "⇒": "implies", "⟹": "implies", "⇔": "if and only if",
    "∈": "in", "∉": "not in", "⊂": "subset of", "⊆": "subset of", "∪": "union", "∩": "intersect",
    "∑": "the sum of", "∏": "the product of", "∫": "the integral of", "…": "and so on",
    "⋯": "and so on", "…": "and so on", "!": "factorial", "′": "prime", "∘": "composed with",
    "⊙": "elementwise times", "⊗": "tensor", "∀": "for all", "∃": "there exists", "¬": "not",
    "∧": "and", "∨": "or", "%": "percent", ":": ":", ";": ";", "∣": "given", "mod": "mod",
  };
  const ACCENT = { "^": "hat", "ˆ": "hat", "¯": "bar", "‾": "bar", "~": "tilde", "˜": "tilde",
    "˙": "dot", "¨": "double dot", "→": "vector", "⃗": "vector" };
  const OPEN = new Set(["(", "[", "{", "⟨"]), CLOSE = new Set([")", "]", "}", "⟩"]);
  const ORD = { 2: "square", 3: "cube" };

  const tag = (n) => (n.localName || "").toLowerCase();
  const kids = (n) => [...n.children].filter((c) => !["annotation", "annotation-xml"].includes(tag(c)));
  const txt = (n) => (n.textContent || "").replace(/[⁡-⁤​]/g, "").trim();

  function ident(t, n) {
    // plain letters read fine (checked with whisper); only "a" would be read as the article
    if (t === "a" || t === "A") return LETTER.a;
    if (OPS[t] && !/[a-z]/i.test(t)) return OPS[t]; // KaTeX puts "/" in an <mi>
    if (CLOSE.has(t) || OPEN.has(t) || BAR.has(t) || NORM.has(t)) return "";
    if (GREEK[t]) return GREEK[t];
    if (t === "𝔼") return "E";
    return t;
  }

  // a "simple" node reads fine after "to the" / "over" without a pause
  function simple(n) {
    const k = tag(n);
    if (k === "mi" || k === "mn") return true;
    if (k === "mrow") {
      const c = kids(n);
      return c.length === 1 ? simple(c[0]) : c.length === 2 && tag(c[0]) === "mo" && /[−-]/.test(txt(c[0])) && simple(c[1]);
    }
    return false;
  }
  const isLabel = (n) => tag(n) === "mtext" || (tag(n) === "mi" && txt(n).length > 1 && !/^(sin|cos|tan|log|ln|exp|max|min)$/.test(txt(n)))
    || (tag(n) === "mrow" && kids(n).length === 1 && isLabel(kids(n)[0]));

  function supPart(sup, base) {
    const t = txt(sup);
    if (t === "T" || t === "⊤") return " transpose";
    if (t === "′" || t === "'") return " prime";
    if (t === "″") return " double prime";
    if (t === "∗" || t === "*") return " star";
    if (t === "2") return " squared";
    if (t === "3") return " cubed";
    if ((t === "−1" || t === "-1") && tag(base) === "mi" && /^[A-Z]$/.test(txt(base))) return " inverse";
    if (isLabel(sup)) return " " + speak(sup, { sup: true });
    const s = speak(sup, { sup: true });
    return simple(sup) ? " to the " + s : " to the power of " + s + ",";
  }

  function speak(n, ctx = {}) {
    const k = tag(n);
    const c = kids(n);
    switch (k) {
      case "math": case "mrow": case "semantics": case "mstyle": case "mpadded": case "menclose":
      case "mfenced": case "mtd": case "mlabeledtr":
        return seq(k === "semantics" ? c.slice(0, 1) : c, ctx);
      case "mphantom": return "";
      case "mspace": return " ";
      case "mi": return ident(txt(n), n);
      case "mn": return txt(n);
      case "mtext": return txt(n);
      case "ms": return txt(n);
      case "mo": {
        const t = txt(n);
        if (CLOSE.has(t)) return ","; // e.g. msup(")", T) from (w^T)^T
        if (OPEN.has(t) || BAR.has(t) || NORM.has(t)) return ""; // msub("‖", 2) from ‖w‖_2
        return OPS[t] ?? t;
      }
      case "msup":
        if (bigOp(c[0])) return bigOpSpeech(c[0], null, c[1]);
        return speak(c[0], ctx) + supPart(c[1], c[0]);
      case "msub":
        if (bigOp(c[0])) return bigOpSpeech(c[0], c[1], null);
        if (/^(log|lg|ln)$/.test(txt(c[0]))) return txt(c[0]) + " base " + speak(c[1], { sup: true });
        return speak(c[0], ctx) + " sub " + speak(c[1], { sup: true });
      case "msubsup": {
        if (bigOp(c[0])) return bigOpSpeech(c[0], c[1], c[2]);
        if (isLabel(c[2])) return speak(c[0], ctx) + " " + speak(c[2], { sup: true }) + " sub " + speak(c[1], { sup: true });
        return speak(c[0], ctx) + " sub " + speak(c[1], { sup: true }) + supPart(c[2], c[0]);
      }
      case "mfrac": {
        const a = speak(c[0], ctx), b = speak(c[1], ctx);
        return simple(c[0]) && simple(c[1]) ? `${a} over ${b}` : `the fraction ${a}, over ${b},`;
      }
      case "msqrt": return "the square root of " + seq(c, ctx) + (c.length > 1 || !simple(c[0]) ? "," : "");
      case "mroot": {
        const deg = txt(c[1]);
        return `the ${ORD[deg] || deg + "th"} root of ` + speak(c[0], ctx);
      }
      case "mover": {
        const acc = ACCENT[txt(c[1])];
        return acc ? speak(c[0], ctx) + " " + acc : speak(c[0], ctx) + " over " + speak(c[1], ctx);
      }
      case "munder": case "munderover": {
        if (bigOp(c[0])) return bigOpSpeech(c[0], c[1], c[2]);
        return speak(c[0], ctx) + (c[1] ? " over " + speak(c[1], { sup: true }) : "");
      }
      case "mtable": return c.map((r) => speak(r, ctx)).join("; ");
      case "mtr": return c.map((d) => speak(d, ctx)).join(", ");
      default: return seq(c, ctx) || txt(n);
    }
  }

  // ∑ ∏ ∫ with limits: "the sum from i equals 1 to n of"
  const bigOp = (n) => n && /^(∑|∏|∫|∮|⋃|⋂)$/.test(txt(n));
  function bigOpSpeech(op, lo, hi) {
    const name = OPS[txt(op)] ? OPS[txt(op)].replace(/ of$/, "") : txt(op);
    return name + (lo ? " from " + speak(lo, { sup: true }) : "") + (hi ? " to " + speak(hi, { sup: true }) : "") + " of";
  }
  const INVISIBLE = /^[⁡-⁤​]*$/; // function application, invisible times, ...
  const BAR = new Set(["|", "∣"]), NORM = new Set(["‖", "∥"]);

  // reads a row of siblings, handling patterns that span them
  function seq(nodes, ctx) {
    const out = [];
    const silent = []; // stack of booleans: is the matching closer silent?
    let prevOperand = false;
    let bars = 0, norms = 0; // open |...| and ‖...‖
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      // KaTeX writes "/" as <mi>; treat single-symbol <mi> operators like <mo>
      const mt = txt(n);
      const k = tag(n) === "mi" && (OPS[mt] || BAR.has(mt) || NORM.has(mt)) && !/[a-z0-9]/i.test(mt) ? "mo" : tag(n);
      const t = k === "mo" ? txt(n) : "";
      if (k === "mo") {
        if (OPEN.has(t)) {
          const prev = nodes[i - 1];
          const pt = prev ? txt(prev) : "";
          if (prev && tag(prev) === "mi" && (pt === "E" || pt === "𝔼")) {
            out.pop();
            out.push("the expected value of");
          } else if (t === "(" && prev && ["mi", "msub", "msup", "mover"].includes(tag(prev)) && !OPS[pt]) {
            out.push("of"); // f(x), L(θ), p(y | x)
          } else if (t === "{") {
            out.push("the set");
          } else if (interval(nodes, i)) {
            const j = matchClose(nodes, i);
            const comma = nodes.findIndex((m, x) => x > i && x < j && tag(m) === "mo" && txt(m) === ",");
            out.push(seq(nodes.slice(i + 1, comma), ctx) + " through " + seq(nodes.slice(comma + 1, j), ctx));
            i = j;
            prevOperand = true;
            continue;
          }
          // "(" right after an operator groups an expression: "times the quantity ..., "
          const group = t === "(" && i > 0 && !prevOperand;
          if (group) out.push("the quantity");
          silent.push(!group);
          prevOperand = false;
          continue;
        }
        if (CLOSE.has(t)) { if (silent.pop() === false) out.push(","); prevOperand = true; continue; }
        if (INVISIBLE.test(t)) continue;
        if (BAR.has(t) || NORM.has(t)) {
          // |x| / ‖x‖: opening bar names it, closing bar is silent; a lone ∣ between
          // operands (p(y ∣ x)) is "given"
          const norm = NORM.has(t);
          if (!prevOperand) { out.push(norm ? "the norm of" : "the absolute value of"); norm ? norms++ : bars++; }
          else if (norm ? norms : bars) { norm ? norms-- : bars--; prevOperand = true; }
          else { out.push(norm ? "parallel to" : "given"); prevOperand = false; }
          continue;
        }
        if (t === "/" && nodes[i + 1] && txt(nodes[i + 1]) === "/") {
          out.push("floor divided by"); i++; prevOperand = false; continue;
        }
        if ((t === "−" || t === "-") && !prevOperand) { out.push(ctx.sup ? "minus" : "negative"); continue; }
        if (t === ",") { out.push(","); prevOperand = false; continue; }
        if (t === "!" || t === "′") { out.push(OPS[t]); prevOperand = true; continue; }
        out.push(OPS[t] ?? t);
        prevOperand = false;
        continue;
      }
      out.push(speak(n, ctx));
      prevOperand = true;
    }
    return out.join(" ");
  }

  function matchClose(nodes, i) {
    let d = 0;
    for (let j = i; j < nodes.length; j++) {
      if (tag(nodes[j]) !== "mo") continue;
      const t = txt(nodes[j]);
      if (OPEN.has(t)) d++;
      else if (CLOSE.has(t) && --d === 0) return j;
    }
    return -1;
  }

  // [a, b] or (a, b] etc. with exactly one top-level comma, not a function call like f(a, b)
  function interval(nodes, i) {
    const t = txt(nodes[i]);
    if (t !== "[" && t !== "(") return false;
    const prev = nodes[i - 1];
    if (prev && (tag(prev) === "mi" || tag(prev) === "msub" || tag(prev) === "msup")) return false;
    const j = matchClose(nodes, i);
    if (j < 0) return false;
    let commas = 0, d = 0;
    for (let x = i + 1; x < j; x++) {
      const m = nodes[x];
      if (tag(m) !== "mo") continue;
      const mt = txt(m);
      if (OPEN.has(mt)) d++;
      else if (CLOSE.has(mt)) d--;
      else if (mt === "," && d === 0) commas++;
    }
    return commas === 1;
  }

  function mathSpeech(mathEl) {
    return speak(mathEl)
      .replace(/\s+/g, " ")
      .replace(/\s+([,;])/g, "$1")
      .replace(/,+/g, ",")
      .replace(/,\s*$/, "")
      .trim();
  }

  root.ttsMathSpeech = mathSpeech;
})(typeof self !== "undefined" ? self : this);
