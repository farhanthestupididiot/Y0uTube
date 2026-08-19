import { app } from 'electron';
import fs from 'fs';
import path from 'path';

/**
 * Y0uTube settings, persisted to %APPDATA%\Y0uTube\config.json.
 * See SPEC §9. Unknown keys are dropped so a hand-edited file can't
 * inject garbage; missing keys fall back to defaults.
 */

export type Quadrant = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface Y0uTubeConfig {
  /** Which corner of the tray's display the flyout lands in. */
  quadrant: Quadrant;
  /** Base zoom applied to YouTube. 0.85 fits desktop YouTube in ~390px width. */
  zoomFactor: number;
  /** After every page load, shrink zoom (0.05 steps, min 0.5) until no horizontal overflow. */
  autoFitWidth: boolean;
  /** Show the top drag strip on the flyout. */
  dragHandle: boolean;
  /** Hide YouTube's own top header bar (logo/search/avatar) in the flyout. */
  hideYouTubeHeader: boolean;
  /** Global accelerator that toggles the flyout ('' disables). */
  toggleShortcut: string;
  alwaysOnTop: boolean;
  /** Desired flyout height; auto-shrinks to fit short screens. */
  windowHeight: number;
  /** Mute video when a watch page's video loads (initial state only). */
  autoMute: boolean;
  /** Auto-click YouTube's "Skip Ad" button when it becomes enabled. */
  autoSkipAds: boolean;
  /** Auto-dismiss the "Video paused. Continue watching?" dialog. */
  autoResumeOnPause: boolean;
}

export const DEFAULT_CONFIG: Y0uTubeConfig = {
  quadrant: 'bottom-right',
  zoomFactor: 0.85,
  autoFitWidth: true,
  dragHandle: false,
  hideYouTubeHeader: false,
  toggleShortcut: 'CommandOrControl+Shift+~',
  alwaysOnTop: true,
  windowHeight: 844,
  autoMute: false,
  autoSkipAds: true,
  autoResumeOnPause: true,
};

const QUADRANTS: Quadrant[] = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];

function sanitize(raw: unknown): Partial<Y0uTubeConfig> {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<Y0uTubeConfig> = {};
  if (typeof r.quadrant === 'string' && (QUADRANTS as string[]).includes(r.quadrant)) {
    out.quadrant = r.quadrant as Quadrant;
  }
  if (typeof r.zoomFactor === 'number' && r.zoomFactor >= 0.5 && r.zoomFactor <= 2) {
    out.zoomFactor = r.zoomFactor;
  }
  for (const key of [
    'autoFitWidth',
    'dragHandle',
    'hideYouTubeHeader',
    'alwaysOnTop',
    'autoMute',
    'autoSkipAds',
    'autoResumeOnPause',
  ] as const) {
    if (typeof r[key] === 'boolean') out[key] = r[key] as boolean;
  }
  if (typeof r.toggleShortcut === 'string' && r.toggleShortcut.trim() && r.toggleShortcut.length <= 100) {
    out.toggleShortcut = r.toggleShortcut;
  }
  if (typeof r.windowHeight === 'number' && r.windowHeight >= 200 && r.windowHeight <= 1400) {
    out.windowHeight = Math.round(r.windowHeight);
  }
  return out;
}

let current: Y0uTubeConfig = { ...DEFAULT_CONFIG };

/** Path to the persisted config file. */
export function configFilePath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

/** Load config from disk (missing/corrupt file => defaults). */
export function loadConfig(): Y0uTubeConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configFilePath(), 'utf8')) as unknown;
    current = { ...DEFAULT_CONFIG, ...sanitize(raw) };
  } catch {
    current = { ...DEFAULT_CONFIG };
    // Persist defaults so the file exists for the user to inspect.
    try {
      saveConfig({});
    } catch {
      /* userData may not be ready yet; ignore */
    }
  }
  return current;
}

export function getConfig(): Y0uTubeConfig {
  return current;
}

/** Persist a partial update (merges over current config). */
export function saveConfig(patch: Partial<Y0uTubeConfig>): Y0uTubeConfig {
  current = { ...current, ...patch };
  const dir = path.dirname(configFilePath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configFilePath(), JSON.stringify(current, null, 2));
  return current;
}
