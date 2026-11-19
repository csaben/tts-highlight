// On x.com, reading from a post plays the thread's post text back to back: no names, handles,
// timestamps or reply/like/view counts in between (SITE_ONLY in content.js).
import { chromium } from "playwright";
import path from "node:path"; import os from "node:os"; import fs from "node:fs";
const ext = path.resolve(import.meta.dirname, "../extension");
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "tts-x-")), {
  headless: false, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--headless=new", "--autoplay-policy=no-user-gesture-required"] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
for (let k = 0; k < 100 && !(await sw.evaluate(() => !!chrome.storage)); k++) await new Promise((r) => setTimeout(r, 100));
await sw.evaluate(() => chrome.storage.sync.set({ voice: "clark", rate: 2 }));
const fails = []; const check = (ok, m) => { console.log((ok ? "PASS " : "FAIL ") + m); if (!ok) fails.push(m); };
const post = (id, name, text) => `
<article data-testid="tweet" style="width:560px">
  <div data-testid="User-Name"><a><span>${name}</span></a> <a><span>@neurolab</span></a> · <time>3h</time></div>
  <div data-testid="tweetText" id="${id}" lang="en"><span>${text}</span></div>
  <div role="group"><button data-testid="reply"><span>12</span></button>
    <button data-testid="like"><span>1.4K</span></button><a><span>89K</span> <span>Views</span></a></div>
</article>`;
const page = await ctx.newPage();
await page.setViewportSize({ width: 1000, height: 900 });
await page.route("https://x.com/**", (r) => r.fulfill({ contentType: "text/html", body: `<main>
${post("t1", "Neuro Lab", "We recorded brain activity in people as they talked and listened. Here is what we found.")}
${post("t2", "Neuro Lab", "Speaking and listening used overlapping regions.<br>The overlap grew over time.")}
${post("t3", "Someone Else", "Fascinating result, thanks for sharing.")}
</main>` }));
await page.goto("https://x.com/neurolab/status/1");
await page.waitForTimeout(2500);
const b = await page.locator("#t1").boundingBox();
await page.mouse.move(b.x + 40, b.y + b.height / 2);
await page.keyboard.down("Alt");
await page.waitForTimeout(400);
const idx = await page.evaluate(() => [...(CSS.highlights.get("tts-indexed") || [])].map((r) => r.toString()));
check(idx.length === 3 && !idx.some((t) => /Neuro Lab|@neurolab|3h|1\.4K|Views/.test(t)), `only post text is indexed (${JSON.stringify(idx)})`);
await page.mouse.click(b.x + 40, b.y + b.height / 2);
await page.keyboard.up("Alt");
await page.waitForFunction(() => CSS.highlights.has("tts-sentence"), null, { timeout: 15000 });
const { lastSpoken } = await sw.evaluate(() => chrome.storage.session.get("lastSpoken"));
console.log(lastSpoken);
const all = lastSpoken.join(" | ");
check(!/Neuro|neurolab|3h|1\.4K|89K|Views|\b12\b|Someone/.test(all), "no names, handles, times or counts spoken");
check(/talked and listened/.test(lastSpoken[0]) && /overlap grew/.test(all) && /Fascinating/.test(all), "thread continues post to post, including replies");
check(lastSpoken.includes("Speaking and listening used overlapping regions."), "a <br> inside a post is a sentence break");
await page.locator('div.p button[data-a="stop"]').click();
await ctx.close(); process.exit(fails.length ? 1 : 0);
