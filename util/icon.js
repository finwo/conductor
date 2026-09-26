// util/icon.js - draws the conductor mark, writes web/src/assets

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const GRID = 1024;

// Square clipped by a diamond, as in the cq mark.
const K = 1.45;

// Design units, measured from the centre.
export const DEFAULTS = {
  outer:   360,
  stroke:  112,
  start:    32,
  reach:   440,
  stretch:  32,
};

// Break cut to the inner octagon's corner, so no sliver of limb survives it.
function breakHeight(inner, stretch) {
  return 2 * (inner * (K - 1) + stretch);
}

// Slice leaving the limbs' horizontal face (stroke-d) and vertical face
// (stroke*(K-1)+d) equal, both at stroke*K/2.
function limbTrim(stroke) {
  return (stroke * (2 - K)) / 2;
}

function octagon(r) {
  const limit = r * K;
  return (x, y) => {
    const ax = Math.abs(x), ay = Math.abs(y);
    return ax <= r && ay <= r && ax + ay <= limit;
  };
}

// Clockwise from the upper right flat. Every corner sits off the axis, so
// the stretch displaces all eight.
function corners(r, stretch) {
  const c = r * K - r;
  const t = c + stretch, s = r + stretch;
  return [[r, -t], [c, -s], [-c, -s], [-r, -t], [-r, t], [-c, s], [c, s], [r, t]];
}

// Ring, stretch, break, slice, bar. Stretching after the cuts would drag
// them out of true; the bar goes last so the slice does not shorten it.
export function mark(opts = {}) {
  const { outer, stroke, start, reach, stretch } = { ...DEFAULTS, ...opts };
  const inner = outer - stroke;
  const gap = opts.gap ?? breakHeight(inner, stretch);
  const trim = opts.trim ?? limbTrim(stroke);
  const ring = octagon(outer);
  const hole = octagon(inner);
  return (x, y) => {
    // Pulled apart at the seam; the limbs are uniform there, so the
    // duplicated band reads as a taller octagon rather than a tear.
    const yy = y > 0 ? y - stretch : y + stretch;
    let on = ring(x, yy) && !hole(x, yy);
    if (x >= 0 && Math.abs(y) <= gap / 2) on = false;
    if (x > outer - trim) on = false;
    if (x >= start && x <= reach && Math.abs(y) <= stroke / 2) on = true;
    return on;
  };
}

// Small icons need the antialiasing, large ones are nearly all interior.
function sampling(size) {
  return Math.min(16, Math.max(2, Math.round(512 / size)));
}

// Coverage per pixel, 0..255.
export function raster(size, shape = mark(), samples = sampling(size)) {
  const out = new Uint8Array(size * size);
  const scale = GRID / size;
  const step = 1 / samples;
  const total = samples * samples;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hit = 0;
      for (let sy = 0; sy < samples; sy++) {
        const y = (py + (sy + 0.5) * step) * scale - GRID / 2;
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) * step) * scale - GRID / 2;
          if (shape(x, y)) hit++;
        }
      }
      out[py * size + px] = Math.round((hit * 255) / total);
    }
  }
  return out;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// Colour type 4, greyscale with alpha. A null bg stays transparent, a value
// composites against it.
export function png(size, coverage, ink = 0x00, bg = null) {
  const raw = Buffer.alloc(size * (1 + size * 2));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;
    for (let x = 0; x < size; x++) {
      const a = coverage[y * size + x];
      raw[p++] = bg === null ? ink : Math.round((ink * a + bg * (255 - a)) / 255);
      raw[p++] = bg === null ? a : 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 4;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function svg(opts = {}) {
  const { outer, stroke, start, reach, stretch } = { ...DEFAULTS, ...opts };
  const inner = outer - stroke;
  const gap = opts.gap ?? breakHeight(inner, stretch);
  const trim = opts.trim ?? limbTrim(stroke);
  const c = GRID / 2;
  const n = (v) => +v.toFixed(3);
  const points = (r) => corners(r, stretch).map(([x, y]) => `${n(c + x)},${n(c + y)}`).join(' ');
  // Same steps, same order as mark().
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" width="${GRID}" height="${GRID}">
  <style>:root{color:#1c1f23}@media(prefers-color-scheme:dark){:root{color:#e7e9ea}}</style>
  <mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="${GRID}" height="${GRID}">
    <polygon points="${points(outer)}" fill="#fff"/>
    <polygon points="${points(inner)}" fill="#000"/>
    <rect x="${c}" y="${n(c - gap / 2)}" width="${c}" height="${n(gap)}" fill="#000"/>
    <rect x="${n(c + outer - trim)}" y="0" width="${c}" height="${GRID}" fill="#000"/>
    <rect x="${n(c + start)}" y="${n(c - stroke / 2)}" width="${n(reach - start)}" height="${n(stroke)}" fill="#fff"/>
  </mask>
  <rect width="${GRID}" height="${GRID}" fill="currentColor" mask="url(#m)"/>
</svg>
`;
}

// The palette's fg and bg, as greyscale.
const INK = { dark: 0x1c, light: 0xe9 };
const TILE = 0xf6;

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/src/assets');

const MANIFEST = {
  name: 'conductor',
  short_name: 'conductor',
  // Relative to the manifest's url, so a sub-path deployment resolves to it.
  start_url: '../',
  scope: '../',
  display: 'standalone',
  background_color: '#f6f7f9',
  theme_color: '#1c1f23',
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
  ],
};

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const shape = mark();
  const written = [];
  const put = (name, data) => {
    fs.writeFileSync(path.join(OUT, name), data);
    written.push([name, data.length]);
  };

  put('icon.svg', svg());
  put('manifest.json', `${JSON.stringify(MANIFEST, null, 2)}\n`);

  const small = raster(32, shape);
  put('favicon-32.png', png(32, small, INK.dark));
  put('favicon-32-dark.png', png(32, small, INK.light));

  // Opaque: iOS composites a transparent touch icon onto black.
  for (const [name, size] of [
    ['apple-touch-icon.png', 180],
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['icon-1024.png', 1024],
  ]) put(name, png(size, raster(size, shape), INK.dark, TILE));

  const pad = Math.max(...written.map(([n]) => n.length));
  for (const [name, bytes] of written) {
    process.stdout.write(`${name.padEnd(pad)}  ${String(bytes).padStart(7)} bytes\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
