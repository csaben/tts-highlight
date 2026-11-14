// MathML -> speech: every formula in the TM 4-bit post (saved fixture) plus common notation
// rendered through KaTeX. Prints each and fails on any that still contain raw symbols.
import { chromium } from "playwright"; import fs from "node:fs"; import path from "node:path";
const dir = import.meta.dirname;
const b = await chromium.launch(); const p = await b.newPage();
await p.setContent(fs.readFileSync(path.join(dir, "fixtures/tm-4bit.html"), "utf8"));
await p.addScriptTag({ path: path.join(dir, "../extension/math.js") });
await p.addScriptTag({ url: "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js" });
const extra = String.raw`\frac{a}{b} ; \frac{x+1}{2} ; \sqrt{x} ; \sqrt[3]{x} ; \sum_{i=1}^{n} x_i ; x^2 ; e^{-x^2} ;
  |x| ; \hat{\theta} ; A^{-1} ; \alpha \le 0.5 ; f(x, y) ; (a, b] ; \|w\|_2 ; \nabla L(\theta) ;
  p(y \mid x) ; x \in \mathbb{R}^d ; \mathbb{E}[X] ; \log_2 n ; \max_i x_i`.split(";").map((s) => s.trim());
const r = await p.evaluate((extra) => {
  const page = [...document.querySelectorAll(".katex")].map((k) => [k.querySelector("annotation")?.textContent, ttsMathSpeech(k.querySelector("math"))]);
  const more = extra.map((t) => {
    const d = document.createElement("div");
    d.innerHTML = katex.renderToString(t, { output: "mathml" });
    return [t, ttsMathSpeech(d.querySelector("math"))];
  });
  return [...page, ...more];
}, extra);
let bad = 0;
r.forEach(([t, s], i) => {
  const raw = /[\/^_{}()\[\]\\=+−×⋅÷±|‖∥∣⁡]/.test(s);
  if (raw) bad++;
  console.log((raw ? "RAW " : "    ") + String(i + 1).padStart(2), t.padEnd(56), "=>", s);
});
await b.close();
process.exit(bad ? 1 : 0);
