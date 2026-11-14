# tts-highlight

Chrome extension: select text, right-click **Read aloud** (or Alt+Shift+R), hear it in Clark's
or Travis Baldree's voice from cradle's GPUs at a default speed (2×), with a sentence highlight
and an estimated word highlight that follows the audio.

## Install

chrome://extensions → Developer mode → **Load unpacked** → `D:\Code\tts-highlight\extension`.
Unpacked installs reload themselves: background.js fetches its own files (served live from
disk), and ~1 s after they stop changing it calls `chrome.runtime.reload()`, then re-injects
`content.js` into open tabs. The new copy fires a `tts-read-aloud-reset` DOM event that makes
the orphaned old copy tear down its listeners. If the worker is asleep, a 30 s alarm catches
it. Reloading stops any read in progress. `test/reload.mjs` covers it. Manual reload is only
needed if background.js is broken badly enough that the watcher never runs.

## Layout

- `extension/background.js`: context menu, shortcuts, session routing, offscreen doc lifecycle.
- `extension/content.js`: selection → flat text + DOM map, CSS Custom Highlight API painting,
  floating mini player (voice toggle, prev/pause/next, speed −/+, stop).
- `extension/offscreen.js`: fetches one segment at a time (server is single-GPU, so sequential,
  3 ahead) and plays with `playbackRate` + `preservesPitch`.
- `extension/segment.js`: sentence splitter shared by content + background. First chunk ≤ 90
  chars so audio starts in ~1–1.5 s.
- `test/e2e.mjs`: Playwright Chromium loads the unpacked extension and checks highlights move.
  `cd test && PLAYWRIGHT_BROWSERS_PATH=$PWD/.browsers node e2e.mjs clark|baldree`

## Servers (cradle, tailnet, no auth)

- Clark: `clark-voice.service`, :50300, GPU 0, `ckpt/clark`.
- Baldree: `baldree-voice.service`, :50301, GPU 1, `ckpt/baldree` (unit created 2026-11-13 by
  copying clark-voice's unit). Versioned copy in `cradle/baldree-voice.service`; to reinstall:
  `scp cradle/baldree-voice.service <user>@<gpu-host>:.config/systemd/user/` then
  `systemctl --user daemon-reload && systemctl --user enable --now baldree-voice`. Its `/llms.txt` still says "Clark" because the text is hardcoded
  in `tts_dots/service.py`.
- Both are `~/Code/tts-workspace/dots-tts` `python -m tts_dots.service`, `POST /synthesize`.
  Each sentence takes about 1–2 s at 16 steps, about 0.9 s at 8 steps (popup → Servers → Quality).

## Read from here (eager index, lazy compute)

Each frame indexes its page into sentences on idle (re-indexes 1 s after DOM mutations),
skipping `nav, footer, aside, pre, code, [aria-hidden]`, and groups sentences into blocks
(nearest non-inline ancestor: paragraph, heading, list item). **Pick mode** (right-click page → "Pick where to read", Alt+Shift+B, or the popup button) shows
the same preview and keeps it up with a banner; a plain click on a block starts reading
(links inside don't navigate), Esc / ✕ cancels. Holding Alt (150 ms, so shortcuts
don't flash it) previews: dotted blue underline = everything indexed, blue fill = the block
under the mouse. Alt+click (or right-click, no selection → "Read from here") starts at the
*start of that block* and continues to the end of the page; the player parks at the right edge
level with the click. Only audio is lazy: offscreen fetches 3 sentences ahead.
`test/fromhere.mjs` covers it.

Player drag: pointerdown anywhere on the pill (buttons too); past 4 px it becomes a drag and
the click is swallowed. Move/up listeners are on `window`, not the pill, or a fast first move
escapes the pill and nothing happens.

Tests must wait for `chrome.storage` to appear in the service worker before using it: Chromium
attaches the extension APIs a moment after the worker starts.

## Pronunciation

Popup → Pronunciation: `word = respelling` per line (synced), plus an "spell out acronyms"
toggle that turns 2–5 letter all-caps words into `A.S.I.` (except a KEEP list in `segment.js`
like NASA, RAM, CUDA; add `NASA = NASA` to keep others). Applied in background `startSession`
to the text sent to the server only, so on-page highlighting still uses the original words.
Respellings were checked by synthesizing and transcribing with whispr-proxy (:8004):
`A.S.I.` and `G.P.U.s` come back right; `ay ess eye` and `G P Us` don't.

## Notes / gotchas

- Control messages: the background must spread `...m` *before* `type: "control"`; the reverse
  let `type: "tts-control"` win and the offscreen player silently ignored every button (fixed
  2026-11-13). `test/controls.mjs` clicks every button.

- `crypto.randomUUID` is missing on http pages (insecure context), so don't use it in content.js.
- Word timing is estimated from character weights within each sentence (the server gives no
  word timestamps). If you want it exact, add forced alignment server-side.
- No highlighting where content scripts can't run (Chrome PDF viewer, chrome:// pages, Web
  Store). There the background falls back to reading `info.selectionText` with no player UI;
  use Alt+Shift+X / the popup to stop.
