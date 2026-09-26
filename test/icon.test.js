// test/icon.test.js - the mark's geometry, and the png it encodes to

import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import { DEFAULTS, GRID, mark, png, raster, svg } from '../util/icon.js';

function parse(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [];
  let p = 8;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    const stored = buf.readUInt32BE(p + 8 + len);
    chunks.push({ type, data, stored, covered: buf.subarray(p + 4, p + 8 + len) });
    p += len + 12;
  }
  const ihdr = chunks.find(c => c.type === 'IHDR');
  return {
    chunks,
    width: ihdr.data.readUInt32BE(0),
    height: ihdr.data.readUInt32BE(4),
    depth: ihdr.data[8],
    colour: ihdr.data[9],
    pixels: zlib.inflateSync(Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data))),
  };
}

// Greyscale+alpha, so a row is one filter byte then two bytes a pixel.
function pixel(img, x, y) {
  const row = y * (1 + img.width * 2) + 1;
  return { grey: img.pixels[row + x * 2], alpha: img.pixels[row + x * 2 + 1] };
}

test('encodes a png every size it is asked for', () => {
  for (const size of [32, 180, 512]) {
    const img = parse(png(size, raster(size)));
    assert.equal(img.width, size);
    assert.equal(img.height, size);
    assert.equal(img.depth, 8);
    assert.equal(img.colour, 4);
    assert.equal(img.pixels.length, size * (1 + size * 2));
    assert.equal(img.chunks.at(-1).type, 'IEND');
  }
});

test('every chunk carries its own checksum', () => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  for (const chunk of parse(png(32, raster(32))).chunks) {
    let c = -1;
    for (const byte of chunk.covered) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    assert.equal((c ^ -1) >>> 0, chunk.stored, `${chunk.type} checksum`);
  }
});

test('the background stays transparent and the ink keeps its value', () => {
  const img = parse(png(64, raster(64), 0x1c));
  for (const [x, y] of [[0, 0], [63, 0], [0, 63], [63, 63]]) {
    assert.equal(pixel(img, x, y).alpha, 0, `corner ${x},${y}`);
  }
  assert.equal(pixel(img, 32, 32).alpha, 0, 'the bowl is hollow');
  const left = pixel(img, 12, 32);
  assert.equal(left.alpha, 255, 'the left limb is solid');
  assert.equal(left.grey, 0x1c);
});

test('a background composites the mark onto an opaque tile', () => {
  const img = parse(png(64, raster(64), 0x1c, 0xf6));
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) assert.equal(pixel(img, x, y).alpha, 255);
  }
  assert.equal(pixel(img, 0, 0).grey, 0xf6);
  assert.equal(pixel(img, 12, 32).grey, 0x1c);
});

test('the mark is symmetric about the horizontal axis', () => {
  const size = 256;
  const cov = raster(size, mark());
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      assert.equal(cov[y * size + x], cov[(size - 1 - y) * size + x], `${x},${y}`);
    }
  }
});

test('the break is cut to the inner corner and the limbs end balanced', () => {
  const { outer, stroke, stretch } = DEFAULTS;
  const K = 1.45;
  const inner = outer - stroke;
  const shape = mark();
  const gapEdge = inner * (K - 1) + stretch;
  const trim = (stroke * (2 - K)) / 2;

  // Probes sit 4 units off every edge: (inner, gapEdge) is the corner itself,
  // where the diagonal lands on a float that rounds either way.
  assert.ok(shape(inner + 4, gapEdge + 4), 'limb present just past the corner');
  assert.ok(!shape(inner - 8, gapEdge + 4), 'the hole is not filled in');
  assert.ok(!shape(inner + 4, gapEdge - 4), 'the break is open below it');

  assert.ok(shape(outer - trim - 4, gapEdge + 4), 'limb present just inside the slice');
  assert.ok(!shape(outer - trim + 4, gapEdge + 4), 'nothing survives the slice');

  const horizontal = outer - trim - inner;
  const vertical = outer * (K - 1) + stretch + trim - gapEdge;
  assert.ok(Math.abs(horizontal - vertical) < 1e-9, `${horizontal} vs ${vertical}`);
  assert.ok(Math.abs(horizontal - (stroke * K) / 2) < 1e-9);
});

test('the bar clears the break and reaches past the sliced limbs', () => {
  const { start, reach, stroke, outer } = DEFAULTS;
  const shape = mark();
  assert.ok(!shape(start - 2, 0), 'nothing before the bar starts');
  assert.ok(shape(start + 2, 0), 'the bar starts where it says');
  assert.ok(shape(reach - 2, 0), 'the bar runs to its reach');
  assert.ok(!shape(reach + 2, 0), 'and stops there');
  assert.ok(reach > outer, 'the bar overshoots the ring');
  assert.ok(shape(reach - 2, stroke / 2 - 2), 'bar is a full stroke thick');
  assert.ok(!shape(reach - 2, stroke / 2 + 2));
});

// The svg restates the geometry independently, so it can drift from the
// raster without either looking wrong on its own.
test('the svg draws the same shape as the raster', () => {
  const doc = svg();
  const nums = (re) => [...doc.match(re)[0].matchAll(/-?[\d.]+/g)].map(Number);
  const polys = [...doc.matchAll(/<polygon points="([^"]+)"/g)]
    .map(m => m[1].split(' ').map(p => p.split(',').map(Number)));
  const rects = [...doc.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)]
    .map(m => m.slice(1, 5).map(Number));
  assert.equal(polys.length, 2);
  assert.equal(rects.length, 3);

  const inside = (poly, x, y) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  const within = ([rx, ry, rw, rh], x, y) => x >= rx && x < rx + rw && y >= ry && y < ry + rh;

  const fromSvg = (x, y) => {
    let on = inside(polys[0], x, y) && !inside(polys[1], x, y);
    if (within(rects[0], x, y)) on = false;
    if (within(rects[1], x, y)) on = false;
    if (within(rects[2], x, y)) on = true;
    return on;
  };

  const shape = mark();
  let checked = 0;
  for (let y = 4; y < GRID; y += 7) {
    for (let x = 4; x < GRID; x += 7) {
      // Half-unit offsets keep the probes off the shared edges, where the
      // polygon rule and the predicate are each free to round either way.
      const px = x + 0.5, py = y + 0.5;
      assert.equal(fromSvg(px, py), shape(px - GRID / 2, py - GRID / 2), `${px},${py}`);
      checked++;
    }
  }
  assert.ok(checked > 20000, `only probed ${checked} points`);
});

test('the same options always encode to the same bytes', () => {
  assert.deepEqual(png(64, raster(64)), png(64, raster(64)));
  assert.equal(svg(), svg());
});
