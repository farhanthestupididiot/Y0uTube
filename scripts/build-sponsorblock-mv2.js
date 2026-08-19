#!/usr/bin/env node
/**
 * Builds SponsorBlock 4.7.1 (the last MV2 tag) from source for Electron.
 * SponsorBlock went MV3-only in v5.0; no community MV2 build exists (SPEC §4.3).
 *
 * Patches applied before the webpack build:
 *   PATCH 1 — src/config.ts: chrome.storage.sync -> chrome.storage.local.
 *     Electron never implemented the sync area ("sync is not available in
 *     this instance of Chrome"); SponsorBlock routes ALL settings through
 *     sync, so without this alias Config.config === null and everything
 *     times out.
 *   PATCH 2 — manifest.json: background.persistent false -> true.
 *     Electron only eagerly boots PERSISTENT background pages; event pages
 *     (persistent:false) never start.
 *   PATCH 3 — src/config.ts: retry-wrapped fetchConfig storage reads.
 *     Electron's content-script storage bridge occasionally never invokes the
 *     chrome.storage.local.get callback on first load (~1/3 of launches),
 *     leaving Config.config null until a page reload. Retry until a call
 *     returns (or budget exhausted), so setupConfig always completes.
 *
 * Run: npm run sb:install    (override tag with: npm run sb:install -- 4.7.1)
 * Output: extensions/SponsorBlock/
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = 'https://github.com/ajayyy/SponsorBlock.git';
const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, 'work', 'sponsorblock-src');
const DEST = path.join(ROOT, 'extensions', 'SponsorBlock');

let tag = process.env.SB_TAG || '4.7.1';
const candidate = process.argv[2];
if (candidate) tag = candidate;

function fail(msg) {
  console.error(`[sp] ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const line = [cmd, ...args].map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');
  console.log(`[sp] ${line}`);
  // shell:true — npm is a .cmd shim on Windows and spawnSync won't resolve it.
  const r = spawnSync(line, [], { stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) fail(`${cmd} failed (exit ${r.status})`);
}

// ---------------------------------------------------------------------------
// 1. Clone the tag
// ---------------------------------------------------------------------------

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.dirname(WORK), { recursive: true });
run('git', ['clone', '--depth', '1', '--branch', tag, REPO, WORK]);

// ---------------------------------------------------------------------------
// 2. Apply the two Electron compat patches
// ---------------------------------------------------------------------------

const cfgPath = path.join(WORK, 'src', 'config.ts');
// At 4.7.1 the manifest lives in manifest/manifest.json; the webpack build
// merges it with browser extras into dist/manifest.json (webpack.manifest.js).
const manifestPath = path.join(WORK, 'manifest', 'manifest.json');
if (!fs.existsSync(cfgPath)) fail(`expected src/config.ts at tag ${tag}`);
if (!fs.existsSync(manifestPath)) fail(`manifest/manifest.json missing in checkout (tag ${tag})`);

let cfg = fs.readFileSync(cfgPath, 'utf8');
// git autocrlf can leave CRLF on Windows checkouts; normalize so the exact
// PATCH 3 string match (LF-only) is stable across machines.
cfg = cfg.replace(/\r\n/g, '\n');
if (!cfg.includes('chrome.storage.')) fail('src/config.ts has no storage calls; patch assumptions changed');
cfg = cfg.replace(/chrome\.storage\.sync/g, 'chrome.storage.local');
fs.writeFileSync(cfgPath, cfg);
console.log('[sp] PATCH: src/config.ts storage.sync -> storage.local');

// PATCH 3 — fetchConfig must always resolve. Electron's content-script storage
// bridge can drop the get callback on first load; retry until one returns.
const fetchConfigOld =
  'async function fetchConfig(): Promise<void> {\n' +
  '    await Promise.all([new Promise<void>((resolve) => {\n' +
  '        chrome.storage.local.get(null, function(items) {\n' +
  '            Config.cachedSyncConfig = <SBConfig> <unknown> items;\n' +
  '            resolve();\n' +
  '        });\n' +
  '    }), new Promise<void>((resolve) => {\n' +
  '        chrome.storage.local.get(null, function(items) {\n' +
  '            Config.cachedLocalStorage = <SBStorage> <unknown> items;\n' +
  '            resolve();\n' +
  '        });\n' +
  '    })]);\n' +
  '}'; // PATCH 1 runs first, so fetchConfig reads chrome.storage.local here.
const fetchConfigNew =
  'async function fetchConfig(): Promise<void> {\n' +
  '    await Promise.all([new Promise<void>((resolve) => {\n' +
  '        // PATCH 3 (Y0uTube): Electron\'s content-script storage bridge can\n' +
  '        // drop the get callback on first load (~1/3 of launches). Keep\n' +
  '        // retrying until a call returns; resolve with defaults as a last\n' +
  '        // resort so setupConfig() always completes (features then work\n' +
  '        // with default settings instead of hanging).\n' +
  '        let done = false;\n' +
  '        let attempts = 0;\n' +
  '        const attempt = () => {\n' +
  '            if (done) return;\n' +
  '            chrome.storage.local.get(null, function(items) {\n' +
  '                if (done) return;\n' +
  '                done = true;\n' +
  '                Config.cachedSyncConfig = <SBConfig> <unknown> items;\n' +
  '                resolve();\n' +
  '            });\n' +
  '            attempts++;\n' +
  '            if (attempts < 30) {\n' +
  '                setTimeout(attempt, 500);\n' +
  '            } else if (!done) {\n' +
  '                done = true;\n' +
  '                Config.cachedSyncConfig = <SBConfig> <unknown> {};\n' +
  '                resolve();\n' +
  '            }\n' +
  '        };\n' +
  '        attempt();\n' +
  '    }), new Promise<void>((resolve) => {\n' +
  '        let done = false;\n' +
  '        let attempts = 0;\n' +
  '        const attempt = () => {\n' +
  '            if (done) return;\n' +
  '            chrome.storage.local.get(null, function(items) {\n' +
  '                if (done) return;\n' +
  '                done = true;\n' +
  '                Config.cachedLocalStorage = <SBStorage> <unknown> items;\n' +
  '                resolve();\n' +
  '            });\n' +
  '            attempts++;\n' +
  '            if (attempts < 30) {\n' +
  '                setTimeout(attempt, 500);\n' +
  '            } else if (!done) {\n' +
  '                done = true;\n' +
  '                Config.cachedLocalStorage = <SBStorage> <unknown> {};\n' +
  '                resolve();\n' +
  '            }\n' +
  '        };\n' +
  '        attempt();\n' +
  '    })]);\n' +
  '}';
const fetchConfigIdx = cfg.indexOf(fetchConfigOld);
if (fetchConfigIdx === -1) {
  fail('PATCH 3: fetchConfig pattern not found; patch assumptions changed');
}
cfg = cfg.slice(0, fetchConfigIdx) + fetchConfigNew + cfg.slice(fetchConfigIdx + fetchConfigOld.length);
fs.writeFileSync(cfgPath, cfg);
console.log('[sp] PATCH: src/config.ts fetchConfig retry-wrapped');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.manifest_version !== 2) {
  fail(`expected MV2 manifest, got manifest_version=${manifest.manifest_version} at tag ${tag}`);
}
// MV2 defaults persistent to true when omitted, but make it EXPLICIT so the
// webpack-built dist manifest always asks for an eagerly-booted background
// page (event pages never start in Electron — SPEC §4.3 PATCH 2).
// The base manifest already says true; crucially chrome-manifest-extra.json
// overrides it to false during BuildManifest's merge — patch that too.
if (!manifest.background) manifest.background = {};
manifest.background.persistent = true;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
const chromeExtraPath = path.join(WORK, 'manifest', 'chrome-manifest-extra.json');
if (fs.existsSync(chromeExtraPath)) {
  const extra = JSON.parse(fs.readFileSync(chromeExtraPath, 'utf8'));
  if (extra.background) {
    extra.background.persistent = true;
    fs.writeFileSync(chromeExtraPath, JSON.stringify(extra, null, 2) + '\n');
  }
}
console.log('[sp] PATCH: manifest background.persistent -> true (source + chrome extra)');

// ---------------------------------------------------------------------------
// 3. Install deps and run the webpack build
// ---------------------------------------------------------------------------

// The build imports ../config.json (API keys); the repo ships an example.
const exampleCfg = path.join(WORK, 'config.json.example');
if (fs.existsSync(exampleCfg)) {
  fs.copyFileSync(exampleCfg, path.join(WORK, 'config.json'));
}

run('npm', ['install', '--no-audit', '--no-fund'], { cwd: WORK });
run('npm', ['run', 'build:chrome'], { cwd: WORK });

// ---------------------------------------------------------------------------
// 4. Stage into extensions/SponsorBlock and validate manifest references
// ---------------------------------------------------------------------------

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

/** Copy the CONTENTS of srcDir so files land at destDir's root. */
const copyContents = (srcDir, destDir) => {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir)) {
    fs.cpSync(path.join(srcDir, entry), path.join(destDir, entry), { recursive: true });
  }
};

// dist/ carries the merged manifest.json AND all built assets — its contents
// must land at the EXTENSION ROOT (the loader requires manifest.json there).
copyContents(path.join(WORK, 'dist'), DEST);
// Older tags may keep icons/_locales outside dist; merge if present.
for (const rel of ['icons', '_locales', 'lib', 'public', 'LICENSE', 'README.md']) {
  const src = path.join(WORK, rel);
  if (fs.existsSync(src)) copyContents(src, DEST);
}

const stagedManifest = JSON.parse(fs.readFileSync(path.join(DEST, 'manifest.json'), 'utf8'));
const refs = [];
if (stagedManifest.background) refs.push(...(stagedManifest.background.scripts || []));
for (const c of stagedManifest.content_scripts || []) {
  refs.push(...(c.js || []), ...(c.css || []));
}
if (stagedManifest.options_ui && stagedManifest.options_ui.page) refs.push(stagedManifest.options_ui.page);
if ((stagedManifest.browser_action || stagedManifest.action || {}).default_popup) {
  refs.push((stagedManifest.browser_action || stagedManifest.action).default_popup);
}
for (const w of stagedManifest.web_accessible_resources || []) {
  refs.push(...(Array.isArray(w) ? w : w.resources || []));
}

const missing = refs.filter((r) => r && !fs.existsSync(path.join(DEST, r)));
if (missing.length) {
  console.error(`[sp] WARNING: staged manifest references missing files:\n  ${missing.join('\n  ')}`);
} else {
  console.log('[sp] all manifest-referenced files staged OK');
}

console.log(`[sp] done — installed to extensions/SponsorBlock (${stagedManifest.name || 'SponsorBlock'} ${stagedManifest.version || '?'}, tag ${tag})`);