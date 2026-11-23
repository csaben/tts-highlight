// Audio cache: once a sentence has been synthesized, starting again from another block (or
// re-reading) plays it from IndexedDB with no server round-trip.
import { chromium } from "playwright";
import path from "node:path"; import os from "node:os"; import fs from "node:fs";
const ext = path.resolve(import.meta.dirname, "../extension");
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "tts-c-")), {
  headless: false, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--headless=new", "--autoplay-policy=no-user-gesture-required"] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
for (let k = 0; k < 100 && !(await sw.evaluate(() => !!chrome.storage)); k++) await new Promise((r) => setTimeout(r, 100));
await sw.evaluate(() => chrome.storage.sync.set({ voice: "clark", rate: 2 }));
const fails = []; const check = (ok, m) => { console.log((ok ? "PASS " : "FAIL ") + m); if (!ok) fails.push(m); };
const page = await ctx.newPage();
await page.setViewportSize({ width: 1000, height: 800 });
const n = Date.now() % 100000; // fresh text each run so the server really synthesizes the first pass
await page.route("http://test.local/**", (r) => r.fulfill({ contentType: "text/html", body: `
<p id=b1 style="width:500px">Run ${n} begins with this opening line. It has a second sentence too.</p>
<p id=b2 style="width:500px">The next section starts right here. Then it keeps on going.</p>
<p id=b3 style="width:500px">A final section closes the page.</p>` }));
await page.goto("http://test.local/");
await page.waitForTimeout(2500);
const cache = (op) => sw.evaluate((op) => toOffscreen({ type: "cache-" + op }), op);
const status = () => page.locator("div.p .st").textContent().catch(() => "");
const sentence = () => page.evaluate(() => { const h = CSS.highlights.get("tts-sentence"); return h ? [...h][0].toString() : ""; });
async function altClick(id) {
  const b = await page.locator("#" + id).boundingBox();
  await page.mouse.move(b.x + 30, b.y + b.height / 2);
  await page.keyboard.down("Alt"); await page.waitForTimeout(300);
  const t0 = Date.now();
  await page.mouse.click(b.x + 30, b.y + b.height / 2);
  await page.keyboard.up("Alt");
  return t0;
}
async function untilPlaying(text, t0) {
  await page.waitForFunction((t) => { const h = CSS.highlights.get("tts-sentence"); return h && [...h][0].toString().startsWith(t); }, text, { timeout: 20000 });
  return Date.now() - t0;
}
const before = await cache("stats");
let t0 = await altClick("b1");
const cold = await untilPlaying(`Run ${n}`, t0);
// lookahead synthesizes b1 sentence 2 and b2 (at 2x playback outruns synthesis, so poll)
for (let k = 0; k < 40 && (await cache("stats")).entries - before.entries < 3; k++) await page.waitForTimeout(500);
const mid = await cache("stats");
check(mid.entries - before.entries >= 3, `first pass stores sentences (${before.entries} -> ${mid.entries})`);
t0 = await altClick("b2");
const jump = await untilPlaying("The next section", t0);
const s1 = await cache("stats");
check(s1.hits >= 1, `alt+click on the next section plays from cache (hits ${s1.hits}, ${jump} ms vs ${cold} ms cold)`);
await page.locator('div.p button[data-a="stop"]').click();
await page.waitForTimeout(500);
t0 = await altClick("b1");
const warm = await untilPlaying(`Run ${n}`, t0);
check(warm < cold && warm < 600, `re-reading starts from cache (${warm} ms vs ${cold} ms cold)`);
await page.locator('div.p button[data-a="stop"]').click();
await sw.evaluate(() => chrome.storage.sync.set({ cache: false }));
await page.waitForTimeout(300);
t0 = await altClick("b3");
await untilPlaying("A final", t0);
const off = await cache("stats");
check(off.hits === 0, `with the setting off nothing is read from cache (hits ${off.hits})`);
await page.locator('div.p button[data-a="stop"]').click();
await sw.evaluate(() => chrome.storage.sync.set({ cache: true }));
await ctx.close(); process.exit(fails.length ? 1 : 0);
