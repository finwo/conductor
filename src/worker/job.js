// src/worker/job.js - running one job
//
// Sequence: create the container, put the tree and the script into it,
// start any services on a private network, run it, ship its output,
// take the artifacts back out, report, and clean up.
//
// Nothing is shared with the container through the filesystem. The tree
// arrives over the docker API and the artifacts leave the same way, so
// the worker needs no directory the host can also see, and therefore no
// mounts, no matching paths, and no storage of its own. What little it
// does write goes to a scratch directory that lives and dies with the
// job.
//
// Cleanup runs whatever happened. A worker that leaks containers or
// networks stops being usable after a few dozen jobs.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { containerName } from './docker.js';
import { createLogStream } from './logstream.js';
import { sourceIntoContainer } from './source.js';

// Where a job runs when the conductor did not say. The conductor resolves
// this from the pipeline and the project, so this only covers a worker
// talking to one too old to have an opinion.
const FALLBACK_WORKDIR = '/work';
import { buildScript, SCRIPT_NAME, SCRIPT_PATH } from './script.js';
import { collectArtifacts, uploadArtifacts, shouldCollect } from './artifacts.js';

// The part of an artifact pattern before its first wildcard, which is the
// most that can be copied out without asking the container to expand a
// glob it is no longer running to expand. An empty string means the
// pattern could match anywhere, so the whole tree has to come back.
export function patternPrefix(pattern) {
  const segments = String(pattern).split('/');
  const literal = [];
  for (const segment of segments) {
    if (/[*?[\]{}]/.test(segment)) break;
    literal.push(segment);
  }
  // A pattern with no wildcard at all names one path, and its last
  // segment is a file rather than a directory to descend into.
  return literal.join('/');
}

// The set of paths to copy out for a job's artifact patterns, with any
// path that is covered by another removed.
export function copyOutPaths(patterns) {
  const prefixes = (patterns ?? []).map(patternPrefix);
  if (prefixes.some((p) => p === '')) return [''];

  const unique = [...new Set(prefixes)].sort();
  return unique.filter((p, i) => !unique.slice(0, i).some((other) => p === other || p.startsWith(`${other}/`)));
}

// Resolves the features a job asked for into local resources.
export function resolveFeatures(job, available) {
  const mounts = [];
  const env = {};
  const devices = [];
  let privileged = false;
  const missing = [];

  for (const name of job.requires ?? []) {
    const feature = available[name];
    if (!feature) {
      missing.push(name);
      continue;
    }
    mounts.push(...feature.mounts);
    devices.push(...feature.devices);
    Object.assign(env, feature.env);
    if (feature.privileged) privileged = true;
  }

  return { mounts, env, devices, privileged, missing };
}

export async function runJob({ cfg, client, runtime, job, logger = console }) {
  const network = containerName('conductor-net', job.id);
  const jobContainer = containerName('conductor', job.id);
  const workdir = job.workdir || FALLBACK_WORKDIR;

  // Worker local, and only ever written by the worker: the generated
  // script on its way in, and artifacts on their way out. The container
  // never sees it.
  let scratch = null;

  const log = createLogStream(client, job.endpoints.log, { masked: job.masked ?? [], logger });

  const services = [];
  let networkCreated = false;
  let containerCreated = false;
  let heartbeat = null;
  let timeoutTimer = null;
  let cancelled = false;
  let timedOut = false;
  let exitCode = null;
  let failure = null;

  try {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-job-'));

    log.note(`[conductor] job ${job.name} on ${cfg.name}`);
    log.note(`[conductor] commit ${String(job.sha).slice(0, 12)} attempt ${job.attempt}`);
    log.note(`[conductor] image ${job.image}`);

    const features = resolveFeatures(job, cfg.features);
    if (features.missing.length > 0) {
      // The conductor should never send such a job, so this means the two
      // sides disagree about what this worker offers.
      throw new Error(`worker does not provide required feature(s): ${features.missing.join(', ')}`);
    }

    await runtime.createNetwork(network);
    networkCreated = true;

    for (const service of job.services ?? []) {
      const name = containerName('conductor-svc', job.id, service.alias);
      log.note(`[conductor] starting service ${service.image} as ${service.alias}`);
      await runtime.startService({
        name,
        image: service.image,
        network,
        networkAlias: service.alias,
        env: service.env ?? {},
        entrypoint: service.entrypoint?.length ? service.entrypoint[0] : null,
        command: service.entrypoint?.length ? [...service.entrypoint.slice(1), ...(service.command ?? [])] : (service.command ?? []),
      });
      services.push(name);
    }

    // Created rather than run, so its filesystem can be filled before it
    // starts and read after it exits. Feature mounts are still bind
    // mounts, since those name host paths the operator chose deliberately.
    await runtime.create({
      name: jobContainer,
      image: job.image,
      network,
      workdir,
      env: { ...features.env, ...job.env },
      mounts: features.mounts,
      devices: features.devices,
      privileged: features.privileged,
      entrypoint: cfg.shell,
      command: [SCRIPT_PATH],
    });
    containerCreated = true;

    await sourceIntoContainer({ client, runtime, job, container: jobContainer, workdir });

    const scriptPath = path.join(scratch, SCRIPT_NAME);
    await fs.writeFile(scriptPath, buildScript(job.script), { mode: 0o755 });
    await runtime.copyIn(jobContainer, scriptPath, SCRIPT_PATH);

    const { child } = runtime.startCreated(jobContainer);

    child.stdout.on('data', (chunk) => log.write(chunk));
    child.stderr.on('data', (chunk) => log.write(chunk));

    // Report in, and find out whether the run was cancelled underneath us.
    const beatEvery = Math.max(5, Number(job.heartbeat_interval) || 30) * 1000;
    heartbeat = setInterval(async () => {
      try {
        const result = await client.heartbeat(job.endpoints.heartbeat);
        if (result.cancelled && !cancelled) {
          cancelled = true;
          log.note('[conductor] cancelled, stopping the container');
          await runtime.kill(jobContainer);
        }
      } catch (e) {
        logger.warn?.(`heartbeat failed for ${job.name}: ${e.message}`);
      }
    }, beatEvery);
    heartbeat.unref?.();

    const limit = (Number(job.timeout) || cfg.default_timeout) * 1000;
    timeoutTimer = setTimeout(async () => {
      timedOut = true;
      log.note(`[conductor] timed out after ${Math.round(limit / 1000)}s, stopping the container`);
      await runtime.kill(jobContainer);
    }, limit);
    timeoutTimer.unref?.();

    exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
  } catch (e) {
    failure = e;
    log.note(`[conductor] ${e.message}`);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }

  const success = failure === null && exitCode === 0 && !cancelled && !timedOut;

  // Artifacts are collected before teardown, and even after a failure
  // when the pipeline asked for that. They come out of the stopped
  // container, which still has its filesystem until it is removed.
  if (containerCreated && job.artifacts && shouldCollect(job.artifacts.when, success)) {
    try {
      const staged = await stageArtifacts();
      const files = await collectArtifacts(staged, job.artifacts.paths, { logger });
      if (files.length > 0) {
        log.note(`[conductor] uploading ${files.length} artifact(s)`);
        await uploadArtifacts(client, job.endpoints.artifact, files, { logger });
      } else {
        log.note('[conductor] no files matched the artifact patterns');
      }
    } catch (e) {
      log.note(`[conductor] artifact collection failed: ${e.message}`);
      logger.warn?.(`artifact collection failed for ${job.name}: ${e.message}`);
    }
  }

  const error = failure
    ? failure.message
    : timedOut
      ? 'job timed out'
      : cancelled
        ? 'job cancelled'
        : exitCode === 0
          ? null
          : `job exited ${exitCode}`;

  if (error) log.note(`[conductor] ${error}`);
  else log.note('[conductor] done');

  await log.close();

  // Teardown first, so a slow conductor cannot hold containers open.
  await cleanup();

  try {
    await client.done(job.endpoints.done, { success, exitCode, error });
  } catch (e) {
    logger.error?.(`could not report completion of ${job.name}: ${e.message}`);
  }

  return { success, exitCode, error, cancelled, timedOut };

  // Copies what the artifact patterns could possibly match out of the
  // stopped container, into a directory the globbing can then walk.
  //
  // Only the leading literal part of each pattern can be copied, since
  // the container is no longer running to expand a glob. A pattern that
  // could match anywhere brings the whole tree back, which is the price
  // of asking for one.
  async function stageArtifacts() {
    const staged = path.join(scratch, 'artifacts');
    await fs.mkdir(staged, { recursive: true });

    for (const relative of copyOutPaths(job.artifacts.paths)) {
      if (relative === '') {
        // The trailing /. copies the contents rather than the directory.
        await runtime.copyOut(jobContainer, `${workdir}/.`, staged);
        break;
      }

      // Copying out of a container does need the parent to exist here,
      // unlike copying in.
      const parent = path.join(staged, path.dirname(relative));
      await fs.mkdir(parent, { recursive: true });
      await runtime.copyOut(jobContainer, `${workdir}/${relative}`, parent);
    }

    return staged;
  }

  async function cleanup() {
    for (const name of services) await runtime.remove(name);
    await runtime.remove(jobContainer);
    if (networkCreated) await runtime.removeNetwork(network);

    // Nothing here was written by the job, so there is no root owned
    // output to work around: removing the container took that with it.
    if (scratch) {
      await fs.rm(scratch, { recursive: true, force: true })
        .catch((e) => logger.warn?.(`could not remove scratch ${scratch}: ${e.message}`));
    }
  }
}
