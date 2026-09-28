// test/management.test.js - the authenticated management surface

import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, data, apiError } from './helpers/harness.js';

async function withAdmin(options, fn) {
  const h = await startHarness({ ...options, bootstrap: true });
  try {
    const { headers } = await h.login();
    return await fn(h, headers);
  } finally {
    await h.stop();
  }
}

const json = (headers) => ({ ...headers, 'content-type': 'application/json' });

async function claimTask(h) {
  const triggered = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
  await h.waitForJob(data(triggered).job_id);
  const claimed = await h.claim({});
  assert.equal(claimed.statusCode, 200, claimed.body);
  return data(claimed).task;
}

test('a project is created with a trigger secret that is shown once', async () => {
  await withAdmin({}, async (h, admin) => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: json(admin),
      payload: JSON.stringify({ id: 'newproj', name: 'New', repo_url: 'https://git.example.com/new.git' }),
    });
    assert.equal(created.statusCode, 201, created.body);
    const secret = data(created).trigger_secret;
    assert.ok(secret && secret.length >= 32);

    const listed = await h.app.inject({ method: 'GET', url: '/api/v1/projects', headers: admin });
    const project = data(listed).find((p) => p.id === 'newproj');
    assert.equal(project.has_trigger_secret, true);
    assert.equal(project.trigger_secret, undefined);
    assert.ok(!listed.body.includes(secret));

    const removed = await h.app.inject({
      method: 'DELETE', url: '/api/v1/projects/newproj', headers: admin,
    });
    assert.equal(removed.statusCode, 200, removed.body);
  });
});

test('a rotated trigger secret replaces the one before it', async () => {
  await withAdmin({}, async (h, admin) => {
    const rotated = await h.app.inject({
      method: 'POST', url: '/api/v1/projects/demo/trigger-secret', headers: json(admin), payload: '{}',
    });
    assert.equal(rotated.statusCode, 200, rotated.body);
    const secret = data(rotated).trigger_secret;

    const stale = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' }, { secret: 'test-secret' });
    assert.equal(stale.statusCode, 401, stale.body);

    const fresh = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' }, { secret });
    assert.equal(fresh.statusCode, 200, fresh.body);
    await h.waitForJob(data(fresh).job_id);
  });
});

test('a worker token is issued once and revoking it takes effect at once', async () => {
  await withAdmin({}, async (h, admin) => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/workers',
      headers: json(admin),
      payload: JSON.stringify({ name: 'builder-2' }),
    });
    assert.equal(created.statusCode, 201, created.body);
    const { id, token } = data(created);

    const claim = (t) => h.app.inject({
      method: 'POST',
      url: '/api/v1/tasks/claim',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      payload: '{}',
    });

    assert.notEqual((await claim(token)).statusCode, 401);

    const listed = await h.app.inject({ method: 'GET', url: '/api/v1/workers', headers: admin });
    assert.ok(!listed.body.includes(token));

    const disabled = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/workers/${id}`,
      headers: json(admin),
      payload: JSON.stringify({ enabled: false }),
    });
    assert.equal(disabled.statusCode, 200, disabled.body);

    const after = await claim(token);
    assert.equal(after.statusCode, 401, after.body);
    assert.equal(apiError(after).name, 'InvalidWorkerToken');
  });
});

test('a project variable reaches a task environment and is never listed', async () => {
  await withAdmin({}, async (h, admin) => {
    const set = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/demo/variables/DEPLOY_TOKEN',
      headers: json(admin),
      payload: JSON.stringify({ value: 'super-secret-value', masked: true }),
    });
    assert.equal(set.statusCode, 200, set.body);

    const listed = await h.app.inject({
      method: 'GET', url: '/api/v1/projects/demo/variables', headers: admin,
    });
    const listing = data(listed);
    assert.equal(listing[0].name, 'DEPLOY_TOKEN');
    assert.equal(listing[0].masked, true);
    assert.ok(!listed.body.includes('super-secret-value'));

    const task = await claimTask(h);
    assert.equal(task.env.DEPLOY_TOKEN, 'super-secret-value');
    assert.deepEqual(task.masked, ['super-secret-value']);
  });
});

test('a variable is encrypted at rest and bound to its project and name', async () => {
  await withAdmin({}, async (h, admin) => {
    await h.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/demo/variables/TOKEN',
      headers: json(admin),
      payload: JSON.stringify({ value: 'rest-secret-value' }),
    });

    const row = await h.services.db.get(
      'SELECT value FROM project_variables WHERE project_id = {p} AND name = {n}',
      { p: 'demo', n: 'TOKEN' }
    );
    assert.ok(row.value.startsWith('v1.'), 'expected an encrypted value');
    assert.ok(!row.value.includes('rest-secret-value'));

    await h.services.db.run(
      `INSERT INTO project_variables (project_id, name, value, masked, created_at)
       VALUES ({p}, {n}, {v}, 1, {t})`,
      { p: 'demo', n: 'MOVED', v: row.value, t: Date.now() }
    );

    const resolved = await h.services.variables.resolve('demo');
    assert.equal(resolved.env.TOKEN, 'rest-secret-value');
    assert.equal(resolved.env.MOVED, undefined, 'a relocated ciphertext must not open');
  });
});

test('a value that will not open is reported as broken rather than absent', async () => {
  await withAdmin({}, async (h, admin) => {
    await h.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/demo/variables/TOKEN',
      headers: json(admin),
      payload: JSON.stringify({ value: 'unopenable-secret-value' }),
    });

    const row = await h.services.db.get(
      'SELECT value FROM project_variables WHERE project_id = {p} AND name = {n}',
      { p: 'demo', n: 'TOKEN' }
    );
    await h.services.db.run(
      `INSERT INTO project_variables (project_id, name, value, masked, created_at)
       VALUES ({p}, {n}, {v}, 1, {t})`,
      { p: 'demo', n: 'MOVED', v: row.value, t: Date.now() }
    );

    const res = await h.app.inject({
      url: '/api/v1/projects/demo/variables/MOVED/value', headers: admin,
    });
    assert.equal(res.statusCode, 500, res.body);
    assert.ok(!res.body.includes('unopenable-secret-value'));
  });
});

test('a pipeline setting wins over a project variable of the same name', async () => {
  const pipeline = `
version: 1
defaults:
  image: debian:bookworm-slim
tasks:
  a:
    script: ['true']
    env:
      SHARED: from-pipeline
`;
  await withAdmin({ pipeline }, async (h, admin) => {
    await h.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/demo/variables/SHARED',
      headers: json(admin),
      payload: JSON.stringify({ value: 'from-variable' }),
    });

    const task = await claimTask(h);
    assert.equal(task.env.SHARED, 'from-pipeline');
  });
});

test('a masked variable is redacted from an ingested log', async () => {
  await withAdmin({}, async (h, admin) => {
    await h.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/demo/variables/LEAKY',
      headers: json(admin),
      payload: JSON.stringify({ value: 'leaked-secret-value', masked: true }),
    });

    const task = await claimTask(h);
    const appended = await h.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${encodeURIComponent(task.id)}/log`,
      headers: { ...h.auth, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('echo leaked-secret-value here\n'),
    });
    assert.equal(appended.statusCode, 200, appended.body);

    const log = await h.app.inject({
      method: 'GET', url: `/api/v1/tasks/${encodeURIComponent(task.id)}/log`,
    });
    assert.ok(!log.body.includes('leaked-secret-value'), `log leaked: ${log.body}`);
    assert.match(log.body, /\[masked\]/);
  });
});

test('a job can be cancelled and retried at the same commit', async () => {
  await withAdmin({}, async (h, admin) => {
    const triggered = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const jobId = data(triggered).job_id;
    await h.waitForJob(jobId);

    const cancelled = await h.app.inject({
      method: 'POST', url: `/api/v1/jobs/${jobId}/cancel`, headers: json(admin), payload: '{}',
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);

    const detail = await h.app.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}` });
    assert.equal(data(detail).state, 'cancelled');

    const retried = await h.app.inject({
      method: 'POST', url: `/api/v1/jobs/${jobId}/retry`, headers: json(admin), payload: '{}',
    });
    assert.equal(retried.statusCode, 200, retried.body);
    assert.notEqual(data(retried).job_id, jobId);
    await h.waitForJob(data(retried).job_id);

    const fresh = await h.app.inject({ method: 'GET', url: `/api/v1/jobs/${data(retried).job_id}` });
    assert.equal(data(fresh).head_sha, h.sha);
  });
});

test('an administrator cannot lock themselves out', async () => {
  await withAdmin({}, async (h, admin) => {
    const me = data(await h.app.inject({ method: 'GET', url: '/api/v1/users/me', headers: admin }));

    const demoted = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${me.id}`,
      headers: json(admin),
      payload: JSON.stringify({ role: 'user' }),
    });
    assert.equal(demoted.statusCode, 403, demoted.body);

    const removed = await h.app.inject({
      method: 'DELETE', url: `/api/v1/users/${me.id}`, headers: admin,
    });
    assert.equal(removed.statusCode, 403, removed.body);
  });
});

test('a disabled account stops being accepted', async () => {
  await withAdmin({}, async (h, admin) => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: json(admin),
      payload: JSON.stringify({ username: 'temp', password: 'temp-password', role: 'user' }),
    });
    const id = data(created).id;
    const { headers } = await h.login('temp', 'temp-password');

    assert.equal(
      (await h.app.inject({ method: 'GET', url: '/api/v1/users/me', headers })).statusCode, 200
    );

    await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${id}`,
      headers: json(admin),
      payload: JSON.stringify({ disabled: true }),
    });

    const after = await h.app.inject({ method: 'GET', url: '/api/v1/users/me', headers });
    assert.equal(after.statusCode, 401, after.body);
  });
});
