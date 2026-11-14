// On the saved TM 4-bit post: picking the paragraph with 2^{-10} sends "2 to the minus 10"
// (once, not doubled with the visual copy) to the voice server, and highlights the formula.
import { chromium } from "playwright";
import path from "node:path"; import os from "node:os"; import fs from "node:fs";
const ext = path.resolve(import.meta.dirname, "../extension");
const html = fs.readFileSync(path.join(import.meta.dirname, "fixtures/tm-4bit.html"), "utf8")
  .replace("</head>", `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css"><style>body{max-width:760px;margin:auto;font:18px/1.6 serif}</style></head>`);
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "tts-m-")), {
  headless: false, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--headless=new", "--autoplay-policy=no-user-gesture-required"] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
for (let k = 0; k < 100 && !(await sw.evaluate(() => !!chrome.storage)); k++) await new Promise((r) => setTimeout(r, 100));
await sw.evaluate(() => chrome.storage.sync.set({ voice: "clark", rate: 2 }));
const fails = []; const check = (ok, m) => { console.log((ok ? "PASS " : "FAIL ") + m); if (!ok) fails.push(m); };
const page = await ctx.newPage();
await page.setViewportSize({ width: 1200, height: 900 });
await page.route("http://test.local/**", (r) => r.fulfill({ contentType: "text/html", body: html }));
await page.goto("http://test.local/");
await page.waitForTimeout(2500);
// screen point on the words "as low as" just before the formula
const pt = await page.evaluate(() => {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const i = n.data.indexOf("as low as");
    if (i < 0) continue;
    n.parentElement.scrollIntoView({ block: "center" });
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 6);
    const b = r.getBoundingClientRect();
    return [b.x + b.width / 2, b.y + b.height / 2];
  }
});
const kb = { x: pt[0] + 40, y: pt[1], height: 0 };
await sw.evaluate(async () => { const [t] = await chrome.tabs.query({ url: "http://test.local/*" }); await pickInTab(t.id); });
await page.waitForTimeout(300);
await page.mouse.move(kb.x - 40, kb.y + kb.height / 2);
await page.waitForTimeout(200);
const prev = await page.evaluate(() => [...(CSS.highlights.get("tts-preview") || [])].map((r) => r.toString())[0] || "");
check(/as low as/.test(prev), `hover over the formula's paragraph previews it`);
await page.mouse.click(kb.x - 40, kb.y + kb.height / 2);
let spoken = [];
for (let t = 0; t < 40 && !spoken.some((x) => /as low as/.test(x)); t++) {
  await page.waitForTimeout(250);
  spoken = (await sw.evaluate(() => chrome.storage.session.get("lastSpoken"))).lastSpoken || [];
}
const s = spoken.find((x) => /as low as/.test(x)) || "";
console.log("sent:", JSON.stringify(s));
check(/as low as 2 to the minus 10\b/.test(s), "formula is spoken as \"2 to the minus 10\"");
check(!/2\s*−\s*10|2−10|−/.test(s), "no raw minus sign / doubled visual copy");
// wait until the formula's sentence is highlighted and check the range covers the formula
let covers = false;
for (let t = 0; t < 80 && !covers; t++) {
  covers = await page.evaluate(() => {
    const h = CSS.highlights.get("tts-sentence"); if (!h) return false;
    const r = [...h][0]; const k = [...document.querySelectorAll(".katex")].find((e) => e.querySelector("annotation")?.textContent === "2^{-10}");
    return r.intersectsNode(k) && /as low as/.test(r.toString());
  });
  if (!covers) await page.waitForTimeout(250);
}
check(covers, "sentence highlight covers the formula on the page");
await page.locator('div.p button[data-a="stop"]').click().catch(() => {});
await ctx.close(); process.exit(fails.length ? 1 : 0);
