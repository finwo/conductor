// test/worker-docker.test.js - the whole loop, for real

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startHarness, data, freePort } from './helpers/harness.js';
import { createClient } from '../src/worker/client.js';
import { createRuntime, containerName } from '../src/worker/docker.js';
import { runTask } from '../src/worker/task.js';

const execFileAsync = promisify(execFile);

const IMAGE = process.env.CONDUCTOR_TEST_IMAGE || 'alpine:3';

async function dockerUsable() {
  if (process.env.CONDUCTOR_TEST_NO_DOCKER) return false;
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 15000 });
    await execFileAsync('docker', ['image', 'inspect', IMAGE], { timeout: 15000 })
      .catch(() => execFileAsync('docker', ['pull', IMAGE], { timeout: 300000 }));
    return true;
  } catch {
    return false;
  }
}

const available = await dockerUsable();
const opts = { skip: available ? false : 'docker is not available' };

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// The port must settle before the server is built: task payloads carry
// absolute callback URLs derived from public_url.
async function listening(options = {}) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const h = await startHarness({ ...options, port, publicUrl: url });
  await h.app.listen({ port, host: '127.0.0.1' });

  const workerCfg = {
    conductor_url: url,
    name: 'docker-test-worker',
    token: h.worker.token,
    arches: [],
    features: {},
    concurrency: 1,
    poll_interval: 1,
    docker: 'docker',
    shell: 'sh',
    default_timeout: 300,
    ...(options?.worker ?? {}),
  };

  return {
    ...h,
    url,
    workerCfg,
    client: createClient(workerCfg),
    runtime: createRuntime(workerCfg, { logger: quiet }),
  };
}

async function queue(h) {
  const triggered = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
  const jobId = data(triggered).job_id;
  await h.waitForJob(jobId);
  return jobId;
}

async function logOf(h, taskId) {
  const res = await h.app.inject({
    method: 'GET', url: `/api/v1/tasks/${encodeURIComponent(taskId)}/log`,
  });
  return data(res).data;
}

async function artifactsOf(h, taskId) {
  const res = await h.app.inject({
    method: 'GET', url: `/api/v1/tasks/${encodeURIComponent(taskId)}/artifacts`,
  });
  return data(res);
}

function download(h, jobId, taskId, artifactId) {
  return h.app.inject({
    method: 'GET',
    url: `/api/v1/projects/demo/jobs/${jobId}/tasks/${encodeURIComponent(taskId)}`
      + `/artifacts/${artifactId}`,
  });
}

async function stateOf(h, jobId) {
  return data(await h.app.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}` })).state;
}

async function exists(kind, name) {
  const args = kind === 'network'
    ? ['network', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}']
    : ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}'];
  const { stdout } = await execFileAsync('docker', args);
  return stdout.trim().length > 0;
}

test('a task runs in a container and its output reaches the conductor', opts, async () => {
  const pipeline = `
version: 1
tasks:
  hello:
    image: ${IMAGE}
    script:
      - echo "hello from the task"
      - echo "commit is $CONDUCTOR_SHA"
      - echo "task is $CONDUCTOR_TASK"
      - cat README.md
`;
  const h = await listening({ pipeline });
  try {
    const jobId = await queue(h);
    const task = await h.client.claim({ arches: [], features: [], name: 'test' });
    assert.ok(task, 'expected a task');

    const result = await runTask({ cfg: h.workerCfg, client: h.client, runtime: h.runtime, task, logger: quiet });
    assert.equal(result.success, true, `task failed: ${result.error}`);
    assert.equal(result.exitCode, 0);

    const log = await logOf(h, task.id);
    assert.match(log, /\$ echo "hello from the task"/, 'each command should be echoed');
    assert.match(log, /hello from the task/);
    assert.match(log, new RegExp(`commit is ${h.sha}`));
    assert.match(log, /task is hello/);
    assert.match(log, /test repository/, 'the source tarball should have been unpacked');

    assert.equal(await stateOf(h, jobId), 'success');
  } finally {
    await h.stop();
  }
});

test('a failing command fails the task and preserves the log', opts, async () => {
  const pipeline = `
version: 1
tasks:
  boom:
    image: ${IMAGE}
    script:
      - echo before
      - exit 3
      - echo after
`;
  const h = await listening({ pipeline });
  try {
    const jobId = await queue(h);
    const task = await h.client.claim({ arches: [], features: [], name: 'test' });

    const result = await runTask({ cfg: h.workerCfg, client: h.client, runtime: h.runtime, task, logger: quiet });
    assert.equal(result.success, false);
    assert.equal(result.exitCode, 3);

    const log = await logOf(h, task.id);
    assert.match(log, /before/);
    assert.ok(!log.includes('after'), 'set -e must stop the script at the failure');

    assert.equal(await stateOf(h, jobId), 'failed');
  } finally {
    await h.stop();
  }
});

test('artifacts produced in the container are uploaded and downloadable', opts, async () => {
  const pipeline = `
version: 1
tasks:
  produce:
    image: ${IMAGE}
    script:
      - mkdir -p dist/nested
      - printf 'binary-content' > dist/app.bin
      - printf 'deep' > dist/nested/deep.txt
    artifacts:
      paths: [dist/**]
`;
  const h = await listening({ pipeline });
  try {
    const jobId = await queue(h);
    const task = await h.client.claim({ arches: [], features: [], name: 'test' });

    const result = await runTask({ cfg: h.workerCfg, client: h.client, runtime: h.runtime, task, logger: quiet });
    assert.equal(result.success, true, `task failed: ${result.error}`);

    const artifacts = await artifactsOf(h, task.id);
    assert.deepEqual(artifacts.map((a) => a.path).sort(), ['dist/app.bin', 'dist/nested/deep.txt']);

    const binary = artifacts.find((a) => a.path === 'dist/app.bin');
    assert.equal((await download(h, jobId, task.id, binary.id)).body, 'binary-content');
  } finally {
    await h.stop();
  }
});

test('a worker feature injects a mount and environment the conductor never sees', opts, async () => {
  const pipeline = `
version: 1
tasks:
  signed:
    image: ${IMAGE}
    requires: [sign-key]
    script:
      - echo "key path is $SIGN_KEY"
      - cat "$SIGN_KEY"
`;
  const h = await listening({
    pipeline,
    worker: {
      features: {
        'sign-key': { mounts: [], env: { SIGN_KEY: '/keys/build.key' }, devices: [], privileged: false },
      },
    },
  });

  try {
    await fs.mkdir(`${h.root}/keys`, { recursive: true });
    await fs.writeFile(`${h.root}/keys/build.key`, 'PRIVATE-KEY-MATERIAL');
    h.workerCfg.features['sign-key'].mounts = [`${h.root}/keys/build.key:/keys/build.key:ro`];

    await queue(h);

    const denied = await createClient({ ...h.workerCfg, token: h.worker.token })
      .claim({ arches: [], features: [], name: 'test' });
    assert.equal(denied, null, 'a worker lacking the feature must not be offered the task');

    const task = await h.client.claim({ arches: [], features: ['sign-key'], name: 'test' });
    assert.ok(task, 'expected the task once the feature is advertised');

    const result = await runTask({ cfg: h.workerCfg, client: h.client, runtime: h.runtime, task, logger: quiet });
    assert.equal(result.success, true, `task failed: ${result.error}`);

    const log = await logOf(h, task.id);
    assert.match(log, /key path is \/keys\/build\.key/);
    assert.match(log, /PRIVATE-KEY-MATERIAL/);

    const stored = await h.services.db.get(
      'SELECT requires, spec FROM tasks WHERE id = {id}', { id: task.id }
    );
    assert.equal(stored.requires, '["sign-key"]');
    assert.ok(!stored.spec.includes('PRIVATE-KEY-MATERIAL'));
  } finally {
    await h.stop();
  }
});

test('a service container is reachable from the task by its alias', opts, async () => {
  const pipeline = `
version: 1
tasks:
  talks:
    image: ${IMAGE}
    services:
      - image: ${IMAGE}
        alias: sidecar
        command: [sleep, '60']
    script:
      - ping -c1 -W2 sidecar
`;
  const h = await listening({ pipeline });
  try {
    await queue(h);
    const task = await h.client.claim({ arches: [], features: [], name: 'test' });

    const result = await runTask({ cfg: h.workerCfg, client: h.client, runtime: h.runtime, task, logger: quiet });
    const log = await logOf(h, task.id);
    assert.equal(result.success, true, `task failed: ${result.error}\n${log}`);
    assert.match(log, /1 packets received|1 received/);
  } finally {
    await h.stop();
  }
});

test('a task that exceeds its timeout is stopped', opts, async () => {
  const pipeline = `
version: 1
tasks:
  slow:
    image: ${IMAGE}
    timeout: 2
    script:
      - echo starting
      - sleep 60
`;
  const h = await listening({ pipeline });
  try {
    await queue(h);
    const task = await h.client.claim({ arches: [], features: [], name: 'test' });

    const started = Date.now();
    const result = await runTask({ cfg: h.workerCfg, client: h.client, runtime: h.runtime, task, logger: quiet });
    const elapsed = (Date.now() - started) / 1000;

    assert.equal(result.success, false);
    assert.equal(result.timedOut, true);
    assert.ok(elapsed < 45, `should have been stopped promptly, took ${elapsed}s`);
    assert.match(await logOf(h, task.id), /timed out/);
  } finally {
    await h.stop();
  }
});

test('containers, networks and scratch directories are cleaned up', opts, async () => {
  const pipeline = `
version: 1
tasks:
  tidy:
    image: ${IMAGE}
    services:
      - image: ${IMAGE}
        alias: sidecar
        command: [sleep, '60']
    script:
      - echo work
`;
  const h = await listening({ pipeline });
  try {
    const before = new Set(
      (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith('conductor-task-'))
    );

    await queue(h);
    const task = await h.client.claim({ arches: [], features: [], name: 'test' });
    await runTask({ cfg: h.workerCfg, client: h.client, runtime: h.runtime, task, logger: quiet });

    assert.equal(await exists('container', containerName('conductor', task.id)), false,
      'the task container should be gone');
    assert.equal(await exists('container', containerName('conductor-svc', task.id, 'sidecar')), false,
      'the service container should be gone');
    assert.equal(await exists('network', containerName('conductor-net', task.id)), false,
      'the task network should be gone');

    const leaked = (await fs.readdir(os.tmpdir()))
      .filter((n) => n.startsWith('conductor-task-'))
      .filter((n) => !before.has(n));
    assert.deepEqual(leaked, [], 'the scratch directory should be removed');
  } finally {
    await h.stop();
  }
});

test('a task runs with no mounts, and nothing of the worker is shared with it', opts, async () => {
  const pipeline = `
version: 1
tasks:
  isolated:
    image: ${IMAGE}
    script:
      - pwd
      - cat README.md
      - cat /proc/mounts
`;
  const h = await listening({ pipeline });
  try {
    await queue(h);
    const task = await h.client.claim({ arches: [], features: [], name: 'test' });

    const created = h.runtime.buildCreateArgs({
      name: 'inspect', image: IMAGE, workdir: task.workdir, entrypoint: 'sh', command: ['/tmp/entrypoint.sh'],
    });
    assert.ok(!created.includes('--volume'), `no volume should be passed, got: ${created.join(' ')}`);

    const result = await runTask({ cfg: h.workerCfg, client: h.client, runtime: h.runtime, task, logger: quiet });
    assert.equal(result.success, true, `task failed: ${result.error}`);

    const log = await logOf(h, task.id);
    assert.match(log, /^\/work$/m, 'the task should run in the working directory');
    assert.match(log, /test repository/, 'the tree should have arrived');

    const mounts = log.split('\n').filter((line) => / \/\S+ \S+ (rw|ro)[,\s]/.test(line));
    assert.ok(mounts.length > 0, 'expected /proc/mounts in the log');

    const shared = mounts
      .map((line) => line.split(' ')[1])
      .filter((target) => !/^\/(proc|sys|dev|etc\/(hostname|hosts|resolv\.conf))/.test(target))
      .filter((target) => target !== '/');
    assert.deepEqual(shared, [], `nothing should be mounted into the task, found: ${shared.join(', ')}`);
  } finally {
    await h.stop();
  }
});

test('a pipeline chooses where its tree lands', opts, async () => {
  const pipeline = `
version: 1
workdir: /usr/src/app
tasks:
  build:
    image: ${IMAGE}
    script:
      - pwd
      - cat README.md
      - mkdir -p out && printf 'made here' > out/result.txt
    artifacts:
      paths: [out/**]
`;
  const h = await listening({ pipeline });
  try {
    const jobId = await queue(h);
    const task = await h.client.claim({ arches: [], features: [], name: 'test' });
    assert.equal(task.workdir, '/usr/src/app');

    const result = await runTask({ cfg: h.workerCfg, client: h.client, runtime: h.runtime, task, logger: quiet });
    assert.equal(result.success, true, `task failed: ${result.error}`);

    const log = await logOf(h, task.id);
    assert.match(log, /^\/usr\/src\/app$/m, 'the script should run there');
    assert.match(log, /test repository/, 'and the tree should be there, not at /work');

    const artifacts = await artifactsOf(h, task.id);
    assert.deepEqual(artifacts.map((a) => a.path), ['out/result.txt']);
    assert.equal((await download(h, jobId, task.id, artifacts[0].id)).body, 'made here');
  } finally {
    await h.stop();
  }
});
