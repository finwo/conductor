// test/ownership.test.js - who owns what, and what that decides

import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, data, apiError } from './helpers/harness.js';

async function withHarness(options, fn) {
  const h = await startHarness({ bootstrap: true, ...options });
  try {
    await fn(h);
  } finally {
    await h.stop();
  }
}

const json = { 'content-type': 'application/json' };

async function addUser(h, admin, username, role = 'user') {
  const password = `${username}-password`;
  const created = await h.app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: { ...admin, ...json },
    payload: JSON.stringify({ username, password, role }),
  });
  assert.equal(created.statusCode, 201, created.body);

  const grant = await h.login(username, password);
  return { user: data(created), headers: grant.headers };
}

function claimAs(h, token, body = {}) {
  return h.app.inject({
    method: 'POST',
    url: '/api/v1/tasks/claim',
    headers: { authorization: `Bearer ${token}`, ...json },
    payload: JSON.stringify(body),
  });
}

async function queueWork(h) {
  const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
  const jobId = data(res).job_id;
  await h.waitForJob(jobId);
  return jobId;
}

test("a worker belonging to a user is not offered another user's work", async () => {
  await withHarness({ visibility: 'private' }, async (h) => {
    const { headers: admin } = await h.login();
    const alice = await addUser(h, admin, 'alice');
    const bob = await addUser(h, admin, 'bob');

    await h.services.projects.setOwner('demo', alice.user.id);
    const forAlice = await h.services.workerTokens.create('alice-pi', { ownerId: alice.user.id });
    const forBob = await h.services.workerTokens.create('bob-pi', { ownerId: bob.user.id });

    await queueWork(h);

    assert.equal((await claimAs(h, forBob.token)).statusCode, 204);

    const claimed = await claimAs(h, forAlice.token);
    assert.equal(claimed.statusCode, 200, claimed.body);
    assert.equal(data(claimed).task.name, 'lint');
  });
});

test('a worker with no owner is offered work from any project', async () => {
  await withHarness({ visibility: 'private' }, async (h) => {
    const { headers: admin } = await h.login();
    const alice = await addUser(h, admin, 'alice');
    await h.services.projects.setOwner('demo', alice.user.id);

    const shared = await h.services.workerTokens.create('pool', { ownerId: null });
    await queueWork(h);

    const claimed = await claimAs(h, shared.token);
    assert.equal(claimed.statusCode, 200, claimed.body);
  });
});

test('a project a user creates belongs to them and a stranger cannot touch it', async () => {
  await withHarness({}, async (h) => {
    const { headers: admin } = await h.login();
    const alice = await addUser(h, admin, 'alice');
    const bob = await addUser(h, admin, 'bob');

    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { ...alice.headers, ...json },
      payload: JSON.stringify({ id: 'alice-app', repo_url: 'https://git.example.com/a.git' }),
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(data(created).owner_id, alice.user.id);

    const listed = await h.app.inject({ method: 'GET', url: '/api/v1/projects', headers: bob.headers });
    assert.ok(!data(listed).some((p) => p.id === 'alice-app'));

    const removed = await h.app.inject({
      method: 'DELETE', url: '/api/v1/projects/alice-app', headers: bob.headers,
    });
    assert.equal(removed.statusCode, 404, removed.body);
  });
});

test('a worker a user registers is invisible to another user', async () => {
  await withHarness({}, async (h) => {
    const { headers: admin } = await h.login();
    const alice = await addUser(h, admin, 'alice');
    const bob = await addUser(h, admin, 'bob');

    const token = await h.app.inject({
      method: 'POST',
      url: '/api/v1/workers',
      headers: { ...bob.headers, ...json },
      payload: JSON.stringify({ name: 'bob-laptop' }),
    });
    assert.equal(token.statusCode, 201, token.body);
    assert.equal(data(token).owner_id, bob.user.id);

    const listed = await h.app.inject({ method: 'GET', url: '/api/v1/workers', headers: alice.headers });
    assert.deepEqual(data(listed).map((w) => w.name), []);

    const probed = await h.app.inject({
      method: 'GET', url: `/api/v1/workers/${data(token).id}`, headers: alice.headers,
    });
    assert.equal(probed.statusCode, 404, probed.body);
  });
});

test('an ordinary user asking for shared capacity gets a personal worker', async () => {
  await withHarness({}, async (h) => {
    const { headers: admin } = await h.login();
    const alice = await addUser(h, admin, 'alice');

    const sneaky = await h.app.inject({
      method: 'POST',
      url: '/api/v1/workers',
      headers: { ...alice.headers, ...json },
      payload: JSON.stringify({ name: 'sneaky', owner_id: null }),
    });
    assert.equal(data(sneaky).owner_id, alice.user.id);

    const pool = await h.app.inject({
      method: 'POST',
      url: '/api/v1/workers',
      headers: { ...admin, ...json },
      payload: JSON.stringify({ name: 'pool', owner_id: null }),
    });
    assert.equal(data(pool).owner_id, null);
  });
});

test('only an administrator can reassign a project', async () => {
  await withHarness({}, async (h) => {
    const { headers: admin } = await h.login();
    const alice = await addUser(h, admin, 'alice');
    await h.services.projects.setOwner('demo', alice.user.id);

    const refused = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/projects/demo',
      headers: { ...alice.headers, ...json },
      payload: JSON.stringify({ owner_id: null }),
    });
    assert.equal(refused.statusCode, 403, refused.body);
    assert.equal(apiError(refused).name, 'NotPermitted');

    const allowed = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/projects/demo',
      headers: { ...admin, ...json },
      payload: JSON.stringify({ owner_id: null }),
    });
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(data(allowed).owner_id, null);
  });
});

test('deleting a user takes their projects and workers with them', async () => {
  await withHarness({}, async (h) => {
    const { headers: admin } = await h.login();
    const alice = await addUser(h, admin, 'alice');

    await h.services.projects.setOwner('demo', alice.user.id);
    const token = await h.services.workerTokens.create('alice-pi', { ownerId: alice.user.id });
    const jobId = await queueWork(h);

    const removed = await h.app.inject({
      method: 'DELETE', url: `/api/v1/users/${alice.user.id}`, headers: admin,
    });
    assert.equal(removed.statusCode, 200, removed.body);

    assert.equal(await h.services.projects.get('demo'), undefined);
    assert.equal(await h.services.workerTokens.get(token.id), undefined);
    assert.equal(await h.services.db.get('SELECT id FROM jobs WHERE id = {id}', { id: jobId }), undefined);
  });
});

test('a worker token does not outlive its owner and become shared capacity', async () => {
  await withHarness({}, async (h) => {
    const { headers: admin } = await h.login();
    const alice = await addUser(h, admin, 'alice');
    const token = await h.services.workerTokens.create('alice-pi', { ownerId: alice.user.id });

    await h.app.inject({ method: 'DELETE', url: `/api/v1/users/${alice.user.id}`, headers: admin });

    const rows = await h.services.db.all(
      'SELECT id FROM worker_tokens WHERE id = {id}', { id: token.id }
    );
    assert.deepEqual(rows, []);

    const claimed = await claimAs(h, token.token);
    assert.equal(claimed.statusCode, 401, claimed.body);
    assert.equal(apiError(claimed).name, 'InvalidWorkerToken');
  });
});

const valueUrl = (project, name) => `/api/v1/projects/${project}/variables/${name}/value`;

test('an owner reads back a variable whether or not it is masked in logs', async () => {
  await withHarness({}, async (h) => {
    const { headers: admin } = await h.login();
    const alice = await addUser(h, admin, 'alice');
    await h.services.projects.setOwner('demo', alice.user.id);

    await h.services.variables.set('demo', 'HIDDEN', 'hidden-value', { masked: true });
    await h.services.variables.set('demo', 'SHOWN', 'shown-value', { masked: false });

    const hidden = await h.app.inject({ url: valueUrl('demo', 'HIDDEN'), headers: alice.headers });
    assert.equal(hidden.statusCode, 200, hidden.body);
    assert.equal(data(hidden).value, 'hidden-value');
    assert.equal(data(hidden).masked, true);

    const shown = await h.app.inject({ url: valueUrl('demo', 'SHOWN'), headers: alice.headers });
    assert.equal(data(shown).value, 'shown-value');
    assert.equal(data(shown).masked, false);
  });
});

test('the listing still withholds what the value endpoint hands over', async () => {
  await withHarness({}, async (h) => {
    const { headers: admin } = await h.login();
    await h.services.variables.set('demo', 'TOKEN', 'listing-secret-value', { masked: true });

    const listed = await h.app.inject({ url: '/api/v1/projects/demo/variables', headers: admin });
    assert.ok(!listed.body.includes('listing-secret-value'));
    assert.equal(data(listed)[0].name, 'TOKEN');

    const revealed = await h.app.inject({ url: valueUrl('demo', 'TOKEN'), headers: admin });
    assert.equal(data(revealed).value, 'listing-secret-value');
  });
});

test('an administrator reads a variable of a project they do not own', async () => {
  await withHarness({}, async (h) => {
    const { headers: admin } = await h.login();
    const alice = await addUser(h, admin, 'alice');
    await h.services.projects.setOwner('demo', alice.user.id);
    await h.services.variables.set('demo', 'TOKEN', 'admin-readable-value');

    const res = await h.app.inject({ url: valueUrl('demo', 'TOKEN'), headers: admin });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(data(res).value, 'admin-readable-value');
  });
});

test('a public project does not hand its variables to every signed in user', async () => {
  await withHarness({ visibility: 'public' }, async (h) => {
    const { headers: admin } = await h.login();
    const alice = await addUser(h, admin, 'alice');
    const bob = await addUser(h, admin, 'bob');
    await h.services.projects.setOwner('demo', alice.user.id);
    await h.services.variables.set('demo', 'TOKEN', 'not-for-bob-value');

    const refused = await h.app.inject({ url: valueUrl('demo', 'TOKEN'), headers: bob.headers });
    assert.equal(refused.statusCode, 403, refused.body);
    assert.equal(apiError(refused).name, 'NotPermitted');
    assert.ok(!refused.body.includes('not-for-bob-value'));

    const anonymous = await h.app.inject({ url: valueUrl('demo', 'TOKEN') });
    assert.equal(anonymous.statusCode, 403, anonymous.body);
    assert.ok(!anonymous.body.includes('not-for-bob-value'));
  });
});

test('a private project answers a variable read as though it were not there', async () => {
  await withHarness({ visibility: 'private' }, async (h) => {
    const { headers: admin } = await h.login();
    const alice = await addUser(h, admin, 'alice');
    const bob = await addUser(h, admin, 'bob');
    await h.services.projects.setOwner('demo', alice.user.id);
    await h.services.variables.set('demo', 'TOKEN', 'not-for-bob-value');

    const stranger = await h.app.inject({ url: valueUrl('demo', 'TOKEN'), headers: bob.headers });
    assert.equal(stranger.statusCode, 404, stranger.body);

    const anonymous = await h.app.inject({ url: valueUrl('demo', 'TOKEN') });
    assert.equal(anonymous.statusCode, 404, anonymous.body);
  });
});

test('reading a variable that was never set is a miss, not an empty value', async () => {
  await withHarness({}, async (h) => {
    const { headers: admin } = await h.login();
    const res = await h.app.inject({ url: valueUrl('demo', 'ABSENT'), headers: admin });
    assert.equal(res.statusCode, 404, res.body);
  });
});
