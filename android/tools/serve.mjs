// Static server for android/dist (download page + APK), proxied on the tailnet by `tailscale serve`.
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const dir = path.resolve(process.argv[2]), port = +process.argv[3];
http.createServer((q, r) => {
  const f = path.join(dir, decodeURIComponent(q.url.split("?")[0]).replace(/\/$/, "/index.html"));
  if (!f.startsWith(dir) || !fs.existsSync(f)) { r.writeHead(404); return r.end("not found"); }
  const ext = path.extname(f);
  r.writeHead(200, { "content-type": { ".html": "text/html; charset=utf-8", ".apk": "application/vnd.android.package-archive" }[ext] || "application/octet-stream" });
  fs.createReadStream(f).pipe(r);
}).listen(port, "127.0.0.1", () => console.log("serving", dir, "on", port));
