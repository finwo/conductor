// test/retention.test.js - deleting artifacts and logs once they are old
//
// This is the one part of the conductor whose task is to destroy data, so
// the rules are pinned down here rather than left to read from the
// implementation. Jobs and tasks are seeded directly with chosen
// timestamps, since waiting fourteen days for a test is not practical.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

async function withHarness(options, fn) {
  const h = await startHarness(options);
  try {
    return await fn(h);
  } finally {
    await h.stop();
  }
}

// Seeds a finished job with one task and one artifact, at a chosen age.
// Returns the identifiers so a test can assert on what survived.
async function seedRun(h, {
  number,
  ageDays,
  state = 'success',
  artifactExpiresAt = null,
  logSize = 1024,
  finished = true,
}) {
  const db = h.services.db;
  const at = NOW - ageDays * DAY;
  const jobId = `job-${number}`;
  const taskId = `${jobId}:build`;
  const artifactId = `art-${number}`;
  const artifactKey = `artifacts/${jobId}/build/out.txt`;
  const logKey = `logs/${jobId}/build.log`;

  await db.run(
    `INSERT INTO jobs (id, project_id, number, ref, head_sha, trigger_type,
                       state, visibility, created_at, started_at, finished_at)
     VALUES ({id}, {project}, {number}, {ref}, {sha}, 'push',
             {state}, 'public', {at}, {at}, {finished})`,
    {
      id: jobId,
      project: h.project.id,
      number,
      ref: 'refs/heads/main',
      sha: 'a'.repeat(40),
      state,
      at,
      finished: finished ? at : null,
    }
  );

  await db.run(
    `INSERT INTO tasks (id, job_id, name, base_name, image, requires, spec, state,
                       allow_failure, attempt, max_attempts, timeout,
                       log_key, log_size, created_at, finished_at)
     VALUES ({id}, {job}, 'build', 'build', 'alpine:3', '[]', '{}', {state},
             0, 1, 1, 3600, {logKey}, {logSize}, {at}, {finished})`,
    {
      id: taskId,
      job: jobId,
      state: finished ? state : 'running',
      logKey,
      logSize,
      at,
      finished: finished ? at : null,
    }
  );

  await db.run(
    `INSERT INTO artifacts (id, task_id, job_id, path, storage_key, size, sha256,
                            created_at, expires_at)
     VALUES ({id}, {task}, {job}, 'out.txt', {key}, 512, {sha}, {at}, {expires})`,
    {
      id: artifactId,
      task: taskId,
      job: jobId,
      key: artifactKey,
      sha: 'b'.repeat(64),
      at,
      expires: artifactExpiresAt,
    }
  );

  // Real objects, so a sweep that forgets to delete one is visible.
  await h.services.storage.put(artifactKey, Buffer.from('artifact body'));
  await h.services.storage.put(logKey, Buffer.from('log body'));

  return { jobId, taskId, artifactId, artifactKey, logKey };
}

async function artifactIds(h) {
  const rows = await h.services.db.all('SELECT id FROM artifacts ORDER BY id', {});
  return rows.map((r) => r.id);
}

async function objectExists(h, key) {
  try {
    return (await h.services.storage.head(key)) !== null;
  } catch {
    return false;
  }
}

test('an artifact past its own deadline is deleted', async () => {
  await withHarness({ retention: { artifact_keep_jobs: 0, artifact_keep_days: 0 } }, async (h) => {
    const fresh = await seedRun(h, { number: 1, ageDays: 0, artifactExpiresAt: NOW + DAY });
    const stale = await seedRun(h, { number: 2, ageDays: 0, artifactExpiresAt: NOW - 1 });

    const result = await h.services.retention.sweep({ now: NOW });

    assert.equal(result.artifacts, 1);
    assert.deepEqual(await artifactIds(h), ['art-1']);
    assert.equal(await objectExists(h, fresh.artifactKey), true);
    assert.equal(await objectExists(h, stale.artifactKey), false, 'the object must go too, not just the row');
  });
});

test('an explicit deadline overrides the policy in both directions', async () => {
  // Shorter than the policy would allow, on the newest job.
  await withHarness({ retention: { artifact_keep_jobs: 10, artifact_keep_days: 30 } }, async (h) => {
    await seedRun(h, { number: 1, ageDays: 0, artifactExpiresAt: NOW - 1 });
    await h.services.retention.sweep({ now: NOW });
    assert.deepEqual(await artifactIds(h), [], 'a task may expire its artifacts early');
  });

  // Longer than the policy would allow, on a job far outside it.
  await withHarness({ retention: { artifact_keep_jobs: 1, artifact_keep_days: 1 } }, async (h) => {
    await seedRun(h, { number: 1, ageDays: 400, artifactExpiresAt: NOW + DAY });
    await seedRun(h, { number: 2, ageDays: 0 });
    await h.services.retention.sweep({ now: NOW });
    assert.ok((await artifactIds(h)).includes('art-1'), 'a task may keep its artifacts longer');
  });
});

test('an explicit deadline also beats the last good job', async () => {
  // The protection exists so a quiet project keeps something downloadable.
  // A task that asked for a short life is asking on purpose, and a bulky
  // intermediate should not become immortal by being green.
  await withHarness({ retention: { artifact_keep_jobs: 0, artifact_keep_days: 0 } }, async (h) => {
    await seedRun(h, { number: 1, ageDays: 0, state: 'success', artifactExpiresAt: NOW - 1 });
    await h.services.retention.sweep({ now: NOW });
    assert.deepEqual(await artifactIds(h), []);
  });
});

test('the last few jobs keep their artifacts however old they are', async () => {
  await withHarness({ retention: { artifact_keep_jobs: 3, artifact_keep_days: 0 } }, async (h) => {
    for (let n = 1; n <= 6; n += 1) {
      await seedRun(h, { number: n, ageDays: 400, state: n === 6 ? 'failed' : 'failed' });
    }

    await h.services.retention.sweep({ now: NOW });

    // The three highest numbered jobs, regardless of age.
    assert.deepEqual(await artifactIds(h), ['art-4', 'art-5', 'art-6']);
  });
});

test('recent artifacts are kept however many jobs have followed', async () => {
  // The two rules are combined by whichever keeps longer, so a job outside
  // the count window still survives while it is inside the age window.
  await withHarness({ retention: { artifact_keep_jobs: 2, artifact_keep_days: 30 } }, async (h) => {
    for (let n = 1; n <= 5; n += 1) {
      await seedRun(h, { number: n, ageDays: 1, state: 'failed' });
    }

    await h.services.retention.sweep({ now: NOW });

    assert.equal((await artifactIds(h)).length, 5, 'all are young enough, whatever their position');
  });
});

test('an artifact outside both rules is deleted', async () => {
  await withHarness({ retention: { artifact_keep_jobs: 2, artifact_keep_days: 7 } }, async (h) => {
    const old = await seedRun(h, { number: 1, ageDays: 30, state: 'failed' });
    await seedRun(h, { number: 2, ageDays: 1, state: 'failed' });
    await seedRun(h, { number: 3, ageDays: 1, state: 'failed' });

    const result = await h.services.retention.sweep({ now: NOW });

    assert.equal(result.artifacts, 1);
    assert.deepEqual(await artifactIds(h), ['art-2', 'art-3']);
    assert.equal(await objectExists(h, old.artifactKey), false);
  });
});

test('the most recent successful job is kept whatever the policy says', async () => {
  await withHarness({ retention: { artifact_keep_jobs: 1, artifact_keep_days: 1 } }, async (h) => {
    await seedRun(h, { number: 1, ageDays: 400, state: 'success' });
    await seedRun(h, { number: 2, ageDays: 300, state: 'failed' });
    await seedRun(h, { number: 3, ageDays: 0, state: 'failed' });

    await h.services.retention.sweep({ now: NOW });

    // job 1 is the last green one, job 3 is inside both windows, and the
    // failed job between them has nothing protecting it.
    assert.deepEqual(await artifactIds(h), ['art-1', 'art-3']);
  });
});

test('only the latest success is protected, not every success', async () => {
  await withHarness({ retention: { artifact_keep_jobs: 1, artifact_keep_days: 1 } }, async (h) => {
    await seedRun(h, { number: 1, ageDays: 400, state: 'success' });
    await seedRun(h, { number: 2, ageDays: 300, state: 'success' });
    await seedRun(h, { number: 3, ageDays: 0, state: 'failed' });

    await h.services.retention.sweep({ now: NOW });

    assert.deepEqual(await artifactIds(h), ['art-2', 'art-3']);
  });
});

test('a project may keep artifacts forever despite a server default', async () => {
  await withHarness({ retention: { artifact_keep_jobs: 1, artifact_keep_days: 1 } }, async (h) => {
    await h.services.db.run(
      'UPDATE projects SET artifact_keep_jobs = 0, artifact_keep_days = 0 WHERE id = {id}',
      { id: h.project.id }
    );

    await seedRun(h, { number: 1, ageDays: 900, state: 'failed' });
    await seedRun(h, { number: 2, ageDays: 900, state: 'failed' });

    const result = await h.services.retention.sweep({ now: NOW });

    // Zero has to mean forever rather than immediately, or a project could
    // not opt out of a default that deletes things.
    assert.equal(result.artifacts, 0);
    assert.equal((await artifactIds(h)).length, 2);
  });
});

test('a project setting overrides the server default', async () => {
  await withHarness({ retention: { artifact_keep_jobs: 0, artifact_keep_days: 365 } }, async (h) => {
    await h.services.db.run(
      'UPDATE projects SET artifact_keep_days = 7 WHERE id = {id}',
      { id: h.project.id }
    );

    await seedRun(h, { number: 1, ageDays: 30, state: 'failed' });

    await h.services.retention.sweep({ now: NOW });
    assert.deepEqual(await artifactIds(h), [], 'the stricter project setting applies');
  });
});

test('an unfinished job is never swept', async () => {
  await withHarness({ retention: { artifact_keep_jobs: 0, artifact_keep_days: 1 } }, async (h) => {
    // Backdated far enough to be well outside the window, but still going.
    await seedRun(h, { number: 1, ageDays: 400, state: 'running', finished: false });

    const result = await h.services.retention.sweep({ now: NOW });

    assert.equal(result.artifacts, 0);
    assert.equal(result.logs, 0);
    assert.equal((await artifactIds(h)).length, 1);
  });
});

test('logs older than the limit are removed but the task remains', async () => {
  await withHarness({ retention: { log_keep_days: 14 } }, async (h) => {
    const old = await seedRun(h, { number: 1, ageDays: 30, state: 'failed' });
    const recent = await seedRun(h, { number: 2, ageDays: 1, state: 'failed' });

    const result = await h.services.retention.sweep({ now: NOW });

    assert.equal(result.logs, 1);
    assert.equal(await objectExists(h, old.logKey), false);
    assert.equal(await objectExists(h, recent.logKey), true);

    // The task itself is history and stays, so a job remains explainable
    // after its output has gone.
    const task = await h.services.db.get(
      'SELECT id, log_key, log_expired_at, state FROM tasks WHERE id = {id}',
      { id: old.taskId }
    );
    assert.ok(task, 'the task row must survive');
    assert.equal(task.log_key, null);
    assert.equal(task.state, 'failed');
    assert.equal(task.log_expired_at, NOW);
  });
});

test('a swept log is distinguishable from one that never existed', async () => {
  await withHarness({ retention: { log_keep_days: 1 } }, async (h) => {
    const swept = await seedRun(h, { number: 1, ageDays: 30, state: 'failed' });
    await h.services.retention.sweep({ now: NOW });

    const gone = await h.services.db.get(
      'SELECT log_key, log_expired_at FROM tasks WHERE id = {id}', { id: swept.taskId }
    );
    // Both have no log_key, so the timestamp is the only thing telling
    // "expired" apart from "never wrote anything".
    assert.equal(gone.log_key, null);
    assert.ok(gone.log_expired_at > 0);
  });
});

test('a log is swept only once', async () => {
  await withHarness({ retention: { log_keep_days: 1 } }, async (h) => {
    await seedRun(h, { number: 1, ageDays: 30, state: 'failed' });

    const first = await h.services.retention.sweep({ now: NOW });
    const second = await h.services.retention.sweep({ now: NOW });

    assert.equal(first.logs, 1);
    assert.equal(second.logs, 0, 'a swept log must not be counted again on every pass');
  });
});

test('zero keeps logs forever', async () => {
  await withHarness({ retention: { log_keep_days: 0 } }, async (h) => {
    const old = await seedRun(h, { number: 1, ageDays: 900, state: 'failed' });
    const result = await h.services.retention.sweep({ now: NOW });

    assert.equal(result.logs, 0);
    assert.equal(await objectExists(h, old.logKey), true);
  });
});

test('a storage failure leaves the row for the next pass', async () => {
  await withHarness({ retention: { artifact_keep_jobs: 0, artifact_keep_days: 1 } }, async (h) => {
    await seedRun(h, { number: 1, ageDays: 30, state: 'failed' });

    const real = h.services.storage.delete;
    h.services.storage.delete = async () => { throw new Error('bucket unreachable'); };

    const failed = await h.services.retention.sweep({ now: NOW });
    assert.equal(failed.artifacts, 0);
    assert.equal((await artifactIds(h)).length, 1, 'the row must survive so the object is not orphaned');

    h.services.storage.delete = real;

    const recovered = await h.services.retention.sweep({ now: NOW });
    assert.equal(recovered.artifacts, 1);
    assert.deepEqual(await artifactIds(h), []);
  });
});

test('a sweep deletes no more than its batch', async () => {
  await withHarness({ retention: { artifact_keep_jobs: 0, artifact_keep_days: 1 } }, async (h) => {
    for (let n = 1; n <= 5; n += 1) {
      await seedRun(h, { number: n, ageDays: 30, state: 'failed' });
    }

    const first = await h.services.retention.sweep({ now: NOW, batch: 2 });
    assert.equal(first.artifacts, 2, 'a backlog must not be swept in one go');
    assert.equal((await artifactIds(h)).length, 3);

    await h.services.retention.sweep({ now: NOW, batch: 10 });
    assert.equal((await artifactIds(h)).length, 0);
  });
});

test('one project policy does not reach into another', async () => {
  await withHarness({ retention: { artifact_keep_jobs: 0, artifact_keep_days: 1 } }, async (h) => {
    await h.services.projects.create({
      id: 'other',
      name: 'Other',
      repo_url: h.repoDir,
      trigger_secret: 'other-secret',
      visibility: 'public',
    });
    await h.services.db.run(
      'UPDATE projects SET artifact_keep_days = 0 WHERE id = {id}', { id: 'other' }
    );

    await seedRun(h, { number: 1, ageDays: 30, state: 'failed' });

    // An old artifact under the project that keeps everything.
    await h.services.db.run(
      `INSERT INTO jobs (id, project_id, number, ref, head_sha, trigger_type,
                         state, visibility, created_at, started_at, finished_at)
       VALUES ('other-job', 'other', 1, 'refs/heads/main', {sha}, 'push',
               'failed', 'public', {at}, {at}, {at})`,
      { sha: 'c'.repeat(40), at: NOW - 900 * DAY }
    );
    await h.services.db.run(
      `INSERT INTO tasks (id, job_id, name, base_name, image, requires, spec, state,
                         allow_failure, attempt, max_attempts, timeout, log_size,
                         created_at, finished_at)
       VALUES ('other-task', 'other-job', 'build', 'build', 'alpine:3', '[]', '{}',
               'failed', 0, 1, 1, 3600, 0, {at}, {at})`,
      { at: NOW - 900 * DAY }
    );
    await h.services.db.run(
      `INSERT INTO artifacts (id, task_id, job_id, path, storage_key, size, sha256, created_at)
       VALUES ('art-other', 'other-task', 'other-job', 'out.txt',
               'artifacts/other/out.txt', 1, {sha}, {at})`,
      { sha: 'd'.repeat(64), at: NOW - 900 * DAY }
    );

    await h.services.retention.sweep({ now: NOW });

    assert.deepEqual(await artifactIds(h), ['art-other']);
  });
});

test('artifacts.expire in a pipeline reaches the stored artifact', async () => {
  // The key has been in the schema since the beginning and was parsed,
  // stored in the task spec, and then ignored by everything. This is the
  // path from pipeline text to a deadline on the row.
  const pipeline = [
    'version: 1',
    'defaults:',
    '  image: alpine:3',
    'tasks:',
    '  build:',
    "    script: ['make']",
    '    artifacts:',
    '      paths: [out/**]',
    '      expire: 1h',
    '  keep:',
    "    script: ['make']",
    '    artifacts:',
    '      paths: [out/**]',
    '',
  ].join('\n');

  await withHarness({ pipeline }, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);

    const before = Date.now();
    for (const name of ['build', 'keep']) {
      const res = await h.claim({});
      assert.equal(res.statusCode, 200, `expected to claim ${name}`);
      const task = res.json().data.task;

      const upload = await h.app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/artifacts`,
        headers: {
          ...h.auth,
          'content-type': 'application/octet-stream',
          'x-artifact-path': 'out/result.txt',
        },
        payload: Buffer.from('packaged'),
      });
      assert.equal(upload.statusCode, 200);
    }

    const rows = await h.services.db.all(
      `SELECT t.base_name AS name, a.expires_at
         FROM artifacts a JOIN tasks t ON t.id = a.task_id
        ORDER BY t.base_name`,
      {}
    );

    const byName = Object.fromEntries(rows.map((r) => [r.name, r.expires_at]));

    // An hour from when it was stored, give or take the time the test took.
    assert.ok(byName.build >= before + 3600 * 1000, 'expire should be an hour out');
    assert.ok(byName.build <= Date.now() + 3600 * 1000);

    // The task that said nothing is left to the project policy.
    assert.equal(byName.keep, null);
  });
});

test('the api reports and accepts project retention', async () => {
  await withHarness({
    bootstrap: true,
    retention: { artifact_keep_jobs: 7, artifact_keep_days: 21, log_keep_days: 9 },
  }, async (h) => {
    const { headers } = await h.login();
    const json = { ...headers, 'content-type': 'application/json' };

    const patch = (payload) => h.app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${h.project.id}`,
      headers: json,
      payload: JSON.stringify(payload),
    });

    const before = await h.app.inject({
      method: 'GET', url: `/api/v1/projects/${h.project.id}`, headers,
    });
    assert.equal(before.json().data.artifact_keep_days, null, 'unset means inherited');

    const patched = await patch({ artifact_keep_jobs: 3, artifact_keep_days: 0, log_keep_days: 30 });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal(patched.json().data.artifact_keep_jobs, 3);
    assert.equal(patched.json().data.artifact_keep_days, 0, 'zero is a value, not an absence');
    assert.equal(patched.json().data.log_keep_days, 30);

    // And back to following the server default.
    const cleared = await patch({ artifact_keep_jobs: null });
    assert.equal(cleared.json().data.artifact_keep_jobs, null);

    const rejected = await patch({ log_keep_days: -5 });
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.json().error.message, /zero or more/);
  });
});

test('a session outlives its expiry only until the next sweep', async () => {
  await withHarness({ bootstrap: true }, async (h) => {
    const grant = await h.login();
    const live = await h.services.refreshTokens.page({ offset: 0, limit: 10 });
    assert.equal(live.total, 1);

    // Still within the grace window, so it can be reported as ended.
    await h.services.db.run(
      'UPDATE refresh_tokens SET expires_at = {then}',
      { then: Date.now() - 1000 }
    );
    assert.equal((await h.services.retention.sweep()).sessions, 0);

    const refused = await h.token({ grant_type: 'refresh_token', refresh_token: grant.refresh_token });
    assert.equal(refused.statusCode, 400);

    await h.services.db.run(
      'UPDATE refresh_tokens SET expires_at = {then}',
      { then: Date.now() - 3 * 24 * 60 * 60 * 1000 }
    );
    assert.equal((await h.services.retention.sweep()).sessions, 1);
  });
});

test('a machine that has stopped claiming is forgotten', async () => {
  await withHarness({ retention: { worker_agent_keep_hours: 24 } }, async (h) => {
    const { workerTokens, db } = h.services;

    await workerTokens.recordAgent({ tokenId: h.worker.id, name: 'gone', features: ['dind'] });
    await workerTokens.recordAgent({ tokenId: h.worker.id, name: 'here', features: ['unos-sign-keys'] });
    // recordAgent stamps the real clock, and NOW is not the real clock.
    await db.run("UPDATE worker_agents SET last_seen_at = {then} WHERE name = 'gone'", { then: NOW - 25 * HOUR });
    await db.run("UPDATE worker_agents SET last_seen_at = {then} WHERE name = 'here'", { then: NOW - 1 * HOUR });

    const result = await h.services.retention.sweep({ now: NOW });

    assert.equal(result.agents, 1);
    const left = await workerTokens.agentsFor(h.worker.id);
    assert.deepEqual(left.map((a) => a.name), ['here']);
  });
});

test('zero keeps machines for ever', async () => {
  await withHarness({ retention: { worker_agent_keep_hours: 0 } }, async (h) => {
    const { workerTokens, db } = h.services;

    await workerTokens.recordAgent({ tokenId: h.worker.id, name: 'ancient', features: [] });
    await db.run('UPDATE worker_agents SET last_seen_at = {then}', { then: NOW - 365 * DAY });

    const result = await h.services.retention.sweep({ now: NOW });

    assert.equal(result.agents, 0);
    assert.equal((await workerTokens.agentsFor(h.worker.id)).length, 1);
  });
});
