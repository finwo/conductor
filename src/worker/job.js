// src/worker/job.js - running one job
//
// Sequence: prepare a workspace, fetch the tree, start any services on a
// private network, run the job container, ship its output, upload
// artifacts, report the outcome, and clean up whatever was created.
//
// Cleanup runs whatever happened. A worker that leaks containers or
// networks stops being usable after a few dozen jobs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { containerName } from './docker.js';
import { createLogStream } from './logstream.js';
import { fetchSource } from './source.js';
import { buildScript, SCRIPT_DIR, SCRIPT_NAME, SCRIPT_PATH } from './script.js';
import { collectArtifacts, uploadArtifacts, shouldCollect } from './artifacts.js';

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

// Cache directories are bind mounted straight onto their path in the
// workspace, which is cheaper than copying in and out around every job.
export async function prepareCache(cfg, job) {
  if (!job.cache || !Array.isArray(job.cache.paths)) return [];

  const key = String(job.cache.key ?? 'default').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 128);
  const project = String(job.project_id ?? 'project').replace(/[^A-Za-z0-9_.-]/g, '-');
  const mounts = [];

  for (const relative of job.cache.paths) {
    const normalized = relative.split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
    if (!normalized) continue;
    const host = path.join(cfg.cache_root, project, key, normalized);
    await fs.mkdir(host, { recursive: true });
    mounts.push(`${host}:/workspace/${normalized}`);
  }

  return mounts;
}

export async function runJob({ cfg, client, runtime, job, logger = console }) {
  const workspace = path.join(cfg.workspace_root, containerName('ws', job.id));
  const network = containerName('conductor-net', job.id);
  const jobContainer = containerName('conductor', job.id);

  const log = createLogStream(client, job.endpoints.log, { masked: job.masked ?? [], logger });

  const services = [];
  let networkCreated = false;
  let heartbeat = null;
  let timeoutTimer = null;
  let cancelled = false;
  let timedOut = false;
  let exitCode = null;
  let failure = null;

  try {
    await fs.mkdir(workspace, { recursive: true });

    log.note(`[conductor] job ${job.name} on ${cfg.name}`);
    log.note(`[conductor] commit ${String(job.sha).slice(0, 12)} attempt ${job.attempt}`);
    log.note(`[conductor] image ${job.image}`);

    const features = resolveFeatures(job, cfg.features);
    if (features.missing.length > 0) {
      // The conductor should never send such a job, so this means the two
      // sides disagree about what this worker offers.
      throw new Error(`worker does not provide required feature(s): ${features.missing.join(', ')}`);
    }

    await fetchSource(client, job, workspace);

    await fs.mkdir(path.join(workspace, SCRIPT_DIR), { recursive: true });
    await fs.writeFile(path.join(workspace, SCRIPT_PATH), buildScript(job.script), { mode: 0o755 });

    const cacheMounts = await prepareCache(cfg, job);

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

    const { child } = runtime.start({
      name: jobContainer,
      image: job.image,
      network,
      workspace,
      env: { ...features.env, ...job.env },
      mounts: [...features.mounts, ...cacheMounts],
      devices: features.devices,
      privileged: features.privileged,
      entrypoint: cfg.shell,
      command: [`/workspace/${SCRIPT_PATH}`],
    });

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

  // Artifacts are collected before teardown, and even after a failure when
  // the pipeline asked for that.
  if (job.artifacts && shouldCollect(job.artifacts.when, success)) {
    try {
      const files = await collectArtifacts(workspace, job.artifacts.paths, { logger });
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

  async function cleanup() {
    for (const name of services) await runtime.remove(name);
    await runtime.remove(jobContainer);
    if (networkCreated) await runtime.removeNetwork(network);
    await removeWorkspace();
  }

  // Most images run as root, so files the job created in the bind mounted
  // workspace are owned by root while the worker usually is not. Removing
  // them from the host then fails with EACCES. The directory itself belongs
  // to the worker, so emptying it from inside a container as root and then
  // removing the empty directory works without forcing every job image to
  // run as the worker's uid.
  async function removeWorkspace() {
    try {
      await fs.rm(workspace, { recursive: true, force: true });
      return;
    } catch (e) {
      if (e.code !== 'EACCES' && e.code !== 'EPERM' && e.code !== 'ENOTEMPTY') {
        logger.warn?.(`could not remove workspace ${workspace}: ${e.message}`);
        return;
      }
    }

    try {
      // The job image is already present locally, so nothing is pulled.
      await runtime.runOnce({
        name: containerName('conductor-clean', job.id),
        image: job.image,
        workspace,
        entrypoint: cfg.shell,
        command: ['-c', 'rm -rf /workspace/..?* /workspace/.[!.]* /workspace/* 2>/dev/null || true'],
      });
      await fs.rm(workspace, { recursive: true, force: true });
    } catch (e) {
      logger.warn?.(`could not remove workspace ${workspace}: ${e.message}`);
    }
  }
}
