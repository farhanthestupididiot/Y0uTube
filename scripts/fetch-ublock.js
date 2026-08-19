#!/usr/bin/env node
/**
 * Downloads the frozen uBlock Origin 1.52.2 (MV2) release zip and extracts it
 * to extensions/uBlock0.chromium so the app can bundle it.
 *
 * Why frozen: Google stopped serving MV2 from the Chrome Web Store, so uBlock
 * 1.52.2 (2024) is the last full-featured MV2 release (SPEC §4.2). Filter
 * lists decay; a from-source build path lives in build-ublock-mv2.js.
 *
 * Run: npm run fetch:ublock
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VERSION = '1.52.2';
const URL = `https://github.com/gorhill/uBlock/releases/download/${VERSION}/uBlock0_${VERSION}.chromium.zip`;
const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'work', 'ublock-download');
const DEST = path.join(ROOT, 'extensions', 'uBlock0.chromium');
const ZIP = path.join(TMP, 'ublock.zip');

function fail(msg) {
  console.error(`[fetch-ublock] ${msg}`);
  process.exit(1);
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.rmSync(ZIP, { force: true });

  console.log(`[fetch-ublock] downloading ${URL}`);
  const res = await fetch(URL);
  if (!res.ok) fail(`HTTP ${res.status} from GitHub`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(ZIP, buf);
  console.log(`[fetch-ublock] got ${(buf.length / 1024 / 1024).toFixed(1)} MiB`);

  const extracted = path.join(TMP, 'ex');
  fs.rmSync(extracted, { recursive: true, force: true });
  fs.mkdirSync(extracted, { recursive: true });

  // Try `unzip` (Git Bash / msys), else PowerShell Expand-Archive.
  try {
    execFileSync('unzip', ['-q', ZIP, '-d', extracted], { stdio: 'inherit' });
  } catch {
    try {
      execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${ZIP}' -DestinationPath '${extracted}' -Force`],
        { stdio: 'inherit' },
      );
    } catch {
      fail('could not extract zip (install unzip or use PowerShell)');
    }
  }

  // The zip contains uBlock0.chromium/ — locate its manifest.
  const manifestPath = path.join(extracted, 'uBlock0.chromium', 'manifest.json');
  if (!fs.existsSync(manifestPath)) fail('manifest.json not found in zip');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.manifest_version !== 2) fail(`expected MV2, got MV${manifest.manifest_version}`);
  if (!/uBlock Origin/.test(manifest.name || '')) fail(`unexpected name: ${manifest.name}`);

  fs.cpSync(path.join(extracted, 'uBlock0.chromium'), DEST, { recursive: true });
  console.log(`[fetch-ublock] installed to extensions/uBlock0.chromium (${manifest.name} ${manifest.version})`);
}

main().catch((e) => fail(e.message));