// test/worker.test.js - worker units that need no container runtime
//
// The full loop against real Docker lives in worker-docker.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadWorkerConfig, featureNames } from '../src/worker/config.js';
import { buildScript, shellQuote } from '../src/worker/script.js';
import { containerName, createRuntime } from '../src/worker/docker.js';
import { createLogStream } from '../src/worker/logstream.js';
import { resolveFeatures, prepareCache } from '../src/worker/job.js';
import { collectArtifacts, shouldCollect } from '../src/worker/artifacts.js';

async function tempDir(prefix = 'conductor-worker-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function withConfigEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CONDUCTOR_')) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('CONDUCTOR_')) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
}

test('worker config loads from json and reports features', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'worker.json');
  await fs.writeFile(file, JSON.stringify({
    conductor_url: 'https://ci.example.com/',
    name: 'pi',
    token: 'abc',
    arches: ['aarch64'],
    features: {
      dind: { privileged: true },
      'sign-key': { mounts: ['/srv/k:/keys/k:ro'], env: { KEY: '/keys/k' } },
    },
  }));

  const cfg = await withConfigEnv({}, () => loadWorkerConfig(file));
  assert.equal(cfg.conductor_url, 'https://ci.example.com');
  assert.deepEqual(featureNames(cfg), ['dind', 'sign-key']);
  assert.equal(cfg.features.dind.privileged, true);
  assert.deepEqual(cfg.features['sign-key'].mounts, ['/srv/k:/keys/k:ro']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('worker config reads the token from a file', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'token'), 'secret-token\n');
  const file = path.join(dir, 'worker.json');
  await fs.writeFile(file, JSON.stringify({ token_file: path.join(dir, 'token') }));

  const cfg = await withConfigEnv({}, () => loadWorkerConfig(file));
  assert.equal(cfg.token, 'secret-token');
  await fs.rm(dir, { recursive: true, force: true });
});

test('environment overrides the worker config file', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'worker.json');
  await fs.writeFile(file, JSON.stringify({ token: 'x', arches: ['x86_64'], concurrency: 1 }));

  const cfg = await withConfigEnv({
    CONDUCTOR_WORKER_ARCHES: 'aarch64,riscv64',
    CONDUCTOR_WORKER_CONCURRENCY: '4',
  }, () => loadWorkerConfig(file));

  assert.deepEqual(cfg.arches, ['aarch64', 'riscv64']);
  assert.equal(cfg.concurrency, 4);
  await fs.rm(dir, { recursive: true, force: true });
});

test('worker config without a token is rejected', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'worker.json');
  await fs.writeFile(file, JSON.stringify({ conductor_url: 'http://x' }));
  await assert.rejects(withConfigEnv({}, () => loadWorkerConfig(file)), /no worker token/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('a malformed feature is reported with its path', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'worker.json');
  await fs.writeFile(file, JSON.stringify({
    token: 'x',
    features: { bad: { mounts: ['no-colon'], nonsense: 1 } },
  }));
  // Both problems are reported together; the order between them is not
  // part of the contract.
  await assert.rejects(withConfigEnv({}, () => loadWorkerConfig(file)), (e) => {
    assert.match(e.message, /features\.bad\.mounts\[0\]/);
    assert.match(e.message, /features\.bad\.nonsense/);
    return true;
  });
  await fs.rm(dir, { recursive: true, force: true });
});

test('shell quoting survives quotes and metacharacters', () => {
  assert.equal(shellQuote('simple'), "'simple'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote('$(rm -rf /)'), "'$(rm -rf /)'");
});

test('a generated script echoes each command and stops on failure', () => {
  const script = buildScript(['npm ci', "echo 'hi'"]);
  assert.match(script, /^#!\/bin\/sh\nset -e\n/);
  assert.ok(script.includes("printf '%s\\n' '$ npm ci'"));
  assert.ok(script.includes('npm ci\n'));
  // The echo of a command containing quotes stays a single argument.
  assert.ok(script.includes("printf '%s\\n' '$ echo '\\''hi'\\'''"));
});

test('container names are valid for docker and stay unique', () => {
  const a = containerName('conductor', 'run1:package:arch=x86_64,pkg=musl');
  const b = containerName('conductor', 'run1:package:arch=x86_64,pkg=busybox');
  assert.match(a, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  assert.notEqual(a, b);
  // Distinct jobs that differ only past the truncation point still differ.
  const long = 'x'.repeat(200);
  assert.notEqual(containerName('c', `${long}a`), containerName('c', `${long}b`));
});

test('run arguments carry mounts, env, network and privilege', () => {
  const runtime = createRuntime({ docker: 'docker', shell: 'sh' });
  const args = runtime.buildRunArgs({
    name: 'job1',
    image: 'alpine:3',
    network: 'net1',
    workspace: '/tmp/ws',
    env: { FOO: 'bar' },
    mounts: ['/srv/k:/keys/k:ro'],
    privileged: true,
    entrypoint: 'sh',
    command: ['/workspace/.conductor/script.sh'],
  });

  assert.equal(args[0], 'run');
  assert.ok(args.includes('--rm'));
  assert.deepEqual(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2), ['--network', 'net1']);
  assert.ok(args.includes('--privileged'));
  assert.ok(args.includes('/srv/k:/keys/k:ro'));
  assert.ok(args.includes('/tmp/ws:/workspace'));
  assert.ok(args.includes('FOO=bar'));
  // The image must come before its command.
  assert.ok(args.indexOf('alpine:3') < args.indexOf('/workspace/.conductor/script.sh'));
});

test('features resolve into mounts, env and privilege', () => {
  const available = {
    dind: { mounts: [], env: {}, devices: [], privileged: true },
    'sign-key': { mounts: ['/srv/k:/keys/k:ro'], env: { KEY: '/keys/k' }, devices: [], privileged: false },
  };
  const resolved = resolveFeatures({ requires: ['sign-key', 'dind'] }, available);
  assert.deepEqual(resolved.mounts, ['/srv/k:/keys/k:ro']);
  assert.deepEqual(resolved.env, { KEY: '/keys/k' });
  assert.equal(resolved.privileged, true);
  assert.deepEqual(resolved.missing, []);
});

test('an unknown required feature is reported rather than ignored', () => {
  const resolved = resolveFeatures({ requires: ['nope'] }, {});
  assert.deepEqual(resolved.missing, ['nope']);
});

test('cache paths become bind mounts and are created', async () => {
  const dir = await tempDir();
  const mounts = await prepareCache(
    { cache_root: dir },
    { project_id: 'demo', cache: { key: 'npm', paths: ['.npm', '../escape/attempt'] } }
  );

  assert.equal(mounts.length, 2);
  assert.ok(mounts[0].endsWith(':/workspace/.npm'));
  // Traversal is stripped, not honoured.
  assert.ok(mounts[1].endsWith(':/workspace/escape/attempt'));
  for (const mount of mounts) {
    const host = mount.split(':')[0];
    assert.ok((await fs.stat(host)).isDirectory());
    assert.ok(host.startsWith(dir));
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test('artifact collection globs, and refuses to leave the workspace', async () => {
  const dir = await tempDir();
  const outside = await tempDir('conductor-outside-');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'do not upload me');

  await fs.mkdir(path.join(dir, 'dist/nested'), { recursive: true });
  await fs.mkdir(path.join(dir, '.conductor'), { recursive: true });
  await fs.writeFile(path.join(dir, 'dist/app.bin'), 'binary');
  await fs.writeFile(path.join(dir, 'dist/nested/deep.bin'), 'deep');
  await fs.writeFile(path.join(dir, '.conductor/script.sh'), 'set -e');
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(dir, 'dist/escape.txt'));

  const found = await collectArtifacts(dir, ['dist/**'], { logger: { warn: () => {} } });
  const names = found.map((f) => f.path).sort();

  assert.ok(names.includes('dist/app.bin'));
  assert.ok(names.includes('dist/nested/deep.bin'));
  assert.ok(!names.includes('dist/escape.txt'), 'symlink out of the workspace must be refused');
  assert.ok(!names.some((n) => n.startsWith('.conductor')));
  assert.equal(found.find((f) => f.path === 'dist/app.bin').size, 6);

  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

test('artifact when controls collection', () => {
  assert.equal(shouldCollect('on_success', true), true);
  assert.equal(shouldCollect('on_success', false), false);
  assert.equal(shouldCollect('on_failure', false), true);
  assert.equal(shouldCollect('on_failure', true), false);
  assert.equal(shouldCollect('always', false), true);
});

// A client stub that records what the log stream sends.
function recordingClient() {
  const calls = [];
  let size = 0;
  return {
    calls,
    get text() {
      return calls.map((c) => c.chunk.toString('utf8')).join('');
    },
    async appendLog(url, chunk, offset) {
      calls.push({ chunk, offset });
      size = offset + chunk.length;
      return { size };
    },
  };
}

test('log output is batched and offsets advance', async () => {
  const client = recordingClient();
  const log = createLogStream(client, 'http://x/log', { flushMs: 5 });

  log.write('hello ');
  log.write('world\n');
  await log.close();

  assert.equal(client.text, 'hello world\n');
  assert.equal(client.calls[0].offset, 0);
  assert.equal(log.offset, 12);
});

test('a conflicting offset resynchronises instead of duplicating', async () => {
  const calls = [];
  let first = true;
  const client = {
    async appendLog(url, chunk, offset) {
      calls.push({ text: chunk.toString('utf8'), offset });
      if (first) {
        first = false;
        // The conductor already has the first four bytes.
        return { conflict: true, expected: 4 };
      }
      return { size: offset + chunk.length };
    },
  };

  const log = createLogStream(client, 'http://x/log', { flushMs: 5 });
  log.write('abcdefgh');
  await log.close();

  assert.equal(calls.length, 2);
  assert.equal(calls[1].offset, 4);
  assert.equal(calls[1].text, 'efgh', 'only the bytes the conductor lacks should be resent');
});

test('secrets are masked before anything leaves the host', async () => {
  const client = recordingClient();
  const log = createLogStream(client, 'http://x/log', { masked: ['hunter2'], flushMs: 5 });

  log.write('password is hunter2 ok\n');
  await log.close();

  assert.ok(!client.text.includes('hunter2'));
  assert.ok(client.text.includes('[masked]'));
});

test('a secret split across two writes is still masked', async () => {
  const client = recordingClient();
  const log = createLogStream(client, 'http://x/log', { masked: ['supersecret'], flushMs: 5 });

  log.write('token=super');
  log.write('secret done\n');
  await log.close();

  assert.ok(!client.text.includes('supersecret'), `leaked: ${client.text}`);
  assert.ok(client.text.includes('[masked]'));
});

test('a failing conductor does not break the job', async () => {
  const client = {
    async appendLog() {
      throw new Error('conductor unreachable');
    },
  };
  const log = createLogStream(client, 'http://x/log', { flushMs: 5, logger: { warn: () => {} } });
  log.write('some output\n');
  await log.close();
  assert.match(log.error.message, /unreachable/);
});
