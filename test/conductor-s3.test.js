// test/conductor-s3.test.js - the conductor running on object storage
//
// The storage module is covered on its own elsewhere. What is checked here
// is the conductor configured to use it: that artifacts actually land in
// the bucket, that a finished log is moved there and remains readable, and
// that a download is handed off with a redirect instead of being proxied.
//
// That handoff only happens on S3, since the local backend has no URL to
// give out, so none of it is exercised by the default configuration.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { startHarness } from './helpers/harness.js';
import { startMinio, s3Available } from './helpers/minio.js';
import { createStorage, keys } from '../src/lib/storage/index.js';

const opts = { skip: s3Available() ? false : 'docker is not available' };

let minio = null;

before(async () => {
  if (s3Available()) minio = await startMinio();
}, { timeout: 240000 });

after(async () => {
  if (minio) await minio.stop();
});

// A conductor whose storage is a fresh bucket, plus a handle on that
// bucket so a test can look at what actually landed in it.
async function withS3Conductor(options, fn) {
  const bucket = await minio.bucket();
  const s3 = minio.storageConfig(bucket);
  const h = await startHarness({ visibility: 'public', s3, ...options });
  const store = createStorage({ storage: { driver: 's3', s3 } });

  try {
    return await fn(h, { store, bucket });
  } finally {
    await h.stop();
  }
}

const octet = (h) => ({ ...h.auth, 'content-type': 'application/octet-stream' });

async function drain(stream) {
  let out = '';
  for await (const chunk of stream) out += chunk;
  return out;
}

// Runs a job far enough to have a log and an artifact.
async function jobWithOutput(h, { log = 'building\ndone\n', artifact = 'artifact bytes' } = {}) {
  await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
  const job = (await h.poll({ arches: 'x86_64' })).json().job;

  await h.app.inject({
    method: 'POST',
    url: `/api/workers/jobs/${encodeURIComponent(job.id)}/log`,
    headers: octet(h),
    payload: Buffer.from(log),
  });

  if (artifact !== null) {
    await h.app.inject({
      method: 'POST',
      url: `/api/workers/jobs/${encodeURIComponent(job.id)}/artifact`,
      headers: { ...octet(h), 'x-artifact-path': 'dist/app bin+v1.tar.gz' },
      payload: Buffer.from(artifact),
    });
  }

  return job;
}

test('the conductor reports object storage when configured for it', opts, async () => {
  await withS3Conductor({}, async (h) => {
    const health = (await h.app.inject({ method: 'GET', url: '/health' })).json();
    assert.equal(health.storage, 's3');
  });
});

test('an artifact uploaded by a worker really lands in the bucket', opts, async () => {
  await withS3Conductor({}, async (h, { store }) => {
    const job = await jobWithOutput(h);

    const detail = await h.app.inject({ method: 'GET', url: `/api/jobs/${encodeURIComponent(job.id)}` });
    const artifact = detail.json().artifacts[0];
    assert.equal(artifact.path, 'dist/app bin+v1.tar.gz');

    // Read it straight out of the bucket, not through the conductor.
    const key = keys.artifact(job.run_id, job.id, artifact.path);
    const stored = await store.get(key);
    assert.equal(await drain(stored.stream), 'artifact bytes');
    assert.equal((await store.head(key)).size, artifact.size);
  });
});

test('an artifact download is handed off with a redirect that works', opts, async () => {
  await withS3Conductor({}, async (h) => {
    const job = await jobWithOutput(h);
    const detail = await h.app.inject({ method: 'GET', url: `/api/jobs/${encodeURIComponent(job.id)}` });
    const artifact = detail.json().artifacts[0];

    const res = await h.app.inject({ method: 'GET', url: `/api/artifacts/${artifact.id}` });

    // With local storage this streams a 200; on S3 the client is sent to
    // the store so the conductor does not carry the bytes.
    assert.equal(res.statusCode, 302);
    const location = res.headers.location;
    assert.match(location, /X-Amz-Signature=/);

    // The presigned URL has to be usable as given, with no credentials.
    const followed = await fetch(location);
    assert.equal(followed.status, 200);
    assert.equal(await followed.text(), 'artifact bytes');
  });
});

test('a finished log is moved to the bucket and stays readable', opts, async () => {
  await withS3Conductor({}, async (h, { store }) => {
    const job = await jobWithOutput(h, { log: 'compiling\nlinking\n' });

    // While running it is served from the local spool.
    const live = await h.app.inject({ method: 'GET', url: `/api/jobs/${encodeURIComponent(job.id)}/log` });
    assert.equal(live.headers['x-log-complete'], 'false');
    assert.equal(live.body, 'compiling\nlinking\n');

    await h.app.inject({
      method: 'POST',
      url: `/api/workers/jobs/${encodeURIComponent(job.id)}/done`,
      headers: { ...h.auth, 'content-type': 'application/json' },
      payload: JSON.stringify({ success: true, exit_code: 0 }),
    });

    // Afterwards it comes from the bucket, and reads the same.
    const archived = await h.app.inject({ method: 'GET', url: `/api/jobs/${encodeURIComponent(job.id)}/log` });
    assert.equal(archived.headers['x-log-complete'], 'true');
    assert.equal(archived.body, 'compiling\nlinking\n');

    const stored = await store.get(keys.log(job.run_id, job.id));
    assert.equal(await drain(stored.stream), 'compiling\nlinking\n');
  });
});

test('the local spool is released once the log is archived', opts, async () => {
  await withS3Conductor({}, async (h) => {
    const job = await jobWithOutput(h, { log: 'output\n', artifact: null });

    const spool = h.services.logs.spoolPath(job.run_id, job.id);
    assert.ok(await fs.stat(spool).catch(() => null), 'the spool should exist while running');

    await h.app.inject({
      method: 'POST',
      url: `/api/workers/jobs/${encodeURIComponent(job.id)}/done`,
      headers: { ...h.auth, 'content-type': 'application/json' },
      payload: JSON.stringify({ success: true, exit_code: 0 }),
    });

    // Storage is the durable copy; keeping the spool too would grow
    // without bound.
    assert.equal(await fs.stat(spool).catch(() => null), null, 'the spool should be gone');
  });
});

test('an archived log still serves incremental ranges', opts, async () => {
  await withS3Conductor({}, async (h) => {
    const job = await jobWithOutput(h, { log: 'first line\nsecond line\n', artifact: null });

    await h.app.inject({
      method: 'POST',
      url: `/api/workers/jobs/${encodeURIComponent(job.id)}/done`,
      headers: { ...h.auth, 'content-type': 'application/json' },
      payload: JSON.stringify({ success: true, exit_code: 0 }),
    });

    const tail = await h.app.inject({
      method: 'GET', url: `/api/jobs/${encodeURIComponent(job.id)}/log?offset=11`,
    });
    assert.equal(tail.body, 'second line\n');
  });
});

test('the interface renders a log that lives in the bucket', opts, async () => {
  await withS3Conductor({}, async (h) => {
    const job = await jobWithOutput(h, { log: 'rendered from s3\n', artifact: null });

    await h.app.inject({
      method: 'POST',
      url: `/api/workers/jobs/${encodeURIComponent(job.id)}/done`,
      headers: { ...h.auth, 'content-type': 'application/json' },
      payload: JSON.stringify({ success: true, exit_code: 0 }),
    });

    const page = await h.app.inject({ method: 'GET', url: `/jobs/${encodeURIComponent(job.id)}` });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /rendered from s3/);
  });
});

test('a private run in a bucket is still not readable by a stranger', opts, async () => {
  await withS3Conductor({ visibility: 'private' }, async (h) => {
    const job = await jobWithOutput(h);
    const detail = await h.app.inject({
      method: 'GET',
      url: `/api/jobs/${encodeURIComponent(job.id)}`,
      headers: await h.login().catch(() => ({})),
    });

    // Anonymous access is refused before any URL is ever signed, so the
    // object store is never asked and no presigned link is handed out.
    const anonymous = await h.app.inject({ method: 'GET', url: `/api/jobs/${encodeURIComponent(job.id)}` });
    assert.equal(anonymous.statusCode, 404);

    const anonymousLog = await h.app.inject({
      method: 'GET', url: `/api/jobs/${encodeURIComponent(job.id)}/log`,
    });
    assert.equal(anonymousLog.statusCode, 404);
    assert.equal(detail.statusCode, 404);
  });
});

test('a large artifact streams through to the bucket', opts, async () => {
  await withS3Conductor({}, async (h, { store }) => {
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = (await h.poll({ arches: 'x86_64' })).json().job;

    // Comfortably past the server's body limit for parsed payloads, which
    // an artifact must not be subject to: build output is routinely far
    // larger than a JSON request.
    const payload = Buffer.alloc(3 * 1024 * 1024, 0x41);

    const upload = await h.app.inject({
      method: 'POST',
      url: `/api/workers/jobs/${encodeURIComponent(job.id)}/artifact`,
      headers: { ...octet(h), 'x-artifact-path': 'dist/big.bin' },
      payload,
    });
    assert.equal(upload.statusCode, 200, upload.body);
    assert.equal(upload.json().size, payload.length);

    const stored = await store.head(keys.artifact(job.run_id, job.id, 'dist/big.bin'));
    assert.equal(stored.size, payload.length);
  });
});
