// test/retention.test.js - deleting artifacts and logs once they are old
//
// This is the one part of the conductor whose job is to destroy data, so
// the rules are pinned down here rather than left to read from the
// implementation. Runs and jobs are seeded directly with chosen
// timestamps, since waiting fourteen days for a test is not practical.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

async function withHarness(options, fn) {
  const h = await startHarness(options);
  try {
    return await fn(h);
  } finally {
    await h.stop();
  }
}

// Seeds a finished run with one job and one artifact, at a chosen age.
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
  const runId = `run-${number}`;
  const jobId = `${runId}:build`;
  const artifactId = `art-${number}`;
  const artifactKey = `artifacts/${runId}/build/out.txt`;
  const logKey = `logs/${runId}/build.log`;

  await db.run(
    `INSERT INTO runs (id, project_id, number, ref, head_sha, trigger_type,
                       state, visibility, created_at, started_at, finished_at)
     VALUES ({id}, {project}, {number}, {ref}, {sha}, 'push',
             {state}, 'public', {at}, {at}, {finished})`,
    {
      id: runId,
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
    `INSERT INTO jobs (id, run_id, name, base_name, image, requires, spec, state,
                       allow_failure, attempt, max_attempts, timeout,
                       log_key, log_size, created_at, finished_at)
     VALUES ({id}, {run}, 'build', 'build', 'alpine:3', '[]', '{}', {state},
             0, 1, 1, 3600, {logKey}, {logSize}, {at}, {finished})`,
    {
      id: jobId,
      run: runId,
      state: finished ? state : 'running',
      logKey,
      logSize,
      at,
      finished: finished ? at : null,
    }
  );

  await db.run(
    `INSERT INTO artifacts (id, job_id, run_id, path, storage_key, size, sha256,
                            created_at, expires_at)
     VALUES ({id}, {job}, {run}, 'out.txt', {key}, 512, {sha}, {at}, {expires})`,
    {
      id: artifactId,
      job: jobId,
      run: runId,
      key: artifactKey,
      sha: 'b'.repeat(64),
      at,
      expires: artifactExpiresAt,
    }
  );

  // Real objects, so a sweep that forgets to delete one is visible.
  await h.services.storage.put(artifactKey, Buffer.from('artifact body'));
  await h.services.storage.put(logKey, Buffer.from('log body'));

  return { runId, jobId, artifactId, artifactKey, logKey };
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
  await withHarness({ retention: { artifact_keep_runs: 0, artifact_keep_days: 0 } }, async (h) => {
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
  // Shorter than the policy would allow, on the newest run.
  await withHarness({ retention: { artifact_keep_runs: 10, artifact_keep_days: 30 } }, async (h) => {
    await seedRun(h, { number: 1, ageDays: 0, artifactExpiresAt: NOW - 1 });
    await h.services.retention.sweep({ now: NOW });
    assert.deepEqual(await artifactIds(h), [], 'a job may expire its artifacts early');
  });

  // Longer than the policy would allow, on a run far outside it.
  await withHarness({ retention: { artifact_keep_runs: 1, artifact_keep_days: 1 } }, async (h) => {
    await seedRun(h, { number: 1, ageDays: 400, artifactExpiresAt: NOW + DAY });
    await seedRun(h, { number: 2, ageDays: 0 });
    await h.services.retention.sweep({ now: NOW });
    assert.ok((await artifactIds(h)).includes('art-1'), 'a job may keep its artifacts longer');
  });
});

test('an explicit deadline also beats the last good run', async () => {
  // The protection exists so a quiet project keeps something downloadable.
  // A job that asked for a short life is asking on purpose, and a bulky
  // intermediate should not become immortal by being green.
  await withHarness({ retention: { artifact_keep_runs: 0, artifact_keep_days: 0 } }, async (h) => {
    await seedRun(h, { number: 1, ageDays: 0, state: 'success', artifactExpiresAt: NOW - 1 });
    await h.services.retention.sweep({ now: NOW });
    assert.deepEqual(await artifactIds(h), []);
  });
});

test('the last few runs keep their artifacts however old they are', async () => {
  await withHarness({ retention: { artifact_keep_runs: 3, artifact_keep_days: 0 } }, async (h) => {
    for (let n = 1; n <= 6; n += 1) {
      await seedRun(h, { number: n, ageDays: 400, state: n === 6 ? 'failed' : 'failed' });
    }

    await h.services.retention.sweep({ now: NOW });

    // The three highest numbered runs, regardless of age.
    assert.deepEqual(await artifactIds(h), ['art-4', 'art-5', 'art-6']);
  });
});

test('recent artifacts are kept however many runs have followed', async () => {
  // The two rules are combined by whichever keeps longer, so a run outside
  // the count window still survives while it is inside the age window.
  await withHarness({ retention: { artifact_keep_runs: 2, artifact_keep_days: 30 } }, async (h) => {
    for (let n = 1; n <= 5; n += 1) {
      await seedRun(h, { number: n, ageDays: 1, state: 'failed' });
    }

    await h.services.retention.sweep({ now: NOW });

    assert.equal((await artifactIds(h)).length, 5, 'all are young enough, whatever their position');
  });
});

test('an artifact outside both rules is deleted', async () => {
  await withHarness({ retention: { artifact_keep_runs: 2, artifact_keep_days: 7 } }, async (h) => {
    const old = await seedRun(h, { number: 1, ageDays: 30, state: 'failed' });
    await seedRun(h, { number: 2, ageDays: 1, state: 'failed' });
    await seedRun(h, { number: 3, ageDays: 1, state: 'failed' });

    const result = await h.services.retention.sweep({ now: NOW });

    assert.equal(result.artifacts, 1);
    assert.deepEqual(await artifactIds(h), ['art-2', 'art-3']);
    assert.equal(await objectExists(h, old.artifactKey), false);
  });
});

test('the most recent successful run is kept whatever the policy says', async () => {
  await withHarness({ retention: { artifact_keep_runs: 1, artifact_keep_days: 1 } }, async (h) => {
    await seedRun(h, { number: 1, ageDays: 400, state: 'success' });
    await seedRun(h, { number: 2, ageDays: 300, state: 'failed' });
    await seedRun(h, { number: 3, ageDays: 0, state: 'failed' });

    await h.services.retention.sweep({ now: NOW });

    // run 1 is the last green one, run 3 is inside both windows, and the
    // failed run between them has nothing protecting it.
    assert.deepEqual(await artifactIds(h), ['art-1', 'art-3']);
  });
});

test('only the latest success is protected, not every success', async () => {
  await withHarness({ retention: { artifact_keep_runs: 1, artifact_keep_days: 1 } }, async (h) => {
    await seedRun(h, { number: 1, ageDays: 400, state: 'success' });
    await seedRun(h, { number: 2, ageDays: 300, state: 'success' });
    await seedRun(h, { number: 3, ageDays: 0, state: 'failed' });

    await h.services.retention.sweep({ now: NOW });

    assert.deepEqual(await artifactIds(h), ['art-2', 'art-3']);
  });
});

test('a project may keep artifacts forever despite a server default', async () => {
  await withHarness({ retention: { artifact_keep_runs: 1, artifact_keep_days: 1 } }, async (h) => {
    await h.services.db.run(
      'UPDATE projects SET artifact_keep_runs = 0, artifact_keep_days = 0 WHERE id = {id}',
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
  await withHarness({ retention: { artifact_keep_runs: 0, artifact_keep_days: 365 } }, async (h) => {
    await h.services.db.run(
      'UPDATE projects SET artifact_keep_days = 7 WHERE id = {id}',
      { id: h.project.id }
    );

    await seedRun(h, { number: 1, ageDays: 30, state: 'failed' });

    await h.services.retention.sweep({ now: NOW });
    assert.deepEqual(await artifactIds(h), [], 'the stricter project setting applies');
  });
});

test('an unfinished run is never swept', async () => {
  await withHarness({ retention: { artifact_keep_runs: 0, artifact_keep_days: 1 } }, async (h) => {
    // Backdated far enough to be well outside the window, but still going.
    await seedRun(h, { number: 1, ageDays: 400, state: 'running', finished: false });

    const result = await h.services.retention.sweep({ now: NOW });

    assert.equal(result.artifacts, 0);
    assert.equal(result.logs, 0);
    assert.equal((await artifactIds(h)).length, 1);
  });
});

test('logs older than the limit are removed but the job remains', async () => {
  await withHarness({ retention: { log_keep_days: 14 } }, async (h) => {
    const old = await seedRun(h, { number: 1, ageDays: 30, state: 'failed' });
    const recent = await seedRun(h, { number: 2, ageDays: 1, state: 'failed' });

    const result = await h.services.retention.sweep({ now: NOW });

    assert.equal(result.logs, 1);
    assert.equal(await objectExists(h, old.logKey), false);
    assert.equal(await objectExists(h, recent.logKey), true);

    // The job itself is history and stays, so a run remains explainable
    // after its output has gone.
    const job = await h.services.db.get(
      'SELECT id, log_key, log_expired_at, state FROM jobs WHERE id = {id}',
      { id: old.jobId }
    );
    assert.ok(job, 'the job row must survive');
    assert.equal(job.log_key, null);
    assert.equal(job.state, 'failed');
    assert.equal(job.log_expired_at, NOW);
  });
});

test('a swept log is distinguishable from one that never existed', async () => {
  await withHarness({ retention: { log_keep_days: 1 } }, async (h) => {
    const swept = await seedRun(h, { number: 1, ageDays: 30, state: 'failed' });
    await h.services.retention.sweep({ now: NOW });

    const gone = await h.services.db.get(
      'SELECT log_key, log_expired_at FROM jobs WHERE id = {id}', { id: swept.jobId }
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
  await withHarness({ retention: { artifact_keep_runs: 0, artifact_keep_days: 1 } }, async (h) => {
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
  await withHarness({ retention: { artifact_keep_runs: 0, artifact_keep_days: 1 } }, async (h) => {
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
  await withHarness({ retention: { artifact_keep_runs: 0, artifact_keep_days: 1 } }, async (h) => {
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
      `INSERT INTO runs (id, project_id, number, ref, head_sha, trigger_type,
                         state, visibility, created_at, started_at, finished_at)
       VALUES ('other-run', 'other', 1, 'refs/heads/main', {sha}, 'push',
               'failed', 'public', {at}, {at}, {at})`,
      { sha: 'c'.repeat(40), at: NOW - 900 * DAY }
    );
    await h.services.db.run(
      `INSERT INTO jobs (id, run_id, name, base_name, image, requires, spec, state,
                         allow_failure, attempt, max_attempts, timeout, log_size,
                         created_at, finished_at)
       VALUES ('other-run:build', 'other-run', 'build', 'build', 'alpine:3', '[]', '{}',
               'failed', 0, 1, 1, 3600, 0, {at}, {at})`,
      { at: NOW - 900 * DAY }
    );
    await h.services.db.run(
      `INSERT INTO artifacts (id, job_id, run_id, path, storage_key, size, sha256, created_at)
       VALUES ('art-other', 'other-run:build', 'other-run', 'out.txt',
               'artifacts/other/out.txt', 1, {sha}, {at})`,
      { sha: 'd'.repeat(64), at: NOW - 900 * DAY }
    );

    await h.services.retention.sweep({ now: NOW });

    assert.deepEqual(await artifactIds(h), ['art-other']);
  });
});

test('artifacts.expire in a pipeline reaches the stored artifact', async () => {
  // The key has been in the schema since the beginning and was parsed,
  // stored in the job spec, and then ignored by everything. This is the
  // path from pipeline text to a deadline on the row.
  const pipeline = [
    'version: 1',
    'defaults:',
    '  image: alpine:3',
    'jobs:',
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
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });

    const before = Date.now();
    for (const name of ['build', 'keep']) {
      const res = await h.poll({});
      assert.equal(res.statusCode, 200, `expected to claim ${name}`);
      const job = res.json().job;

      const upload = await h.app.inject({
        method: 'POST',
        url: `/api/v1/workers/jobs/${encodeURIComponent(job.id)}/artifacts`,
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
      `SELECT j.base_name AS name, a.expires_at
         FROM artifacts a JOIN jobs j ON j.id = a.job_id
        ORDER BY j.base_name`,
      {}
    );

    const byName = Object.fromEntries(rows.map((r) => [r.name, r.expires_at]));

    // An hour from when it was stored, give or take the time the test took.
    assert.ok(byName.build >= before + 3600 * 1000, 'expire should be an hour out');
    assert.ok(byName.build <= Date.now() + 3600 * 1000);

    // The job that said nothing is left to the project policy.
    assert.equal(byName.keep, null);
  });
});

test('the api reports and accepts project retention', { skip: 'the JSON API was removed' }, async () => {
  await withHarness({
    bootstrap: true,
    retention: { artifact_keep_runs: 7, artifact_keep_days: 21, log_keep_days: 9 },
  }, async (h) => {
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'bootstrap-password' },
    });
    assert.equal(login.statusCode, 200);
    const auth = { cookie: login.headers['set-cookie'].split(';')[0] };

    // The defaults have to be discoverable, or a null on a project is
    // meaningless to whoever is reading it.
    const defaults = await h.app.inject({ method: 'GET', url: '/api/retention', headers: auth });
    assert.equal(defaults.statusCode, 200);
    assert.deepEqual(defaults.json().defaults, {
      artifact_keep_runs: 7,
      artifact_keep_days: 21,
      log_keep_days: 9,
    });

    const before = await h.app.inject({
      method: 'GET', url: `/api/projects/${h.project.id}`, headers: auth,
    });
    assert.equal(before.json().project.artifact_keep_days, null, 'unset means inherited');

    const patched = await h.app.inject({
      method: 'PATCH',
      url: `/api/projects/${h.project.id}`,
      headers: auth,
      payload: { artifact_keep_runs: 3, artifact_keep_days: 0, log_keep_days: 30 },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().project.artifact_keep_runs, 3);
    assert.equal(patched.json().project.artifact_keep_days, 0, 'zero is a value, not an absence');
    assert.equal(patched.json().project.log_keep_days, 30);

    // And back to following the server default.
    const cleared = await h.app.inject({
      method: 'PATCH',
      url: `/api/projects/${h.project.id}`,
      headers: auth,
      payload: { artifact_keep_runs: null },
    });
    assert.equal(cleared.json().project.artifact_keep_runs, null);

    const rejected = await h.app.inject({
      method: 'PATCH',
      url: `/api/projects/${h.project.id}`,
      headers: auth,
      payload: { log_keep_days: -5 },
    });
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.json().error, /zero or more/);
  });
});
