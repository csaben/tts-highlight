// Tapping Alt toggles sticky pick mode: blocks stay underlined, clicks jump between blocks
// (no Alt held), and it stays up until Alt is tapped again. Holding Alt still only previews.
import { chromium } from "playwright";
import path from "node:path"; import os from "node:os"; import fs from "node:fs";
const ext = path.resolve(import.meta.dirname, "../extension");
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "tts-a-")), {
  headless: false, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--headless=new", "--autoplay-policy=no-user-gesture-required"] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
for (let k = 0; k < 100 && !(await sw.evaluate(() => !!chrome.storage)); k++) await new Promise((r) => setTimeout(r, 100));
await sw.evaluate(() => chrome.storage.sync.set({ voice: "clark", rate: 2 }));
const fails = []; const check = (ok, m) => { console.log((ok ? "PASS " : "FAIL ") + m); if (!ok) fails.push(m); };
const page = await ctx.newPage();
await page.setViewportSize({ width: 1000, height: 800 });
await page.route("http://test.local/**", (r) => r.fulfill({ contentType: "text/html", body: `
<p id=b1 style="width:500px">The first block is here. It has two sentences.</p>
<p id=b2 style="width:500px">The second block follows. With <a href="http://test.local/away">a link</a> in it.</p>
<p id=b3 style="width:500px">The third block ends it.</p>` }));
await page.goto("http://test.local/");
await page.waitForTimeout(2500);
const indexed = () => page.evaluate(() => (CSS.highlights.get("tts-indexed") || { size: 0 }).size);
const banner = () => page.evaluate(() => !!document.querySelector("[data-tts-player]")?.shadowRoot?.querySelector(".b"));
const sentence = () => page.evaluate(() => { const h = CSS.highlights.get("tts-sentence"); return h ? [...h][0].toString() : ""; });
const clickBlock = async (id) => { const b = await page.locator("#" + id).boundingBox(); await page.mouse.click(b.x + 20, b.y + b.height / 2); };
const until = (t) => page.waitForFunction((t) => { const h = CSS.highlights.get("tts-sentence"); return h && [...h][0].toString().startsWith(t); }, t, { timeout: 20000 });

await page.keyboard.press("Alt");
await page.waitForTimeout(300);
check((await indexed()) === 3 && (await banner()), `tapping Alt shows the 3 blocks + banner (${await indexed()})`);
await page.waitForTimeout(1500);
check((await indexed()) === 3, "and they stay up after Alt is released");
await clickBlock("b2");
await until("The second block");
check((await indexed()) === 3, "plain click reads from that block, mode stays up");
await clickBlock("b3");
await until("The third block");
check(true, `click another block jumps there ("${await sentence()}")`);
await clickBlock("b1");
await until("The first block");
check(page.url() === "http://test.local/", "jumping back works, no navigation");
await page.keyboard.press("Alt");
await page.waitForTimeout(300);
check((await indexed()) === 0, "tapping Alt again closes it");
await clickBlock("b3");
await page.waitForTimeout(800);
check(!(await sentence()).startsWith("The third"), "plain click after closing doesn't start reading");
// hold Alt (longer than a tap): preview only while held
await page.keyboard.down("Alt"); await page.waitForTimeout(700);
check((await indexed()) === 3, "holding Alt previews");
await page.keyboard.up("Alt"); await page.waitForTimeout(200);
check((await indexed()) === 0, "releasing a long hold closes the preview (not a tap)");
// setting off: a tap does nothing sticky
await sw.evaluate(() => chrome.storage.sync.set({ altToggle: false }));
await page.waitForTimeout(300);
await page.keyboard.press("Alt"); await page.waitForTimeout(400);
check((await indexed()) === 0, "with the setting off, tapping Alt doesn't open it");
await sw.evaluate(() => chrome.storage.sync.set({ altToggle: true }));
await page.locator('div.p button[data-a="stop"]').click().catch(() => {});
await ctx.close(); process.exit(fails.length ? 1 : 0);
