// src/read-api/index.js - read-api entry point
//
// Serves the public read surface and the dashboard. Safe to expose without
// a reverse proxy in front of the write surface, because the write routes
// are not registered here at all.

import { loadConfig } from '../lib/config.js';
import { createReadServices, buildReadServer } from './app.js';

const cfg = loadConfig();
const services = await createReadServices(cfg);
const fastify = await buildReadServer(services);

async function shutdown(signal) {
  fastify.log.info(`${signal} received, shutting down`);
  try {
    await fastify.close();
    await services.db.close();
  } catch (e) {
    fastify.log.error({ err: e }, 'shutdown failed');
    process.exitCode = 1;
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { shutdown(signal); });
}

await fastify.listen({ port: cfg.read_api.port, host: cfg.read_api.host });
