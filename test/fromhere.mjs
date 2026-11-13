// Alt+click mid-page reads from that sentence on (page index), skipping nav/code; drag from a button.
import { chromium } from "playwright";
import path from "node:path"; import os from "node:os"; import fs from "node:fs";
const ext = path.resolve(import.meta.dirname, "../extension");
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "tts-h-")), {
  headless: false, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--headless=new", "--autoplay-policy=no-user-gesture-required"] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
for (let k = 0; k < 100 && !(await sw.evaluate(() => !!chrome.storage)); k++) await new Promise((r) => setTimeout(r, 100));
await sw.evaluate(() => chrome.storage.sync.set({ voice: "clark", rate: 2 }));
const page = await ctx.newPage();
await page.setViewportSize({ width: 1000, height: 700 });
await page.route("http://test.local/**", (r) => r.fulfill({ contentType: "text/html", body: `
<nav>Home About Contact</nav>
<p>First sentence of the article. Second sentence follows it.</p>
<p id=t style="width:500px">Third sentence starts here. Fourth one comes after.</p>
<pre>const skipped = true;</pre>
<p>Fifth sentence is the last one.</p>` }));
await page.goto("http://test.local/");
await page.waitForTimeout(2500); // let the idle index build
const fails = []; const check = (ok, m) => { console.log((ok ? "PASS " : "FAIL ") + m); if (!ok) fails.push(m); };
const b = await page.locator("#t").boundingBox();
const hlTexts = (n) => page.evaluate((n) => { const h = CSS.highlights.get(n); return h ? [...h].map((r) => r.toString()) : []; }, n);
await page.mouse.move(b.x + b.width - 30, b.y + b.height / 2); // over "Fourth one comes after."
await page.keyboard.down("Alt");
await page.waitForTimeout(400);
const idx = await hlTexts("tts-indexed");
check(idx.length === 3 && !idx.some((t) => /Home|skipped/.test(t)), `holding Alt shows 3 indexed blocks, no nav/code (${JSON.stringify(idx)})`);
const prev = await hlTexts("tts-preview");
check(prev[0] === "Third sentence starts here. Fourth one comes after.", `hover previews the whole block ("${prev[0]}")`);
await page.mouse.move(b.x + b.width + 200, b.y + b.height / 2);
await page.waitForTimeout(200);
check((await hlTexts("tts-preview")).length === 0, "no preview when hovering empty margin");
await page.mouse.move(b.x + b.width - 30, b.y + b.height / 2);
await page.waitForTimeout(200);
const t0 = Date.now();
await page.mouse.click(b.x + b.width - 30, b.y + b.height / 2);
await page.keyboard.up("Alt");
check((await hlTexts("tts-indexed")).length === 0, "releasing Alt hides the preview");
await page.waitForFunction(() => CSS.highlights.has("tts-sentence"), null, { timeout: 15000 });
const first = await page.evaluate(() => [...CSS.highlights.get("tts-sentence")][0].toString());
check(first === "Third sentence starts here." /* block start, though we clicked sentence 2 */, `alt+click starts at clicked sentence ("${first}", ${Date.now() - t0} ms)`);
const status = await page.locator("div.p .st").textContent();
check(/\/3/.test(status), `3 sentences queued after it, code + nav skipped (status "${status}")`);
const pb = await page.locator("div.p").boundingBox();
check(pb.x + pb.width > 1000 - 40 && Math.abs(pb.y - (b.y + b.height / 2)) < 60, `player parks at right edge, level with the click (x ${Math.round(pb.x)}..${Math.round(pb.x + pb.width)}, y ${Math.round(pb.y)})`);
const vb = await page.locator("div.p button.voice").boundingBox();
await page.mouse.move(vb.x + 5, vb.y + 5); await page.mouse.down();
await page.mouse.move(200, 600, { steps: 10 }); await page.mouse.up();
const nb = await page.locator("div.p").boundingBox();
check(Math.abs(nb.y - pb.y) > 100, `drag starting on a button moves player (${Math.round(pb.y)} -> ${Math.round(nb.y)})`);
check((await page.locator("div.p button.voice").textContent()) === "Clark", "drag did not trigger the button");
await page.locator('div.p button[data-a="stop"]').click();
await ctx.close(); process.exit(fails.length ? 1 : 0);
