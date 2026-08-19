import { app, BrowserWindow, Tray, Menu, screen, nativeImage, ipcMain, session, shell, webContents, globalShortcut } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { ElectronChromeExtensions } from 'electron-chrome-extensions';
import { configFilePath, getConfig, loadConfig } from './config';

/**
 * Y0uTube main process.
 *
 * Behavioral decisions locked in by the spec (SPEC §3):
 * - Dismissal PARKS the window offscreen at (-10000,-10000) while keeping it
 *   visible. Never win.hide(): Chromium fires visibilitychange and YouTube
 *   pauses audio. (document.visibilityState is own/non-configurable in
 *   Electron 37 — verified empirically upstream; do not attempt hiding.)
 * - ALL window moves use atomic setBounds() — separate setSize()+setPosition()
 *   causes ~2px growth per cycle when restoring from the parked position on
 *   Windows.
 * - Tray bounds are normalized to DIPs with a two-phase lookup (DIP
 *   containment first, physical second) for high-DPI displays.
 * - window-all-closed does NOT quit; the app lives in the tray. Quit only via
 *   the tray menu (clean exit: destroys tray + window so no zombie processes
 *   hold the single-instance lock — see SPEC §6).
 */

const IS_SMOKE = process.argv.includes('--smoke-test');

// ---------------------------------------------------------------------------
// Crash diagnostics: pipe console output + process-gone events into a log file
// (%APPDATA%\Y0uTube\logs\y0utube.log, capped ~1 MB with rotation) so a
// renderer/GPU/main crash leaves an audit trail instead of dying silently.
// ---------------------------------------------------------------------------

function logFilePath(): string {
  return path.join(app.getPath('userData'), 'logs', 'y0utube.log');
}

function appendLog(line: string): void {
  try {
    const file = logFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(file, `[${stamp}] ${line}\n`);
    const size = fs.statSync(file).size;
    if (size > 1024 * 1024) {
      // Rotate: keep the most recent 512 KB so the log can't grow forever.
      const data = fs.readFileSync(file);
      fs.writeFileSync(file, data.subarray(data.length - 512 * 1024));
    }
  } catch {
    /* logging must never take the app down */
  }
}

const _log = console.log.bind(console);
const _warn = console.warn.bind(console);
const _err = console.error.bind(console);
console.log = (...a: unknown[]) => {
  _log(...a);
  appendLog(a.map(String).join(' '));
};
console.warn = (...a: unknown[]) => {
  _warn(...a);
  appendLog('WARN ' + a.map(String).join(' '));
};
console.error = (...a: unknown[]) => {
  _err(...a);
  appendLog('ERROR ' + a.map(String).join(' '));
};

// Log (and survive) uncaught main-process errors — a stray throw must never
// silently kill the tray app.
process.on('uncaughtException', (err) => {
  console.error(`[main] uncaughtException: ${err?.stack || err}`);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[main] unhandledRejection: ${String(reason)}`);
});

/**
 * The webview uses the DEFAULT session (no partition attribute): a partition
 * attribute set after parse time is rejected once the guest has navigated,
 * and a JS-assigned webview src never attaches on file:// hosts — both
 * verified empirically. The default session is persistent, so login state
 * survives restarts, and extensions + ECE live there too.
 */
const PARK_OFFSET = 10000;
const WINDOW_MARGIN = 12;

/**
 * Hides the guest's scrollbar chrome (right vertical + bottom horizontal)
 * while keeping scrolling intact. Applied with webContents.insertCSS on EVERY
 * page load (insertCSS is per-document) — the most reliable path, and it also
 * covers non-YouTube pages (consent/sign-in) where the preload bails early.
 */
const GUEST_SCROLLBAR_CSS = `
  html, body {
    scrollbar-width: none !important;
    -ms-overflow-style: none !important;
    scrollbar-color: transparent transparent !important;
  }
  ::-webkit-scrollbar,
  *::-webkit-scrollbar {
    width: 0 !important;
    height: 0 !important;
    display: none !important;
    background: transparent !important;
  }
  ::-webkit-scrollbar-track,
  *::-webkit-scrollbar-track,
  ::-webkit-scrollbar-thumb,
  *::-webkit-scrollbar-thumb {
    background: transparent !important;
  }
`;

/** Hides YouTube's own top header (logo/search/avatar) inside the flyout. */
const GUEST_MASTHEAD_CSS = `
  #masthead-container,
  ytd-masthead {
    display: none !important;
  }
`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let extApi: ElectronChromeExtensions | null = null;
/** True while the flyout is parked offscreen (dismissed but still visible). */
let parked = true;
let quitting = false;
let devtoolsOpen = false;
/**
 * Guests we've already wired up. The guest <webview> can detach and re-attach
 * (host reload / full window reset), which re-fires 'did-attach-webview' with
 * the SAME WebContents — without this guard every re-attach would re-register
 * the whole listener + timer block (observed: MaxListenersExceededWarning on
 * 'destroyed', and duplicate memTimers reloading the guest every ~60s despite
 * the 5-minute cooldown).
 */
const attachedGuests = new WeakSet<Electron.WebContents>();
/**
 * Set right before the memory guard force-crashes the guest renderer so the
 * crash-recovery handler knows it's an intentional memory reset, not a real
 * crash (so it reloads immediately instead of counting toward the crash-loop
 * backoff / full-window-reset escalation).
 */
let memResetPending = false;

const smoke = {
  extensionsLoaded: [] as string[],
  extensionsReady: [] as string[],
  pageLoaded: false,
};

// ---------------------------------------------------------------------------
// Single instance lock (SPEC §3.1). A second launch just shows the flyout.
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Hard-exit NOW: a second instance must not continue booting (loading
  // extensions + a full YouTube renderer just to quit) — several concurrent
  // instances each holding 1-3.6 GB is what OOMs the machine and takes the
  // main process down with a native CHECK crash (0xe0000008).
  console.error('[lock] another Y0uTube instance is running — exiting immediately');
  app.exit(0);
} else {
  app.on('second-instance', () => showFlyout());
}

// Isolate smoke runs from real user data.
if (IS_SMOKE) {
  app.setPath('userData', path.join(app.getPath('temp'), 'y0utube-smoke'));
  // Smoke exercises the preload features, so force them ON regardless of the
  // user-facing defaults (autoMute / dragHandle now default OFF). Written
  // before whenReady so loadConfig() picks it up.
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(
      path.join(app.getPath('userData'), 'config.json'),
      JSON.stringify(
        {
          quadrant: 'bottom-right',
          zoomFactor: 0.85,
          autoFitWidth: true,
          dragHandle: true,
          alwaysOnTop: true,
          windowHeight: 844,
          autoMute: true,
          autoSkipAds: true,
          autoResumeOnPause: true,
        },
        null,
        2,
      ),
    );
  } catch {
    /* temp dir unwritable; smoke falls back to defaults */
  }
}

app.setAppUserModelId('com.y0utube.app');

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function rectContainsPoint(
  rect: { x: number; y: number; width: number; height: number },
  px: number,
  py: number,
): boolean {
  return px >= rect.x && px <= rect.x + rect.width && py >= rect.y && py <= rect.y + rect.height;
}

/**
 * tray.getBounds() can return PHYSICAL pixels on high-DPI Windows. Two-phase
 * lookup per SPEC §3.3:
 *   1. If the tray rect fits inside a display's DIP bounds, it's already DIPs.
 *   2. Otherwise try physical bounds (DIP * scaleFactor); convert via division.
 */
function trayPointInDIP(): { x: number; y: number } {
  const b = tray?.getBounds();
  const displays = screen.getAllDisplays();

  if (b && (b.width > 0 || b.height > 0)) {
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    for (const d of displays) {
      if (rectContainsPoint(d.bounds, cx, cy)) return { x: b.x, y: b.y };
    }
    for (const d of displays) {
      const phys = {
        x: d.bounds.x * d.scaleFactor,
        y: d.bounds.y * d.scaleFactor,
        width: d.bounds.width * d.scaleFactor,
        height: d.bounds.height * d.scaleFactor,
      };
      if (rectContainsPoint(phys, cx, cy)) return { x: b.x / d.scaleFactor, y: b.y / d.scaleFactor };
    }
  }

  // Fallback: center of the primary display.
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width / 2, y: wa.y + wa.height / 2 };
}

/** Flyout bounds for the configured quadrant of the tray's display. */
function computeFlyoutBounds(): Electron.Rectangle {
  const cfg = getConfig();
  const point = trayPointInDIP();
  const display = screen.getDisplayNearestPoint(point);
  const wa = display.workArea;

  const height = Math.min(cfg.windowHeight, wa.height - 40);
  const width = Math.round(height * (9 / 19.5));

  let x: number;
  let y: number;
  const m = WINDOW_MARGIN;
  switch (cfg.quadrant) {
    case 'bottom-left':
      x = wa.x + m;
      y = wa.y + wa.height - height - m;
      break;
    case 'top-right':
      x = wa.x + wa.width - width - m;
      y = wa.y + m;
      break;
    case 'top-left':
      x = wa.x + m;
      y = wa.y + m;
      break;
    case 'bottom-right':
    default:
      x = wa.x + wa.width - width - m;
      y = wa.y + wa.height - height - m;
  }

  return { x: Math.round(x), y: Math.round(y), width, height };
}

/** Park offscreen: the window stays visible, so no visibilitychange fires. */
function park() {
  if (!win || parked || quitting) return;
  parked = true;
  const b = win.getBounds();
  win.setBounds({ x: -PARK_OFFSET, y: -PARK_OFFSET, width: b.width, height: b.height });
}

/** Restore the flyout at its tray-anchored position. */
function showFlyout() {
  if (!win) return;
  parked = false;
  win.setBounds(computeFlyoutBounds()); // atomic, SPEC §3.3
  win.show();
  win.focus();
  // Focus the YouTube page itself so keys (space, k, arrows, Esc) work the
  // moment the flyout opens — important for the global shortcut.
  guestContents()?.focus();
}

function toggleFlyout() {
  if (!win) return;
  if (parked) showFlyout();
  else park();
}

/** The webview guest's WebContents (the YouTube page). */
function guestContents(): Electron.WebContents | null {
  if (!win) return null;
  // The app owns exactly one webview; scan for it rather than relying on
  // owner-window bookkeeping (types differ across Electron versions).
  return webContents.getAllWebContents().find((wc) => wc.getType() === 'webview') ?? null;
}

// ---------------------------------------------------------------------------
// Extensions (SPEC §4)
// ---------------------------------------------------------------------------

// Created inside whenReady — Session is only available after app is ready.
let SESSION: Electron.Session;

/** Copy a bundled extension from app resources into userData on first load. */
function ensureBundledExtension(name: string): string | null {
  // Packaged: extensions ship as loose extraResources (asar can't cpSync).
  // Dev: they live next to the project root.
  const src =
    process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'extensions', name))
      ? path.join(process.resourcesPath, 'extensions', name)
      : path.join(app.getAppPath(), 'extensions', name);
  const dest = path.join(app.getPath('userData'), 'extensions', name);
  if (!fs.existsSync(dest) && fs.existsSync(path.join(src, 'manifest.json'))) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
  }
  return fs.existsSync(path.join(dest, 'manifest.json')) ? dest : null;
}

/**
 * Load every MV2 extension folder present under %APPDATA%\Y0uTube\extensions.
 * Electron 37 no longer remembers loaded extensions between runs, so this must
 * run on every launch (matches "auto-loads on every launch thereafter").
 */
async function loadExtensions(): Promise<string[]> {
  const extsDir = path.join(app.getPath('userData'), 'extensions');
  try {
    fs.mkdirSync(extsDir, { recursive: true });
  } catch {
    /* ignore */
  }

  const candidates: string[] = [];
  const loadedIds: string[] = [];
  try {
    for (const entry of fs.readdirSync(extsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(extsDir, entry.name, 'manifest.json'))) {
        candidates.push(path.join(extsDir, entry.name));
      }
    }
  } catch {
    /* no extensions yet */
  }

  // Debug aid: Y0UTUBE_EXT_FILTER=uBlock0 to load only matching extensions.
  const extFilter = (process.env.Y0UTUBE_EXT_FILTER || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  for (const dir of candidates) {
    if (extFilter.length && !extFilter.some((f) => dir.toLowerCase().includes(f))) continue;
    try {
      const ext = await SESSION.extensions.loadExtension(dir);
      smoke.extensionsLoaded.push(ext.name);
      loadedIds.push(ext.id);
      console.log(`[ext] loaded ${ext.name} (${ext.id}) from ${dir}`);
    } catch (err) {
      console.error(`[ext] FAILED to load extension from ${dir}: ${err}`);
    }
  }
  return loadedIds;
}

// ---------------------------------------------------------------------------
// Window + tray
// ---------------------------------------------------------------------------

function createFlyoutWindow() {
  const cfg = getConfig();

  win = new BrowserWindow({
    width: 389,
    height: 844,
    x: -PARK_OFFSET,
    y: -PARK_OFFSET,
    show: false, // starts hidden in the tray (SPEC §3.2)
    frame: false,
    transparent: true, // rounded corners + shadow
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: cfg.alwaysOnTop,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'host-preload.js'),
      webviewTag: true,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(cfg.alwaysOnTop, 'pop-up-menu');
  win.webContents.on('console-message', (_e, level, message) => {
    console.log(`[host ${level}] ${message}`);
  });
  win.loadFile(path.join(app.getAppPath(), 'renderer', 'host.html'));

  let guestFullscreen = false;
  // Persists across webview re-attaches (host reloads) so the full-reset
  // escape hatch runs at most once per app session.
  let hostResetDone = false;

  // The HOST window's own renderer can die too (rare, but it freezes the
  // flyout silently). Recover by reloading the host page, bounded like the
  // guest recovery.
  let hostCrashCount = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    hostCrashCount++;
    console.error(`[host] renderer gone (${details.reason}, exit ${details.exitCode}) — crash #${hostCrashCount}`);
    if (hostCrashCount > 3) return;
    setTimeout(() => win?.webContents.reload(), 1000 * hostCrashCount);
  });

  // Register the guest webview as a tab so extensions see it (chrome.tabs…).
  win.webContents.on('did-attach-webview', (_event, guest) => {
    // A guest WebContents can re-attach (host reload / full window reset).
    // Re-registering the whole block would double every listener and spawn a
    // second memTimer (observed: MaxListenersExceededWarning + reloads every
    // ~60s despite the 5-min cooldown). Wire each guest exactly once.
    if (attachedGuests.has(guest)) {
      console.warn('[nav] webview re-attached — skipping duplicate wiring');
      return;
    }
    attachedGuests.add(guest);
    console.log('[nav] webview attached');

    guest.on('did-start-loading', () => console.log('[nav] guest loading…'));
    guest.on('did-navigate', (_e, url) => console.log(`[nav] guest navigated: ${url}`));
    guest.on('did-fail-load', (_e, code, desc, url) =>
      console.log(`[nav] guest FAILED (${code}) ${desc} — ${url}`),
    );
    extApi?.addTab(guest, win!);
    guest.setZoomFactor(getConfig().zoomFactor);
    guest.on('enter-html-full-screen', () => { guestFullscreen = true; });
    guest.on('leave-html-full-screen', () => { guestFullscreen = false; });

    // Hide scrollbars (and optionally YouTube's header) on every document
    // load — insertCSS is per-document, so re-inject on each load.
    const injectGuestCss = (): void => {
      const css = GUEST_SCROLLBAR_CSS + (getConfig().hideYouTubeHeader ? GUEST_MASTHEAD_CSS : '');
      void guest.insertCSS(css).catch((err) => {
        console.warn('[webview] CSS injection failed:', err);
      });
    };
    guest.on('dom-ready', injectGuestCss);
    guest.on('did-finish-load', injectGuestCss);

    guest.on('did-finish-load', () => {
      smoke.pageLoaded = true;

      // Auto-resume (SPEC §4.4 FEATURE C): the "Continue watching?" dialog
      // matcher must run in the MAIN world (isolated worlds can't read text
      // from main-world elements — verified empirically). Re-injected on every
      // load; idempotent via the window flag.
      if (getConfig().autoResumeOnPause) {
        guest.executeJavaScript(MAIN_WORLD_RESUME_SCRIPT).catch((err) => {
          console.error('[resume] injection failed:', err);
        });
      }
    });

    // Navigation watchdog: if the FIRST load doesn't finish within 30s
    // (extension injection can starve the first navigation), reload — up to
    // 3 tries. Disarmed after the first successful load: a slow mid-session
    // navigation (or a heavy page) must NEVER cause a surprise reload.
    let tries = 0;
    let firstLoadDone = false;
    let navTimer: NodeJS.Timeout | null = null;
    const armWatchdog = (): void => {
      if (firstLoadDone) return;
      if (navTimer) clearTimeout(navTimer);
      navTimer = setTimeout(() => {
        if (tries < 3) {
          tries++;
          console.log(`[webview] first navigation stalled (${tries}/3), reloading`);
          guest.reload();
        }
      }, 30_000);
    };
    guest.on('did-start-loading', armWatchdog);
    guest.on('did-finish-load', () => {
      firstLoadDone = true;
      if (navTimer) clearTimeout(navTimer);
    });

    // Popups (e.g. Google sign-in) open in the default browser instead.
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    // Crash recovery with a cap + backoff: a crash loop (crash → reload →
    // crash) must stop after 3 tries instead of reloading forever and
    // appearing to "randomly reload then freeze". clean-exit is deliberate
    // teardown (e.g. quit), never a crash. If the loop still won't stop,
    // do ONE full window reset (fresh host + webview + process tree), then
    // surface a tray notification instead of freezing silently.
    let crashCount = 0;
    let crashTimer: NodeJS.Timeout | null = null;
    guest.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      // Intentional memory-guard reset: the renderer was force-crashed to shed
      // a bloated working set. Reload straight away — do NOT count it as a
      // crash (it would burn the 3-try backoff and trigger a full window
      // reset for something that is working as intended).
      if (memResetPending) {
        memResetPending = false;
        console.warn(
          `[mem] renderer restarted (${details.reason}) — fresh process, memory shed`,
        );
        setTimeout(() => guest.reload(), 500);
        return;
      }
      crashCount++;
      console.error(
        `[webview] renderer gone (${details.reason}, exit ${details.exitCode}) — crash #${crashCount}`,
      );
      if (crashCount > 3) {
        console.error('[webview] crash loop — attempting full window reset');
        if (!hostResetDone) {
          hostResetDone = true;
          setTimeout(() => win?.webContents.reload(), 500);
        } else {
          console.error('[webview] full reset already tried — giving up on auto-reload');
          try {
            tray?.displayBalloon({
              title: 'Y0uTube',
              content: 'YouTube keeps crashing in the background. Right-click the tray icon → “Reload YouTube” to bring it back.',
            });
          } catch {
            /* balloon may not be supported */
          }
        }
        return;
      }
      if (crashTimer) clearTimeout(crashTimer);
      crashTimer = setTimeout(() => guest.reload(), 1000 * crashCount);
    });
    guest.on('did-finish-load', () => {
      crashCount = 0;
    });

    // Memory guard: YouTube + extensions can balloon the guest renderer's
    // working set (observed ~1.7 GB before crashes), and Chromium then
    // OOM-crashes the process — which is what the "reload then freeze"
    // reports were. Restart the renderer BEFORE the crash: gently while
    // parked (invisible), at a higher threshold while the user is watching.
    // Cooldown so a heavy page is only restarted at most once per 5 minutes.
    //
    // Plain guest.reload() does NOT shed memory: it reuses the same renderer
    // process, so the bloated working set survives (observed: 1.4 -> 3.6 GB
    // across repeated reloads). The only way to actually free it is to kill
    // the renderer process; the render-process-gone handler then reloads a
    // fresh one. forcefullyCrashRenderer() is the sanctioned way to do that.
    let memStreak = 0;
    let lastMemReset = 0;
    const memTimer = setInterval(() => {
      // Electron 37 removed webContents.getProcessMemoryInfo(); match the
      // guest's renderer PID against app.getAppMetrics() instead.
      try {
        const pid = guest.getOSProcessId();
        const metric = app.getAppMetrics().find((m) => m.pid === pid);
        if (!metric) return;
        const mb = metric.memory.workingSetSize / 1024; // KB → MB
        const limit = parked ? 1000 : 1600; // MB
        if (mb > limit) {
          memStreak++;
          console.warn(
            `[mem] guest ${Math.round(mb)} MB (limit ${limit}, streak ${memStreak}/3)`,
          );
          if (memStreak >= 3) {
            memStreak = 0;
            const now = Date.now();
            if (now - lastMemReset > 5 * 60_000) {
              lastMemReset = now;
              console.warn(
                `[mem] sustained ${Math.round(mb)} MB — restarting guest renderer to shed memory`,
              );
              memResetPending = true;
              try {
                guest.forcefullyCrashRenderer();
              } catch {
                // webContents already gone; nothing to restart.
                memResetPending = false;
              }
            }
          }
        } else {
          memStreak = 0;
        }
      } catch {
        /* webContents destroyed mid-poll */
      }
    }, 20_000);
    guest.on('destroyed', () => clearInterval(memTimer));
    // Esc inside YouTube → dismiss (unless YouTube is fullscreen).
    guest.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && !guestFullscreen) {
        park();
      }
    });
  });

  // Click outside the flyout → dismiss (SPEC §3.4).
  win.on('blur', () => {
    if (parked || quitting) return;
    if (devtoolsOpen) return;
    park();
  });

  win.webContents.on('devtools-opened', () => {
    devtoolsOpen = true;
  });
  win.webContents.on('devtools-closed', () => {
    devtoolsOpen = false;
  });

  // Never quit when the window closes — the app lives in the tray (SPEC §3.4).
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      park();
    }
  });
}

function createTray() {
  // Prefer the multi-size tray.ico (crisp at every DPI); fall back to the
  // single-size PNG if it isn't present.
  const icoPath = path.join(app.getAppPath(), 'build', 'tray.ico');
  const pngPath = path.join(app.getAppPath(), 'build', 'tray.png');
  const icon = nativeImage.createFromPath(fs.existsSync(icoPath) ? icoPath : pngPath);
  tray = new Tray(icon);
  tray.setToolTip('Y0uTube — click to open YouTube');
  tray.on('click', toggleFlyout);

  const menu = Menu.buildFromTemplate([
    { label: 'Open/Close flyout', click: toggleFlyout },
    { type: 'separator' },
    {
      label: 'Reload YouTube',
      click: () => guestContents()?.reload(),
    },
    { label: 'Toggle DevTools', click: () => guestContents()?.toggleDevTools() },
    {
      label: 'Extensions folder…',
      click: () => shell.openPath(path.join(app.getPath('userData'), 'extensions')),
    },
    { label: 'Settings (config.json)…', click: () => shell.openPath(configFilePath()) },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

// ---------------------------------------------------------------------------
// IPC (config + zoom), used by host-preload and webview-preload
// ---------------------------------------------------------------------------

function setupIPC() {
  ipcMain.handle('get-config', () => getConfig());
  ipcMain.on('set-zoom-factor', (event, factor: number) => {
    if (typeof factor === 'number' && Number.isFinite(factor)) {
      event.sender.setZoomFactor(factor);
    }
  });
  ipcMain.handle('get-smoke-state', () => Object.assign({}, smoke));
}

// ---------------------------------------------------------------------------
// Smoke test (SPEC §8; `npm run smoke`)
// ---------------------------------------------------------------------------

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Runs in the guest's MAIN world. Auto-dismisses YouTube's
 * "Video paused. Continue watching?" dialog by clicking its "Yes" button.
 */
const MAIN_WORLD_RESUME_SCRIPT = `
(() => {
  if (window.__ttResumeInjected) return;
  window.__ttResumeInjected = true;
  const DIALOG_TAGS = 'yt-confirm-dialog-renderer, tp-yt-iron-dialog, ytd-modal-with-title-and-button-renderer, [class*="confirm-dialog"], [class*="tp-yt-iron-dialog"]';
  const clickYes = (root) => {
    if (root.__ttResumed) return;
    if (!/continue watching|video paused/i.test(root.textContent || '')) return;
    const buttons = Array.from(root.querySelectorAll('button'));
    const yes = buttons.find(b => b.textContent && b.textContent.trim().toLowerCase() === 'yes')
      || buttons.find(b => !b.disabled);
    if (!yes) return;
    root.__ttResumed = true;
    yes.click();
  };
  const scan = () => {
    document.querySelectorAll(DIALOG_TAGS).forEach(clickYes);
  };
  scan();
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(scan, 1000);
  document.documentElement.setAttribute('data-tt-resume-main', '1');
})();
`;

function recordSmoke(
  results: { check: string; ok: boolean; detail?: string }[],
  check: string,
  ok: boolean,
  detail?: string,
) {
  results.push({ check, ok, detail });
  const status = ok ? 'PASS' : 'FAIL';
  console.log('[smoke] ' + status + ' ' + check + (detail ? ' — ' + detail : ''));
}

async function guestEval<T>(script: string): Promise<T> {
  const guest = guestContents();
  if (!guest) throw new Error('guest webview not found');
  return guest.executeJavaScript(script, true) as Promise<T>;
}

type SmokeRecord = (check: string, ok: boolean, detail?: string) => void;

/**
 * Exercise the preload features by fabricating DOM state inside the guest:
 *   autoMute       — a fresh <video> + loadedmetadata must end up muted
 *   autoSkipAds    - an ENABLED fake skip button must be auto-clicked
 *   autoResumeOnPause — a "Continue watching?" dialog's Yes must be clicked
 */
async function runSmokeGuestChecks(record: SmokeRecord): Promise<void> {
  const preloadRan = await guestEval<boolean>(
    'document.documentElement.getAttribute("data-y0utube-preload") === "1"',
  ).catch(() => false);
  record('guest preload injected', preloadRan);

  // Wait for YouTube's shell to exist so fabricated nodes aren't swept away
  // by hydration (extensions change page timing).
  await guestEval<boolean>(
    '(async () => {' +
      'const t0 = Date.now();' +
      'while (Date.now() - t0 < 20000) {' +
      '  if (document.querySelector("ytd-app") || document.querySelector("#content")) return true;' +
      '  await new Promise(r => setTimeout(r, 300));' +
      '}' +
      'return false;' +
      '})()',
  ).catch(() => false);

  // Poll up to 45s for the feature setup markers (the config IPC can be slow
  // while extension backgrounds boot on first run).
  const feat = await guestEval<string>(
    '(async () => {' +
      'const g = () => document.documentElement ?? document;' +
      'const t0 = Date.now();' +
      'while (Date.now() - t0 < 20000) {' +
      '  if (g().getAttribute("data-tt-ready")) {' +
      '    const e = g();' +
      '    return JSON.stringify({ipcStart: e.getAttribute("data-tt-ipc-start"), ipcOk: e.getAttribute("data-tt-cfg-ok"), ipcErr: e.getAttribute("data-tt-cfg-err"), mute: e.getAttribute("data-tt-mute"), skip: e.getAttribute("data-tt-skip"), resumeMain: e.getAttribute("data-tt-resume-main")});' +
      '  }' +
      '  await new Promise(r => setTimeout(r, 500));' +
      '}' +
      'const e = g();' +
      'return JSON.stringify({timeout: true, fatal: e.getAttribute("data-tt-fatal"), ipcStart: e.getAttribute("data-tt-ipc-start"), ipcOk: e.getAttribute("data-tt-cfg-ok"), ipcErr: e.getAttribute("data-tt-cfg-err")});' +
      '})()',
  ).catch(() => '{}');
  record('preload features', feat.includes('"mute":"1"'), feat);

  // Auto-mute: a fresh <video> must end up muted. Dispatch loadedmetadata
  // AFTER the observer has had a chance to attach its listener.
  const muted = await guestEval<{ ok: boolean; detail: string }>(
    '(async () => {' +
      "const v = document.createElement('video');" +
      'document.body.appendChild(v);' +
      'await new Promise(r => setTimeout(r, 600));' +
      "v.dispatchEvent(new Event('loadedmetadata'));" +
      'await new Promise(r => setTimeout(r, 600));' +
      'const detail = "muted=" + v.muted + " connected=" + v.isConnected;' +
      'v.remove();' +
      'return { ok: detail.startsWith("muted=true"), detail };' +
      '})()',
  ).catch((e) => ({ ok: false, detail: String(e) }));
  record('autoMute', muted.ok, muted.detail);

  // Auto-skip: an ENABLED fake skip button must be auto-clicked.
  const skipped = await guestEval<{ ok: boolean; detail: string }>(
    '(async () => {' +
      "const b = document.createElement('button');" +
      "b.className = 'ytp-ad-skip-button';" +
      "b.textContent = 'Skip Ad';" +
      'b.disabled = false;' +
      "b.addEventListener('click', () => { b.dataset.trayClicked = '1'; });" +
      'document.body.appendChild(b);' +
      'await new Promise(r => setTimeout(r, 2000));' +
      'const detail = "clicked=" + (b.dataset.trayClicked === "1") + " connected=" + b.isConnected;' +
      'b.remove();' +
      'return { ok: detail.startsWith("clicked=true"), detail };' +
      '})()',
  ).catch((e) => ({ ok: false, detail: String(e) }));
  record('autoSkipAds', skipped.ok, skipped.detail);

  // Auto-resume: the "Continue watching?" dialog's Yes button must be clicked.
  const resumed = await guestEval<{ ok: boolean; detail: string }>(
    // The dialog is built with textContent (Trusted Types blocks innerHTML),
    // and the main-world auto-resume script must click its Yes button.
    '(async () => {' +
      // A plain div with the class: createElement('yt-confirm-dialog-renderer')
      // gets UPGRADED by YouTube's Polymer code when it registers the custom
      // element, which wipes the children we appended.
      "const d = document.createElement('div');" +
      "d.className = 'yt-confirm-dialog-renderer';" +
      "d.style.position = 'fixed';" +
      "const text = document.createElement('span');" +
      "text.textContent = 'Video paused. Continue watching?';" +
      'd.appendChild(text);' +
      "const yes = document.createElement('button');" +
      "yes.textContent = 'Yes';" +
      'd.appendChild(yes);' +
      "const no = document.createElement('button');" +
      "no.textContent = 'No';" +
      'd.appendChild(no);' +
      "yes.addEventListener('click', () => { d.dataset.clicked = '1'; });" +
      'document.body.appendChild(d);' +
      'await new Promise(r => setTimeout(r, 4000));' +
      'const detail = "clicked=" + (d.dataset.clicked === "1") + " connected=" + d.isConnected;' +
      'd.remove();' +
      'return { ok: detail.startsWith("clicked=true"), detail };' +
      '})()',
  ).catch((e) => ({ ok: false, detail: String(e) }));
  record('autoResumeOnPause', resumed.ok, resumed.detail);
}

/**
 * Optional end-to-end SponsorBlock probe (Y0UTUBE_SMOKE_SB_PROBE=1).
 * Navigates the guest to a real watch page and checks for the #previewbar
 * <ul>. That element only renders AFTER the content-script's storage bridge
 * resolved (Config.config loaded) AND segments were fetched — the exact path
 * that used to flake (~1/3 of first loads). Reported as a diagnostic, never
 * enforced: YouTube markup drift (4.7.1 is from 2022) can break the preview
 * bar independently of the storage bridge.
 */
async function sbProbe(record: SmokeRecord): Promise<void> {
  const guest = guestContents();
  if (!guest) {
    record('SB previewbar (probe)', false, 'no guest');
    return;
  }
  await guest.loadURL('https://www.youtube.com/watch?v=7dYTw-jAYkY').catch(() => {});
  await new Promise((r) => setTimeout(r, 6_000));
  try {
    const out = await guestEval<string>(
      '(async () => {' +
        'const t0 = Date.now();' +
        'while (Date.now() - t0 < 25000) {' +
        '  const bar = document.getElementById("previewbar");' +
        '  if (bar && bar.childElementCount > 0) {' +
        '    return JSON.stringify({previewbar: true, segments: bar.childElementCount});' +
        '  }' +
        '  await new Promise(r => setTimeout(r, 500));' +
        '}' +
        'return JSON.stringify({previewbar: false, segments: 0});' +
        '})()',
    );
    record('SB previewbar (probe)', out.includes('"previewbar":true'), out);
  } catch (e) {
    record('SB previewbar (probe)', false, String(e));
  }
}

async function runSmokeTest() {
  const results: { check: string; ok: boolean; detail?: string }[] = [];
  const record = (check: string, ok: boolean, detail?: string) =>
    recordSmoke(results, check, ok, detail);

  // Wait for YouTube to finish loading (up to 60s).
  const deadline = Date.now() + 60_000;
  while (!smoke.pageLoaded && Date.now() < deadline) {
    await sleep(500);
  }
  record('youtube page load', smoke.pageLoaded, smoke.pageLoaded ? undefined : 'timeout');

  const exts = SESSION.extensions.getAllExtensions();
  const ublock = exts.find((e) => /uBlock/i.test(e.name));
  record('uBlock loaded', !!ublock, ublock ? `${ublock.id}@${ublock.version}` : 'not installed');
  const ublockReady = smoke.extensionsReady.some((n) => /uBlock/i.test(n));
  record(
    'uBlock background ready',
    ublockReady,
    smoke.extensionsReady.length ? smoke.extensionsReady.join(', ') : 'none ready',
  );

  const sb = exts.find((e) => /SponsorBlock/i.test(e.name));
  if (sb) {
    record('SponsorBlock loaded', true, `${sb.id}@${sb.version}`);
    record('SponsorBlock background ready', smoke.extensionsReady.some((n) => /SponsorBlock/i.test(n)));
  } else {
    record('SponsorBlock loaded', true, 'not bundled (skipped)');
  }

  if (smoke.pageLoaded) {
    await runSmokeGuestChecks(record);
    // Optional: exercise the SponsorBlock content-script storage bridge
    // end-to-end (preview bar on a real watch page). Diagnostic only.
    if (process.env.Y0UTUBE_SMOKE_SB_PROBE === '1') {
      await sbProbe(record);
    }
  }

  console.log('\n[smoke — summary]');
  for (const r of results) console.log(`    ${r.ok ? 'PASS' : 'FAIL'}  ${r.check}${r.detail ? ' — ' + r.detail : ''}`);
  const fails = results.filter((r) => !r.ok);
  console.log(`[smoke] ${results.length - fails.length}/${results.length} checks passed`);
  console.log(JSON.stringify({ ok: fails.length === 0, results }));
  app.exit(fails.length > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  loadConfig();
  SESSION = session.defaultSession;

  setupIPC();

  // Keep the flyout to benign permissions.
  SESSION.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['fullscreen', 'media', 'notifications', 'clipboard-sanitized-write'];
    callback(allowed.includes(permission));
  });

  // Chrome extension API shim for the shared session (tabs, contextMenus,
  // notifications, …). uBlock/SponsorBlock rely on the APIs it provides.
  // Y0UTUBE_NO_ECE=1 disables it (diagnostic: ECE's session preload hooks
  // use deprecated Electron APIs and can interfere with webview attach).
  if (process.env.Y0UTUBE_NO_ECE !== '1') {
    // license: ECE 4.x requires declaring how the GPL-3.0 dependency is
    // distributed — the app has always shipped ECE as a dependency, so
    // GPL-3.0 is the truthful declaration (no change in licensing posture).
    extApi = new ElectronChromeExtensions({ session: SESSION, license: 'GPL-3.0' });
  }
  SESSION.extensions.on('extension-loaded', (_e, ext) => {
    console.log(`[ext] extension-added ${ext.name}`);
  });
  const readyIds = new Set<string>();
  SESSION.extensions.on('extension-ready', (_e, ext) => {
    readyIds.add(ext.id);
    smoke.extensionsReady.push(ext.name);
    console.log(`[ext] background ready ${ext.name} (${ext.version})`);
  });

  // Make sure bundled extensions are copied to userData, then load them all
  // BEFORE the flyout exists — the guest's first navigation then happens with
  // extensions already injected, avoiding first-load starvation.
  ensureBundledExtension('uBlock0.chromium');
  ensureBundledExtension('SponsorBlock');
  const loadedIds = await loadExtensions();

  // SPEC §4.3 CAVEAT 2 (SponsorBlock storage race): Electron's content-script
  // storage bridge can drop the chrome.storage.local.get callback when the
  // extension's browser-side state isn't initialized yet. Wait for every
  // loaded extension to fire 'extension-ready' (storage backend warm) before
  // the guest's first navigation — bounded so a stuck extension never blocks
  // startup.
  const readyDeadline = Date.now() + 15_000;
  while (loadedIds.some((id) => !readyIds.has(id)) && Date.now() < readyDeadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (loadedIds.some((id) => !readyIds.has(id))) {
    console.warn(`[ext] not ready within 15s: ${loadedIds.filter((id) => !readyIds.has(id)).join(', ')}`);
  }

  createFlyoutWindow();
  createTray();

  // Global hotkey to open/close the flyout from anywhere (SPEC-adjacent).
  // Registered after the window + tray exist so toggleFlyout can act.
  if (!IS_SMOKE) {
    const shortcut = getConfig().toggleShortcut;
    if (shortcut) {
      try {
        const ok = globalShortcut.register(shortcut, toggleFlyout);
        if (ok) {
          console.log(`[shortcut] registered "${shortcut}" to toggle the flyout`);
        } else {
          console.warn(`[shortcut] "${shortcut}" already taken by another app`);
        }
      } catch (err) {
        console.warn(`[shortcut] invalid accelerator "${shortcut}": ${err}`);
      }
    }
  }

  if (IS_SMOKE) {
    // Hard backstop so CI/scripts never hang on a wedged launch (SPEC §6).
    // The SB probe navigates to a watch page, so give it headroom.
    const backstopMs = process.env.Y0UTUBE_SMOKE_SB_PROBE === '1' ? 180_000 : 105_000;
    setTimeout(() => {
      console.error('[smoke] hard timeout — forcing exit');
      app.exit(2);
    }, backstopMs);
    setTimeout(() => runSmokeTest(), 5_000); // let the page + extensions settle
  }
});

// The app lives in the tray: closing the window must NOT quit (SPEC §3.4).
app.on('window-all-closed', () => {
  // The app lives in the tray: closing the window must NOT quit (SPEC §3.4).
});

// Log every child-process death (renderer, GPU, utility…) so crashes are
// diagnosable from the log file even when nothing else survives.
app.on('child-process-gone', (_e, details) => {
  console.error(
    `[child] ${details.type} process gone: ${details.reason} (exit ${details.exitCode})` +
      (details.serviceName ? ` service=${details.serviceName}` : ''),
  );
});

// Clean exit (SPEC §6): destroy the tray + window so no zombies hold the lock.
app.on('before-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
  try { tray?.destroy(); } catch { /* ignore */ }
  try { win?.destroy(); } catch { /* ignore */ }
});