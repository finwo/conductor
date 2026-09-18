// src/worker/docker.js - container runtime
//
// Shells out to a docker compatible CLI. Podman and nerdctl accept the same
// arguments, so the binary is configurable and nothing here is Docker
// specific beyond the command names.
//
// Arguments are always passed as an array and never through a shell, since
// image names, environment values and mount paths all originate from a
// repository.

import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Docker requires [a-zA-Z0-9][a-zA-Z0-9_.-]*, while job names contain
// colons, commas and equals signs. A hash suffix keeps names unique after
// the unsafe characters are folded away.
export function containerName(prefix, id, suffix = '') {
  const digest = crypto.createHash('sha256').update(id).digest('hex').slice(0, 8);
  const safe = id.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 40);
  return [prefix, safe, digest, suffix].filter(Boolean).join('-');
}

export function createRuntime(cfg, { logger = console } = {}) {
  const bin = cfg.docker;

  async function run(args, { timeout = 120000 } = {}) {
    try {
      const { stdout } = await execFileAsync(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
      return stdout.trim();
    } catch (e) {
      const detail = (e.stderr || e.message || '').toString().trim().split('\n').slice(0, 3).join('; ');
      const err = new Error(`${bin} ${args[0]} failed: ${detail}`);
      err.cause = e;
      throw err;
    }
  }

  // Turns a job and the worker's feature definitions into run arguments.
  function buildRunArgs({ name, image, network, workspace, env = {}, mounts = [], privileged = false, devices = [], command = [], entrypoint = null, detach = false, networkAlias = null }) {
    const args = ['run', '--rm', '--name', name];
    if (detach) args.push('--detach');
    else args.push('--attach', 'stdout', '--attach', 'stderr');

    if (network) args.push('--network', network);
    if (networkAlias) args.push('--network-alias', networkAlias);
    if (privileged) args.push('--privileged');

    for (const device of devices) args.push('--device', device);
    for (const mount of mounts) args.push('--volume', mount);

    if (workspace) {
      args.push('--volume', `${workspace}:/workspace`);
      args.push('--workdir', '/workspace');
    }

    for (const [key, value] of Object.entries(env)) {
      args.push('--env', `${key}=${value}`);
    }

    if (entrypoint !== null) args.push('--entrypoint', entrypoint);
    args.push(image);
    args.push(...command);
    return args;
  }

  return {
    buildRunArgs,

    async available() {
      try {
        await run(['version', '--format', '{{.Server.Version}}'], { timeout: 15000 });
        return true;
      } catch {
        return false;
      }
    },

    async createNetwork(name) {
      await run(['network', 'create', name]);
      return name;
    },

    async removeNetwork(name) {
      try {
        await run(['network', 'rm', name]);
      } catch (e) {
        logger.warn?.(`could not remove network ${name}: ${e.message}`);
      }
    },

    // Services run detached; their output is not part of the job log.
    async startService(options) {
      return run(buildRunArgs({ ...options, detach: true }));
    },

    // Starts the job container and hands back the process. The caller reads
    // stdout and stderr, and awaits the exit code.
    start(options) {
      const args = buildRunArgs({ ...options, detach: false });
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      return { child, args };
    },

    // Runs a container to completion and returns its output. Used for
    // short housekeeping tasks rather than for jobs.
    async runOnce(options, { timeout = 120000 } = {}) {
      return run(buildRunArgs({ ...options, detach: false }), { timeout });
    },

    async kill(name, signal = 'KILL') {
      try {
        await run(['kill', '--signal', signal, name], { timeout: 30000 });
      } catch {
        // Already gone, which is the desired state.
      }
    },

    async remove(name) {
      try {
        await run(['rm', '--force', name], { timeout: 30000 });
      } catch {
        // Already gone.
      }
    },

    async pull(image) {
      return run(['pull', image], { timeout: 30 * 60 * 1000 });
    },
  };
}
