#!/usr/bin/env node
/**
 * Builds uBlock Origin 1.52.2 (the frozen MV2 release) FROM SOURCE.
 * This is the maintenance path for when the release zip gets too old to
 * trust (SPEC §4.2 TODO): the zip download (fetch-ublock.js) installs the
 * exact same artifact today.
 *
 * Flow (mirrors the uBlock dev workflow):
 *   1. git clone --depth 1 --branch 1.52.2
 *   2. make chromium   -> dist/build/uBlock0.chromium
 *      (requires GNU make + python3 in PATH, as the uBlock Makefile does)
 *   3. If the uAssets submodule pull fails (it is a very large repo), build
 *      again with an empty uAssets dir — uBlock then fetches all filter
 *      lists from the network on first run, which is what users get anyway.
 *   4. Validate the manifest (must be MV2, "uBlock Origin") and stage to
 *      extensions/uBlock0.chromium.
 *
 * Run: npm run ub:build    (override tag: npm run ub:build -- 1.53.0)
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = 'https://github.com/gorhill/uBlock.git';
const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, 'work', 'ublock-src');
const DEST = path.join(ROOT, 'extensions', 'uBlock0.chromium');

let tag = process.env.UB_TAG || '1.52.2';
const candidate = process.argv[2];
if (candidate) tag = candidate;

function fail(msg) {
  console.error(`[ub] ${msg}`);
  process.exit(1);
}

function sh(cmd, args, opts = {}) {
  console.log(`[ub] ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  return r.status === 0;
}

// ---------------------------------------------------------------------------
// 1. Clone
// ---------------------------------------------------------------------------

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.dirname(WORK), { recursive: true });
if (!sh('git', ['clone', '--depth', '1', '--branch', tag, REPO, WORK])) fail('clone failed');

// ---------------------------------------------------------------------------
// 2. Build (make chromium)
// ---------------------------------------------------------------------------

const makeOpts = { cwd: WORK, timeout: 15 * 60 * 1000 };
let built = sh('make', ['chromium'], makeOpts);

if (!built) {
  // Retry without the uAssets filter submodule — often huge/slow to pull.
  console.log('[ub] full build failed; retrying with EMPTY uAssets (filter lists will be fetched at runtime)');
  fs.mkdirSync(path.join(WORK, 'dist', 'build', 'uAssets'), { recursive: true });
  built = sh('make', ['chromium'], makeOpts);
}

const outDir = path.join(WORK, 'dist', 'build', 'uBlock0.chromium');
if (!built || !fs.existsSync(path.join(outDir, 'manifest.json'))) {
  fail(
    'chromium build failed. Prerequisites: GNU make + python3 on PATH (git-bash has make). ' +
      'If the toolchain is unavailable, use `npm run fetch:ublock` — it installs the identical 1.52.2 artifact.',
  );
}

// ---------------------------------------------------------------------------
// 3. Validate + copy
// ---------------------------------------------------------------------------

const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 2) fail(`expected MV2, got MV${manifest.manifest_version}`);
if (!/uBlock Origin/.test(manifest.name || '')) fail(`unexpected name: ${manifest.name}`);

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.cpSync(outDir, DEST, { recursive: true });

console.log(`[ub] done — installed to extensions/uBlock0.chromium (${manifest.name} ${manifest.version}, tag ${tag})`);