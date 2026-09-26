// test/conductor.test.js - end to end behaviour of the conductor service
//
// Drives a real server against a real git repository: trigger, dispatch,
// logs, artifacts, completion and failure handling.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, DEFAULT_PIPELINE, data, apiError } from './helpers/harness.js';

// Tests that exercised the JSON read API, which has been removed. Kept
// until the suite is rebuilt against the interface.
const apiGone = { skip: 'the JSON API was removed' };

// Each test gets its own harness so that ordering never matters.
async function withHarness(options, fn) {
  const h = await startHarness(options);
  try {
    return await fn(h);
  } finally {
    await h.stop();
  }
}

function tasksByName(payload) {
  return Object.fromEntries(payload.tasks.map((j) => [j.name, j]));
}

// Reads a job and its tasks straight from the database. There is no read API;
// the interface is for people, and the tests inspect the data itself.
async function jobState(h, jobId) {
  const job = await h.services.db.get('SELECT * FROM jobs WHERE id = {id}', { id: jobId });
  const tasks = await h.services.db.all(
    'SELECT * FROM tasks WHERE job_id = {job} ORDER BY name', { job: jobId }
  );
  const deps = await h.services.db.all(
    `SELECT d.task_id, d.depends_on_id, d.kind FROM task_deps d
       JOIN tasks t ON t.id = d.task_id WHERE t.job_id = {job}`,
    { job: jobId }
  );
  const edges = new Map(tasks.map((t) => [t.id, { needs: [], after: [] }]));
  for (const d of deps) edges.get(d.task_id)?.[d.kind === 'after' ? 'after' : 'needs'].push(d.depends_on_id);
  return { job, tasks: tasks.map((t) => ({ ...t, ...(edges.get(t.id) ?? { needs: [], after: [] }) })) };
}

// The job a task belongs to. A worker is never told this, so a test that
// needs it asks the database, exactly as the conductor does.
async function jobIdOf(h, taskId) {
  const row = await h.services.db.get('SELECT job_id FROM tasks WHERE id = {id}', { id: taskId });
  return row.job_id;
}

// Claims everything currently eligible for a worker with the given
// capabilities, keyed by task name. Tests assert on which tasks appear rather
// than on the order they arrive in, which is not part of the contract.
async function drain(h, query = {}) {
  const claimed = {};
  for (let i = 0; i < 50; i += 1) {
    const res = await h.claim(query);
    if (res.statusCode === 204) break;
    const task = res.json().data.task;
    claimed[task.name] = task;
  }
  return claimed;
}

async function claimNamed(h, name, query) {
  return (await drain(h, query))[name] ?? null;
}

async function finishRaw(h, taskId, {
  success = true, state = null, exitCode = 0, error = null, outputs = [],
} = {}) {
  return h.app.inject({
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/complete`,
    headers: { ...h.auth, 'content-type': 'application/json' },
    payload: JSON.stringify({ success, state, exit_code: exitCode, error, outputs }),
  });
}

async function finish(h, taskId, opts) {
  return data(await finishRaw(h, taskId, opts));
}

test('health reports the selected drivers', async () => {
  await withHarness({}, async (h) => {
    const res = await h.app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(data(res), {
      service: 'conductor', database: 'sqlite', storage: 'local', auth: 'local',
    });
  });
});

test('a signed trigger creates a job and expands the pipeline', async () => {
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main', actor: 'alice' });
    assert.equal(res.statusCode, 200);

    const body = data(res);
    assert.equal(body.status, 'created');

    const job = await h.waitForJob(body.job_id);
    assert.equal(job.state, 'running');
    assert.equal(job.actor, 'alice');
    assert.equal(job.title, 'initial commit');
    assert.equal(job.number, 1);

    const detail = await jobState(h, body.job_id);
    // lint + 2 build + 2 package + publish
    assert.equal(detail.tasks.length, 6);

    // Task ids are opaque, so the edge is checked by resolving the name
    // rather than reconstructing an id the conductor no longer derives.
    const tasks = tasksByName(detail);
    assert.deepEqual(
      tasks['package:arch=x86_64,pkg=musl'].needs,
      [tasks['build:arch=x86_64'].id]
    );
    assert.equal(tasks.publish.needs.length, 3);
  });
});

test('an unsigned or wrongly signed trigger is refused', async () => {
  await withHarness({}, async (h) => {
    const unsigned = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/demo/trigger',
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
    const githubJob = await h.waitForJob(github.json().data.job_id);
    assert.equal(githubJob.state, 'running');

    const gitlab = await h.trigger({
      checkout_sha: h.sha,
      ref: 'refs/heads/main',
      user_username: 'gl-user',
    });
    assert.equal(gitlab.statusCode, 200);
    const gitlabJob = await h.waitForJob(gitlab.json().data.job_id);
    assert.equal(gitlabJob.state, 'running');
  });
});

test('a branch deletion is ignored rather than failing', async () => {
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: '0'.repeat(40), ref: 'refs/heads/gone' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.status, 'ignored');
  });
});

test('a broken pipeline is reported as a client error with detail', async () => {
  await withHarness({ pipeline: 'version: 1\ntasks:\n  a:\n    script: [x]\n' }, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    assert.equal(res.statusCode, 200);
    const job = await h.waitForJob(res.json().data.job_id);
    assert.equal(job.state, 'failed');
    assert.ok(job.error?.includes('tasks.a.image'));
  });
});

test('a missing pipeline file is reported clearly', async () => {
  await withHarness({ pipeline: null }, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    assert.equal(res.statusCode, 200);
    const job = await h.waitForJob(res.json().data.job_id);
    assert.equal(job.state, 'failed');
    assert.match(job.error ?? '', /\.conductor\.yml not found/);
  });
});

test('a pipeline may be spelled .conductor.yaml instead of .conductor.yml', async () => {
  await withHarness({ repoConfigPath: '.conductor.yaml' }, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    assert.equal(res.statusCode, 200);
    const job = await h.waitForJob(res.json().data.job_id);
    assert.equal(job.state, 'running');
  });
});

test('a project pointed at a specific file gets no fallback', async () => {
  await withHarness({ configPath: 'ci/build.yml', repoConfigPath: '.conductor.yml' }, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    assert.equal(res.statusCode, 200);
    const job = await h.waitForJob(res.json().data.job_id);
    assert.equal(job.state, 'failed');
    assert.match(job.error ?? '', /ci\/build\.yml not found/);
  });
});

test('a repository carrying both spellings is refused rather than guessed at', async () => {
  await withHarness({}, async (h) => {
    const sha = await h.commit({ '.conductor.yaml': DEFAULT_PIPELINE }, 'add the other spelling');
    const res = await h.trigger({ sha, ref: 'refs/heads/main' });
    assert.equal(res.statusCode, 200);
    const job = await h.waitForJob(res.json().data.job_id);
    assert.equal(job.state, 'failed');
    assert.match(job.error ?? '', /both exist/);
  });
});

test('a pipeline still using the jobs key is told what it was renamed to', async () => {
  const old = 'version: 1\njobs:\n  build:\n    image: alpine\n    script: [make]\n';
  await withHarness({}, async (h) => {
    const sha = await h.commit({ '.conductor.yml': old }, 'pre-rename pipeline');
    const res = await h.trigger({ sha, ref: 'refs/heads/main' });
    assert.equal(res.statusCode, 200);
    const job = await h.waitForJob(res.json().data.job_id);
    assert.equal(job.state, 'failed');
    assert.match(job.error ?? '', /was renamed to tasks/);
  });
});

test('a job can be created directly, without a push payload to imitate', async () => {
  await withHarness({}, async (h) => {
    const res = await h.createJob({ sha: h.sha, ref: 'refs/heads/main', actor: 'alice' });
    assert.equal(res.statusCode, 200);

    const body = data(res);
    assert.equal(body.status, 'created');

    const job = await h.waitForJob(body.job_id);
    assert.equal(job.state, 'running');
    assert.equal(job.actor, 'alice');
    assert.equal(job.trigger_type, 'api');
  });
});

test('creating a job requires the same signature as a trigger', async () => {
  await withHarness({}, async (h) => {
    const unsigned = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/demo/jobs',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ sha: h.sha }),
    });
    assert.equal(unsigned.statusCode, 401);

    const wrong = await h.createJob({ sha: h.sha }, { secret: 'not-the-secret' });
    assert.equal(wrong.statusCode, 401);
  });
});

test('creating a job insists on a real commit rather than inferring one', async () => {
  await withHarness({}, async (h) => {
    assert.equal((await h.createJob({ ref: 'refs/heads/main' })).statusCode, 400);
    assert.equal((await h.createJob({ sha: 'abc' })).statusCode, 400);
  });
});

test('a job can be read back, with the state of every task', async () => {
  await withHarness({}, async (h) => {
    const jobId = (await h.createJob({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(jobId);

    const signature = h.sign('');
    const headers = { 'content-type': 'application/json', 'x-hub-signature-256': signature };

    const signed = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/demo/jobs/${jobId}`,
      headers,
    });
    assert.equal(signed.statusCode, 200, signed.body);
    assert.equal(data(signed).id, jobId);
    assert.equal(data(signed).state, 'running');

    const tasks = await h.app.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}/tasks`, headers });
    const body = data(tasks);
    assert.equal(body.tasks.length, 6);
    assert.ok(body.tasks.every((t) => t.state === 'queued'));
    assert.ok(body.tasks.some((t) => t.name === 'build:arch=x86_64'));
  });
});

test('a public job is readable without any credential at all', async () => {
  await withHarness({}, async (h) => {
    const jobId = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(jobId);

    const res = await h.app.inject({ method: 'GET', url: `/api/v1/projects/demo/jobs/${jobId}` });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().data.visibility, 'public');
  });
});

test('a private job needs the trigger secret, and is otherwise absent', async () => {
  const pipeline = DEFAULT_PIPELINE.replace('version: 1\n', 'version: 1\nvisibility: private\n');
  await withHarness({ pipeline }, async (h) => {
    const jobId = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(jobId);

    const anon = await h.app.inject({ method: 'GET', url: `/api/v1/projects/demo/jobs/${jobId}` });
    assert.equal(anon.statusCode, 404);

    const signed = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/demo/jobs/${jobId}`,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': h.sign('') },
    });
    assert.equal(signed.statusCode, 200, signed.body);
    assert.equal(signed.json().data.visibility, 'private');
  });
});

test('a job of another project cannot be read through this one', async () => {
  await withHarness({}, async (h) => {
    const jobId = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(jobId);
    const signature = h.sign('');
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/absent/jobs/${jobId}`,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    });
    assert.equal(res.statusCode, 404);
  });
});

// --- reading a task back ---

// The two paths answer identically; only what may reach a private task
// differs between them.
function taskUrls(taskId, project = 'demo') {
  return [`/api/v1/tasks/${taskId}`, `/api/v1/projects/${project}/tasks/${taskId}`];
}

// package needs build, so nothing downstream is claimable until the first
// wave has finished.
async function claimDownstream(h, name) {
  for (const task of Object.values(await drain(h, { arches: 'x86_64,aarch64' }))) {
    await finish(h, task.id);
  }
  return claimNamed(h, name, { arches: 'x86_64', features: 'sign-key' });
}

test('a task can be read back on its own, and by its full name', async () => {
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);
    const task = await claimNamed(h, 'build:arch=x86_64', { arches: 'x86_64' });

    const [bare, scoped] = await Promise.all(
      taskUrls(task.id).map((url) => h.app.inject({ method: 'GET', url }))
    );
    assert.equal(bare.statusCode, 200, bare.body);
    assert.equal(scoped.statusCode, 200, scoped.body);
    assert.deepEqual(data(bare), data(scoped), 'both paths describe the same task');

    const { task: body } = data(bare);
    assert.equal(body.id, task.id);
    assert.equal(body.name, 'build:arch=x86_64');
    assert.equal(body.base_name, 'build');
    assert.equal(body.state, 'running');
    assert.equal(body.arch, 'x86_64');
    assert.equal(body.image, 'debian:bookworm-slim');
    assert.equal(body.visibility, 'public');
    assert.equal(body.sha, h.sha);
    assert.equal(body.ref, 'refs/heads/main');
    assert.equal(body.project_id, 'demo');
    assert.equal(body.job_id, await jobIdOf(h, task.id));
    assert.equal(body.job_number, 1);
    assert.equal(body.allow_failure, false, 'stored as 0 or 1, reported as a boolean');
    assert.deepEqual(body.artifact_paths, ['dist/**'], 'what it was told to collect');
  });
});

test('reading a task back carries its dependencies and matrix', async () => {
  await withHarness({}, async (h) => {
    const tr = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(tr.json().data.job_id);
    const task = await claimDownstream(h, 'package:arch=x86_64,pkg=musl');

    const res = await h.app.inject({ method: 'GET', url: `/api/v1/tasks/${task.id}` });
    assert.equal(res.statusCode, 200, res.body);

    const { task: body } = data(res);
    assert.deepEqual(body.matrix, { pkg: 'musl' });
    assert.deepEqual(body.needs, ['build:arch=x86_64']);
    assert.equal(body.workdir, '/work', 'settled when the job was created');
  });
});

// The point of the endpoint: a task's environment can hold project
// variables, and its services carry an environment of their own.
test('reading a task back never exposes its environment, services or script', async () => {
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);
    const task = await claimDownstream(h, 'package:arch=x86_64,pkg=musl');

    // The claim payload has them, which is what makes their absence below
    // meaningful rather than incidental.
    assert.ok(task.env.MATRIX_PKG, 'the worker is given the environment');
    assert.ok(Array.isArray(task.script) && task.script.length > 0);

    for (const url of taskUrls(task.id)) {
      const res = await h.app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 200, res.body);

      const payload = data(res);
      // Asserted before the loop below, which would otherwise pass happily
      // against a payload that has no task in it at all.
      assert.ok(payload.task, `${url} must describe a task`);
      for (const key of ['env', 'services', 'script', 'spec', 'worker_token_id', 'log_key', 'storage_key']) {
        assert.equal(payload.task[key], undefined, `${url} must not carry ${key}`);
      }
      // Belt and braces: a value smuggled in under any other name.
      assert.ok(!JSON.stringify(payload).includes('MATRIX_PKG'), `${url} leaked an environment name`);
      assert.ok(!JSON.stringify(payload).includes('./pkg.sh'), `${url} leaked the script`);
    }
  });
});

test('a task lists the artifacts it stored, with a usable download url', async () => {
  await withHarness({}, async (h) => {
    const tr = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(tr.json().data.job_id);
    const task = await claimNamed(h, 'build:arch=x86_64', { arches: 'x86_64' });

    await h.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/artifacts`,
      headers: { ...h.auth, 'content-type': 'application/octet-stream', 'x-artifact-path': 'dist/app' },
      payload: Buffer.from('artifact bytes'),
    });

    const res = await h.app.inject({ method: 'GET', url: `/api/v1/tasks/${task.id}` });
    assert.equal(res.statusCode, 200, res.body);

    const { artifacts } = data(res);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].path, 'dist/app');
    assert.equal(artifacts[0].size, 14);
    assert.match(artifacts[0].sha256, /^[0-9a-f]{64}$/);
    assert.ok(artifacts[0].url.startsWith('http://conductor.test/'), artifacts[0].url);

    // The url is the whole point of returning one, so follow it.
    const download = await h.app.inject({ method: 'GET', url: new URL(artifacts[0].url).pathname });
    assert.equal(download.statusCode, 200);
    assert.equal(download.body, 'artifact bytes');
  });
});

test('reading a task back needs no worker token', async () => {
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);
    const task = await claimNamed(h, 'lint', {});

    // The worker protocol shares this prefix and puts a token hook over its
    // own plugin. If that hook ever reaches these routes, this fails.
    for (const url of taskUrls(task.id)) {
      const res = await h.app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 200, `${url} should not require a token`);
    }
  });
});

test('a private task is absent without a credential, and needs its project named', async () => {
  const pipeline = DEFAULT_PIPELINE.replace('version: 1\n', 'version: 1\nvisibility: private\n');
  await withHarness({ pipeline }, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);
    const task = await claimNamed(h, 'lint', {});

    for (const url of taskUrls(task.id)) {
      const anon = await h.app.inject({ method: 'GET', url });
      assert.equal(anon.statusCode, 404, `${url} should be absent anonymously`);
    }

    const signed = { 'content-type': 'application/json', 'x-hub-signature-256': h.sign('') };

    const scoped = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/demo/tasks/${task.id}`,
      headers: signed,
    });
    assert.equal(scoped.statusCode, 200, scoped.body);
    assert.equal(scoped.json().data.task.visibility, 'private');

    // Without a project in the path there is no secret to check against, so
    // a signature proves nothing here.
    const bare = await h.app.inject({ method: 'GET', url: `/api/v1/tasks/${task.id}`, headers: signed });
    assert.equal(bare.statusCode, 404, 'a signature is meaningless without a project');
  });
});

test('a private task is readable by an administrator, by either path', async () => {
  const pipeline = DEFAULT_PIPELINE.replace('version: 1\n', 'version: 1\nvisibility: private\n');
  // scrypt is slow, so the harness only creates the admin when asked.
  await withHarness({ pipeline, bootstrap: true }, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);
    const task = await claimNamed(h, 'lint', {});
    const { headers } = await h.login();

    for (const url of taskUrls(task.id)) {
      const res = await h.app.inject({ method: 'GET', url, headers });
      assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
      assert.equal(res.json().data.task.id, task.id);
    }
  });
});

test('a task of another project cannot be read through this one', async () => {
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);
    const task = await claimNamed(h, 'lint', {});

    const res2 = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/absent/tasks/${task.id}`,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': h.sign('') },
    });
    assert.equal(res2.statusCode, 404);
  });
});

test('an unknown task is 404 by either path', async () => {
  await withHarness({}, async (h) => {
    for (const url of taskUrls('m2y0000000000000nope')) {
      const res = await h.app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 404, `${url} should be 404`);
      assert.equal(apiError(res).name, 'UnknownTask');
    }
  });
});

test('a claim records what the machine advertises, even when there is no work', async () => {
  await withHarness({}, async (h) => {
    const idle = await h.claim({ name: 'builder-01', arches: ['x86_64'], features: ['unos-sign-keys'] });
    assert.equal(idle.statusCode, 204, 'nothing is queued yet');

    const agents = await h.services.workerTokens.agentsFor(h.worker.id);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].name, 'builder-01');
    assert.deepEqual(agents[0].features, ['unos-sign-keys']);
    assert.deepEqual(agents[0].arches, ['x86_64']);
  });
});

test('a machine that changes its features updates its row rather than adding one', async () => {
  await withHarness({}, async (h) => {
    await h.claim({ name: 'builder-01', features: ['dind'] });
    await h.claim({ name: 'builder-01', features: ['dind', 'unos-sign-keys'] });

    const agents = await h.services.workerTokens.agentsFor(h.worker.id);
    assert.equal(agents.length, 1, 'one machine is one row');
    assert.deepEqual(agents[0].features, ['dind', 'unos-sign-keys']);
  });
});

test('machines sharing a token are recorded separately', async () => {
  await withHarness({}, async (h) => {
    await h.claim({ name: 'builder-01', features: ['unos-sign-keys'] });
    await h.claim({ name: 'builder-02', features: [] });

    const agents = await h.services.workerTokens.agentsFor(h.worker.id);
    assert.deepEqual(agents.map((a) => a.name).sort(), ['builder-01', 'builder-02']);
  });
});

test('the worker api rejects missing and invalid tokens', async () => {
  await withHarness({}, async (h) => {
    const none = await h.app.inject({ method: 'POST', url: '/api/v1/tasks/claim' });
    assert.equal(none.statusCode, 401);

    const bad = await h.app.inject({
      method: 'POST', url: '/api/v1/tasks/claim', headers: { authorization: 'Bearer nope' },
    });
    assert.equal(bad.statusCode, 401);
  });
});

test('independent tasks dispatch concurrently', async () => {
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);

    // The prototype could only ever hand out one task at a time.
    const [a, b, c] = await Promise.all([
      h.claim({ arches: 'x86_64,aarch64' }),
      h.claim({ arches: 'x86_64,aarch64' }),
      h.claim({ arches: 'x86_64,aarch64' }),
    ]);

    const names = [a, b, c].map((r) => r.json().data.task.name);
    assert.equal(new Set(names).size, 3, `expected three distinct tasks, got ${names.join(', ')}`);
    assert.deepEqual(names.slice().sort(), ['build:arch=aarch64', 'build:arch=x86_64', 'lint']);
  });
});

test('a task is only offered to a worker that satisfies its requires', async () => {
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);

    // Clear the three root tasks so only package and publish remain.
    const roots = await drain(h, { arches: 'x86_64,aarch64' });
    assert.deepEqual(Object.keys(roots).sort(), ['build:arch=aarch64', 'build:arch=x86_64', 'lint']);
    for (const task of Object.values(roots)) await finish(h, task.id, { success: true });

    // package requires sign-key, which this worker does not advertise.
    const without = await h.claim({ arches: 'x86_64,aarch64' });
    assert.equal(without.statusCode, 204);

    const with_ = await h.claim({ arches: 'x86_64,aarch64', features: 'sign-key' });
    assert.equal(with_.statusCode, 200);
    assert.match(with_.json().data.task.name, /^package:/);
  });
});

test('a worker is not offered work for an architecture it cannot build', async () => {
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);

    const claimed = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await h.claim({ arches: 'aarch64' });
      if (res.statusCode === 204) break;
      claimed.push(res.json().data.task);
    }

    // lint has no arch so it is eligible; the x86_64 build is not.
    assert.ok(!claimed.some((j) => j.arch === 'x86_64'));
    assert.ok(claimed.some((j) => j.name === 'build:arch=aarch64'));
  });
});

test('a claimed task carries everything the worker needs', async () => {
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);
    const task = await claimNamed(h, 'build:arch=x86_64', { arches: 'x86_64' });

    assert.equal(task.image, 'debian:bookworm-slim');
    assert.deepEqual(task.script, ['./build.sh $ARCH']);
    assert.equal(task.env.ARCH, 'x86_64');
    assert.equal(task.sha, h.sha);
    assert.match(task.endpoints.source, /^http:\/\/conductor\.test\/api\/v1\/tasks\//);
    assert.ok(task.endpoints.source.endsWith('/source.tar.gz'));
    assert.ok(task.endpoints.log.endsWith('/log'));

    // The worker resolves features from these, so a missing field
    // silently disables them.
    assert.deepEqual(task.requires, []);
    assert.ok(Number.isInteger(task.heartbeat_interval) && task.heartbeat_interval > 0);
    assert.deepEqual(task.masked, []);

    // A worker is given a context and a script. Which project or job the
    // work belongs to is none of its business, and the id it holds carries
    // no structure to read it out of either.
    assert.equal(task.project_id, undefined);
    assert.equal(task.job_id, undefined);
    assert.ok(!task.id.includes(':'), `task id should be opaque, got ${task.id}`);
  });
});

test('a task that requires a feature reports it to the worker', async () => {
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);
    const roots = await drain(h, { arches: 'x86_64,aarch64' });
    for (const task of Object.values(roots)) await finish(h, task.id, { success: true });

    const pkg = (await drain(h, { arches: 'x86_64', features: 'sign-key' }))['package:arch=x86_64,pkg=musl'];
    assert.ok(pkg);
    assert.deepEqual(pkg.requires, ['sign-key']);
  });
});

test('the standard conductor variables are present in the task environment', async () => {
  await withHarness({}, async (h) => {
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);
    const task = await claimNamed(h, 'lint', {});

    // The worker is not told any of this, but the script is: these reach
    // the container as ordinary environment, which is the only place the
    // build legitimately needs them.
    assert.equal(task.env.CONDUCTOR_PROJECT, 'demo');
    assert.equal(task.env.CONDUCTOR_JOB_ID, job);
    assert.equal(task.env.CONDUCTOR_JOB_NUMBER, '1');
    assert.equal(task.env.CONDUCTOR_TASK, 'lint');
    assert.equal(task.env.CONDUCTOR_TASK_ID, task.id);
    assert.equal(task.env.CONDUCTOR_SHA, h.sha);
    assert.equal(task.env.CONDUCTOR_REF, 'refs/heads/main');
    assert.equal(task.env.CONDUCTOR_ATTEMPT, '1');
  });
});

test('the source tarball is served from the mirror', async () => {
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);
    const task = await claimNamed(h, 'lint', {});

    const res2 = await h.app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${task.id}/source.tar.gz`,
      headers: h.auth,
    });
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.headers['content-type'], 'application/gzip');
    // gzip magic number
    assert.equal(res2.rawPayload[0], 0x1f);
    assert.equal(res2.rawPayload[1], 0x8b);
  });
});

test('a worker cannot touch a task it does not hold', async () => {
  await withHarness({}, async (h) => {
    const tr = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(tr.json().data.job_id);
    const task = await claimNamed(h, 'lint', {});

    const other = await h.services.workerTokens.create('intruder');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/log`,
      headers: { authorization: `Bearer ${other.token}`, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('malicious'),
    });
    assert.equal(res.statusCode, 403);
  });
});

test('log appends are resumable and deduplicated by offset', async () => {
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);
    const task = await claimNamed(h, 'lint', {});
    const url = `/api/v1/tasks/${task.id}/log`;
    const headers = { ...h.auth, 'content-type': 'application/octet-stream' };

    const first = await h.app.inject({
      method: 'POST', url, headers: { ...headers, 'x-log-offset': '0' }, payload: Buffer.from('hello\n'),
    });
    assert.deepEqual(data(first), { size: 6, written: 6, truncated: false });

    // A retry resends what was already stored plus new data.
    const retry = await h.app.inject({
      method: 'POST', url, headers: { ...headers, 'x-log-offset': '0' }, payload: Buffer.from('hello\nworld\n'),
    });
    assert.deepEqual(data(retry), { size: 12, written: 6, truncated: false });

    // A gap is refused, and says where to resume.
    const gap = await h.app.inject({
      method: 'POST', url, headers: { ...headers, 'x-log-offset': '9999' }, payload: Buffer.from('x'),
    });
    assert.equal(gap.statusCode, 409);
    assert.equal(apiError(gap).details.expected_offset, 12);

    const tail = await h.services.logs.read(await jobIdOf(h, task.id), task.id, { offset: 0, limit: 1024 });
    assert.equal(tail.data.toString('utf8'), 'hello\nworld\n');
    assert.equal(tail.size, 12);

    const partial = await h.services.logs.read(await jobIdOf(h, task.id), task.id, { offset: 6, limit: 1024 });
    assert.equal(partial.data.toString('utf8'), 'world\n');
  });
});

test('an oversized log chunk is refused', async () => {
  await withHarness({}, async (h) => {
    const tr = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(tr.json().data.job_id);
    const task = await claimNamed(h, 'lint', {});

    // Artifacts are streamed and may be large, but a single log append is
    // buffered, so it has to be bounded or a worker can exhaust memory.
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/log`,
      headers: { ...h.auth, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(2 * 1024 * 1024, 0x41),
    });

    assert.equal(res.statusCode, 413);
    assert.equal(await h.services.logs.size(await jobIdOf(h, task.id), task.id), 0, 'nothing should have been written');
  });
});

test('a finished log moves to storage and is still readable', async () => {
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);
    const task = await claimNamed(h, 'lint', {});

    await h.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/log`,
      headers: { ...h.auth, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('compiling\ndone\n'),
    });
    await finish(h, task.id, { success: true });

    const row = await h.services.db.get('SELECT log_key FROM tasks WHERE id = {id}', { id: task.id });
    assert.ok(row.log_key, 'the log should have moved to storage');
    const object = await h.services.storage.get(row.log_key);
    const parts = [];
    for await (const part of object.stream) parts.push(part);
    assert.equal(Buffer.concat(parts).toString('utf8'), 'compiling\ndone\n');
  });
});

test('artifacts are stored, hashed, and stripped of traversal', async () => {
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);
    const task = await claimNamed(h, 'build:arch=x86_64', { arches: 'x86_64' });

    const upload = await h.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/artifacts`,
      headers: {
        ...h.auth,
        'content-type': 'application/octet-stream',
        'x-artifact-path': '../../../etc/passwd',
      },
      payload: Buffer.from('artifact bytes'),
    });
    assert.equal(upload.statusCode, 200);

    const body = data(upload);
    assert.equal(body.path, 'etc/passwd', 'traversal should be stripped, not honoured');
    assert.equal(body.size, 14);
    assert.match(body.sha256, /^[0-9a-f]{64}$/);

    const artifacts = await h.services.db.all(
      'SELECT id FROM artifacts WHERE task_id = {task}', { task: task.id }
    );
    assert.equal(artifacts.length, 1);

    const download = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/demo/jobs/${await jobIdOf(h, task.id)}/tasks/${task.id}/artifacts/${artifacts[0].id}`,
    });
    assert.equal(download.statusCode, 200);
    assert.equal(download.body, 'artifact bytes');
  });
});

test('an artifact shorter than its content-length is rejected', async () => {
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);
    const task = await claimNamed(h, 'lint', {});

    const res2 = await h.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/artifacts`,
      headers: {
        ...h.auth,
        'content-type': 'application/octet-stream',
        'content-length': '500',
        'x-artifact-path': 'short.bin',
      },
      payload: Buffer.from('tiny'),
    });
    assert.equal(res2.statusCode, 400);
  });
});

test('success releases dependents, matched on shared dimensions', async () => {
  await withHarness({}, async (h) => {
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);

    const roots = await drain(h, { arches: 'x86_64,aarch64', features: 'sign-key' });
    await finish(h, roots['build:arch=x86_64'].id, { success: true });

    // Only the x86_64 package becomes eligible; the aarch64 one still waits
    // on its own architecture's build.
    const next = await drain(h, { arches: 'x86_64,aarch64', features: 'sign-key' });
    assert.ok(next['package:arch=x86_64,pkg=musl'], 'x86_64 package should be released');
    assert.ok(!next['package:arch=aarch64,pkg=musl'], 'aarch64 package should still be waiting');

    const state = tasksByName(await jobState(h, job));
    assert.equal(state['package:arch=aarch64,pkg=musl'].state, 'queued');
  });
});

test('failure skips transitive dependents, not just direct ones', async () => {
  await withHarness({}, async (h) => {
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);

    const build = await claimNamed(h, 'build:arch=x86_64', { arches: 'x86_64' });
    const outcome = await finish(h, build.id, { success: false, exitCode: 2, error: 'compile failed' });
    assert.equal(outcome.state, 'failed');

    const tasks = tasksByName(await jobState(h, job));
    // Direct dependent.
    assert.equal(tasks['package:arch=x86_64,pkg=musl'].state, 'skipped');
    // Transitive dependent: the prototype left this queued and dispatchable.
    assert.equal(tasks.publish.state, 'skipped');
    // Unrelated branches are untouched.
    assert.equal(tasks['build:arch=aarch64'].state, 'queued');
    assert.equal(tasks['package:arch=aarch64,pkg=musl'].state, 'queued');
  });
});

test('a job settles as failed once every task is terminal', async () => {
  await withHarness({}, async (h) => {
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);

    const roots = await drain(h, { arches: 'x86_64,aarch64', features: 'sign-key' });

    // Failing the x86_64 build skips its package and, transitively, publish.
    await finish(h, roots['build:arch=x86_64'].id, { success: false, exitCode: 1 });
    await finish(h, roots['build:arch=aarch64'].id, { success: true });
    await finish(h, roots.lint.id, { success: true });

    const released = await drain(h, { arches: 'aarch64', features: 'sign-key' });
    const last = await finish(h, released['package:arch=aarch64,pkg=musl'].id, { success: true });

    assert.equal(last.job_state, 'failed');
    const detail = await jobState(h, job);
    assert.equal(detail.job.state, 'failed');

    // The failure fails the job, not the skips it caused.
    assert.ok(
      detail.tasks.some((t) => t.state === 'skipped'),
      'the cascade should have skipped something'
    );
    assert.ok(detail.tasks.some((t) => t.state === 'failed' && t.allow_failure === 0));
  });
});

test('a job settles as success when everything passes', async () => {
  // Quoted, because an unquoted true in YAML is a boolean, not a command.
  const pipeline = `
version: 1
tasks:
  a:
    image: alpine
    script: ['true']
  b:
    image: alpine
    script: ['true']
    needs: [a]
`;
  await withHarness({ pipeline }, async (h) => {
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);

    const a = await claimNamed(h, 'a', {});
    await finish(h, a.id, { success: true });
    const b = await claimNamed(h, 'b', {});
    const last = await finish(h, b.id, { success: true });

    assert.equal(last.job_state, 'success');
    assert.equal((await jobState(h, job)).job.state, 'success');
  });
});

test('an allowed failure does not fail the job or block dependents', async () => {
  const pipeline = `
version: 1
tasks:
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
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);

    const flaky = await claimNamed(h, 'flaky', {});
    const outcome = await finish(h, flaky.id, { success: false, exitCode: 1 });
    assert.deepEqual(outcome.skipped, []);

    const after = await claimNamed(h, 'after', {});
    assert.ok(after, 'dependent should still run after an allowed failure');
    const last = await finish(h, after.id, { success: true });
    assert.equal(last.job_state, 'success');
    assert.equal((await jobState(h, job)).job.state, 'success');
  });
});

test('a task with retries left is requeued instead of failing the job', async () => {
  const pipeline = `
version: 1
tasks:
  retried:
    image: alpine
    script: [maybe]
    max_attempts: 2
`;
  await withHarness({ pipeline }, async (h) => {
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);

    const first = await claimNamed(h, 'retried', {});
    const outcome = await finish(h, first.id, { success: false, exitCode: 1 });
    assert.equal(outcome.state, 'queued');
    assert.equal(outcome.retry, true);

    const second = await claimNamed(h, 'retried', {});
    assert.equal(second.attempt, 2);
    const last = await finish(h, second.id, { success: false, exitCode: 1 });
    assert.equal(last.state, 'failed');
    assert.equal((await jobState(h, job)).job.state, 'failed');
  });
});

test('heartbeats keep a task alive and report cancellation', async () => {
  await withHarness({}, async (h) => {
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);
    const task = await claimNamed(h, 'lint', {});

    const beat = await h.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/heartbeat`,
      headers: { ...h.auth, 'content-type': 'application/json' },
      payload: '{}',
    });
    assert.deepEqual(data(beat), { cancelled: false });

    await h.services.scheduler.cancelJob(job);

    const after = await h.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/heartbeat`,
      headers: { ...h.auth, 'content-type': 'application/json' },
      payload: '{}',
    });
    assert.equal(after.json().data.cancelled, true);
    assert.equal((await jobState(h, job)).job.state, 'cancelled');
  });
});

test('the reaper fails a task whose worker stopped reporting', async () => {
  await withHarness({}, async (h) => {
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);
    const task = await claimNamed(h, 'lint', {});
    assert.equal(tasksByName(await jobState(h, job)).lint.state, 'running');

    // Backdate the heartbeat rather than waiting out the real timeout.
    await h.services.db.run(
      'UPDATE tasks SET heartbeat_at = {then} WHERE id = {id}',
      { then: Date.now() - 10 * 60 * 1000, id: task.id }
    );

    const reaped = await h.services.scheduler.reap();
    assert.ok(reaped.length > 0);

    const after = tasksByName(await jobState(h, job)).lint;
    assert.equal(after.state, 'failed');
    assert.match(after.error, /stopped reporting/);

    // The worker that lost the task can no longer complete it.
    const late = await finishRaw(h, task.id, { success: true });
    assert.equal(late.statusCode, 409);
    assert.equal(apiError(late).name, 'TaskNotRunning');
  });
});

test('a second push produces an independent, numbered job', async () => {
  await withHarness({}, async (h) => {
    const first = data(await h.trigger({ sha: h.sha, ref: 'refs/heads/main' }));
    await h.waitForJob(first.job_id);
    const sha2 = await h.commit({ 'README.md': 'changed\n' }, 'second commit');
    const second = data(await h.trigger({ sha: sha2, ref: 'refs/heads/main' }));
    await h.waitForJob(second.job_id);

    assert.notEqual(first.job_id, second.job_id);
    const detail = await jobState(h, second.job_id);
    assert.equal(detail.job.number, 2);
    assert.equal(detail.job.title, 'second commit');
    assert.equal(detail.job.head_sha, sha2);
  });
});

test('a jobs list belongs to its project', async () => {
  await withHarness({ visibility: 'public' }, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);

    const mine = await h.app.inject({ method: 'GET', url: '/api/v1/projects/demo/jobs' });
    assert.equal(mine.json().data.length, 1);

    const other = await h.app.inject({ method: 'GET', url: '/api/v1/projects/absent/jobs' });
    assert.equal(other.statusCode, 404);
  });
});

test('a job is addressable with or without its project', async () => {
  await withHarness({ visibility: 'public' }, async (h) => {
    const jobId = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(jobId);

    for (const url of [`/api/v1/jobs/${jobId}`, `/api/v1/projects/demo/jobs/${jobId}`]) {
      const res = await h.app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
      assert.equal(res.json().data.id, jobId);
    }

    // Naming the wrong project asserts it rather than being ignored.
    const wrong = await h.app.inject({ method: 'GET', url: `/api/v1/projects/absent/jobs/${jobId}` });
    assert.equal(wrong.statusCode, 404);
  });
});

test('unknown jobs, tasks and artifacts return 404', async () => {
  await withHarness({}, async (h) => {
    const urls = [
      '/api/v1/jobs/nope',
      '/api/v1/jobs/nope/tasks',
      '/api/v1/tasks/nope',
      '/api/v1/projects/nope',
    ];
    for (const url of urls) {
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
      url: '/api/v1/projects/absent/trigger',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ sha: h.sha }),
    });
    assert.equal(res.statusCode, 404);
  });
});

test('a commit that is not in the repository is refused', async () => {
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: 'b'.repeat(40), ref: 'refs/heads/main' });
    assert.equal(res.statusCode, 200);
    const job = await h.waitForJob(res.json().data.job_id);
    assert.equal(job.state, 'failed');
    assert.match(job.error ?? '', /not present in the mirror/);
  });
});

test('a task is told to fetch an archive, and never the repository itself', async () => {
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);
    const task = await claimNamed(h, 'lint', {});

    assert.match(task.endpoints.source, /\/source\.tar\.gz$/);

    // A worker holds no repository credentials and can reach no ref other
    // than the commit it was given work for, so the repository location
    // has no business being in the payload.
    assert.equal(task.source, undefined, 'there is one way to get the source, so there is no mode');
    assert.ok(!JSON.stringify(task).includes(h.repoDir), 'the repository path must not reach the worker');
  });
});

test('the source archive is the bare tree, with no wrapping directory', async () => {
  // The worker hands it to docker cp with the working directory as the
  // destination, and docker creates that directory as it extracts. A
  // wrapping directory in the archive would land one level too deep.
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);
    const task = await claimNamed(h, 'lint', {});

    const archive = await h.app.inject({
      method: 'GET',
      url: new URL(task.endpoints.source).pathname,
      headers: h.auth,
    });
    assert.equal(archive.statusCode, 200);

    // spawnSync rather than the promisified execFile, which has no way to
    // supply stdin and simply waits for input that never comes.
    const { spawnSync } = await import('node:child_process');
    const listing = spawnSync('tar', ['-tzf', '-'], {
      input: archive.rawPayload,
      encoding: 'utf8',
    });
    assert.equal(listing.status, 0, `tar failed: ${listing.stderr}`);

    const entries = listing.stdout.split('\n').filter(Boolean);
    assert.ok(entries.length > 0, 'the archive should not be empty');
    assert.ok(
      entries.includes('.conductor.yml'),
      `the pipeline should sit at the root of the archive, got:\n${listing.stdout}`,
    );
  });
});

test('the working directory is resolved from the pipeline, then the project', async () => {
  const pipeline = [
    'version: 1',
    'workdir: /usr/src/app',
    'defaults:',
    '  image: alpine:3',
    'tasks:',
    '  build:',
    "    script: ['make']",
    '',
  ].join('\n');

  await withHarness({ pipeline }, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);
    const task = await claimNamed(h, 'build', {});
    assert.equal(task.workdir, '/usr/src/app', 'the repository has the final say');
  });

  // With the repository silent, the project decides.
  await withHarness({}, async (h) => {
    await h.services.db.run(
      'UPDATE projects SET workdir = {dir} WHERE id = {id}',
      { dir: '/srv/build', id: h.project.id }
    );
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);
    const task = await claimNamed(h, 'lint', {});
    assert.equal(task.workdir, '/srv/build');
  });

  // With neither, there is a default.
  await withHarness({}, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);
    const task = await claimNamed(h, 'lint', {});
    assert.equal(task.workdir, '/work');
  });
});

test('an unusable working directory is refused rather than sanitised', async () => {
  for (const workdir of ['relative/path', '/', '/a/../b', '/has space']) {
    const pipeline = [
      'version: 1',
      `workdir: ${JSON.stringify(workdir)}`,
      'defaults:',
      '  image: alpine:3',
      'tasks:',
      '  build:',
      "    script: ['make']",
      '',
    ].join('\n');

    await withHarness({ pipeline }, async (h) => {
      const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
      assert.equal(res.statusCode, 200);
      const job = await h.waitForJob(res.json().data.job_id);
      assert.equal(job.state, 'failed', `expected ${JSON.stringify(workdir)} to be refused`);
      assert.ok((job.error ?? '').includes('workdir'), `error should mention workdir: ${job.error}`);
    });
  }
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

test('after runs its dependent whether the dependency passed or failed', async () => {
  const pipeline = `
version: 1
defaults:
  image: alpine
tasks:
  build:
    script: ['true']
  test:
    script: ['false']
    needs: [build]
  notify:
    script: ['true']
    after: [test]
`;
  await withHarness({ pipeline }, async (h) => {
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);

    const build = await claimNamed(h, 'build', {});
    await finish(h, build.id, { success: true });

    // Draining yields test alone: notify waits for it to finish, exactly as
    // needs would. after asks for less, not for nothing.
    const released = await drain(h, {});
    assert.ok(released.test, 'test should be released by build');
    assert.ok(!released.notify, 'notify should wait while test runs');

    const outcome = await finish(h, released.test.id, { success: false, exitCode: 1 });
    // The failure has nothing downstream of it to skip.
    assert.deepEqual(outcome.skipped, []);

    const notify = await claimNamed(h, 'notify', {});
    assert.ok(notify, 'notify should run after a failed dependency');
    const last = await finish(h, notify.id, { success: true });

    // The failure still fails the job. after decides what runs, not what counts.
    assert.equal(last.job_state, 'failed');
    const tasks = tasksByName(await jobState(h, job));
    assert.equal(tasks.notify.state, 'success');
    assert.equal(tasks.test.state, 'failed');
  });
});

test('after runs its dependent even when the dependency was skipped', async () => {
  const pipeline = `
version: 1
defaults:
  image: alpine
tasks:
  build:
    script: ['false']
  test:
    script: ['true']
    needs: [build]
  cleanup:
    script: ['true']
    after: [test]
`;
  await withHarness({ pipeline }, async (h) => {
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);

    const build = await claimNamed(h, 'build', {});
    const outcome = await finish(h, build.id, { success: false, exitCode: 1 });
    // test is skipped with its dependency, cleanup is not.
    assert.deepEqual(outcome.skipped, [(await jobState(h, job)).tasks.find((t) => t.name === 'test').id]);

    const cleanup = await claimNamed(h, 'cleanup', {});
    assert.ok(cleanup, 'cleanup should run once test settled as skipped');
    await finish(h, cleanup.id, { success: true });

    const tasks = tasksByName(await jobState(h, job));
    assert.equal(tasks.test.state, 'skipped');
    assert.equal(tasks.cleanup.state, 'success');
  });
});

// --- task outputs and set-state ---

test('an output reaches the task that reads it, and implies the dependency', async () => {
  const pipeline = `
version: 1
defaults:
  image: alpine
tasks:
  build:
    script: ['true']
  deploy:
    script: ['ship \${{ tasks.build.outputs.tag }}']
    env:
      TAG: '\${{ tasks.build.outputs.tag }}'
`;
  await withHarness({ pipeline }, async (h) => {
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);

    // deploy was never declared to need build; reading its output says so.
    const tasks = tasksByName(await jobState(h, job));
    assert.deepEqual(tasks.deploy.needs, [tasks.build.id]);

    const build = await claimNamed(h, 'build', {});
    assert.ok(build, 'build runs first');
    assert.equal(await claimNamed(h, 'deploy', {}), null, 'deploy waits for it');

    await finish(h, build.id, {
      success: true,
      outputs: [{ name: 'tag', value: 'v1.2.3', masked: false }],
    });

    const deploy = await claimNamed(h, 'deploy', {});
    assert.deepEqual(deploy.script, ['ship v1.2.3']);
    assert.equal(deploy.env.TAG, 'v1.2.3');
  });
});

test('a masked output stays masked in the log of whatever reads it', async () => {
  const pipeline = `
version: 1
defaults:
  image: alpine
tasks:
  build:
    script: ['true']
  deploy:
    script: ['ship \${{ tasks.build.outputs.token }}']
`;
  await withHarness({ pipeline }, async (h) => {
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);

    const build = await claimNamed(h, 'build', {});
    await finish(h, build.id, {
      success: true,
      outputs: [{ name: 'token', value: 'sup3rsecret', masked: true }],
    });

    const deploy = await claimNamed(h, 'deploy', {});
    assert.deepEqual(deploy.script, ['ship sup3rsecret'], 'the value is still delivered');
    assert.ok(
      deploy.masked.includes('sup3rsecret'),
      'and the worker is told to redact it from this task too'
    );
  });
});

test('outputs rest sealed rather than readable in the table', async () => {
  const pipeline = `
version: 1
tasks:
  build:
    image: alpine
    script: ['true']
`;
  await withHarness({ pipeline }, async (h) => {
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);

    const build = await claimNamed(h, 'build', {});
    await finish(h, build.id, {
      success: true,
      outputs: [{ name: 'tag', value: 'v1.2.3', masked: false }],
    });

    const row = await h.services.db.get(
      'SELECT value FROM task_outputs WHERE task_id = {id}', { id: build.id }
    );
    assert.ok(!row.value.includes('v1.2.3'), `stored in the clear: ${row.value}`);
  });
});

test('a task that reads an output that was never produced fails before it runs', async () => {
  const pipeline = `
version: 1
defaults:
  image: alpine
tasks:
  build:
    script: ['true']
  deploy:
    script: ['ship \${{ tasks.build.outputs.tag }}']
`;
  await withHarness({ pipeline }, async (h) => {
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);

    const build = await claimNamed(h, 'build', {});
    await finish(h, build.id, { success: true });

    assert.equal(await claimNamed(h, 'deploy', {}), null, 'nothing to hand a worker');

    const tasks = tasksByName(await jobState(h, job));
    assert.equal(tasks.deploy.state, 'failed');
    assert.match(tasks.deploy.error, /produced no output "tag"/);
    assert.equal(tasks.deploy.started_at, null, 'it never started');
    assert.equal((await jobState(h, job)).job.state, 'failed');
  });
});

test('set-state success overrides a non-zero exit', async () => {
  const pipeline = `
version: 1
tasks:
  check:
    image: alpine
    script: ['false']
`;
  await withHarness({ pipeline }, async (h) => {
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);

    const check = await claimNamed(h, 'check', {});
    const outcome = await finish(h, check.id, { success: false, state: 'success', exitCode: 1 });

    assert.equal(outcome.state, 'success');
    assert.equal(outcome.job_state, 'success');
    const tasks = tasksByName(await jobState(h, job));
    assert.equal(tasks.check.exit_code, 1, 'the exit code is still recorded');
  });
});

test('a skipped task is not a failure, and what needed it still runs', async () => {
  const pipeline = `
version: 1
defaults:
  image: alpine
tasks:
  package:
    script: ['true']
  index:
    script: ['reindex']
    needs: [package]
`;
  await withHarness({ pipeline }, async (h) => {
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);

    const pkg = await claimNamed(h, 'package', {});
    const outcome = await finish(h, pkg.id, { success: false, state: 'skipped', exitCode: 0 });
    assert.equal(outcome.state, 'skipped');
    assert.equal(outcome.job_state, null, 'the job is not settled: index still has to run');

    const index = await claimNamed(h, 'index', {});
    assert.ok(index, 'a skip is not a failure, so the indexer still runs');
    const last = await finish(h, index.id, { success: true });

    assert.equal(last.job_state, 'success');
    const tasks = tasksByName(await jobState(h, job));
    assert.equal(tasks.package.state, 'skipped');
  });
});

test('a skipped task that owed a value fails the one that needed it', async () => {
  const pipeline = `
version: 1
defaults:
  image: alpine
tasks:
  package:
    script: ['true']
  index:
    script: ['reindex \${{ tasks.package.outputs.path }}']
`;
  await withHarness({ pipeline }, async (h) => {
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);

    const pkg = await claimNamed(h, 'package', {});
    await finish(h, pkg.id, { success: false, state: 'skipped', exitCode: 0 });

    assert.equal(await claimNamed(h, 'index', {}), null);
    const tasks = tasksByName(await jobState(h, job));
    assert.equal(tasks.index.state, 'failed');
    assert.match(tasks.index.error, /produced no output "path"/);
  });
});

test('set-state failed fails a task that exited zero', async () => {
  const pipeline = `
version: 1
tasks:
  check:
    image: alpine
    script: ['true']
`;
  await withHarness({ pipeline }, async (h) => {
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);

    const check = await claimNamed(h, 'check', {});
    const outcome = await finish(h, check.id, { success: false, state: 'failed', exitCode: 0 });
    assert.equal(outcome.state, 'failed');
    assert.equal(outcome.job_state, 'failed');
  });
});

test('a worker that reports no state at all is still understood', async () => {
  const pipeline = `
version: 1
tasks:
  check:
    image: alpine
    script: ['true']
`;
  await withHarness({ pipeline }, async (h) => {
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);

    const check = await claimNamed(h, 'check', {});
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${check.id}/complete`,
      headers: { ...h.auth, 'content-type': 'application/json' },
      payload: JSON.stringify({ success: true, exit_code: 0 }),
    });
    assert.equal(data(res).state, 'success');
  });
});

test('a retry drops what the failed attempt produced', async () => {
  const pipeline = `
version: 1
tasks:
  flaky:
    image: alpine
    script: ['true']
    max_attempts: 2
`;
  await withHarness({ pipeline }, async (h) => {
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);

    const first = await claimNamed(h, 'flaky', {});
    await finish(h, first.id, {
      success: false,
      exitCode: 1,
      outputs: [{ name: 'tag', value: 'from-the-bad-run', masked: false }],
    });

    const rows = await h.services.db.all(
      'SELECT name FROM task_outputs WHERE task_id = {id}', { id: first.id }
    );
    assert.deepEqual(rows, [], 'a requeued task carries nothing forward');
  });
});

test('after edges are stored as their own kind', async () => {
  const pipeline = `
version: 1
defaults:
  image: alpine
tasks:
  a:
    script: ['true']
  b:
    script: ['true']
    needs: [a]
  c:
    script: ['true']
    after: [a]
`;
  await withHarness({ pipeline }, async (h) => {
    const job = (await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).json().data.job_id;
    await h.waitForJob(job);

    const tasks = tasksByName(await jobState(h, job));
    assert.deepEqual(tasks.b.needs, [tasks.a.id]);
    assert.deepEqual(tasks.b.after, []);
    assert.deepEqual(tasks.c.needs, []);
    assert.deepEqual(tasks.c.after, [tasks.a.id]);
  });
});
