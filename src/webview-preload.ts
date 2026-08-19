import { ipcRenderer } from 'electron';

/**
 * Runs inside the YouTube guest page (sandboxed preload of the <webview>).
 * Implements SPEC §3.6 (width fitting) and §4.4 (auto-mute / auto-skip /
 * auto-resume). All toggles come from config.json via IPC and default on.
 *
 * Design notes:
 * - Zoom changes MUST go through main (webContents.setZoomFactor) — the
 *   sandboxed preload cannot set the page zoom itself.
 * - All observers watch the whole document (YouTube is an SPA; video nodes,
 *   skip buttons and dialogs are created/destroyed on every navigation), and
 *   are backed by periodic rescans so nothing is missed.
 */

interface GuestConfig {
  zoomFactor: number;
  autoFitWidth: boolean;
  autoMute: boolean;
  autoSkipAds: boolean;
  autoResumeOnPause: boolean;
}

const watchers: MutationObserver[] = [];

function observe(root: Node | null, cb: () => void, opts: MutationObserverInit): void {
  // documentElement can be null at document-start; defer until the DOM exists.
  if (!root) {
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        if (document.documentElement) observe(document.documentElement, cb, opts);
      },
      { once: true },
    );
    return;
  }
  const mo = new MutationObserver(() => cb());
  mo.observe(root, opts);
  watchers.push(mo);
}

// ---------------------------------------------------------------------------
// Scrollbar hiding
// ---------------------------------------------------------------------------
// Windows Chromium paints fat overlay-less scrollbars (right + bottom) over
// the phone-sized viewport. Hide the scrollbar CHROME while keeping scroll
// behavior intact. Injected from the isolated world; <style> applies to the
// main world's rendering.

function hideScrollbars(): void {
  const style = document.createElement('style');
  style.textContent = `
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
  const inject = (): void => {
    (document.head ?? document.documentElement).appendChild(style);
  };
  if (document.head || document.documentElement) inject();
  else document.addEventListener('DOMContentLoaded', inject, { once: true });
}

// ---------------------------------------------------------------------------
// Width fitting (SPEC §3.6)
// ---------------------------------------------------------------------------
// Desktop YouTube at ~390px overflows on the watch page. After every page
// load, shrink zoom from the configured base in 0.05 steps (min 0.5) until
// scrollWidth <= innerWidth. A viewport meta injection is a documented no-op;
// zoom is the only reliable path.

function setupZoomFit(cfg: GuestConfig): void {
  const base = cfg.zoomFactor;

  const fit = async (): Promise<void> => {
    if (!cfg.autoFitWidth) {
      ipcRenderer.send('set-zoom-factor', base);
      return;
    }
    let factor = base;
    while (factor >= 0.5) {
      ipcRenderer.send('set-zoom-factor', factor);
      // Give Chromium a moment to reflow at the new zoom before measuring.
      await new Promise((r) => setTimeout(r, 600));
      if (document.documentElement.scrollWidth <= window.innerWidth) return;
      factor = Math.max(0.5, factor - 0.05);
    }
  };

  window.addEventListener('load', () => void fit());
  document.addEventListener('DOMContentLoaded', () => void fit());
  // SPA navigation within youtube.com.
  window.addEventListener('yt-navigate-finish', () => void fit());
}

// ---------------------------------------------------------------------------
// Auto-mute (SPEC §4.4 FEATURE A)
// ---------------------------------------------------------------------------
// Mute on loadedmetadata — initial state only, so the user can unmute via
// YouTube's own volume control afterwards.

function setupAutoMute(): void {
  const attach = (v: HTMLVideoElement): void => {
    if ((v as HTMLVideoElement & { __ttMuted?: boolean }).__ttMuted) return;
    (v as HTMLVideoElement & { __ttMuted?: boolean }).__ttMuted = true;
    const mute = (): void => {
      v.muted = true;
    };
    // `once` — initial state only; later user unmutes are respected.
    v.addEventListener('loadedmetadata', mute, { once: true });
    if (v.readyState > 0) mute();
  };

  const scan = (): void => document.querySelectorAll('video').forEach(attach);

  scan();
  observe(document.documentElement, scan, { childList: true, subtree: true });
  setInterval(scan, 2000);
}

// ---------------------------------------------------------------------------
// Auto-skip ads (SPEC §4.4 FEATURE B)
// ---------------------------------------------------------------------------
// uBlock handles most ads; this is the fallback for what slips through,
// including mid-rolls. Watch for both current and "modern" skip buttons and
// click only when ENABLED (the button appears disabled during the 5s countdown).

function setupAutoSkipAds(): void {
  const clickIfReady = (btn: HTMLButtonElement | null): void => {
    if (!btn || btn.disabled) return;
    if ((btn as HTMLButtonElement & { __ttSkipped?: boolean }).__ttSkipped) return;
    (btn as HTMLButtonElement & { __ttSkipped?: boolean }).__ttSkipped = true;
    btn.click();
  };

  const scan = (): void => {
    clickIfReady(document.querySelector('.ytp-ad-skip-button'));
    clickIfReady(document.querySelector('.ytp-ad-skip-button-modern'));
  };

  scan();
  observe(
    document.documentElement,
    scan,
    {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'class'],
    },
  );
  setInterval(scan, 1000);
}

// ---------------------------------------------------------------------------
// Auto-resume (SPEC §4.4 FEATURE C) — NOT here.
// ---------------------------------------------------------------------------
// Auto-dismissing the "Video paused. Continue watching?" dialog runs in the
// MAIN world, injected by main.ts via executeJavaScript. Reason (verified
// empirically): this preload executes in an isolated world, and isolated
// worlds cannot read text content from elements created in the main world
// (textContent returns '' or throws) — so text-matching on YouTube's real
// dialogs would never work from here.

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

// Marker so smoke tests can prove this preload ran in the page. Must be a DOM
// attribute: preloads run in an isolated world, invisible to main-world eval.
function markPreloadRan(): void {
  if (document.documentElement) {
    document.documentElement.setAttribute('data-y0utube-preload', '1');
  } else {
    document.addEventListener('DOMContentLoaded', markPreloadRan, { once: true });
  }
}
markPreloadRan();

async function init(): Promise<void> {
  const host = window.location.hostname;
  if (host !== 'www.youtube.com' && host !== 'youtube.com' && host !== 'music.youtube.com') {
    return;
  }

  // documentElement may not exist yet at document-start — defer the marker
  // until it does (Document has no setAttribute; only Element does).
  const mark = (name: string, value = '1'): void => {
    const apply = (): void => {
      if (document.documentElement) {
        document.documentElement.setAttribute(`data-tt-${name}`, value);
      }
    };
    if (document.documentElement) apply();
    else document.addEventListener('DOMContentLoaded', apply, { once: true });
  };
  mark('ipc-start', String(Date.now()));

  let cfg: GuestConfig;
  try {
    cfg = (await ipcRenderer.invoke('get-config')) as GuestConfig;
    mark('cfg-ok', String(Date.now()));
  } catch (err) {
    mark('cfg-err', String(err));
    cfg = {
      zoomFactor: 0.85,
      autoFitWidth: true,
      autoMute: true,
      autoSkipAds: true,
      autoResumeOnPause: true,
    };
  }

  hideScrollbars();
  setupZoomFit(cfg);
  if (cfg.autoMute) { setupAutoMute(); mark('mute'); }
  if (cfg.autoSkipAds) { setupAutoSkipAds(); mark('skip'); }
  mark('ready');
}

void init().catch((err: unknown) => {
  console.error('[webview-preload] init failed:', err);
  if (document.documentElement) {
    document.documentElement.setAttribute('data-tt-fatal', String(err));
  }
});