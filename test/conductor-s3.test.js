// test/conductor-s3.test.js - the conductor running on object storage

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { startHarness, data } from './helpers/harness.js';
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

async function taskWithOutput(h, { log = 'building\ndone\n', artifact = 'artifact bytes' } = {}) {
  const triggered = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
  const jobId = data(triggered).job_id;
  await h.waitForJob(jobId);

  const claimed = await h.claim({ arches: ['x86_64'] });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const task = data(claimed).task;

  await h.app.inject({
    method: 'POST',
    url: `/api/v1/tasks/${encodeURIComponent(task.id)}/log`,
    headers: octet(h),
    payload: Buffer.from(log),
  });

  if (artifact !== null) {
    const upload = await h.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${encodeURIComponent(task.id)}/artifacts`,
      headers: { ...octet(h), 'x-artifact-path': 'dist/app bin+v1.tar.gz' },
      payload: Buffer.from(artifact),
    });
    assert.equal(upload.statusCode, 200, upload.body);
  }

  return { jobId, task };
}

function complete(h, taskId) {
  return h.app.inject({
    method: 'POST',
    url: `/api/v1/tasks/${encodeURIComponent(taskId)}/complete`,
    headers: { ...h.auth, 'content-type': 'application/json' },
    payload: JSON.stringify({ state: 'success', success: true, exit_code: 0 }),
  });
}

function readLog(h, taskId, query = '') {
  return h.app.inject({ method: 'GET', url: `/api/v1/tasks/${encodeURIComponent(taskId)}/log${query}` });
}

test('the conductor reports object storage when configured for it', opts, async () => {
  await withS3Conductor({}, async (h) => {
    const health = await h.app.inject({ method: 'GET', url: '/health' });
    assert.equal(data(health).storage, 's3');
  });
});

test('an artifact uploaded by a worker really lands in the bucket', opts, async () => {
  await withS3Conductor({}, async (h, { store }) => {
    const { jobId, task } = await taskWithOutput(h);

    const listed = await h.app.inject({
      method: 'GET', url: `/api/v1/tasks/${encodeURIComponent(task.id)}/artifacts`,
    });
    const artifact = data(listed)[0];
    assert.equal(artifact.path, 'dist/app bin+v1.tar.gz');

    const key = keys.artifact(jobId, task.id, artifact.path);
    const stored = await store.get(key);
    assert.equal(await drain(stored.stream), 'artifact bytes');
    assert.equal((await store.head(key)).size, artifact.size);
  });
});

test('an artifact download is handed off with a redirect that works', opts, async () => {
  await withS3Conductor({}, async (h) => {
    const { jobId, task } = await taskWithOutput(h);
    const listed = await h.app.inject({
      method: 'GET', url: `/api/v1/tasks/${encodeURIComponent(task.id)}/artifacts`,
    });
    const artifact = data(listed)[0];

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/demo/jobs/${jobId}/tasks/${encodeURIComponent(task.id)}`
        + `/artifacts/${artifact.id}`,
    });
    assert.equal(res.statusCode, 302, res.body);
    assert.match(res.headers.location, /X-Amz-Signature=/);

    const followed = await fetch(res.headers.location);
    assert.equal(followed.status, 200);
    assert.equal(await followed.text(), 'artifact bytes');
  });
});

test('a finished log is moved to the bucket and stays readable', opts, async () => {
  await withS3Conductor({}, async (h, { store }) => {
    const { jobId, task } = await taskWithOutput(h, { log: 'compiling\nlinking\n' });

    const live = await readLog(h, task.id);
    assert.equal(data(live).data, 'compiling\nlinking\n');

    assert.equal((await complete(h, task.id)).statusCode, 200);

    const archived = await readLog(h, task.id);
    assert.equal(data(archived).data, 'compiling\nlinking\n');

    const row = await h.services.db.get('SELECT log_key FROM tasks WHERE id = {id}', { id: task.id });
    assert.equal(row.log_key, keys.log(jobId, task.id));

    const stored = await store.get(row.log_key);
    assert.equal(await drain(stored.stream), 'compiling\nlinking\n');
  });
});

test('the local spool is released once the log is archived', opts, async () => {
  await withS3Conductor({}, async (h) => {
    const { jobId, task } = await taskWithOutput(h, { log: 'output\n', artifact: null });

    const spool = h.services.logs.spoolPath(jobId, task.id);
    assert.ok(await fs.stat(spool).catch(() => null), 'the spool should exist while running');

    await complete(h, task.id);

    assert.equal(await fs.stat(spool).catch(() => null), null, 'the spool should be gone');
  });
});

test('an archived log still serves incremental ranges', opts, async () => {
  await withS3Conductor({}, async (h) => {
    const { task } = await taskWithOutput(h, { log: 'first line\nsecond line\n', artifact: null });
    await complete(h, task.id);

    const tail = await readLog(h, task.id, '?offset=11');
    assert.equal(data(tail).data, 'second line\n');
  });
});

test('a private job in a bucket is not readable by a stranger', opts, async () => {
  await withS3Conductor({ visibility: 'private' }, async (h) => {
    const { jobId, task } = await taskWithOutput(h);

    const detail = await h.app.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}` });
    assert.equal(detail.statusCode, 404);

    const log = await readLog(h, task.id);
    assert.equal(log.statusCode, 404);
  });
});

test('a large artifact streams through to the bucket', opts, async () => {
  await withS3Conductor({}, async (h, { store }) => {
    const triggered = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const jobId = data(triggered).job_id;
    await h.waitForJob(jobId);

    const claimed = await h.claim({ arches: ['x86_64'] });
    const task = data(claimed).task;
    const payload = Buffer.alloc(3 * 1024 * 1024, 0x41);

    const upload = await h.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${encodeURIComponent(task.id)}/artifacts`,
      headers: { ...octet(h), 'x-artifact-path': 'dist/big.bin' },
      payload,
    });
    assert.equal(upload.statusCode, 200, upload.body);
    assert.equal(data(upload).size, payload.length);

    const stored = await store.head(keys.artifact(jobId, task.id, 'dist/big.bin'));
    assert.equal(stored.size, payload.length);
  });
});
