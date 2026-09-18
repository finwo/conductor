// src/conductor/app.js - assembles the conductor
//
// Separated from index.js so tests can build a server on a temporary
// database without starting a listener or installing signal handlers.

import Fastify from 'fastify';
import cors from '@fastify/cors';

import { ensureStateDirs, parseKey } from '../lib/config.js';
import { openDatabase, runMigrations } from '../lib/db/index.js';
import { createStorage } from '../lib/storage/index.js';
import { createSecretBox } from '../lib/secretbox.js';
import { createLogStore } from '../lib/log.js';
import { createGit } from '../lib/git.js';
import { createProjects } from '../lib/projects.js';
import { createWorkerTokens } from '../lib/workers.js';
import { createScheduler } from './scheduler.js';

import workerRoutes from './routes/workers.js';
import triggerRoutes from './routes/trigger.js';
import runRoutes from './routes/runs.js';

export async function createServices(cfg, options = {}) {
  ensureStateDirs(cfg);

  const db = await openDatabase(cfg);
  if (options.migrate !== false) {
    await runMigrations(db, { logger: options.migrationLogger });
  }

  const secrets = createSecretBox(parseKey(cfg.secrets.encryption_key, 'secrets.encryption_key'));
  const storage = createStorage(cfg);
  const logs = createLogStore(cfg);
  const git = createGit(cfg);
  const projects = createProjects({ db, secrets });
  const workerTokens = createWorkerTokens({ db });

  const logger = options.logger ?? console;
  const scheduler = createScheduler({ cfg, db, git, logs, storage, projects, logger });

  return { cfg, db, secrets, storage, logs, git, projects, workerTokens, scheduler, logger };
}

export async function buildServer(services, options = {}) {
  const { cfg } = services;
  const fastify = Fastify({
    logger: options.logger ?? { level: process.env.LOG_LEVEL || 'info' },
    // Workers upload artifacts as raw streams; this only bounds parsed
    // bodies such as the trigger payload.
    bodyLimit: 1024 * 1024,
    trustProxy: options.trustProxy ?? true,
  });

  await fastify.register(cors, { origin: true });

  fastify.get('/health', async () => ({
    ok: true,
    service: 'conductor',
    database: services.db.dialect,
    storage: services.storage.driver,
    auth: cfg.auth.mode,
  }));

  await fastify.register(triggerRoutes, { ...services, prefix: '/api/trigger' });
  await fastify.register(workerRoutes, { ...services, prefix: '/api/workers' });
  await fastify.register(runRoutes, { ...services, prefix: '/api' });

  return fastify;
}

// Requeues or fails jobs whose worker went away. Returns a stop function.
export function startReaper(services) {
  const { cfg, scheduler, logger } = services;
  let running = false;

  const timer = setInterval(async () => {
    // Skip a tick rather than overlapping if a sweep runs long.
    if (running) return;
    running = true;
    try {
      await scheduler.reap();
    } catch (e) {
      logger.error?.(`reaper failed: ${e.message}`);
    } finally {
      running = false;
    }
  }, cfg.scheduler.reap_interval * 1000);

  timer.unref();
  return () => clearInterval(timer);
}
