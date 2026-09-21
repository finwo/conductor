// test/helpers/harness.js - a conductor on a temporary database
//
// Builds a real server against a real git repository and a real sqlite file,
// then drives it through fastify inject. No ports are bound and no
// background processes are started, so the tests stay deterministic.

import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../../src/lib/config.js';
import { createServices, buildServer } from '../../src/conductor/app.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_PIPELINE = `
version: 1
defaults:
  image: debian:bookworm-slim
tasks:
  lint:
    script: [make lint]
  build:
    arch: [x86_64, aarch64]
    script: ['./build.sh $ARCH']
    artifacts:
      paths: [dist/**]
  package:
    needs: [build]
    arch: [x86_64, aarch64]
    matrix:
      pkg: [musl]
    requires: [sign-key]
    script: ['./pkg.sh $MATRIX_PKG $ARCH']
  publish:
    needs: [package, lint]
    script: [./publish.sh]
`;

export async function createRepo(dir, { pipeline = DEFAULT_PIPELINE, configPath = '.conductor.yml' } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const git = (...args) => execFileAsync('git', ['-C', dir, ...args]);

  await execFileAsync('git', ['init', '-q', '-b', 'main', dir]);
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'user.name', 'Test');

  await fs.mkdir(path.dirname(path.join(dir, configPath)), { recursive: true });
  if (pipeline !== null) await fs.writeFile(path.join(dir, configPath), pipeline);
  await fs.writeFile(path.join(dir, 'README.md'), 'test repository\n');

  await git('add', '-A');
  await git('commit', '-q', '-m', 'initial commit');
  const { stdout } = await git('rev-parse', 'HEAD');
  return stdout.trim();
}

export async function startHarness(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-it-'));
  const repoDir = path.join(root, 'repo');
  // The file in the repository and the project's config_path are usually
  // the same, but not when the point of the test is that they differ.
  const sha = await createRepo(repoDir, {
    ...options,
    configPath: options.repoConfigPath ?? options.configPath ?? '.conductor.yml',
  });

  const configFile = path.join(root, 'conductor.yaml');
  await fs.writeFile(configFile, [
    'server:',
    // A real port and a matching public_url are needed whenever something
    // outside the process, such as a worker, has to reach back in.
    `  port: ${options.port ?? 0}`,
    `  public_url: ${options.publicUrl ?? 'http://conductor.test'}`,
    'database:',
    '  path: ./state/conductor.db',
    'storage:',
    '  path: ./state/storage',
    // Given an s3 block, artifacts and finished logs go there instead of
    // to the local path above.
    ...(options.s3
      ? [
        '  s3:',
        `    endpoint: ${options.s3.endpoint}`,
        `    region: ${options.s3.region}`,
        `    bucket: ${options.s3.bucket}`,
        `    access_key_id: ${options.s3.access_key_id}`,
        `    secret_access_key: ${options.s3.secret_access_key}`,
        `    force_path_style: ${options.s3.force_path_style !== false}`,
      ]
      : []),
    'git:',
    '  mirror_path: ./state/mirrors',
    '  fetch_interval: 0',
    'log:',
    '  spool_path: ./state/logs',
    'secrets:',
    `  encryption_key: ${crypto.randomBytes(32).toString('hex')}`,
    'scheduler:',
    '  heartbeat_timeout: 120',
    '  reap_interval: 30',
    ...(options.retention
      ? ['retention:', ...Object.entries(options.retention).map(([k, v]) => `  ${k}: ${v}`)]
      : []),
    'auth:',
    '  session_secret: test-session-secret-not-for-real-use',
    ...(options.oidcDiscoveryUrl
      ? [
        '  oidc:',
        `    discovery_url: ${options.oidcDiscoveryUrl}`,
        `    client_id: ${options.oidcClientId ?? 'conductor'}`,
        ...(options.oidcClientSecret ? [`    client_secret: ${options.oidcClientSecret}`] : []),
        ...(options.oidcScopes ? [`    scopes: ${options.oidcScopes}`] : []),
        ...(options.oidcAdminRole ? [`    admin_role: ${options.oidcAdminRole}`] : []),
      ]
      : []),
    '  bootstrap_admin:',
    `    username: ${options.adminUsername ?? 'admin'}`,
    `    password: ${options.adminPassword ?? 'bootstrap-password'}`,
    '',
  ].join('\n'));

  const savedConfig = process.env.CONDUCTOR_CONFIG;
  process.env.CONDUCTOR_CONFIG = configFile;
  const cfg = loadConfig();
  if (savedConfig === undefined) delete process.env.CONDUCTOR_CONFIG;
  else process.env.CONDUCTOR_CONFIG = savedConfig;

  const services = await createServices(cfg, {
    migrationLogger: () => {},
    logger: silentLogger(),
    // scrypt is deliberately slow, so the admin account is only created for
    // the tests that actually sign in.
    bootstrap: options.bootstrap === true,
  });
  const app = await buildServer(services, { logger: false });

  const project = await services.projects.create({
    id: 'demo',
    name: 'Demo',
    repo_url: repoDir,
    trigger_secret: 'test-secret',
    config_path: options.configPath ?? '.conductor.yml',

    // Public by default so that tests about scheduling can read jobs back
    // without signing in. Visibility itself is covered by its own suite,
    // which creates private projects explicitly.
    visibility: options.visibility ?? 'public',
    owner_id: options.ownerId ?? null,
  });

  const worker = await services.workerTokens.create('test-worker');

  return {
    root,
    repoDir,
    sha,
    cfg,
    app,
    services,
    project,
    worker,
    auth: { authorization: `Bearer ${worker.token}` },

    // Commits a change and returns the new commit id.
    async commit(files, message = 'update') {
      for (const [name, content] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(repoDir, name)), { recursive: true });
        await fs.writeFile(path.join(repoDir, name), content);
      }
      await execFileAsync('git', ['-C', repoDir, 'add', '-A']);
      await execFileAsync('git', ['-C', repoDir, 'commit', '-q', '-m', message]);
      const { stdout } = await execFileAsync('git', ['-C', repoDir, 'rev-parse', 'HEAD']);
      return stdout.trim();
    },

    sign(body) {
      return `sha256=${crypto.createHmac('sha256', 'test-secret').update(body).digest('hex')}`;
    },

    async trigger(payload, { secret = 'test-secret' } = {}) {
      const body = JSON.stringify(payload);
      const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
      return app.inject({
        method: 'POST',
        url: '/api/v1/projects/demo/trigger',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
        payload: body,
      });
    },

    // Starts a task the deliberate way, rather than by forwarding a push.
    async createJob(payload, { secret = 'test-secret' } = {}) {
      const body = JSON.stringify(payload);
      const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
      return app.inject({
        method: 'POST',
        url: '/api/v1/projects/demo/jobs',
        headers: { ...this.auth, 'content-type': 'application/json', 'x-hub-signature-256': signature },
        payload: body,
      });
    },

    // Waits for a job to leave the pending state (compilation complete).
    // Reads directly from the database so visibility rules don't block us.
    async waitForJob(jobId, { timeout = 10000 } = {}) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const job = await services.db.get('SELECT * FROM jobs WHERE id = {id}', { id: jobId });
        if (job && job.state !== 'pending') return job;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`job ${jobId} did not leave pending state within ${timeout}ms`);
    },

    async claim(body = {}) {
      return app.inject({
        method: 'POST',
        url: '/api/v1/tasks/claim',
        headers: { ...this.auth, 'content-type': 'application/json' },
        payload: JSON.stringify(body),
      });
    },

    // Signs in through the interface, which is the only way in, and returns
    // the session cookie. The interface's login form is htmx only.
    async login(username = options.adminUsername ?? 'admin', password = options.adminPassword ?? 'bootstrap-password') {
      const res = await app.inject({
        method: 'POST',
        url: '/login',
        headers: { 'hx-request': 'true', 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ username, password }).toString(),
      });
      if (res.statusCode !== 204) {
        throw new Error(`login failed: ${res.statusCode} ${res.body}`);
      }
      return { cookie: res.headers['set-cookie'].split(';')[0] };
    },

    async stop() {
      await app.close();
      await services.db.close();
      // Best effort: a container that ran as root may have left files the
      // test process cannot remove, and that must not mask a real failure.
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

// Asks the kernel for a free port and releases it. Only needed because the
// public_url has to be known before the server is built.
export async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
