// test/visibility.test.js - who can see and run what
//
// Two rules are enforced here, and both matter for letting strangers use
// the same installation:
//
//   A run is private unless its project or its pipeline says otherwise.
//   An anonymous visitor sees only public runs; a user additionally sees
//   their own; an administrator sees everything.
//
//   A worker registered by a user is only ever offered that user's jobs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';

async function withHarness(options, fn) {
  const h = await startHarness({ bootstrap: true, ...options });
  try {
    return await fn(h);
  } finally {
    await h.stop();
  }
}

// Creates a user and returns their credentials and identity.
async function addUser(h, admin, username, role = 'viewer') {
  const created = await h.app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { ...admin, 'content-type': 'application/json' },
    payload: JSON.stringify({ username, password: `${username}-password`, role }),
  });
  const user = created.json().user;

  const login = await h.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ username, password: `${username}-password` }),
  });
  return { user, headers: { authorization: `Bearer ${login.json().token}` } };
}

const runIds = (res) => res.json().runs.map((r) => r.id);

test('a private run is invisible to anonymous callers', async () => {
  await withHarness({ visibility: 'private' }, async (h) => {
    const run = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().run_id;

    assert.deepEqual(runIds(await h.app.inject({ method: 'GET', url: '/api/runs' })), []);
    // The same answer as a run that does not exist, so nothing is leaked
    // by the status code.
    assert.equal((await h.app.inject({ method: 'GET', url: `/api/runs/${run}` })).statusCode, 404);
  });
});

test('a public run is visible to anonymous callers', async () => {
  await withHarness({ visibility: 'public' }, async (h) => {
    const run = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().run_id;

    assert.deepEqual(runIds(await h.app.inject({ method: 'GET', url: '/api/runs' })), [run]);
    assert.equal((await h.app.inject({ method: 'GET', url: `/api/runs/${run}` })).statusCode, 200);
  });
});

test('the pipeline may override the project visibility', async () => {
  const pipeline = `
version: 1
visibility: public
jobs:
  a:
    image: alpine
    script: ['true']
`;
  await withHarness({ pipeline, visibility: 'private' }, async (h) => {
    const run = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().run_id;

    // The project is private, but this commit declared itself public.
    const detail = await h.app.inject({ method: 'GET', url: `/api/runs/${run}` });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().run.visibility, 'public');
  });
});

test('visibility is recorded per run, so a later commit can change it', async () => {
  const open = "version: 1\nvisibility: public\njobs:\n  a: { image: alpine, script: ['true'] }\n";
  await withHarness({ pipeline: open, visibility: 'private' }, async (h) => {
    const first = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().run_id;

    const closed = "version: 1\nvisibility: private\njobs:\n  a: { image: alpine, script: ['true'] }\n";
    const sha2 = await h.commit({ '.conductor.yml': closed }, 'go private');
    const second = (await h.trigger({ sha: sha2, ref: 'refs/heads/main' })).json().run_id;

    // The old run stays public; the new one does not.
    assert.deepEqual(runIds(await h.app.inject({ method: 'GET', url: '/api/runs' })), [first]);
    assert.equal((await h.app.inject({ method: 'GET', url: `/api/runs/${second}` })).statusCode, 404);
  });
});

test('an owner sees their private runs, a stranger does not', async () => {
  await withHarness({ visibility: 'private' }, async (h) => {
    const admin = await h.login();
    const owner = await addUser(h, admin, 'owner');
    const stranger = await addUser(h, admin, 'stranger');

    await h.services.projects.setOwner('demo', owner.user.id);
    const run = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().run_id;

    assert.deepEqual(runIds(await h.app.inject({ method: 'GET', url: '/api/runs', headers: owner.headers })), [run]);
    assert.deepEqual(runIds(await h.app.inject({ method: 'GET', url: '/api/runs', headers: stranger.headers })), []);
    // An administrator sees everything.
    assert.deepEqual(runIds(await h.app.inject({ method: 'GET', url: '/api/runs', headers: admin })), [run]);
  });
});

test('logs and artifacts of a private run are not readable by a stranger', async () => {
  await withHarness({ visibility: 'private' }, async (h) => {
    const admin = await h.login();
    const owner = await addUser(h, admin, 'owner');
    await h.services.projects.setOwner('demo', owner.user.id);

    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = (await h.poll({})).json().job;

    await h.app.inject({
      method: 'POST',
      url: `/api/workers/jobs/${encodeURIComponent(job.id)}/log`,
      headers: { ...h.auth, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('private build output\n'),
    });
    await h.app.inject({
      method: 'POST',
      url: `/api/workers/jobs/${encodeURIComponent(job.id)}/artifact`,
      headers: { ...h.auth, 'content-type': 'application/octet-stream', 'x-artifact-path': 'secret.bin' },
      payload: Buffer.from('private artifact'),
    });

    const jobUrl = `/api/jobs/${encodeURIComponent(job.id)}`;
    assert.equal((await h.app.inject({ method: 'GET', url: jobUrl })).statusCode, 404);
    assert.equal((await h.app.inject({ method: 'GET', url: `${jobUrl}/log` })).statusCode, 404);

    const asOwner = await h.app.inject({ method: 'GET', url: jobUrl, headers: owner.headers });
    assert.equal(asOwner.statusCode, 200);

    const artifactId = asOwner.json().artifacts[0].id;
    assert.equal((await h.app.inject({ method: 'GET', url: `/api/artifacts/${artifactId}` })).statusCode, 404);
    const download = await h.app.inject({ method: 'GET', url: `/api/artifacts/${artifactId}`, headers: owner.headers });
    assert.equal(download.body, 'private artifact');
  });
});

test("a worker belonging to a user only receives that owner's projects", async () => {
  await withHarness({ visibility: 'private' }, async (h) => {
    const admin = await h.login();
    const alice = await addUser(h, admin, 'alice');
    const bob = await addUser(h, admin, 'bob');

    // demo belongs to alice.
    await h.services.projects.setOwner('demo', alice.user.id);

    const aliceWorker = await h.services.workerTokens.create('alice-pi', { ownerId: alice.user.id });
    const bobWorker = await h.services.workerTokens.create('bob-pi', { ownerId: bob.user.id });

    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });

    // Bob's worker must never see alice's work.
    const forBob = await h.app.inject({
      method: 'GET', url: '/api/workers/poll', headers: { authorization: `Bearer ${bobWorker.token}` },
    });
    assert.equal(forBob.statusCode, 204);

    const forAlice = await h.app.inject({
      method: 'GET', url: '/api/workers/poll', headers: { authorization: `Bearer ${aliceWorker.token}` },
    });
    assert.equal(forAlice.statusCode, 200);
    assert.equal(forAlice.json().job.project_id, 'demo');
  });
});

test('a shared worker receives work from any project', async () => {
  await withHarness({ visibility: 'private' }, async (h) => {
    const admin = await h.login();
    const alice = await addUser(h, admin, 'alice');
    await h.services.projects.setOwner('demo', alice.user.id);

    // No owner means shared capacity.
    const shared = await h.services.workerTokens.create('shared', { ownerId: null });
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });

    const res = await h.app.inject({
      method: 'GET', url: '/api/workers/poll', headers: { authorization: `Bearer ${shared.token}` },
    });
    assert.equal(res.statusCode, 200);
  });
});

test("a user registers their own project and worker, and cannot touch another's", async () => {
  await withHarness({}, async (h) => {
    const admin = await h.login();
    const alice = await addUser(h, admin, 'alice');
    const bob = await addUser(h, admin, 'bob');
    const json = (headers) => ({ ...headers, 'content-type': 'application/json' });

    const created = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: json(alice.headers),
      payload: JSON.stringify({ id: 'alice-app', repo_url: 'https://git.example.com/a.git' }),
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().project.owner_id, alice.user.id);

    // Bob cannot see or manage it.
    const bobList = await h.app.inject({ method: 'GET', url: '/api/projects', headers: bob.headers });
    assert.deepEqual(bobList.json().projects.map((p) => p.id), []);
    assert.equal((await h.app.inject({
      method: 'DELETE', url: '/api/projects/alice-app', headers: bob.headers,
    })).statusCode, 403);

    // A worker bob registers belongs to bob.
    const token = await h.app.inject({
      method: 'POST',
      url: '/api/worker-tokens',
      headers: json(bob.headers),
      payload: JSON.stringify({ name: 'bob-laptop' }),
    });
    assert.equal(token.json().worker_token.owner_id, bob.user.id);
    assert.equal(token.json().worker_token.shared, false);

    // And alice cannot see it.
    const aliceWorkers = await h.app.inject({ method: 'GET', url: '/api/worker-tokens', headers: alice.headers });
    assert.deepEqual(aliceWorkers.json().worker_tokens.map((t) => t.name), []);
  });
});

test('only an administrator can create shared capacity or reassign a project', async () => {
  await withHarness({}, async (h) => {
    const admin = await h.login();
    const alice = await addUser(h, admin, 'alice');
    const json = (headers) => ({ ...headers, 'content-type': 'application/json' });

    // Asking for a shared worker as an ordinary user gets a personal one.
    const attempt = await h.app.inject({
      method: 'POST',
      url: '/api/worker-tokens',
      headers: json(alice.headers),
      payload: JSON.stringify({ name: 'sneaky', shared: true }),
    });
    assert.equal(attempt.json().worker_token.shared, false);
    assert.equal(attempt.json().worker_token.owner_id, alice.user.id);

    const asAdmin = await h.app.inject({
      method: 'POST',
      url: '/api/worker-tokens',
      headers: json(admin),
      payload: JSON.stringify({ name: 'pool', shared: true }),
    });
    assert.equal(asAdmin.json().worker_token.shared, true);

    // Reassigning an owner is administrator only.
    await h.services.projects.setOwner('demo', alice.user.id);
    const reassign = await h.app.inject({
      method: 'PATCH',
      url: '/api/projects/demo',
      headers: json(alice.headers),
      payload: JSON.stringify({ owner_id: null }),
    });
    assert.equal(reassign.statusCode, 400);
  });
});

test('deleting a user deletes what they owned, leaving nothing orphaned', async () => {
  await withHarness({}, async (h) => {
    const admin = await h.login();
    const alice = await addUser(h, admin, 'alice');
    await h.services.projects.setOwner('demo', alice.user.id);
    const token = await h.services.workerTokens.create('alice-pi', { ownerId: alice.user.id });
    const run = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().run_id;

    // The caller is told what will go before it goes.
    const impact = await h.app.inject({
      method: 'GET', url: `/api/admin/users/${alice.user.id}/impact`, headers: admin,
    });
    assert.deepEqual(impact.json().projects, ['demo']);
    assert.equal(impact.json().worker_tokens_deleted, 1);
    assert.ok(impact.json().runs_deleted > 0);

    const removed = await h.app.inject({
      method: 'DELETE', url: `/api/admin/users/${alice.user.id}`, headers: admin,
    });
    assert.equal(removed.statusCode, 200);
    assert.deepEqual(removed.json().projects, ['demo']);

    // Nothing of theirs is left behind.
    assert.equal(await h.services.projects.get('demo'), undefined);
    assert.equal(await h.services.db.get('SELECT id FROM runs WHERE id = {id}', { id: run }), undefined);
    assert.equal(await h.services.workerTokens.get(token.id), undefined);
  });
});

test('an orphaned worker token cannot appear and quietly become shared', async () => {
  await withHarness({}, async (h) => {
    const admin = await h.login();
    const alice = await addUser(h, admin, 'alice');
    const token = await h.services.workerTokens.create('alice-pi', { ownerId: alice.user.id });

    await h.app.inject({ method: 'DELETE', url: `/api/admin/users/${alice.user.id}`, headers: admin });

    // Were the row merely unowned, this token would now accept any
    // project's jobs instead of none.
    const rows = await h.services.db.all('SELECT id, owner_id FROM worker_tokens WHERE id = {id}', { id: token.id });
    assert.deepEqual(rows, []);

    const poll = await h.app.inject({
      method: 'GET', url: '/api/workers/poll', headers: { authorization: `Bearer ${token.token}` },
    });
    assert.equal(poll.statusCode, 401);
  });
});
