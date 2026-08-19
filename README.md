# Y0uTube

A standalone Windows desktop app that lives in the system tray as a YouTube icon.
Left-click opens a phone-shaped, borderless flyout window anchored to the tray
(Win+A style), loading **desktop** YouTube inside a narrow phone-portrait
viewport. Full MV2 Chrome extension support (uBlock Origin, SponsorBlock).
Audio keeps playing when the flyout is dismissed.

Built on **Electron 37** + **electron-chrome-extensions 4.9.0**. MIT licensed.

## Quick start

```bash
npm install
npm run gen:icons      # build/tray.png + build/icon.ico (pure Node, no deps)
npm run fetch:ublock   # uBlock Origin 1.52.2 (MV2) -> extensions/uBlock0.chromium
npm run sb:install     # SponsorBlock 4.7.1 (MV2) built from source -> extensions/SponsorBlock
npm start              # run the app in dev mode
```

To use a custom logo instead of the built-in glyph, drop a square PNG (with
transparency) at `build/youtube-logo.png` and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-icon.ps1
```

It auto-crops to the opaque content and regenerates `tray.png`, `tray.ico`
(crisp at every DPI) and `icon.ico` (installer/app icon).

First run copies both extensions into `%APPDATA%\Y0uTube\extensions\<id>` and
loads them into the session (Electron 37 no longer remembers loaded extensions
between runs, so this happens on every launch). Y0uTube then lives in the
system tray: left-click toggles the flyout, right-click for the menu.

## Smoke test

```bash
npm run smoke
```

Launches the app headlessly-in-tray and asserts (JSON summary + exit code):

1. youtube.com loads in the flyout webview
2. uBlock Origin 1.52.2 loads **and its background page boots**
3. SponsorBlock 4.7.1 loads **and its background page boots**
4. the webview preload is injected into the page
5. `autoMute` — a fresh `<video>` is muted after `loadedmetadata`
6. `autoSkipAds` — an enabled `.ytp-ad-skip-button` is auto-clicked
7. `autoResumeOnPause` — a "Video paused. Continue watching?" dialog's Yes is clicked

Smoke runs use a throwaway userData dir (`%TEMP%\y0utube-smoke`) and force-exit,
so nothing leaks into your real profile. A 105s hard backstop guarantees the
script can never hang CI.

## Settings — `%APPDATA%\Y0uTube\config.json`

| Key                | Default               | Meaning                                             |
| ------------------ | --------------------- | --------------------------------------------------- |
| `quadrant`         | `bottom-right`        | corner of the tray's display the flyout lands in    |
| `zoomFactor`       | `0.85`                | base zoom for desktop YouTube at ~390px width       |
| `autoFitWidth`     | `true`                | shrink zoom (0.05 steps, min 0.5) until no overflow |
| `dragHandle`       | `false`               | show the top drag strip (invisible on YouTube)      |
| `hideYouTubeHeader`| `false`               | hide YouTube's top logo/search bar in the flyout    |
| `toggleShortcut`   | `` Ctrl+Shift+` ``      | global hotkey that opens/closes the flyout          |
| `alwaysOnTop`      | `true`                | flyout stays above other windows                    |
| `windowHeight`     | `844`                 | flyout height (auto-shrinks to fit short screens)   |
| `autoMute`         | `false`               | mute the video on watch-page load (initial state)   |
| `autoSkipAds`      | `true`                | auto-click "Skip Ad" when enabled                   |
| `autoResumeOnPause`| `true`                | auto-dismiss "Continue watching?"                   |

`toggleShortcut` uses [Electron accelerator](https://www.electronjs.org/docs/latest/api/accelerator)
syntax (`CommandOrControl+Shift+~` default — the key left of `1`; empty string disables it).

Edit the file and relaunch; there is no in-app settings UI yet (deferred todo).

## Packaging

```bash
npm run dist    # electron-builder -> release/Y0uTube Setup *.exe (NSIS, ~92-120MB)
```

The installer bundles `extensions/` so first launch works offline. Dev mode is
`npm start`.

## Stability & crash handling

- Every launch writes a diagnostic log to
  `%APPDATA%\Y0uTube\logs\y0utube.log` (rotated, capped ~1 MB): console
  output, extension loads, navigations, and every process-gone event
  (renderer / GPU / utility) with its reason and exit code.
- A **memory guard** polls the YouTube renderer every 20s. YouTube + blockers
  can balloon its working set (observed ~1.7 GB before crashes); the guard
  **forcefully restarts the renderer process** *before* it OOM-crashes —
  gently at 1 GB while the flyout is dismissed, at 1.6 GB while visible — at
  most once per 5 minutes. (A plain page reload was found to reuse the same
  renderer process, so its bloated working set never shrank; restarting the
  process is the only way to actually shed the memory.)
- Renderer crashes auto-reload with backoff (3 tries), then do **one full
  window reset** (fresh host + webview + process tree); if that still fails, a
  tray notification points at “Reload YouTube” instead of freezing silently.
- The host window's own renderer crash is recovered the same way (bounded).
- Main-process exceptions are logged and do not silently kill the tray app.

### If the app crashes (dies / black screen / `0xe0000008`)

Every crash we've seen is a **native main-process CHECK failure** (`0xe0000008`
in `KERNELBASE.dll`) — a fail-fast that no JS handler can catch, so the app
dies without a log line. There are three known triggers, in order of likelihood:

1. **Memory exhaustion from a bloated guest renderer.** YouTube + uBlock +
   SponsorBlock in one renderer can balloon to 1.4–3.6 GB. When the machine
   runs low on RAM, Chromium CHECK-fails in the main process and the whole app
   dies (`0xe0000008`). The memory guard now **forcefully restarts the renderer**
   (fresh process) instead of reloading the page — a plain `reload()` reuses
   the same process, so its working set never shrank (verified: 1.4→3.6 GB
   across repeated reloads).
2. **A corrupt/stale user profile** (`%APPDATA%\Y0uTube`) crashing the app
   right after the webview navigates. If that happens: quit the app, then
   delete these folders from `%APPDATA%\Y0uTube` (they regenerate;
   **`Network\` is NOT in the list — that keeps your YouTube login/cookies**):

   ```
   IndexedDB  Local Extension Settings  Local State  Local Storage  Preferences  Service Worker
   ```

   Extensions re-download their settings (uBlock filter lists, SponsorBlock
   config) on next launch.
3. **Several instances running at once.** Y0uTube must run exactly one
   instance; a second launch now hard-exits immediately instead of booting a
   second full YouTube renderer. Two+ instances (e.g. old zombie processes or
   launching from both the installer and `win-unpacked`) multiply memory
   pressure and crash together. Kill strays with `taskkill /f /im Y0uTube.exe`
   before relaunching.

Note: `electron-chrome-extensions` 3.x did hard-crash the main process on
webview attach under Electron 37 with this exact signature; it is pinned to
`^4.9.0`, which is compatible (verified by the smoke test passing 10/10 on a
fresh profile). The recurring `0xe0000008` crashes are the memory/profile
issues above, not ECE.

## Architecture notes (verified empirically on Electron 37 / Windows 11)

- **Dismissal parks the window offscreen** at `(-10000,-10000)` while keeping it
  *visible*. `win.hide()` fires `visibilitychange` and YouTube pauses audio.
  `document.visibilityState` is an own, non-configurable property — it cannot
  be patched. Parking is the only reliable way to keep audio playing.
- **All window moves use atomic `setBounds()`.** Separate `setSize()` +
  `setPosition()` causes ~2px growth per park/restore cycle on Windows.
- **Tray bounds are DIP-normalized with a two-phase lookup** (DIP containment
  first, then physical `bounds * scaleFactor`) for high-DPI secondary displays.
- **The webview is created in JS by the host preload**, with `preload` and
  `src` set *before insertion*, and **no `partition` attribute**:
  - a parser-created webview with static `src` attaches, but a `preload`
    attribute applied later misses the first navigation;
  - a JS-assigned `src` on a parser-created webview never attaches on
    `file://` hosts;
  - a JS-created webview with a `partition` attribute fails to attach.
  The webview therefore uses the **default session** (extensions + login state
  live there too).
- **Auto-resume runs in the main world** (injected from main via
  `executeJavaScript`), not in the preload. Isolated worlds cannot read text
  content from elements created in the main world (`textContent` returns `''`
  or throws) — verified by building the feature in both places.
- **The smoke test fakes YouTube's pause dialog with a plain `<div class=…>`**:
  a `createElement('yt-confirm-dialog-renderer')` element gets *upgraded* by
  YouTube's Polymer code the moment the custom element is registered, wiping
  appended children.
- Extension boot order matters: extensions load **before** the flyout is
  created so the guest's first navigation happens with content scripts already
  injected (avoids first-load starvation).

## Extension strategy (SPEC §4)

- **MV2 only.** Google stopped serving MV2 from the Chrome Web Store; anything
  "Add to Chrome" today is MV3 and won't load (Electron has no service-worker
  support for extensions yet). Unpacked MV2 extensions from disk are the
  reliable path.
- **uBlock Origin 1.52.2** is the last full-featured MV2 release (2024). The
  MV3 "Lite" version is substantially weaker. The frozen zip is fetched by
  `fetch-ublock.js`; `build-ublock-mv2.js` provides the from-source path for
  when the zip needs replacing.
- **SponsorBlock 4.7.1** is the last MV2 tag (2022). No community MV2 build
  exists; `sb:install` clones the tag, applies three Electron patches
  (`storage.sync → storage.local`, `background.persistent → true`, and a
  retry-wrapped `fetchConfig`), webpack-builds, and stages the result. The
  sync→local patch is mandatory — Electron never implemented the sync storage
  area.
- The former SponsorBlock storage flake (content-script storage bridge never
  calling back on ~1/3 of first loads) is fixed two ways: the main process
  waits for every extension's `extension-ready` before the guest's first
  navigation, and `fetchConfig` retries its `chrome.storage.local.get` until a
  call returns (bounded, so setup never hangs). Verified end-to-end: the smoke
  probe (`Y0UTUBE_SMOKE_SB_PROBE=1`) navigates to a real watch page and finds
  the `#previewbar` on the first load — 5/5 consecutive fresh launches.

## Debugging "exe opens then disappears"

1. Kill zombies: `taskkill /f /im Y0uTube.exe` and `taskkill /f /im electron.exe`.
2. Run from a terminal and read stderr.
3. Check Task Manager for a live process with no tray icon (missing icon asset).
4. Windows Event Viewer → Application log.
5. Try the unpacked build (`release/win-unpacked/Y0uTube.exe`) vs the installer.
6. `npm start` (dev) vs packaged.

## Deferred todos (SPEC §10)

1. Persist window position across launches.
2. MV3 service-worker support shim (would unblock Web Store installs but nerf
   uBlock — double-edged).
3. Mini-player media controls (media keys, play/pause/skip).
4. In-flyout settings panel (GUI for config.json).
7. Playwright-style UI test suite (replaces the smoke harness).

## License

MIT. Electron, electron-chrome-extensions, uBlock Origin and SponsorBlock are
licensed separately by their owners.
