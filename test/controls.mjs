// Clicks the floating player's buttons and checks they act: pause freezes the word highlight,
// next jumps a sentence, stop clears everything; player opens near the selection and drags.
import { chromium } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const ext = path.resolve(import.meta.dirname, "../extension");
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "tts-c-")), {
  headless: false,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--headless=new",
         "--autoplay-policy=no-user-gesture-required"],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
for (let k = 0; k < 100 && !(await sw.evaluate(() => !!chrome.storage)); k++) await new Promise((r) => setTimeout(r, 100));
await sw.evaluate(() => chrome.storage.sync.set({ voice: "clark", rate: 1 }));

const body = Array.from({ length: 6 }, (_, i) => `Sentence number ${i + 1} is here and it has a handful of ordinary words.`).join(" ");
const page = await ctx.newPage();
await page.setViewportSize({ width: 1000, height: 700 });
await page.route("http://test.local/**", (r) => r.fulfill({ contentType: "text/html",
  body: `<p id=a style="width:400px;margin:40px">${body}</p>` }));
await page.goto("http://test.local/");
await page.waitForTimeout(500);
await page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector("#a")); getSelection().addRange(r); });
await sw.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: "http://test.local/*" }); await readInTab(tab, 0, ""); });

const hl = () => page.evaluate(() => {
  const g = (n) => { const h = CSS.highlights.get(n); return h ? [...h][0]?.toString() : null; };
  return { s: g("tts-sentence"), w: g("tts-word") };
});
const btn = (a) => page.locator(`div.p button[data-a="${a}"]`);
const fails = [];
const check = (ok, msg) => { console.log((ok ? "PASS " : "FAIL ") + msg); if (!ok) fails.push(msg); };

await page.waitForFunction(() => CSS.highlights.has("tts-sentence"), null, { timeout: 15000 });
const box = await page.locator("div.p").boundingBox();
check(box && box.y < 400 && box.x > 300, `player opens near selection (at ${box && Math.round(box.x)},${box && Math.round(box.y)})`);

await page.waitForTimeout(1200);
await btn("toggle").click();
await page.waitForTimeout(300);
const w1 = await hl();
await page.waitForTimeout(1500);
const w2 = await hl();
check(w1.w === w2.w && w1.s === w2.s, `pause freezes highlight ("${w1.w}" == "${w2.w}")`);
check((await btn("toggle").textContent()) === "▶", "pause button shows play");

await btn("toggle").click();
await page.waitForTimeout(1500);
const w3 = await hl();
check(w3.w !== w2.w || w3.s !== w2.s, `resume moves highlight ("${w2.w}" -> "${w3.w}")`);

const before = (await hl()).s;
await btn("next").click();
await page.waitForFunction((b) => { const h = CSS.highlights.get("tts-sentence"); return h && [...h][0].toString() !== b; }, before, { timeout: 10000 }).catch(() => {});
const after = (await hl()).s;
check(after !== before, `next skips sentence ("${before?.slice(0, 18)}" -> "${after?.slice(0, 18)}")`);

const pb = await page.locator("div.p").boundingBox();
await page.mouse.move(pb.x + pb.width - 60, pb.y + pb.height / 2);
await page.mouse.down();
await page.mouse.move(150, 600, { steps: 8 });
await page.mouse.up();
const nb = await page.locator("div.p").boundingBox();
check(Math.abs(nb.y - pb.y) > 100, `drag moves player (${Math.round(pb.y)} -> ${Math.round(nb.y)})`);

await btn("stop").click();
await page.waitForTimeout(600);
const end = await hl();
check(!end.s && (await page.locator("div.p").count()) === 0, "stop clears highlight and player");
await page.waitForTimeout(1500);
check(!(await hl()).s, "stays stopped");

await ctx.close();
process.exit(fails.length ? 1 : 0);
