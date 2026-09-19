// test/read-api.test.js - the public read surface
//
// The point of running this separately is that the write surface is not
// reachable on it. That is asserted here rather than assumed, because it is
// the only thing making the service safe to expose.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';
import { createReadServices, buildReadServer } from '../src/read-api/app.js';

// Brings up a read-api against the same database the harness conductor uses.
async function withBoth(options, fn) {
  const h = await startHarness(options);
  const services = await createReadServices(h.cfg);
  const read = await buildReadServer(services, { logger: false });
  try {
    return await fn(h, read);
  } finally {
    await read.close();
    await services.db.close();
    await h.stop();
  }
}

test('the read-api reports its drivers', async () => {
  await withBoth({}, async (h, read) => {
    const res = await read.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().service, 'read-api');
  });
});

test('the write surface is not mounted at all', async () => {
  await withBoth({}, async (h, read) => {
    const writes = [
      ['POST', '/api/trigger/demo'],
      ['GET', '/api/workers/poll'],
      ['GET', '/api/admin/projects'],
      ['POST', '/api/admin/worker-tokens'],
      ['POST', '/api/auth/login'],
      ['GET', '/api/auth/me'],
    ];

    for (const [method, url] of writes) {
      const res = await read.inject({ method, url });
      // 404 rather than 401: the route does not exist here, so no
      // credential could ever reach it.
      assert.equal(res.statusCode, 404, `${method} ${url} should not exist on the read-api`);
    }
  });
});

test('runs, jobs and logs are readable', async () => {
  await withBoth({}, async (h, read) => {
    const run = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().run_id;

    const list = await read.inject({ method: 'GET', url: '/api/runs' });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().runs.length, 1);

    const detail = await read.inject({ method: 'GET', url: `/api/runs/${run}` });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().jobs.length, 6);
    // Edges are exposed so a client can draw the graph.
    assert.ok(detail.json().jobs.every((j) => Array.isArray(j.needs)));
  });
});

test('a job environment is never exposed', async () => {
  await withBoth({}, async (h, read) => {
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = (await h.poll({ arches: 'x86_64' })).json().job;

    // The job really does carry an environment when dispatched.
    assert.ok(Object.keys(job.env).length > 0);

    const res = await read.inject({ method: 'GET', url: `/api/jobs/${encodeURIComponent(job.id)}` });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    assert.equal(body.job.env, undefined);
    assert.equal(body.job.spec.env, undefined);
    // The useful parts are still there.
    assert.ok(Array.isArray(body.job.spec.script));
    assert.ok(Array.isArray(body.job.spec.needs));
  });
});

test('a project variable cannot be read back through the read-api', async () => {
  await withBoth({ bootstrap: true }, async (h, read) => {
    await h.services.variables.set('demo', 'SECRET_TOKEN', 'do-not-expose-this');

    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = (await h.poll({})).json().job;
    assert.equal(job.env.SECRET_TOKEN, 'do-not-expose-this');

    for (const url of ['/api/runs', `/api/runs/${job.run_id}`, `/api/jobs/${encodeURIComponent(job.id)}`]) {
      const res = await read.inject({ method: 'GET', url });
      assert.ok(!res.body.includes('do-not-expose-this'), `${url} leaked a variable`);
    }
  });
});

test('logs and artifacts are served', async () => {
  await withBoth({}, async (h, read) => {
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = (await h.poll({ arches: 'x86_64' })).json().job;

    await h.app.inject({
      method: 'POST',
      url: `/api/workers/jobs/${encodeURIComponent(job.id)}/log`,
      headers: { ...h.auth, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('building\ndone\n'),
    });
    await h.app.inject({
      method: 'POST',
      url: `/api/workers/jobs/${encodeURIComponent(job.id)}/artifact`,
      headers: { ...h.auth, 'content-type': 'application/octet-stream', 'x-artifact-path': 'dist/out.bin' },
      payload: Buffer.from('artifact bytes'),
    });

    const log = await read.inject({ method: 'GET', url: `/api/jobs/${encodeURIComponent(job.id)}/log` });
    assert.equal(log.body, 'building\ndone\n');
    assert.equal(log.headers['x-log-complete'], 'false');

    const detail = await read.inject({ method: 'GET', url: `/api/jobs/${encodeURIComponent(job.id)}` });
    const artifact = detail.json().artifacts[0];
    const download = await read.inject({ method: 'GET', url: `/api/artifacts/${artifact.id}` });
    assert.equal(download.body, 'artifact bytes');
  });
});

test('an incremental log tail returns only what is new', async () => {
  await withBoth({}, async (h, read) => {
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = (await h.poll({ arches: 'x86_64' })).json().job;
    const url = `/api/workers/jobs/${encodeURIComponent(job.id)}/log`;
    const headers = { ...h.auth, 'content-type': 'application/octet-stream' };

    await h.app.inject({ method: 'POST', url, headers, payload: Buffer.from('first\n') });
    const first = await read.inject({ method: 'GET', url: `/api/jobs/${encodeURIComponent(job.id)}/log` });
    assert.equal(first.body, 'first\n');
    const offset = Number(first.headers['x-log-size']);

    await h.app.inject({ method: 'POST', url, headers, payload: Buffer.from('second\n') });
    const next = await read.inject({
      method: 'GET', url: `/api/jobs/${encodeURIComponent(job.id)}/log?offset=${offset}`,
    });
    assert.equal(next.body, 'second\n');
  });
});

test('the dashboard is served, and only its own files', async () => {
  await withBoth({}, async (h, read) => {
    const index = await read.inject({ method: 'GET', url: '/' });
    assert.equal(index.statusCode, 200);
    assert.match(index.headers['content-type'], /text\/html/);
    assert.match(index.body, /<title>conductor<\/title>/);

    for (const path of ['/app.js', '/style.css']) {
      const res = await read.inject({ method: 'GET', url: path });
      assert.equal(res.statusCode, 200);
    }

    // Nothing outside the allowlist exists, so traversal has nothing to hit.
    for (const path of ['/../package.json', '/conductor.yaml', '/index.js']) {
      assert.equal((await read.inject({ method: 'GET', url: path })).statusCode, 404);
    }
  });
});

test('the dashboard is also served by the conductor', async () => {
  await withBoth({}, async (h) => {
    const res = await h.app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /conductor/);
  });
});

test('a cached dashboard file is not resent', async () => {
  await withBoth({}, async (h, read) => {
    const first = await read.inject({ method: 'GET', url: '/app.js' });
    const etag = first.headers.etag;
    assert.ok(etag);

    const second = await read.inject({ method: 'GET', url: '/app.js', headers: { 'if-none-match': etag } });
    assert.equal(second.statusCode, 304);
  });
});

test('the read-api refuses to start against a database with no schema', async () => {
  const h = await startHarness({});
  try {
    await h.services.db.exec('DROP TABLE runs');
    await assert.rejects(createReadServices(h.cfg), /schema is missing/);
  } finally {
    await h.stop();
  }
});
