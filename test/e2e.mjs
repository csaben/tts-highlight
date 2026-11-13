// End-to-end: load the unpacked extension in Playwright's Chromium, select text on a page,
// trigger "read" through the service worker (same path as the context menu), and check that
// audio segments arrive from cradle and the sentence/word highlights move.
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const ext = path.resolve(import.meta.dirname, "../extension");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tts-e2e-"));
const voice = process.argv[2] || "clark";

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--headless=new",
         "--autoplay-policy=no-user-gesture-required"],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
for (let k = 0; k < 100 && !(await sw.evaluate(() => !!chrome.storage)); k++) await new Promise((r) => setTimeout(r, 100));

const html = `<!doctype html><html><body style="font:18px serif;max-width:600px">
<h1>Test article</h1>
<p id="a">The quick brown fox jumps over the lazy dog. <b>Bold words</b> sit in the middle of this sentence.</p>
<p>A second paragraph begins here, and it keeps going for a little while. Finally it ends.</p>
</body></html>`;
const page = await ctx.newPage();
await page.route("http://test.local/**", (r) => r.fulfill({ contentType: "text/html", body: html }));
await page.goto("http://test.local/");
await page.waitForTimeout(500);

await sw.evaluate((v) => chrome.storage.sync.set({ voice: v, rate: 2 }), voice);

// select everything in the body text
await page.evaluate(() => {
  const r = document.createRange();
  r.setStart(document.querySelector("#a").firstChild, 0);
  r.setEndAfter(document.body.lastElementChild);
  getSelection().removeAllRanges();
  getSelection().addRange(r);
});

const t0 = Date.now();
await sw.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ url: "http://test.local/*" });
  await readInTab(tab, 0, "");
});

const seen = new Set();
const words = new Set();
let firstHL = null;
while (Date.now() - t0 < 25000) {
  const s = await page.evaluate(() => {
    const get = (n) => { const h = CSS.highlights.get(n); return h ? [...h][0]?.toString() : null; };
    return { sent: get("tts-sentence"), word: get("tts-word") };
  });
  if (s.sent && !firstHL) firstHL = Date.now() - t0;
  if (s.sent) seen.add(s.sent);
  if (s.word) words.add(s.word);
  if (firstHL && !s.sent) break; // finished
  await page.waitForTimeout(100);
}
console.log(`voice=${voice} first highlight after ${firstHL} ms, total ${Date.now() - t0} ms`);
console.log("sentences:", [...seen]);
console.log("words highlighted:", words.size, [...words].slice(0, 12).join(" | "));
await ctx.close();
process.exit(seen.size >= 4 && words.size > 10 ? 0 : 1);
