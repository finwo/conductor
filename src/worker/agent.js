#!/usr/bin/env node
// src/worker/agent.js - the worker
//
// Polls a conductor for work and runs it in containers. Pull based, so the
// worker needs no inbound connectivity and can sit behind any amount of NAT.
//
// Deliberately free of npm dependencies: copy src/worker onto a host with
// node, tar and a container runtime and it runs. That matters because the
// point of this design is accepting build capacity from machines you do not
// administer.
//
// Usage:
//   node src/worker/agent.js [--config worker.json] [--once]

import { loadWorkerConfig, featureNames } from './config.js';
import { createClient } from './client.js';
import { createRuntime } from './docker.js';
import { hasTar, hasGit } from './source.js';
import { runJob } from './job.js';

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

const logger = {
  info: (m) => console.log(`${stamp()} ${m}`),
  warn: (m) => console.warn(`${stamp()} warning: ${m}`),
  error: (m) => console.error(`${stamp()} error: ${m}`),
  debug: () => {},
};

function parseArgv(argv) {
  const out = { config: null, once: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config' || argv[i] === '-c') {
      out.config = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--once') {
      out.once = true;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('usage: agent.js [--config <file>] [--once]');
      process.exit(0);
    }
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgv(argv);
  const cfg = await loadWorkerConfig(args.config);
  const client = createClient(cfg);
  const runtime = createRuntime(cfg, { logger });

  // Fail at startup rather than on the first job, when a missing tool would
  // otherwise look like a broken pipeline.
  if (!(await runtime.available())) {
    throw new Error(`container runtime ${JSON.stringify(cfg.docker)} is not usable; is the daemon running?`);
  }
  if (!(await hasTar())) {
    throw new Error('tar is required to unpack job sources but was not found on PATH');
  }
  if (!(await hasGit())) {
    logger.warn('git was not found; projects configured for clone mode will fail');
  }

  const features = featureNames(cfg);
  logger.info(`worker ${cfg.name} polling ${cfg.conductor_url}`);
  logger.info(`  arches:      ${cfg.arches.length > 0 ? cfg.arches.join(', ') : '(any)'}`);
  logger.info(`  features:    ${features.length > 0 ? features.join(', ') : '(none)'}`);
  logger.info(`  concurrency: ${cfg.concurrency}`);

  let stopping = false;
  const running = new Set();

  // An idle worker is waiting on a timer and nothing else. The timer has
  // to hold the event loop open, or node finds it has no work left and
  // exits cleanly the first time there is nothing to build. Waking the
  // sleepers on a signal keeps shutdown immediate despite that.
  const sleepers = new Set();

  function sleep(ms) {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      sleepers.add(wake);
    });
  }

  const shutdown = (signal) => {
    if (stopping) {
      logger.warn('second signal, exiting now');
      process.exit(1);
    }
    stopping = true;
    logger.info(`${signal} received, finishing ${running.size} running job(s)`);
    for (const wake of [...sleepers]) wake();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown(signal));

  // One loop per concurrency slot. Each polls independently, so a slow job
  // in one slot does not stall the others.
  async function slot(index) {
    let backoff = cfg.poll_interval;

    while (!stopping) {
      let job = null;
      try {
        job = await client.poll({ arches: cfg.arches, features, name: cfg.name });
        backoff = cfg.poll_interval;
      } catch (e) {
        // A conductor that is down or restarting should not become a busy
        // loop, so back off up to a minute.
        logger.warn(`poll failed: ${e.message}`);
        await sleep(backoff * 1000);
        backoff = Math.min(backoff * 2, 60);
        continue;
      }

      if (!job) {
        if (args.once) return;
        await sleep(cfg.poll_interval * 1000);
        continue;
      }

      running.add(job.id);
      logger.info(`[${index}] ${job.name} (${job.image})`);
      const started = Date.now();
      try {
        const result = await runJob({ cfg, client, runtime, job, logger });
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        logger.info(`[${index}] ${job.name} ${result.success ? 'succeeded' : 'failed'} in ${seconds}s`);
      } catch (e) {
        logger.error(`[${index}] ${job.name} crashed the worker loop: ${e.stack ?? e.message}`);
      } finally {
        running.delete(job.id);
      }

      if (args.once) return;
    }
  }

  await Promise.all(Array.from({ length: cfg.concurrency }, (_, i) => slot(i + 1)));
  logger.info('stopped');
}

// Only run when executed directly, so the module stays importable by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    logger.error(e.message);
    process.exit(1);
  });
}
