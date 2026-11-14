// Pick mode: blocks are shown without holding anything, a plain click starts reading at that
// block (links inside don't navigate), Esc cancels.
import { chromium } from "playwright";
import path from "node:path"; import os from "node:os"; import fs from "node:fs";
const ext = path.resolve(import.meta.dirname, "../extension");
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "tts-p-")), {
  headless: false, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--headless=new", "--autoplay-policy=no-user-gesture-required"] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
for (let k = 0; k < 100 && !(await sw.evaluate(() => !!chrome.storage)); k++) await new Promise((r) => setTimeout(r, 100));
await sw.evaluate(() => chrome.storage.sync.set({ voice: "clark", rate: 2 }));
const fails = []; const check = (ok, m) => { console.log((ok ? "PASS " : "FAIL ") + m); if (!ok) fails.push(m); };
const page = await ctx.newPage();
await page.setViewportSize({ width: 1000, height: 700 });
await page.route("http://test.local/**", (r) => r.fulfill({ contentType: "text/html", body: `
<nav>Home About</nav>
<p style="width:500px">Opening paragraph is here. It has two sentences.</p>
<p id=t style="width:500px">Second block starts now, with <a id=l href="http://test.local/elsewhere">a link inside</a>. Then it ends.</p>
<p style="width:500px">Last block of the page.</p>` }));
await page.goto("http://test.local/");
await page.waitForTimeout(2000);
const hl = (n) => page.evaluate((n) => { const h = CSS.highlights.get(n); return h ? [...h].map((r) => r.toString()) : []; }, n);
const pick = () => sw.evaluate(async () => { const [t] = await chrome.tabs.query({ url: "http://test.local/*" }); await pickInTab(t.id); });

await pick();
await page.waitForTimeout(300);
check((await page.getByText("Click a highlighted block").count()) === 1, "pick mode shows the banner");
check((await hl("tts-indexed")).length === 3, "all 3 readable blocks shown without holding Alt");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check((await hl("tts-indexed")).length === 0 && (await page.getByText("Click a highlighted block").count()) === 0, "Esc cancels pick mode");

await pick();
const l = await page.locator("#l").boundingBox();
await page.mouse.move(l.x + 5, l.y + l.height / 2);
await page.waitForTimeout(200);
const prev = await hl("tts-preview");
check(prev[0] === "Second block starts now, with a link inside. Then it ends.", `hover shows the block ("${prev[0]}")`);
await page.mouse.click(l.x + 5, l.y + l.height / 2); // plain click, on the link
await page.waitForFunction(() => CSS.highlights.has("tts-sentence"), null, { timeout: 15000 });
const first = await page.evaluate(() => [...CSS.highlights.get("tts-sentence")][0].toString());
check(first === "Second block starts now, with a link inside.", `plain click starts at block start ("${first}")`);
check(page.url() === "http://test.local/", "clicking the link inside did not navigate");
check((await hl("tts-indexed")).length === 0 && (await page.getByText("Click a highlighted block").count()) === 0, "pick mode closes once reading starts");
await page.locator('div.p button[data-a="stop"]').click();
await page.waitForTimeout(300);
await page.locator("#l").click();
await page.waitForTimeout(300);
check(page.url().endsWith("/elsewhere"), "outside pick mode, links work normally");
await ctx.close(); process.exit(fails.length ? 1 : 0);
