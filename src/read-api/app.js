// src/read-api/app.js - the public read surface
//
// Deliberately a separate service. It opens the same database but mounts
// only the read routes, so the trigger, worker and admin surfaces are not
// reachable on a port exposed to the internet. Nothing here can change
// state, which is a property of what is mounted rather than of a check that
// somebody has to remember to write.
//
// The schema belongs to the conductor, so this never runs migrations.

import Fastify from 'fastify';
import cors from '@fastify/cors';

import { openDatabase } from '../lib/db/index.js';
import { createStorage } from '../lib/storage/index.js';
import { createLogStore } from '../lib/log.js';
import runRoutes from '../conductor/routes/runs.js';
import staticRoutes from '../lib/static.js';

export async function createReadServices(cfg) {
  const db = await openDatabase(cfg);

  // Fail at startup with something actionable rather than on the first
  // request with a bare SQL error.
  try {
    await db.get('SELECT 1 FROM runs LIMIT 1');
  } catch (e) {
    await db.close();
    throw new Error(
      'the conductor schema is missing or unreadable. Start the conductor first, ' +
      `or run npm run migrate.\n  ${e.message}`,
      { cause: e }
    );
  }

  return {
    cfg,
    db,
    storage: createStorage(cfg),
    logs: createLogStore(cfg),
  };
}

export async function buildReadServer(services, options = {}) {
  const { cfg } = services;
  const fastify = Fastify({
    logger: options.logger ?? { level: process.env.LOG_LEVEL || 'info' },
    trustProxy: options.trustProxy ?? true,
  });

  await fastify.register(cors, { origin: true });

  fastify.get('/health', async () => ({
    ok: true,
    service: 'read-api',
    database: services.db.dialect,
    storage: services.storage.driver,
  }));

  await fastify.register(runRoutes, { ...services, prefix: '/api' });

  if (options.dashboard !== false) {
    await fastify.register(staticRoutes, {});
  }

  return fastify;
}
