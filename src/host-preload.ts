import { ipcRenderer } from 'electron';

/**
 * Runs in the host page (renderer/host.html) and CREATES the <webview>
 * dynamically. Verified empirically on file:// hosts with Electron 37:
 *   1. A webview whose src is assigned via JS after parse never attaches.
 *   2. A parser-created webview with static src attaches, but a `preload`
 *      attribute applied later misses the first navigation.
 *   3. A JS-created webview with preload+src set BEFORE insertion works —
 *      but only WITHOUT a `partition` attribute (partition at creation time
 *      kills the attach).
 * So: create here, set preload + src first, use the default session, and let
 * extensions live on the default session too (login state persists there).
 */

interface HostConfig {
  dragHandle: boolean;
}

function onDomReady(cb: () => void): void {
  if (document.readyState !== 'loading') {
    cb();
  } else {
    document.addEventListener('DOMContentLoaded', cb, { once: true });
  }
}

function createWebview(): void {
  const webview = document.createElement('webview');
  // Preload path: host page lives in <root>/renderer/, preload in <root>/dist/.
  webview.setAttribute('preload', new URL('../dist/webview-preload.js', window.location.href).href);
  webview.setAttribute('src', 'https://www.youtube.com');
  webview.setAttribute('style', 'flex:1;min-height:0;border:0');

  const shell = document.getElementById('shell');
  shell?.appendChild(webview);
}

async function init(): Promise<void> {
  onDomReady(createWebview);

  let cfg: HostConfig = { dragHandle: true };
  try {
    cfg = (await ipcRenderer.invoke('get-config')) as HostConfig;
  } catch {
    /* config IPC unavailable: keep defaults */
  }

  if (!cfg.dragHandle) {
    // RACE: this preload runs at document-start, and the config IPC can
    // resolve BEFORE <body> is parsed. document.body would be null and
    // classList.add would throw silently, leaving the drag strip visible
    // forever (observed in the wild). Defer until the body exists.
    const apply = (): void => {
      document.body?.classList.add('no-handle');
      // Belt and braces: physically remove the strip element so no top bar
      // can ever render, even if the CSS rule somehow failed to apply.
      document.getElementById('strip')?.remove();
    };
    if (document.body) apply();
    else document.addEventListener('DOMContentLoaded', apply, { once: true });
  }
}

void init();