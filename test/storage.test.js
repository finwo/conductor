// test/storage.test.js - object storage backends
//
// The local backend is always exercised. The S3 backend runs against a live
// server only when CONDUCTOR_TEST_S3_ENDPOINT is set, for example:
//
//   docker run -d -p 9000:9000 -e MINIO_ROOT_USER=testkey \
//     -e MINIO_ROOT_PASSWORD=testsecret123 quay.io/minio/minio server /data
//   CONDUCTOR_TEST_S3_ENDPOINT=http://127.0.0.1:9000 \
//     CONDUCTOR_TEST_S3_KEY=testkey CONDUCTOR_TEST_S3_SECRET=testsecret123 \
//     npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createStorage, keys, StorageNotFound, assertKey, sanitizeRelativePath } from '../src/lib/storage/index.js';
import { signRequest, sha256Hex } from '../src/lib/storage/sigv4.js';

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

// S3 coverage, opt in.
const S3_ENDPOINT = process.env.CONDUCTOR_TEST_S3_ENDPOINT;
const s3Options = { skip: S3_ENDPOINT ? false : 'set CONDUCTOR_TEST_S3_ENDPOINT to run S3 tests' };

test('s3 backend round trips awkward keys against a live server', s3Options, async () => {
  const bucket = `citest${Date.now().toString(36)}`;
  const creds = {
    region: 'us-east-1',
    accessKeyId: process.env.CONDUCTOR_TEST_S3_KEY,
    secretAccessKey: process.env.CONDUCTOR_TEST_S3_SECRET,
  };

  const bucketUrl = new URL(`${S3_ENDPOINT.replace(/\/+$/, '')}/${bucket}`);
  const created = await fetch(bucketUrl, {
    method: 'PUT',
    headers: signRequest({ method: 'PUT', url: bucketUrl, payloadHash: sha256Hex(''), ...creds }),
  });
  assert.ok(created.ok, `failed to create bucket: ${created.status}`);

  const st = createStorage({
    storage: {
      driver: 's3',
      s3: {
        endpoint: S3_ENDPOINT,
        bucket,
        region: creds.region,
        access_key_id: creds.accessKeyId,
        secret_access_key: creds.secretAccessKey,
        force_path_style: true,
      },
    },
  });

  // Spaces and plus signs are exactly what a naive signer gets wrong.
  const key = 'artifacts/r1/r1:build/dist/app bin+v1(final)!.tar.gz';
  const put = await st.put(key, Buffer.from('hello from s3'), { contentType: 'application/gzip' });
  assert.equal(put.size, 13);

  assert.equal(await drain((await st.get(key)).stream), 'hello from s3');
  assert.equal(await drain((await st.get(key, { range: { start: 6, end: 9 } })).stream), 'from');
  assert.equal((await st.head(key)).size, 13);

  const streamed = await st.put('logs/r1/j.log', Readable.from([Buffer.from('streamed '), Buffer.from('upload')]), { size: 15 });
  assert.equal(streamed.size, 15);

  const presigned = await fetch(await st.presign(key, { expires: 300 }));
  assert.equal(presigned.status, 200);
  assert.equal(await presigned.text(), 'hello from s3');

  await assert.rejects(st.get('missing/object'), (e) => e instanceof StorageNotFound);

  await st.delete(key);
  assert.equal(await st.head(key), null);
  await st.delete(key);
});

test('s3 put of a stream without a size is refused', s3Options, async () => {
  const st = createStorage({
    storage: {
      driver: 's3',
      s3: {
        endpoint: S3_ENDPOINT,
        bucket: 'irrelevant',
        region: 'us-east-1',
        access_key_id: 'k',
        secret_access_key: 's',
        force_path_style: true,
      },
    },
  });
  await assert.rejects(st.put('k', Readable.from(['x'])), /needs an explicit size/);
});
