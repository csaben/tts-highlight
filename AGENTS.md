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

## Servers (GPU box on a private network, no auth)

Server URLs are not in the repo: copy `extension/config.example.js` to
`extension/config.local.js` (gitignored) and fill in your hosts, or set them in popup →
Servers. Without either, it defaults to `http://localhost:50300` / `:50301`. This repo is
public: never commit hostnames, IPs, usernames or keys.

- Clark: `clark-voice.service`, :50300, GPU 0, `ckpt/clark`.
- Baldree: `baldree-voice.service`, :50301, GPU 1, `ckpt/baldree` (unit created 2026-11-13 by
  copying clark-voice's unit). Versioned copy in `cradle/baldree-voice.service` (uses `%h`
  for home, `%H` for hostname); to reinstall: `scp cradle/baldree-voice.service
  <user>@<gpu-host>:.config/systemd/user/` then
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

**Tap Alt** (popup setting, on by default): a lone Alt tap (< 400 ms, no other key or click in
between) opens *sticky* pick mode: blocks stay underlined, a plain click reads from that block
and the mode stays up, so you can jump around; tap Alt again (or Esc / ✕) to close. Holding Alt
longer still only previews while held. Pick mode from the menu / Alt+Shift+B stays one-shot.
`test/alttap.mjs` covers it.

**Audio cache** (`offscreen.js`, popup → Servers → "Reuse audio already made", on by
default): every synthesized sentence is stored in IndexedDB (`tts-audio`), keyed by server URL
+ steps + exact spoken text, LRU-evicted past 500 MB. IndexedDB rather than memory because
Chrome closes an audio offscreen document after ~30 s of silence. Block reads slice the
page-wide sentence split, so jumping to a block that was already synthesized ahead of time is
a cache hit (~20 ms instead of ~1.5 s). Cache hits skip the sequential server queue; misses join it.
Changing pronunciation rules or steps changes the key, so those sentences get synthesized again.
`test/cache.mjs` covers it (stats/clear go through background `tts-cache`).

**Site rules** (`SITE_ONLY` in content.js): on some sites the page index reads only matching
elements. X/Twitter reads only `[data-testid="tweetText"]`, so a thread plays post after post
without names, handles, times or reply/like/view counts. X only has the posts you've scrolled
past (plus a few ahead) in the DOM, so reading stops at the last loaded post. A `<br>` inside a
block counts as a line break. `test/xthread.mjs` covers it.

Player drag: pointerdown anywhere on the pill (buttons too); past 4 px it becomes a drag and
the click is swallowed. Move/up listeners are on `window`, not the pill, or a fast first move
escapes the pill and nothing happens.

Tests must wait for `chrome.storage` to appear in the service worker before using it: Chromium
attaches the extension APIs a moment after the worker starts.

## Math

`extension/math.js` turns a formula's MathML (KaTeX `.katex`, MathJax `mjx-container`, or a
bare `<math>`) into speech: `2^{-10}` → "2 to the minus 10", `w_q^T` → "w sub q transpose",
`E[x]` → "the expected value of x", `\frac{a}{b}` → "ay over b", sums, roots, norms, abs,
`f(x)` → "f of x", `[a, b]` → "a through b", `i//16` → "i floor divided by 16". In
`collect()` each formula becomes one piece: its spoken text is what goes to the server, its
DOM range is the whole formula (so highlight/hover treat it as a unit), and the visual spans
and hidden MathML copy aren't read twice. Plain letters are left as letters (whisper hears
"x sub q" fine either way); only "a" becomes "ay". Math written as plain text (`x²`, `10⁻⁵`,
`2^-10`, `1e-5`, `×`, `≈`, `≤`, `~5%`) is handled by `plainMath()` in `segment.js`, under the
"spell out acronyms and math symbols" toggle. `test/math.mjs` prints every conversion (TM
post, downloaded once to the gitignored `test/fixtures/` by `test/fixture.mjs`, + common notation) and fails on leftover raw symbols; `test/mathpage.mjs` runs
the real post end to end, reading what was sent via `chrome.storage.session.lastSpoken`.

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

## Android app (`android/`)

Chrome on Android has no extensions, so the app is an **AccessibilityService**: it reads the
screen's accessibility tree in any app (Chrome's web content included) and draws on overlays.
Kotlin, no Compose, Gradle 8.14.3 / AGP 8.13, minSdk 30.

- **Pick mode** = the extension's Alt tap: tap the floating Aa bubble; readable blocks get
  outlined (images orange), tap one to read from it to the end, it stays up so you can jump; tap
  ✕ to close. Drags are replayed to the app with `dispatchGesture` (the overlay stops taking
  touches for the replay), so scrolling still works, just after you lift your finger.
- **Selection menu**: `ProcessTextActivity` ("Read aloud", in Chrome's toolbar) and
  `ReadFromHereActivity` ("Read from here", under ⋮). It finds the selection on the page (via the
  node's `textSelectionStart`, else text search) and starts at that sentence.
- `Page.kt`: tree → leaves → blocks. Inside a browser only the WebView subtree. Runs are one
  block when they share a parent *and* continue on the same line (a link in a paragraph). A
  container's own text is ignored when its children have text (Chrome gives the page node its
  `<title>`). UI-chrome filter instead of the extension's X selector: short blocks made only of
  links/buttons/counts/times/handles are skipped (names, `@handle · 3h`, `12 1.4K 89K Views`).
- Highlight: per-character rects from `EXTRA_DATA_TEXT_CHARACTER_LOCATION_KEY` (Chrome reports
  some wrap characters with the whole run's box; heights > 1.8× median are dropped), merged
  per line; word = estimated from character weights, as in the extension.
- Images ≥ 40% of screen width become OCR items: when reading reaches one, it is scrolled on
  screen (`ACTION_SHOW_ON_SCREEN`), overlays are hidden, `takeScreenshot`, ML Kit text
  recognition (on-device, bundled), then its text is spliced into the queue (`Player.resolve`).
- `Text.kt` is a port of `segment.js`; `TextTest` checks it against outputs generated from
  `segment.js` under node (`app/src/test/resources/text-cases.json`; regenerate after changing
  either side).
- `Player.kt` = `offscreen.js`: sequential fetch 3 ahead, disk cache (`AudioCache`, same key,
  500 MB LRU), `PlaybackParams` speed with pitch 1.
- Server URLs: `android/local.properties` (gitignored) `tts.clark=` / `tts.baldree=`, baked into
  `BuildConfig`; editable in the app. Release is signed with the local debug keystore so updates
  install over each other, and is arm64-only (21 MB vs 50 MB).

Build: `cd android && ./gradlew --max-workers=2 :app:testDebugUnitTest :app:assembleRelease`
(`--max-workers=2` and `./gradlew --stop` afterwards: builds + emulator froze inari once).
Publish: copy `app/build/outputs/apk/release/app-release.apk` to `android/dist/ReadAloud.apk`.
`dist/` is served by `node android/tools/serve.mjs android/dist 8863` behind
`tailscale serve --https=10026` → https://inari.<tailnet>:10026/ (not a service: restart the
node server after a reboot).

Emulator testing (inari): run it headless and low priority so it stays out of the way:
`emulator -avd Medium_Phone_API_36.1 -no-window -cores 2 -memory 2048` then set the qemu process
to BelowNormal. The emulator has no tailnet: proxy the voice ports on 127.0.0.1 and point the
debug app at `http://10.0.2.2:<port>` with
`adb shell am broadcast -a app.readaloud.DEBUG --es cmd server --es voice clark --es url ...`.
Debug builds also take `cmd pick|unpick|dump|block --ei i N|select --es text T --ez here true|stop|stats`;
`dump` logs every block (`adb logcat -s ReadAloud`). Enable the service with
`settings put secure enabled_accessibility_services app.readaloud/.ReadAloudService`.
