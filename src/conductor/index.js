// src/conductor/index.js - conductor entry point
//
// The write side: accepts triggers, schedules runs, and serves the worker
// API. Run the read-api separately when the public read surface should not
// sit on the same port as the write surface.

import { loadConfig } from '../lib/config.js';
import { createServices, buildServer, startReaper } from './app.js';

const cfg = loadConfig();
const services = await createServices(cfg);
const fastify = await buildServer(services);

if (cfg.auth.session_secret_ephemeral) {
  fastify.log.warn('auth.session_secret is unset; a random one was generated and sessions will not survive a restart');
}
if (!cfg.secrets.encryption_key) {
  fastify.log.warn('secrets.encryption_key is unset; stored secrets are kept in the clear');
}

const stopReaper = startReaper({ ...services, logger: fastify.log });

async function shutdown(signal) {
  fastify.log.info(`${signal} received, shutting down`);
  stopReaper();
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

await fastify.listen({ port: cfg.server.port, host: cfg.server.host });
