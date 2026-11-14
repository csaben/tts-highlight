// The TM 4-bit post isn't ours to redistribute, so it's downloaded on first use (gitignored).
import fs from "node:fs"; import path from "node:path";
const URL = "https://thinkingmachines.ai/blog/end-to-end-4-bit-training/";
export async function tmPost() {
  const f = path.join(import.meta.dirname, "fixtures/tm-4bit.html");
  if (!fs.existsSync(f)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const r = await fetch(URL);
    if (!r.ok) throw new Error(`fetch ${URL}: ${r.status}`);
    fs.writeFileSync(f, await r.text());
  }
  return fs.readFileSync(f, "utf8");
}
