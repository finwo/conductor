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
import { createUsers } from '../lib/users.js';
import { createVariables } from '../lib/variables.js';
import { createAuth } from '../lib/auth/index.js';
import { createScheduler } from './scheduler.js';
import { createRetention } from './retention.js';

import workerRoutes from './routes/workers.js';
import triggerRoutes from './routes/trigger.js';
import artifactRoutes from './routes/artifacts.js';
import uiRoutes from './ui/routes.js';
import staticRoutes from '../lib/static.js';

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
  const logger = options.logger ?? console;

  const projects = createProjects({ db, secrets });
  const workerTokens = createWorkerTokens({ db });
  const variables = createVariables({ db, secrets });
  const users = createUsers({ db, logger });
  const auth = createAuth({ cfg, users, logger });

  const scheduler = createScheduler({ cfg, db, git, logs, storage, projects, variables, logger });
  const retention = createRetention({ cfg, db, storage, logs, logger });

  // Without a first administrator there is no way into the admin surface.
  // Only done for local accounts; with OIDC the provider owns identity.
  if (options.bootstrap !== false && auth.localLogin) {
    await users.bootstrap(cfg);
  }

  return {
    cfg, db, secrets, storage, logs, git,
    projects, workerTokens, variables, users, auth, scheduler, retention, logger,
  };
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

  // The only HTTP surface besides the interface: the trigger edge, the
  // worker edge, and artifact downloads. Everything else is the UI.
  await fastify.register(triggerRoutes, { ...services, prefix: '/api/v1' });
  await fastify.register(workerRoutes, { ...services, prefix: '/api/v1' });
  await fastify.register(artifactRoutes, { ...services, prefix: '/api/v1' });

  // Signing in, managing projects and registering workers all happen in the
  // interface; there is no separate management API.
  if (options.ui !== false) {
    await fastify.register(staticRoutes, {});
    await fastify.register(uiRoutes, { ...services });
  }

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

// Deletes artifacts and logs past their retention. Returns a stop function.
export function startRetention(services) {
  const { cfg, retention, logger } = services;
  let running = false;

  const timer = setInterval(async () => {
    // A sweep over a large backlog can outlast its interval, and running
    // two at once would have them fight over the same rows.
    if (running) return;
    running = true;
    try {
      await retention.sweep();
    } catch (e) {
      logger.error?.(`retention sweep failed: ${e.message}`);
    } finally {
      running = false;
    }
  }, cfg.retention.sweep_interval * 1000);

  timer.unref();
  return () => clearInterval(timer);
}
