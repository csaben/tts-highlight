// Editing an extension file makes the unpacked extension reload itself and re-inject into
// open tabs: the page keeps working without a refresh, with exactly one live content script.
import { chromium } from "playwright";
import path from "node:path"; import os from "node:os"; import fs from "node:fs";
const ext = path.resolve(import.meta.dirname, "../extension");
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "tts-r-")), {
  headless: false, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--headless=new", "--autoplay-policy=no-user-gesture-required"] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
for (let k = 0; k < 100 && !(await sw.evaluate(() => !!chrome.storage)); k++) await new Promise((r) => setTimeout(r, 100));
const fails = []; const check = (ok, m) => { console.log((ok ? "PASS " : "FAIL ") + m); if (!ok) fails.push(m); };
const page = await ctx.newPage();
await page.route("http://test.local/**", (r) => r.fulfill({ contentType: "text/html", body: "<p id=t style='width:500px'>One sentence here. Another one.</p>" }));
await page.goto("http://test.local/");
await page.waitForTimeout(2500);
const boot1 = await sw.evaluate(() => performance.timeOrigin);

const file = path.join(ext, "highlight.css");
const orig = fs.readFileSync(file, "utf8");
fs.writeFileSync(file, orig + "\n/* reload test */\n");
const t0 = Date.now();
let reloaded = false;
try {
  while (Date.now() - t0 < 15000) {
    await page.waitForTimeout(250);
    const w = ctx.serviceWorkers().at(-1);
    const o = await w.evaluate(() => performance.timeOrigin).catch(() => boot1);
    if (o !== boot1) { reloaded = true; sw = w; break; }
  }
} finally { fs.writeFileSync(file, orig); }
check(reloaded, `extension reloaded itself after a file edit (${Date.now() - t0} ms)`);
await page.waitForTimeout(1500);

const b = await page.locator("#t").boundingBox();
await page.mouse.move(b.x + 20, b.y + b.height / 2);
await page.keyboard.down("Alt"); await page.waitForTimeout(400);
const n = await page.evaluate(() => CSS.highlights.get("tts-indexed")?.size ?? 0);
check(n === 1, `content script live again without a page refresh (Alt preview ranges: ${n})`);
await page.mouse.click(b.x + 20, b.y + b.height / 2); await page.keyboard.up("Alt");
await page.waitForFunction(() => CSS.highlights.has("tts-sentence"), null, { timeout: 15000 }).then(() => {}, () => {});
const players = await page.locator("div.p").count();
check(players === 1, `reading works after reload, one player (${players})`);
await page.locator('div.p button[data-a="stop"]').click().catch(() => {});
await ctx.close(); process.exit(fails.length ? 1 : 0);
