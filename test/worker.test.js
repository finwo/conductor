// test/worker.test.js - worker units that need no container runtime
//
// The full loop against real Docker lives in worker-docker.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadWorkerConfig, featureNames } from '../src/worker/config.js';
import { buildScript, shellQuote } from '../src/worker/script.js';
import { containerName, createRuntime } from '../src/worker/docker.js';
import { createLogStream } from '../src/worker/logstream.js';
import { resolveFeatures, patternPrefix, copyOutPaths } from '../src/worker/task.js';
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
  // Distinct tasks that differ only past the truncation point still differ.
  const long = 'x'.repeat(200);
  assert.notEqual(containerName('c', `${long}a`), containerName('c', `${long}b`));
});

test('job arguments carry mounts, env, network and privilege', () => {
  const runtime = createRuntime({ docker: 'docker', shell: 'sh' });
  const args = runtime.buildRunArgs({
    name: 'job1',
    image: 'alpine:3',
    network: 'net1',
    workdir: '/work',
    env: { FOO: 'bar' },
    mounts: ['/srv/k:/keys/k:ro'],
    privileged: true,
    entrypoint: 'sh',
    command: ['/tmp/entrypoint.sh'],
  });

  assert.equal(args[0], 'run');
  assert.ok(args.includes('--rm'));
  assert.deepEqual(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2), ['--network', 'net1']);
  assert.ok(args.includes('--privileged'));
  assert.ok(args.includes('/srv/k:/keys/k:ro'));
  assert.deepEqual(args.slice(args.indexOf('--workdir'), args.indexOf('--workdir') + 2), ['--workdir', '/work']);
  assert.ok(args.includes('FOO=bar'));
  // The image must come before its command.
  assert.ok(args.indexOf('alpine:3') < args.indexOf('/tmp/entrypoint.sh'));
});

test('a task container is created without sharing anything with the worker', () => {
  // The whole point of copying the tree in: no path of the worker's is
  // handed to the daemon, so nothing has to line up between the two.
  const runtime = createRuntime({ docker: 'docker', shell: 'sh' });
  const args = runtime.buildCreateArgs({
    name: 'job1',
    image: 'alpine:3',
    network: 'net1',
    workdir: '/work',
    env: { FOO: 'bar' },
    entrypoint: 'sh',
    command: ['/tmp/entrypoint.sh'],
  });

  assert.equal(args[0], 'create');
  assert.ok(!args.includes('--attach'), 'create takes no attach flags');
  assert.ok(!args.includes('--volume'), 'nothing of the worker is mounted in');
  assert.ok(!args.some((a) => a.includes(':/work')), 'the tree is copied in, never bind mounted');
  assert.deepEqual(args.slice(args.indexOf('--workdir'), args.indexOf('--workdir') + 2), ['--workdir', '/work']);
  assert.ok(args.indexOf('alpine:3') < args.indexOf('/tmp/entrypoint.sh'));
});

test('a feature still contributes its bind mounts', () => {
  // Those name host paths an operator chose deliberately, which is a
  // different thing from the worker sharing its own directories.
  const runtime = createRuntime({ docker: 'docker', shell: 'sh' });
  const args = runtime.buildCreateArgs({
    name: 'job1',
    image: 'alpine:3',
    mounts: ['/srv/keys/build.rsa:/keys/build.rsa:ro'],
    entrypoint: 'sh',
    command: ['/tmp/entrypoint.sh'],
  });

  assert.ok(args.includes('/srv/keys/build.rsa:/keys/build.rsa:ro'));
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

test('an artifact pattern reduces to the part that can be copied out', () => {
  // A stopped container cannot expand a glob, so only the leading
  // literal part of a pattern can be asked for by name.
  assert.equal(patternPrefix('out/**'), 'out');
  assert.equal(patternPrefix('build/*.tar.gz'), 'build');
  assert.equal(patternPrefix('a/b/c/**'), 'a/b/c');
  assert.equal(patternPrefix('dist/app.tar'), 'dist/app.tar');

  // A pattern that could match anywhere has no usable prefix.
  assert.equal(patternPrefix('**/*.log'), '');
  assert.equal(patternPrefix('*'), '');
});

test('overlapping artifact paths are copied out once', () => {
  assert.deepEqual(copyOutPaths(['out/**', 'out/deep/**', 'build/*']), ['build', 'out']);
  assert.deepEqual(copyOutPaths(['out/**', 'out/**']), ['out']);

  // One pattern matching anywhere means the whole tree comes back, and
  // there is no point copying anything else separately.
  assert.deepEqual(copyOutPaths(['**/*.log', 'out/**']), ['']);

  // A prefix must be a whole path segment: outer must not swallow out.
  assert.deepEqual(copyOutPaths(['out/**', 'outer/**']), ['out', 'outer']);
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

test('an idle worker keeps running instead of exiting', async () => {
  // A worker with nothing to do is waiting on a timer and nothing else.
  // If that timer does not hold the event loop open, node decides it has
  // finished and exits 0, which looks like a clean shutdown and is not.
  const dir = await tempDir();
  const config = path.join(dir, 'worker.json');

  // Points at a port nothing is listening on, so every poll fails and the
  // agent stays in its retry sleep.
  await fs.writeFile(config, JSON.stringify({
    conductor_url: 'http://127.0.0.1:1',
    token: 'irrelevant',
    poll_interval: 1,
    docker: 'true',
  }));

  const agent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/worker/agent.js');
  const child = spawn(process.execPath, [agent, '--config', config], { stdio: 'ignore' });

  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('still running'), 4000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(`exited with ${code}`);
    });
  });

  child.kill('SIGKILL');
  assert.equal(outcome, 'still running');

  await fs.rm(dir, { recursive: true, force: true });
});

test('a worker stops promptly on a signal rather than after its poll interval', async () => {
  const dir = await tempDir();
  const config = path.join(dir, 'worker.json');
  await fs.writeFile(config, JSON.stringify({
    conductor_url: 'http://127.0.0.1:1',
    token: 'irrelevant',
    // Long enough that waiting it out would fail this test.
    poll_interval: 60,
    docker: 'true',
  }));

  const agent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/worker/agent.js');
  const child = spawn(process.execPath, [agent, '--config', config], { stdio: 'ignore' });

  // Let it reach the sleep, then ask it to stop.
  await new Promise((r) => { setTimeout(r, 1500); });
  const started = Date.now();
  child.kill('SIGTERM');

  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timed out'), 10000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });

  child.kill('SIGKILL');
  assert.equal(code, 0, 'should exit cleanly on SIGTERM');
  assert.ok(Date.now() - started < 8000, 'should not wait out the poll interval');

  await fs.rm(dir, { recursive: true, force: true });
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

test('a secret named while the task runs is masked from then on', async () => {
  const client = recordingClient();
  const log = createLogStream(client, 'http://x/log', { flushMs: 5 });

  assert.equal(log.addSecret('abcdef123456'), true);
  log.write('token is abcdef123456 ok\n');
  await log.close();

  assert.ok(!client.text.includes('abcdef123456'), `leaked: ${client.text}`);
  assert.ok(client.text.includes('[masked]'));
});

test('naming a secret also masks output still buffered', async () => {
  const client = recordingClient();
  const log = createLogStream(client, 'http://x/log', { flushMs: 50 });

  log.write('echoed abcdef123456 early\n');
  log.addSecret('abcdef123456');
  await log.close();

  assert.ok(!client.text.includes('abcdef123456'), `leaked: ${client.text}`);
});

test('a value too short to mask is refused rather than made into noise', async () => {
  const client = recordingClient();
  const log = createLogStream(client, 'http://x/log', { flushMs: 5 });

  assert.equal(log.addSecret('ab'), false);
  log.write('ab is everywhere\n');
  await log.close();

  assert.equal(client.text, 'ab is everywhere\n');
});

test('a failing conductor does not break the task', async () => {
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
