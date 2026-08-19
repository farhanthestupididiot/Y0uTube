#!/usr/bin/env node
/**
 * Generates build/tray.png and build/icon.ico with ZERO dependencies:
 * - YouTube-style glyph: red rounded square + white play triangle
 * - Pure-Node PNG encoder (zlib deflate) and PNG-inside-ICO wrapper
 * - 2x2 supersampling per pixel for edge smoothing
 *
 * Run: npm run gen:icons
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'build');

const RED = { r: 255, g: 0, b: 0 };
const WHITE = { r: 255, g: 255, b: 255 };

/** Glyph test in normalized coordinates (0..1). Returns WHITE or RED or null. */
function glyph(x, y) {
  const x0 = 0.03, y0 = 0.03, x1 = 0.97, y1 = 0.97, r = 0.22;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx, dy = y - cy;
  if (dx * dx + dy * dy > r * r) return null; // outside rounded rect

  // Play triangle: vertical left edge at 0.42, slanted edges to (0.72, 0.5).
  const ax = 0.42, ay = 0.31, bx = 0.42, by = 0.69, cx2 = 0.72, cy2 = 0.5;
  if (x >= ax) {
    const onAC = ay + ((x - ax) * (cy2 - ay)) / (cx2 - ax);
    const onBC = by + ((x - bx) * (cy2 - by)) / (cx2 - bx);
    if (y >= onAC && y <= onBC) return WHITE;
  }
  return RED;
}

/** Render one RGBA canvas of size s with 2x2 supersampling. */
function render(s) {
  const buf = Buffer.alloc(s * s * 4);
  for (let py = 0; py < s; py++) {
    for (let px = 0; px < s; px++) {
      let hits = 0;
      for (const ox of [0.25, 0.75]) {
        for (const oy of [0.25, 0.75]) {
          if (glyph((px + ox) / s, (py + oy) / s)) hits++;
        }
      }
      const i = (py * s + px) * 4;
      if (hits === 0) {
        buf[i + 3] = 0;
      } else {
        buf[i] = RED.r;
        buf[i + 1] = RED.g;
        buf[i + 2] = RED.b;
        buf[i + 3] = Math.round((hits / 4) * 255);
      }
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// PNG encoder
// ---------------------------------------------------------------------------

function crc32(data) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(data) >>> 0;
  // Fallback table-based CRC-32 for Node < 22.2.
  let table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// ICO container (PNG-compressed entries are supported on Vista+)
// ---------------------------------------------------------------------------

function toICO(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const p of pngs) {
    const e = Buffer.alloc(16);
    e[0] = p.size >= 256 ? 0 : p.size;
    e[1] = p.size >= 256 ? 0 : p.size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(p.png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += p.png.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.png)]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fs.mkdirSync(OUT_DIR, { recursive: true });

fs.writeFileSync(path.join(OUT_DIR, 'tray.png'), encodePNG(32, render(32)));
console.log('wrote build/tray.png (32x32)');

const sizes = [16, 24, 32, 48, 64, 128, 256];
fs.writeFileSync(
  path.join(OUT_DIR, 'icon.ico'),
  toICO(sizes.map((s) => ({ size: s, png: encodePNG(s, render(s)) }))),
);
console.log(`wrote build/icon.ico (${sizes.join(',')}px)`);