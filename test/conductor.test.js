// test/conductor.test.js - end to end behaviour of the conductor service
//
// Drives a real server against a real git repository: trigger, dispatch,
// logs, artifacts, completion and failure handling.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';

// Each test gets its own harness so that ordering never matters.
async function withHarness(options, fn) {
  const h = await startHarness(options);
  try {
    return await fn(h);
  } finally {
    await h.stop();
  }
}

function jobsByName(payload) {
  return Object.fromEntries(payload.jobs.map((j) => [j.name, j]));
}

async function runState(h, runId) {
  const res = await h.app.inject({ method: 'GET', url: `/api/runs/${runId}` });
  return res.json();
}

// Claims everything currently eligible for a worker with the given
// capabilities, keyed by job name. Tests assert on which jobs appear rather
// than on the order they arrive in, which is not part of the contract.
async function drain(h, query = {}) {
  const claimed = {};
  for (let i = 0; i < 50; i += 1) {
    const res = await h.poll(query);
    if (res.statusCode === 204) break;
    const job = res.json().job;
    claimed[job.name] = job;
  }
  return claimed;
}

async function claimNamed(h, name, query) {
  return (await drain(h, query))[name] ?? null;
}

async function finish(h, jobId, { success = true, exitCode = 0, error = null } = {}) {
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/workers/jobs/${encodeURIComponent(jobId)}/done`,
    headers: { ...h.auth, 'content-type': 'application/json' },
    payload: JSON.stringify({ success, exit_code: exitCode, error }),
  });
  return res.json();
}

test('health reports the selected drivers', async () => {
  await withHarness({}, async (h) => {
    const res = await h.app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      ok: true, service: 'conductor', database: 'sqlite', storage: 'local', auth: 'local',
    });
  });
});

test('a signed trigger creates a run and expands the pipeline', async () => {
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main', actor: 'alice' });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    assert.equal(body.status, 'created');
    // lint + 2 build + 2 package + publish
    assert.equal(body.jobs, 6);

    const detail = await runState(h, body.run_id);
    assert.equal(detail.run.state, 'running');
    assert.equal(detail.run.actor, 'alice');
    assert.equal(detail.run.title, 'initial commit');
    assert.equal(detail.run.number, 1);

    const jobs = jobsByName(detail);
    assert.deepEqual(jobs['package:arch=x86_64,pkg=musl'].needs, [`${body.run_id}:build:arch=x86_64`]);
    assert.equal(jobs.publish.needs.length, 3);
  });
});

test('an unsigned or wrongly signed trigger is refused', async () => {
  await withHarness({}, async (h) => {
    const unsigned = await h.app.inject({
      method: 'POST',
      url: '/api/trigger/demo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ sha: h.sha }),
    });
    assert.equal(unsigned.statusCode, 401);

    const wrong = await h.trigger({ sha: h.sha }, { secret: 'not-the-secret' });
    assert.equal(wrong.statusCode, 401);
  });
});

test('github and gitlab push payloads are understood', async () => {
  await withHarness({}, async (h) => {
    const github = await h.trigger({
      after: h.sha,
      before: '0'.repeat(40),
      ref: 'refs/heads/main',
      pusher: { name: 'octocat' },
    });
    assert.equal(github.statusCode, 200);
    assert.equal(github.json().status, 'created');

    const gitlab = await h.trigger({
      checkout_sha: h.sha,
      ref: 'refs/heads/main',
      user_username: 'gl-user',
    });
    assert.equal(gitlab.statusCode, 200);
  });
});

test('a branch deletion is ignored rather than failing', async () => {
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: '0'.repeat(40), ref: 'refs/heads/gone' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'ignored');
  });
});

test('a broken pipeline is reported as a client error with detail', async () => {
  await withHarness({ pipeline: 'version: 1\njobs:\n  a:\n    script: [x]\n' }, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    assert.equal(res.statusCode, 422);
    const body = res.json();
    assert.equal(body.error, 'invalid pipeline');
    assert.ok(body.problems.some((p) => p.path === 'jobs.a.image'));
  });
});

test('a missing pipeline file is reported clearly', async () => {
  await withHarness({ pipeline: null }, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    assert.equal(res.statusCode, 422);
    assert.match(res.json().detail, /\.conductor\.yml not found/);
  });
});

test('the worker api rejects missing and invalid tokens', async () => {
  await withHarness({}, async (h) => {
    const none = await h.app.inject({ method: 'GET', url: '/api/workers/poll' });
    assert.equal(none.statusCode, 401);

    const bad = await h.app.inject({
      method: 'GET', url: '/api/workers/poll', headers: { authorization: 'Bearer nope' },
    });
    assert.equal(bad.statusCode, 401);
  });
});

test('independent jobs dispatch concurrently', async () => {
  await withHarness({}, async (h) => {
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });

    // The prototype could only ever hand out one job at a time.
    const [a, b, c] = await Promise.all([
      h.poll({ arches: 'x86_64,aarch64' }),
      h.poll({ arches: 'x86_64,aarch64' }),
      h.poll({ arches: 'x86_64,aarch64' }),
    ]);

    const names = [a, b, c].map((r) => r.json().job.name);
    assert.equal(new Set(names).size, 3, `expected three distinct jobs, got ${names.join(', ')}`);
    assert.deepEqual(names.slice().sort(), ['build:arch=aarch64', 'build:arch=x86_64', 'lint']);
  });
});

test('a job is only offered to a worker that satisfies its requires', async () => {
  await withHarness({}, async (h) => {
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });

    // Clear the three root jobs so only package and publish remain.
    const roots = await drain(h, { arches: 'x86_64,aarch64' });
    assert.deepEqual(Object.keys(roots).sort(), ['build:arch=aarch64', 'build:arch=x86_64', 'lint']);
    for (const job of Object.values(roots)) await finish(h, job.id, { success: true });

    // package requires sign-key, which this worker does not advertise.
    const without = await h.poll({ arches: 'x86_64,aarch64' });
    assert.equal(without.statusCode, 204);

    const with_ = await h.poll({ arches: 'x86_64,aarch64', features: 'sign-key' });
    assert.equal(with_.statusCode, 200);
    assert.match(with_.json().job.name, /^package:/);
  });
});

test('a worker is not offered work for an architecture it cannot build', async () => {
  await withHarness({}, async (h) => {
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });

    const claimed = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await h.poll({ arches: 'aarch64' });
      if (res.statusCode === 204) break;
      claimed.push(res.json().job);
    }

    // lint has no arch so it is eligible; the x86_64 build is not.
    assert.ok(!claimed.some((j) => j.arch === 'x86_64'));
    assert.ok(claimed.some((j) => j.name === 'build:arch=aarch64'));
  });
});

test('a claimed job carries everything the worker needs', async () => {
  await withHarness({}, async (h) => {
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = await claimNamed(h, 'build:arch=x86_64', { arches: 'x86_64' });

    assert.equal(job.image, 'debian:bookworm-slim');
    assert.deepEqual(job.script, ['./build.sh $ARCH']);
    assert.equal(job.env.ARCH, 'x86_64');
    assert.equal(job.sha, h.sha);
    assert.equal(job.source.mode, 'archive');
    assert.match(job.source.url, /^http:\/\/conductor\.test\/api\/workers\/jobs\//);
    assert.ok(job.endpoints.log.endsWith('/log'));
  });
});

test('the source tarball is served from the mirror', async () => {
  await withHarness({}, async (h) => {
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = await claimNamed(h, 'lint', {});

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/workers/jobs/${encodeURIComponent(job.id)}/source.tar.gz`,
      headers: h.auth,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/gzip');
    // gzip magic number
    assert.equal(res.rawPayload[0], 0x1f);
    assert.equal(res.rawPayload[1], 0x8b);
  });
});

test('a worker cannot touch a job it does not hold', async () => {
  await withHarness({}, async (h) => {
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = await claimNamed(h, 'lint', {});

    const other = await h.services.workerTokens.create('intruder');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/workers/jobs/${encodeURIComponent(job.id)}/log`,
      headers: { authorization: `Bearer ${other.token}`, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('malicious'),
    });
    assert.equal(res.statusCode, 403);
  });
});

test('log appends are resumable and deduplicated by offset', async () => {
  await withHarness({}, async (h) => {
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = await claimNamed(h, 'lint', {});
    const url = `/api/workers/jobs/${encodeURIComponent(job.id)}/log`;
    const headers = { ...h.auth, 'content-type': 'application/octet-stream' };

    const first = await h.app.inject({
      method: 'POST', url, headers: { ...headers, 'x-log-offset': '0' }, payload: Buffer.from('hello\n'),
    });
    assert.deepEqual(first.json(), { size: 6, written: 6, truncated: false });

    // A retry resends what was already stored plus new data.
    const retry = await h.app.inject({
      method: 'POST', url, headers: { ...headers, 'x-log-offset': '0' }, payload: Buffer.from('hello\nworld\n'),
    });
    assert.deepEqual(retry.json(), { size: 12, written: 6, truncated: false });

    // A gap is refused, and says where to resume.
    const gap = await h.app.inject({
      method: 'POST', url, headers: { ...headers, 'x-log-offset': '9999' }, payload: Buffer.from('x'),
    });
    assert.equal(gap.statusCode, 409);
    assert.equal(gap.json().expected_offset, 12);

    const tail = await h.app.inject({ method: 'GET', url: `/api/jobs/${encodeURIComponent(job.id)}/log` });
    assert.equal(tail.body, 'hello\nworld\n');
    assert.equal(tail.headers['x-log-size'], '12');
    assert.equal(tail.headers['x-log-complete'], 'false');

    const partial = await h.app.inject({
      method: 'GET', url: `/api/jobs/${encodeURIComponent(job.id)}/log?offset=6`,
    });
    assert.equal(partial.body, 'world\n');
  });
});

test('a finished log moves to storage and is still readable', async () => {
  await withHarness({}, async (h) => {
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = await claimNamed(h, 'lint', {});

    await h.app.inject({
      method: 'POST',
      url: `/api/workers/jobs/${encodeURIComponent(job.id)}/log`,
      headers: { ...h.auth, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('compiling\ndone\n'),
    });
    await finish(h, job.id, { success: true });

    const tail = await h.app.inject({ method: 'GET', url: `/api/jobs/${encodeURIComponent(job.id)}/log` });
    assert.equal(tail.statusCode, 200);
    assert.equal(tail.body, 'compiling\ndone\n');
    assert.equal(tail.headers['x-log-complete'], 'true');
  });
});

test('artifacts are stored, hashed, and stripped of traversal', async () => {
  await withHarness({}, async (h) => {
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = await claimNamed(h, 'build:arch=x86_64', { arches: 'x86_64' });

    const upload = await h.app.inject({
      method: 'POST',
      url: `/api/workers/jobs/${encodeURIComponent(job.id)}/artifact`,
      headers: {
        ...h.auth,
        'content-type': 'application/octet-stream',
        'x-artifact-path': '../../../etc/passwd',
      },
      payload: Buffer.from('artifact bytes'),
    });
    assert.equal(upload.statusCode, 200);

    const body = upload.json();
    assert.equal(body.path, 'etc/passwd', 'traversal should be stripped, not honoured');
    assert.equal(body.size, 14);
    assert.match(body.sha256, /^[0-9a-f]{64}$/);

    const detail = await h.app.inject({ method: 'GET', url: `/api/jobs/${encodeURIComponent(job.id)}` });
    const artifacts = detail.json().artifacts;
    assert.equal(artifacts.length, 1);

    const download = await h.app.inject({ method: 'GET', url: `/api/artifacts/${artifacts[0].id}` });
    assert.equal(download.statusCode, 200);
    assert.equal(download.body, 'artifact bytes');
  });
});

test('an artifact shorter than its content-length is rejected', async () => {
  await withHarness({}, async (h) => {
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = await claimNamed(h, 'lint', {});

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/workers/jobs/${encodeURIComponent(job.id)}/artifact`,
      headers: {
        ...h.auth,
        'content-type': 'application/octet-stream',
        'content-length': '500',
        'x-artifact-path': 'short.bin',
      },
      payload: Buffer.from('tiny'),
    });
    assert.equal(res.statusCode, 400);
  });
});

test('success releases dependents, matched on shared dimensions', async () => {
  await withHarness({}, async (h) => {
    const run = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().run_id;

    const roots = await drain(h, { arches: 'x86_64,aarch64', features: 'sign-key' });
    await finish(h, roots['build:arch=x86_64'].id, { success: true });

    // Only the x86_64 package becomes eligible; the aarch64 one still waits
    // on its own architecture's build.
    const next = await drain(h, { arches: 'x86_64,aarch64', features: 'sign-key' });
    assert.ok(next['package:arch=x86_64,pkg=musl'], 'x86_64 package should be released');
    assert.ok(!next['package:arch=aarch64,pkg=musl'], 'aarch64 package should still be waiting');

    const state = jobsByName(await runState(h, run));
    assert.equal(state['package:arch=aarch64,pkg=musl'].state, 'queued');
  });
});

test('failure skips transitive dependents, not just direct ones', async () => {
  await withHarness({}, async (h) => {
    const run = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().run_id;

    const build = await claimNamed(h, 'build:arch=x86_64', { arches: 'x86_64' });
    const outcome = await finish(h, build.id, { success: false, exitCode: 2, error: 'compile failed' });
    assert.equal(outcome.state, 'failed');

    const jobs = jobsByName(await runState(h, run));
    // Direct dependent.
    assert.equal(jobs['package:arch=x86_64,pkg=musl'].state, 'skipped');
    // Transitive dependent: the prototype left this queued and dispatchable.
    assert.equal(jobs.publish.state, 'skipped');
    // Unrelated branches are untouched.
    assert.equal(jobs['build:arch=aarch64'].state, 'queued');
    assert.equal(jobs['package:arch=aarch64,pkg=musl'].state, 'queued');
  });
});

test('a run settles as failed once every job is terminal', async () => {
  await withHarness({}, async (h) => {
    const run = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().run_id;

    const roots = await drain(h, { arches: 'x86_64,aarch64', features: 'sign-key' });

    // Failing the x86_64 build skips its package and, transitively, publish.
    await finish(h, roots['build:arch=x86_64'].id, { success: false, exitCode: 1 });
    await finish(h, roots['build:arch=aarch64'].id, { success: true });
    await finish(h, roots.lint.id, { success: true });

    const released = await drain(h, { arches: 'aarch64', features: 'sign-key' });
    const last = await finish(h, released['package:arch=aarch64,pkg=musl'].id, { success: true });

    assert.equal(last.run_state, 'failed');
    assert.equal((await runState(h, run)).run.state, 'failed');
  });
});

test('a run settles as success when everything passes', async () => {
  // Quoted, because an unquoted true in YAML is a boolean, not a command.
  const pipeline = `
version: 1
jobs:
  a:
    image: alpine
    script: ['true']
  b:
    image: alpine
    script: ['true']
    needs: [a]
`;
  await withHarness({ pipeline }, async (h) => {
    const run = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().run_id;

    const a = await claimNamed(h, 'a', {});
    await finish(h, a.id, { success: true });
    const b = await claimNamed(h, 'b', {});
    const last = await finish(h, b.id, { success: true });

    assert.equal(last.run_state, 'success');
    assert.equal((await runState(h, run)).run.state, 'success');
  });
});

test('an allowed failure does not fail the run or block dependents', async () => {
  const pipeline = `
version: 1
jobs:
  flaky:
    image: alpine
    script: ['false']
    allow_failure: true
  after:
    image: alpine
    script: ['true']
    needs: [flaky]
`;
  await withHarness({ pipeline }, async (h) => {
    const run = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().run_id;

    const flaky = await claimNamed(h, 'flaky', {});
    const outcome = await finish(h, flaky.id, { success: false, exitCode: 1 });
    assert.deepEqual(outcome.skipped, []);

    const after = await claimNamed(h, 'after', {});
    assert.ok(after, 'dependent should still run after an allowed failure');
    const last = await finish(h, after.id, { success: true });
    assert.equal(last.run_state, 'success');
    assert.equal((await runState(h, run)).run.state, 'success');
  });
});

test('a job with retries left is requeued instead of failing the run', async () => {
  const pipeline = `
version: 1
jobs:
  retried:
    image: alpine
    script: [maybe]
    max_attempts: 2
`;
  await withHarness({ pipeline }, async (h) => {
    const run = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().run_id;

    const first = await claimNamed(h, 'retried', {});
    const outcome = await finish(h, first.id, { success: false, exitCode: 1 });
    assert.equal(outcome.state, 'queued');
    assert.equal(outcome.retry, true);

    const second = await claimNamed(h, 'retried', {});
    assert.equal(second.attempt, 2);
    const last = await finish(h, second.id, { success: false, exitCode: 1 });
    assert.equal(last.state, 'failed');
    assert.equal((await runState(h, run)).run.state, 'failed');
  });
});

test('heartbeats keep a job alive and report cancellation', async () => {
  await withHarness({}, async (h) => {
    const run = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().run_id;
    const job = await claimNamed(h, 'lint', {});

    const beat = await h.app.inject({
      method: 'POST',
      url: `/api/workers/jobs/${encodeURIComponent(job.id)}/heartbeat`,
      headers: { ...h.auth, 'content-type': 'application/json' },
      payload: '{}',
    });
    assert.deepEqual(beat.json(), { cancelled: false });

    await h.services.scheduler.cancelRun(run);

    const after = await h.app.inject({
      method: 'POST',
      url: `/api/workers/jobs/${encodeURIComponent(job.id)}/heartbeat`,
      headers: { ...h.auth, 'content-type': 'application/json' },
      payload: '{}',
    });
    assert.equal(after.json().cancelled, true);
    assert.equal((await runState(h, run)).run.state, 'cancelled');
  });
});

test('the reaper fails a job whose worker stopped reporting', async () => {
  await withHarness({}, async (h) => {
    const run = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().run_id;
    const job = await claimNamed(h, 'lint', {});
    assert.equal(jobsByName(await runState(h, run)).lint.state, 'running');

    // Backdate the heartbeat rather than waiting out the real timeout.
    await h.services.db.run(
      'UPDATE jobs SET heartbeat_at = {then} WHERE id = {id}',
      { then: Date.now() - 10 * 60 * 1000, id: job.id }
    );

    const reaped = await h.services.scheduler.reap();
    assert.ok(reaped.length > 0);

    const after = jobsByName(await runState(h, run)).lint;
    assert.equal(after.state, 'failed');
    assert.match(after.error, /stopped reporting/);

    // The worker that lost the job can no longer complete it.
    const late = await finish(h, job.id, { success: true });
    assert.match(String(late.error ?? ''), /not running|another worker/);
  });
});

test('a second push produces an independent, numbered run', async () => {
  await withHarness({}, async (h) => {
    const first = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json();
    const sha2 = await h.commit({ 'README.md': 'changed\n' }, 'second commit');
    const second = (await h.trigger({ sha: sha2, ref: 'refs/heads/main' })).json();

    assert.notEqual(first.run_id, second.run_id);
    const detail = await runState(h, second.run_id);
    assert.equal(detail.run.number, 2);
    assert.equal(detail.run.title, 'second commit');
    assert.equal(detail.run.head_sha, sha2);
  });
});

test('runs can be listed and filtered by project', async () => {
  await withHarness({}, async (h) => {
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });

    const all = await h.app.inject({ method: 'GET', url: '/api/runs' });
    assert.equal(all.json().runs.length, 1);

    const mine = await h.app.inject({ method: 'GET', url: '/api/runs?project=demo' });
    assert.equal(mine.json().runs.length, 1);

    const other = await h.app.inject({ method: 'GET', url: '/api/runs?project=absent' });
    assert.equal(other.json().runs.length, 0);
  });
});

test('unknown runs, jobs and artifacts return 404', async () => {
  await withHarness({}, async (h) => {
    for (const url of ['/api/runs/nope', '/api/jobs/nope', '/api/jobs/nope/log', '/api/artifacts/nope']) {
      const res = await h.app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 404, `${url} should be 404`);
    }
  });
});

test('a disabled project refuses triggers', async () => {
  await withHarness({}, async (h) => {
    await h.services.projects.setEnabled('demo', false);
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    assert.equal(res.statusCode, 409);
  });
});

test('a trigger for an unknown project is a 404', async () => {
  await withHarness({}, async (h) => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/trigger/absent',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ sha: h.sha }),
    });
    assert.equal(res.statusCode, 404);
  });
});

test('a commit that is not in the repository is refused', async () => {
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: 'b'.repeat(40), ref: 'refs/heads/main' });
    assert.equal(res.statusCode, 500);
    assert.match(res.json().detail, /not present in the mirror/);
  });
});

test('clone mode hands the repository url to the worker instead', async () => {
  await withHarness({ sourceMode: 'clone' }, async (h) => {
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = await claimNamed(h, 'lint', {});
    assert.equal(job.source.mode, 'clone');
    assert.equal(job.source.repo_url, h.repoDir);
  });
});

test('the trigger secret is not stored in the clear', async () => {
  await withHarness({}, async (h) => {
    const row = await h.services.db.get('SELECT trigger_secret FROM projects WHERE id = {id}', { id: 'demo' });
    assert.ok(row.trigger_secret.startsWith('v1.'), 'expected an encrypted value');
    assert.ok(!row.trigger_secret.includes('test-secret'));
    assert.equal(h.services.projects.triggerSecret(await h.services.projects.get('demo')), 'test-secret');
  });
});

test('worker tokens are stored only as hashes', async () => {
  await withHarness({}, async (h) => {
    const rows = await h.services.db.all('SELECT token_hash FROM worker_tokens');
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.match(row.token_hash, /^[0-9a-f]{64}$/);
      assert.notEqual(row.token_hash, h.worker.token);
    }
  });
});
