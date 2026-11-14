// Copy to config.local.js (gitignored) and point at your voice servers.
// Without it the extension defaults to localhost; you can also set URLs in popup -> Servers.
self.TTS_SERVERS = {
  clark: "http://your-gpu-host:50300",
  baldree: "http://your-gpu-host:50301",
};
