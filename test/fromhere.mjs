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
<p id=t>Third sentence starts here. Fourth one comes after.</p>
<pre>const skipped = true;</pre>
<p>Fifth sentence is the last one.</p>` }));
await page.goto("http://test.local/");
await page.waitForTimeout(2500); // let the idle index build
const fails = []; const check = (ok, m) => { console.log((ok ? "PASS " : "FAIL ") + m); if (!ok) fails.push(m); };
const b = await page.locator("#t").boundingBox();
const t0 = Date.now();
await page.keyboard.down("Alt"); await page.mouse.click(b.x + 20, b.y + b.height / 2); await page.keyboard.up("Alt");
await page.waitForFunction(() => CSS.highlights.has("tts-sentence"), null, { timeout: 15000 });
const first = await page.evaluate(() => [...CSS.highlights.get("tts-sentence")][0].toString());
check(first === "Third sentence starts here.", `alt+click starts at clicked sentence ("${first}", ${Date.now() - t0} ms)`);
const status = await page.locator("div.p .st").textContent();
check(/\/3/.test(status), `3 sentences queued after it, code + nav skipped (status "${status}")`);
const pb = await page.locator("div.p").boundingBox();
const vb = await page.locator("div.p button.voice").boundingBox();
await page.mouse.move(vb.x + 5, vb.y + 5); await page.mouse.down();
await page.mouse.move(200, 600, { steps: 10 }); await page.mouse.up();
const nb = await page.locator("div.p").boundingBox();
check(Math.abs(nb.y - pb.y) > 100, `drag starting on a button moves player (${Math.round(pb.y)} -> ${Math.round(nb.y)})`);
check((await page.locator("div.p button.voice").textContent()) === "Clark", "drag did not trigger the button");
await page.locator('div.p button[data-a="stop"]').click();
await ctx.close(); process.exit(fails.length ? 1 : 0);
