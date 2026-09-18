// test/worker-docker.test.js - the whole loop, for real
//
// Runs actual containers against an actual conductor: trigger, claim, fetch
// source, run, stream logs, upload artifacts, report, and clean up.
// Skipped when no container runtime is available.
//
// The conductor is bound to a real port here rather than driven through
// inject, because the worker is a separate process talking over HTTP.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startHarness, freePort } from './helpers/harness.js';
import { createClient } from '../src/worker/client.js';
import { createRuntime, containerName } from '../src/worker/docker.js';
import { runJob } from '../src/worker/job.js';

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

// Starts the harness on a real port so the worker can reach it over HTTP.
// The port has to be settled before the server is built, because the job
// payload embeds absolute callback URLs derived from public_url.
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
    workspace_root: `${h.root}/work`,
    cache_root: `${h.root}/cache`,
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

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

async function logOf(h, jobId) {
  const res = await h.app.inject({ method: 'GET', url: `/api/jobs/${encodeURIComponent(jobId)}/log` });
  return res.body;
}

// Anchored, because a substring filter would also match unrelated
// containers that happen to share the prefix.
async function exists(kind, name) {
  const args = kind === 'network'
    ? ['network', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}']
    : ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}'];
  const { stdout } = await execFileAsync('docker', args);
  return stdout.trim().length > 0;
}

test('a job runs in a container and its output reaches the conductor', opts, async () => {
  const pipeline = `
version: 1
jobs:
  hello:
    image: ${IMAGE}
    script:
      - echo "hello from the job"
      - echo "commit is $CONDUCTOR_SHA"
      - echo "job is $CONDUCTOR_JOB"
      - cat README.md
`;
  const h = await listening({ pipeline });
  try {
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = await h.client.poll({ arches: [], features: [], name: 'test' });
    assert.ok(job, 'expected a job');

    const result = await runJob({ cfg: h.workerCfg, client: h.client, runtime: h.runtime, job, logger: quiet });
    assert.equal(result.success, true, `job failed: ${result.error}`);
    assert.equal(result.exitCode, 0);

    const log = await logOf(h, job.id);
    assert.match(log, /\$ echo "hello from the job"/, 'each command should be echoed');
    assert.match(log, /hello from the job/);
    assert.match(log, new RegExp(`commit is ${h.sha}`), 'CONDUCTOR_SHA should be set');
    assert.match(log, /job is hello/);
    // Proves the source tarball was fetched and unpacked.
    assert.match(log, /test repository/);

    const detail = await h.app.inject({ method: 'GET', url: `/api/runs/${job.run_id}` });
    assert.equal(detail.json().run.state, 'success');
  } finally {
    await h.stop();
  }
});

test('a failing command fails the job and preserves the log', opts, async () => {
  const pipeline = `
version: 1
jobs:
  boom:
    image: ${IMAGE}
    script:
      - echo before
      - exit 3
      - echo after
`;
  const h = await listening({ pipeline });
  try {
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = await h.client.poll({ arches: [], features: [], name: 'test' });

    const result = await runJob({ cfg: h.workerCfg, client: h.client, runtime: h.runtime, job, logger: quiet });
    assert.equal(result.success, false);
    assert.equal(result.exitCode, 3);

    const log = await logOf(h, job.id);
    assert.match(log, /before/);
    // set -e must stop the script at the failure.
    assert.ok(!log.includes('after'), 'commands after a failure must not run');

    const detail = await h.app.inject({ method: 'GET', url: `/api/runs/${job.run_id}` });
    assert.equal(detail.json().run.state, 'failed');
  } finally {
    await h.stop();
  }
});

test('artifacts produced in the container are uploaded and downloadable', opts, async () => {
  const pipeline = `
version: 1
jobs:
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
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = await h.client.poll({ arches: [], features: [], name: 'test' });

    const result = await runJob({ cfg: h.workerCfg, client: h.client, runtime: h.runtime, job, logger: quiet });
    assert.equal(result.success, true, `job failed: ${result.error}`);

    const detail = await h.app.inject({ method: 'GET', url: `/api/jobs/${encodeURIComponent(job.id)}` });
    const artifacts = detail.json().artifacts;
    const paths = artifacts.map((a) => a.path).sort();
    assert.deepEqual(paths, ['dist/app.bin', 'dist/nested/deep.txt']);

    const binary = artifacts.find((a) => a.path === 'dist/app.bin');
    const download = await h.app.inject({ method: 'GET', url: `/api/artifacts/${binary.id}` });
    assert.equal(download.body, 'binary-content');
  } finally {
    await h.stop();
  }
});

test('a worker feature injects a mount and environment the conductor never sees', opts, async () => {
  const pipeline = `
version: 1
jobs:
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
        'sign-key': {
          mounts: [],
          env: { SIGN_KEY: '/keys/build.key' },
          devices: [],
          privileged: false,
        },
      },
    },
  });

  try {
    // The key lives on the worker host and is mounted in by the feature.
    const fs = await import('node:fs/promises');
    await fs.mkdir(`${h.root}/keys`, { recursive: true });
    await fs.writeFile(`${h.root}/keys/build.key`, 'PRIVATE-KEY-MATERIAL');
    h.workerCfg.features['sign-key'].mounts = [`${h.root}/keys/build.key:/keys/build.key:ro`];

    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });

    // Without the feature the job is not offered at all.
    const denied = await createClient({ ...h.workerCfg, token: h.worker.token })
      .poll({ arches: [], features: [], name: 'test' });
    assert.equal(denied, null, 'a worker lacking the feature must not be offered the job');

    const job = await h.client.poll({ arches: [], features: ['sign-key'], name: 'test' });
    assert.ok(job, 'expected the job once the feature is advertised');

    const result = await runJob({ cfg: h.workerCfg, client: h.client, runtime: h.runtime, job, logger: quiet });
    assert.equal(result.success, true, `job failed: ${result.error}`);

    const log = await logOf(h, job.id);
    assert.match(log, /key path is \/keys\/build\.key/);
    assert.match(log, /PRIVATE-KEY-MATERIAL/);

    // The conductor stored the requirement, never the key itself.
    const stored = await h.services.db.get(
      'SELECT requires, spec FROM jobs WHERE id = {id}', { id: job.id }
    );
    assert.equal(stored.requires, '["sign-key"]');
    assert.ok(!stored.spec.includes('PRIVATE-KEY-MATERIAL'));
  } finally {
    await h.stop();
  }
});

test('a service container is reachable from the job by its alias', opts, async () => {
  const pipeline = `
version: 1
jobs:
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
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = await h.client.poll({ arches: [], features: [], name: 'test' });

    const result = await runJob({ cfg: h.workerCfg, client: h.client, runtime: h.runtime, job, logger: quiet });
    const log = await logOf(h, job.id);
    assert.equal(result.success, true, `job failed: ${result.error}\n${log}`);
    assert.match(log, /1 packets received|1 received/);
  } finally {
    await h.stop();
  }
});

test('a job that exceeds its timeout is stopped', opts, async () => {
  const pipeline = `
version: 1
jobs:
  slow:
    image: ${IMAGE}
    timeout: 2
    script:
      - echo starting
      - sleep 60
`;
  const h = await listening({ pipeline });
  try {
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = await h.client.poll({ arches: [], features: [], name: 'test' });

    const started = Date.now();
    const result = await runJob({ cfg: h.workerCfg, client: h.client, runtime: h.runtime, job, logger: quiet });
    const elapsed = (Date.now() - started) / 1000;

    assert.equal(result.success, false);
    assert.equal(result.timedOut, true);
    assert.ok(elapsed < 45, `should have been stopped promptly, took ${elapsed}s`);
    assert.match(await logOf(h, job.id), /timed out/);
  } finally {
    await h.stop();
  }
});

test('containers, networks and workspaces are cleaned up', opts, async () => {
  const pipeline = `
version: 1
jobs:
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
    await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = await h.client.poll({ arches: [], features: [], name: 'test' });
    await runJob({ cfg: h.workerCfg, client: h.client, runtime: h.runtime, job, logger: quiet });

    assert.equal(await exists('container', containerName('conductor', job.id)), false,
      'the job container should be gone');
    assert.equal(await exists('container', containerName('conductor-svc', job.id, 'sidecar')), false,
      'the service container should be gone');
    assert.equal(await exists('network', containerName('conductor-net', job.id)), false,
      'the job network should be gone');

    const fs = await import('node:fs/promises');
    const left = await fs.readdir(`${h.root}/work`).catch(() => []);
    assert.deepEqual(left, [], 'the workspace should be removed');
  } finally {
    await h.stop();
  }
});
