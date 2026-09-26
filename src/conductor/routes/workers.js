// src/conductor/routes/workers.js - registering and inspecting workers
//
// routes/agent.js next door is the protocol the agents themselves speak.

import { ok } from './envelope.js';
import { identifies, requireUser } from './guard.js';
import { BadRequest, NotFound } from '../../lib/errors.js';
import { limitOf, offsetOfQuery, pageBlock, paginateOffset } from '../../lib/page.js';

export default async function workerRoutes(fastify, { cfg, auth, db, workerTokens }) {
  const base = cfg.server.public_url.replace(/\/+$/, '');
  identifies(fastify, auth);

  async function ownedWorker(req) {
    const user = requireUser(req);
    const worker = await workerTokens.get(req.params.id);
    if (!worker) throw new NotFound();
    if (user.role !== 'admin' && worker.owner_id !== user.id) throw new NotFound();
    return worker;
  }

  fastify.get('/workers', async (req, reply) => {
    const user = requireUser(req);
    const window = await workerTokens.pageVisible(user, {
      offset: offsetOfQuery(req.query),
      limit: limitOf(req.query),
    });
    return ok(reply, window.rows, pageBlock({ ...window, url: base + req.url }));
  });

  // The token is shown here and never again.
  fastify.post('/workers', async (req, reply) => {
    const user = requireUser(req);
    const { name, owner_id: ownerId } = req.body ?? {};
    if (typeof name !== 'string' || name.trim().length === 0) throw new BadRequest('a worker needs a name');

    const owner = user.role === 'admin' && ownerId !== undefined ? ownerId : user.id;
    const worker = await workerTokens.create(name.trim(), { ownerId: owner });
    return reply.code(201).send({ ok: true, data: worker });
  });

  fastify.get('/workers/:id', async (req, reply) => ok(reply, await ownedWorker(req)));

  fastify.patch('/workers/:id', async (req, reply) => {
    const worker = await ownedWorker(req);
    if (Object.hasOwn(req.body ?? {}, 'enabled')) {
      await workerTokens.setEnabled(worker.id, Boolean(req.body.enabled));
    }
    return ok(reply, await workerTokens.get(worker.id));
  });

  fastify.delete('/workers/:id', async (req, reply) => {
    const worker = await ownedWorker(req);
    await workerTokens.remove(worker.id);
    return ok(reply, { id: worker.id, removed: true });
  });

  fastify.get('/workers/:id/agents', async (req, reply) => {
    const worker = await ownedWorker(req);
    return ok(reply, await workerTokens.agentsFor(worker.id));
  });

  fastify.get('/workers/:id/tasks', async (req, reply) => {
    const worker = await ownedWorker(req);
    const window = await paginateOffset(db, {
      select: `t.id, t.name, t.state, t.arch, t.attempt, t.exit_code, t.worker_name,
               t.created_at, t.started_at, t.finished_at, t.job_id, j.project_id`,
      from: 'tasks t JOIN jobs j ON j.id = t.job_id',
      where: 't.worker_token_id = {worker}',
      order: 't.created_at DESC',
      params: { worker: worker.id },
      offset: offsetOfQuery(req.query),
      limit: limitOf(req.query),
    });

    return ok(reply, window.rows, pageBlock({ ...window, url: base + req.url }));
  });
}
