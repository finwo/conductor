// test/storage.test.js - object storage backends
//
// The local backend is always exercised. The S3 backend runs against a real
// MinIO, started automatically when docker is available, because the
// signing code is written by hand here and a stub would happily accept a
// signature a real server rejects.
//
// Point the same tests at another implementation, such as Garage or AWS,
// with CONDUCTOR_TEST_S3_ENDPOINT, CONDUCTOR_TEST_S3_KEY and
// CONDUCTOR_TEST_S3_SECRET.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import { createStorage, keys, StorageNotFound, assertKey, sanitizeRelativePath } from '../src/lib/storage/index.js';
import { sha256Hex, signRequest } from '../src/lib/storage/sigv4.js';
import { partSizeFor, inParts } from '../src/lib/storage/s3.js';
import { startMinio, s3Available } from './helpers/minio.js';

async function drain(stream) {
  let out = '';
  for await (const chunk of stream) out += chunk;
  return out;
}

async function localStorage() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-store-'));
  const cfg = { storage: { driver: 'local', path: dir, s3: {} } };
  return { st: createStorage(cfg), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test('key validation rejects traversal and absolute paths', () => {
  for (const bad of ['../etc/passwd', '/abs', 'a//b', 'a/../b', 'a/./b', '', 'a\\b', 'a\0b']) {
    assert.throws(() => assertKey(bad), new RegExp('storage key'), `expected ${JSON.stringify(bad)} to be rejected`);
  }
  assert.equal(assertKey('artifacts/run/job/dist/app.tar.gz'), 'artifacts/run/job/dist/app.tar.gz');
});

test('sanitizeRelativePath strips traversal from worker supplied paths', () => {
  assert.equal(sanitizeRelativePath('../../etc/passwd'), 'etc/passwd');
  assert.equal(sanitizeRelativePath('./dist/./app.bin'), 'dist/app.bin');
  assert.equal(sanitizeRelativePath('/abs/path'), 'abs/path');
  assert.equal(sanitizeRelativePath('..'), null);
  assert.equal(sanitizeRelativePath(''), null);
});

test('key layout is stable', () => {
  assert.equal(keys.artifact('r1', 'r1:build', 'dist/a.bin'), 'artifacts/r1/r1:build/dist/a.bin');
  assert.equal(keys.log('r1', 'r1:build'), 'logs/r1/r1:build.log');
});

test('local backend round trips a buffer and reports its digest', async () => {
  const { st, cleanup } = await localStorage();
  try {
    const put = await st.put('a/b/c.txt', Buffer.from('hello conductor'));
    assert.equal(put.size, 15);
    assert.equal(put.sha256, sha256Hex(Buffer.from('hello conductor')));

    assert.equal(await drain((await st.get('a/b/c.txt')).stream), 'hello conductor');
    assert.equal((await st.head('a/b/c.txt')).size, 15);
  } finally {
    await cleanup();
  }
});

test('local backend serves ranges', async () => {
  const { st, cleanup } = await localStorage();
  try {
    await st.put('r.txt', Buffer.from('hello conductor'));
    assert.equal(await drain((await st.get('r.txt', { range: { start: 6, end: 14 } })).stream), 'conductor');
    assert.equal(await drain((await st.get('r.txt', { range: { start: 6 } })).stream), 'conductor');
  } finally {
    await cleanup();
  }
});

test('local backend accepts a stream', async () => {
  const { st, cleanup } = await localStorage();
  try {
    const put = await st.put('s.log', Readable.from(['line one\n', 'line two\n']));
    assert.equal(put.size, 18);
    assert.equal(await drain((await st.get('s.log')).stream), 'line one\nline two\n');
  } finally {
    await cleanup();
  }
});

test('local backend reports a missing object and deletes idempotently', async () => {
  const { st, cleanup } = await localStorage();
  try {
    await assert.rejects(st.get('nope'), (e) => e instanceof StorageNotFound);
    assert.equal(await st.head('nope'), null);
    await st.delete('nope');
  } finally {
    await cleanup();
  }
});

test('local backend has no presigned urls', async () => {
  const { st, cleanup } = await localStorage();
  try {
    assert.equal(await st.presign('a.txt'), null);
  } finally {
    await cleanup();
  }
});

test('a partial write leaves no object behind', async () => {
  const { st, cleanup } = await localStorage();
  try {
    const failing = new Readable({
      read() { this.destroy(new Error('source failed')); },
    });
    await assert.rejects(st.put('partial.bin', failing), /source failed/);
    assert.equal(await st.head('partial.bin'), null);
  } finally {
    await cleanup();
  }
});

// --- multipart mechanics, no server needed ---

test('part size grows so that a huge object still fits in 10000 parts', () => {
  const MiB = 1024 * 1024;

  // Small and unknown sizes use the default.
  assert.equal(partSizeFor(undefined), 16 * MiB);
  assert.equal(partSizeFor(0), 16 * MiB);
  assert.equal(partSizeFor(100 * MiB), 16 * MiB);

  // 10000 parts of 16 MiB covers about 156 GiB; past that the part size
  // has to grow or the upload cannot be expressed.
  const huge = 1024 * 1024 * MiB; // 1 TiB
  const size = partSizeFor(huge);
  assert.ok(size > 16 * MiB, 'part size should scale up');
  assert.ok(Math.ceil(huge / size) <= 10000, 'must fit within the part limit');
  assert.equal(size % MiB, 0, 'part size should stay a whole number of MiB');
});

test('inParts regroups an awkwardly chunked stream into fixed parts', async () => {
  const source = Readable.from([
    Buffer.from('aaa'), Buffer.from('bb'), Buffer.from('cccccc'), Buffer.from('d'),
  ]);

  const parts = [];
  for await (const part of inParts(source, 4)) parts.push(part.toString());

  // Everything is preserved, in order, in fixed sized pieces with a
  // remainder at the end.
  assert.deepEqual(parts, ['aaab', 'bccc', 'cccd']);
  assert.equal(parts.join(''), 'aaabbccccccd');
});

test('inParts handles a chunk far larger than the part size', async () => {
  const source = Readable.from([Buffer.alloc(10, 0x41)]);
  const parts = [];
  for await (const part of inParts(source, 4)) parts.push(part.length);
  assert.deepEqual(parts, [4, 4, 2]);
});

test('inParts yields nothing for an empty stream', async () => {
  const parts = [];
  for await (const part of inParts(Readable.from([]), 4)) parts.push(part);
  assert.deepEqual(parts, []);
});

// S3 coverage against a real server.
const s3Options = { skip: s3Available() ? false : 'docker is not available' };

let minio = null;

before(async () => {
  if (s3Available()) minio = await startMinio();
}, { timeout: 240000 });

after(async () => {
  if (minio) await minio.stop();
});

// A storage handle onto a fresh bucket.
async function s3Storage() {
  const bucket = await minio.bucket();
  return createStorage({ storage: { driver: 's3', s3: minio.storageConfig(bucket) } });
}

test('s3 backend round trips awkward keys against a real server', s3Options, async () => {
  const st = await s3Storage();

  // Spaces, plus signs and parentheses are exactly what a naive signer
  // gets wrong, and what a stubbed server would never catch.
  const key = 'artifacts/r1/r1:build/dist/app bin+v1(final)!.tar.gz';
  const put = await st.put(key, Buffer.from('hello from s3'), { contentType: 'application/gzip' });
  assert.equal(put.size, 13);
  assert.equal(put.sha256, sha256Hex(Buffer.from('hello from s3')));

  assert.equal(await drain((await st.get(key)).stream), 'hello from s3');
  assert.equal((await st.head(key)).size, 13);
});

test('s3 serves byte ranges', s3Options, async () => {
  const st = await s3Storage();
  await st.put('r.txt', Buffer.from('hello conductor'));

  assert.equal(await drain((await st.get('r.txt', { range: { start: 6, end: 14 } })).stream), 'conductor');
  assert.equal(await drain((await st.get('r.txt', { range: { start: 6 } })).stream), 'conductor');
});

test('s3 accepts a stream when the size is known', s3Options, async () => {
  const st = await s3Storage();
  const body = Readable.from([Buffer.from('streamed '), Buffer.from('upload')]);
  const put = await st.put('logs/r1/j.log', body, { size: 15 });

  assert.equal(put.size, 15);
  assert.equal(await drain((await st.get('logs/r1/j.log')).stream), 'streamed upload');
});

test('a presigned url is usable without credentials', s3Options, async () => {
  const st = await s3Storage();
  const key = 'artifacts/run/job/dist/app bin+v1.tar.gz';
  await st.put(key, Buffer.from('presigned content'));

  const url = await st.presign(key, { expires: 300 });
  assert.match(url, /X-Amz-Signature=[0-9a-f]{64}/);

  // Plain fetch, no Authorization header.
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'presigned content');
});

test('a tampered presigned url is rejected by the server', s3Options, async () => {
  const st = await s3Storage();
  await st.put('secret.txt', Buffer.from('do not serve this'));

  const url = new URL(await st.presign('secret.txt', { expires: 300 }));
  const signature = url.searchParams.get('X-Amz-Signature');
  // Flip a character of the signature.
  url.searchParams.set('X-Amz-Signature', `${signature.slice(0, -1)}${signature.endsWith('a') ? 'b' : 'a'}`);

  const res = await fetch(url);
  assert.ok(!res.ok, 'a forged signature must not be honoured');
});

test('s3 reports a missing object and deletes idempotently', s3Options, async () => {
  const st = await s3Storage();
  await assert.rejects(st.get('missing/object'), (e) => e instanceof StorageNotFound);
  assert.equal(await st.head('missing/object'), null);

  await st.put('gone.txt', Buffer.from('x'));
  await st.delete('gone.txt');
  assert.equal(await st.head('gone.txt'), null);
  await st.delete('gone.txt');
});

test('a stream of unknown length is accepted', s3Options, async () => {
  const st = await s3Storage();

  // Multipart does not need the total up front, so a body whose length is
  // not known in advance no longer has to be buffered by the caller.
  const put = await st.put('unknown.bin', Readable.from([
    Buffer.from('one '), Buffer.from('two '), Buffer.from('three'),
  ]));

  assert.equal(put.size, 13);
  assert.equal(await drain((await st.get('unknown.bin')).stream), 'one two three');
});

test('a body past the single request threshold is uploaded in parts', s3Options, async () => {
  const st = await s3Storage();

  // Above SINGLE_PUT_MAX, so this exercises create, several uploads and
  // complete rather than one PUT.
  const size = 40 * 1024 * 1024;
  const pattern = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < pattern.length; i += 4) pattern.writeUInt32BE(i, i);

  const expected = crypto.createHash('sha256');
  let produced = 0;
  const source = new Readable({
    read() {
      if (produced >= size) return this.push(null);
      // Vary each block so a part written out of order would be visible.
      const block = Buffer.from(pattern);
      block.writeUInt32BE(produced / 1024 / 1024, 0);
      produced += block.length;
      expected.update(block);
      this.push(block);
    },
  });

  const put = await st.put('big/multipart.bin', source, { size });
  assert.equal(put.size, size);
  assert.equal(put.sha256, expected.digest('hex'), 'the assembled object must match what was sent');

  // Read it back independently rather than trusting the reported digest.
  const back = crypto.createHash('sha256');
  let read = 0;
  for await (const chunk of (await st.get('big/multipart.bin')).stream) {
    back.update(chunk);
    read += chunk.length;
  }
  assert.equal(read, size);
  assert.equal(back.digest('hex'), put.sha256);
});

test('a large body really is sent as several parts, and a small one is not', s3Options, async () => {
  const bucket = await minio.bucket();
  const st = createStorage({ storage: { driver: 's3', s3: minio.storageConfig(bucket) } });

  // A multipart ETag is the digest of the part digests with the part
  // count appended, so it says plainly how the object was uploaded. That
  // makes it a reliable check that streaming is still in use, rather than
  // inferring it from timing or memory.
  async function etagOf(key) {
    const url = new URL(`${minio.endpoint}/${bucket}/${key}`);
    const headers = signRequest({
      method: 'HEAD',
      url,
      payloadHash: sha256Hex(''),
      region: minio.credentials.region,
      accessKeyId: minio.credentials.accessKeyId,
      secretAccessKey: minio.credentials.secretAccessKey,
    });
    const res = await fetch(url, { method: 'HEAD', headers });
    assert.ok(res.ok, `HEAD ${key} failed: ${res.status}`);
    return res.headers.get('etag').replace(/"/g, '');
  }

  // 40 MiB at a 16 MiB part size is three parts.
  const size = 40 * 1024 * 1024;
  const source = Readable.from((function* () {
    for (let sent = 0; sent < size; sent += 1024 * 1024) yield Buffer.alloc(1024 * 1024, 0x43);
  })());
  await st.put('big/parted.bin', source, { size });

  const multipart = await etagOf('big/parted.bin');
  assert.match(multipart, /-3$/, `expected a three part upload, got ETag ${multipart}`);

  // Something small must not pay for three round trips.
  await st.put('small/plain.bin', Buffer.alloc(1024, 0x44));
  const single = await etagOf('small/plain.bin');
  assert.ok(!/-\d+$/.test(single), `expected a single request upload, got ETag ${single}`);
});

test('a multipart object still serves ranges', s3Options, async () => {
  const st = await s3Storage();
  const size = 40 * 1024 * 1024;

  const source = Readable.from((function* () {
    for (let sent = 0; sent < size; sent += 1024 * 1024) {
      const block = Buffer.alloc(1024 * 1024);
      block.writeUInt32BE(sent, 0);
      yield block;
    }
  })());

  await st.put('big/ranged.bin', source, { size });

  // A boundary between parts is the interesting place to read across.
  const start = 16 * 1024 * 1024 - 2;
  const chunk = await st.get('big/ranged.bin', { range: { start, end: start + 5 } });
  const bytes = [];
  for await (const part of chunk.stream) bytes.push(part);
  assert.equal(Buffer.concat(bytes).length, 6);
});

test('a body that does not match its declared size is rejected', s3Options, async () => {
  const st = await s3Storage();
  const size = 40 * 1024 * 1024;

  // Claims 40 MiB, sends 20 MiB.
  const short = Readable.from((function* () {
    for (let sent = 0; sent < size / 2; sent += 1024 * 1024) yield Buffer.alloc(1024 * 1024, 0x41);
  })());

  await assert.rejects(st.put('big/short.bin', short, { size }), /size mismatch/);
  assert.equal(await st.head('big/short.bin'), null, 'no partial object should be visible');
});

test('a failed multipart upload does not leave parts behind', s3Options, async () => {
  const bucket = await minio.bucket();
  const st = createStorage({ storage: { driver: 's3', s3: minio.storageConfig(bucket) } });
  const size = 40 * 1024 * 1024;

  const short = Readable.from((function* () {
    for (let sent = 0; sent < size / 2; sent += 1024 * 1024) yield Buffer.alloc(1024 * 1024, 0x42);
  })());
  await assert.rejects(st.put('big/abandoned.bin', short, { size }), /size mismatch/);

  // Abandoned parts are billable and invisible, so the upload must have
  // been aborted rather than simply dropped.
  const url = new URL(`${minio.endpoint}/${bucket}`);
  url.searchParams.set('uploads', '');
  const headers = signRequest({
    method: 'GET',
    url,
    payloadHash: sha256Hex(''),
    region: minio.credentials.region,
    accessKeyId: minio.credentials.accessKeyId,
    secretAccessKey: minio.credentials.secretAccessKey,
  });

  const listing = await (await fetch(url, { headers })).text();
  assert.ok(!listing.includes('<Upload>'), `an upload was left pending:\n${listing}`);
});

test('bad credentials fail loudly rather than silently storing nothing', s3Options, async () => {
  const bucket = await minio.bucket();
  const st = createStorage({
    storage: {
      driver: 's3',
      s3: { ...minio.storageConfig(bucket), secret_access_key: 'wrong-secret' },
    },
  });

  await assert.rejects(st.put('k.txt', Buffer.from('x')), /s3 put failed/);
});
