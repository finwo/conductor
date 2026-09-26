// src/conductor/routes/api.js - everything served under /api/v1
//
// Fastify allows one not-found handler per prefix, so something has to own
// the scope these share. workerRoutes and taskRoutes overlap on
// /api/v1/tasks deliberately: the worker token hook covers its own plugin
// entirely, and reading a task back is not behind it.

import agentRoutes from './agent.js';
import artifactRoutes from './artifacts.js';
import jobRoutes from './jobs.js';
import projectRoutes from './projects.js';
import sessionRoutes from './session.js';
import taskRoutes from './tasks.js';
import userRoutes from './users.js';
import workerRoutes from './workers.js';
import { envelopeFailures } from './envelope.js';

// prefix is dropped rather than passed on: it applied when this plugin was
// registered, and handing it to the children would apply it a second time.
export default async function apiRoutes(fastify, { prefix, ...services }) {
  envelopeFailures(fastify);

  await fastify.register(jobRoutes, services);
  await fastify.register(agentRoutes, services);
  await fastify.register(taskRoutes, services);
  await fastify.register(artifactRoutes, services);
  await fastify.register(sessionRoutes, services);
  await fastify.register(projectRoutes, services);
  await fastify.register(workerRoutes, services);
  await fastify.register(userRoutes, services);
}
