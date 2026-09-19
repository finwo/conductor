// src/conductor/routes/admin.js - installation wide administration
//
// What is left here is genuinely administrator only: user accounts. Project
// and worker management moved to routes/manage.js, where any signed in user
// can act on what they own.

import { requireAdmin } from '../../lib/auth/index.js';
import { ROLES } from '../../lib/users.js';

export default async function adminRoutes(fastify, services) {
  const { db, auth, users } = services;

  fastify.addHook('preHandler', requireAdmin(auth));

  fastify.get('/users', async (req, reply) => {
    const rows = await users.list();
    return reply.send({
      users: rows.map((u) => ({ ...u, disabled: u.disabled === 1 })),
      // Local accounts are inert when the provider issues the tokens.
      active: auth.localLogin,
    });
  });

  fastify.post('/users', async (req, reply) => {
    try {
      return reply.code(201).send({ user: await users.create(req.body ?? {}) });
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  fastify.patch('/users/:id', async (req, reply) => {
    const user = await users.get(req.params.id);
    if (!user) return reply.code(404).send({ error: 'unknown user' });
    const body = req.body ?? {};

    try {
      if (typeof body.password === 'string') await users.setPassword(user.id, body.password);

      if (typeof body.role === 'string') {
        if (!ROLES.includes(body.role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
        // Refuse to remove the last administrator, which would lock
        // everyone out of this surface.
        if (user.role === 'admin' && body.role !== 'admin' && await lastAdmin(user.id)) {
          throw new Error('this is the only administrator; promote another account first');
        }
        await users.setRole(user.id, body.role);
      }

      if (typeof body.disabled === 'boolean') {
        if (body.disabled && user.role === 'admin' && await lastAdmin(user.id)) {
          throw new Error('this is the only administrator; promote another account first');
        }
        await users.setDisabled(user.id, body.disabled);
      }
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }

    return reply.send({ user: await users.get(user.id) });
  });

  // Reports what removing an account would destroy, so a caller can warn
  // before doing it.
  fastify.get('/users/:id/impact', async (req, reply) => {
    const user = await users.get(req.params.id);
    if (!user) return reply.code(404).send({ error: 'unknown user' });
    return reply.send({ user, ...(await impactOf(user.id)) });
  });

  fastify.delete('/users/:id', async (req, reply) => {
    const user = await users.get(req.params.id);
    if (!user) return reply.code(404).send({ error: 'unknown user' });
    if (user.role === 'admin' && await lastAdmin(user.id)) {
      return reply.code(400).send({ error: 'this is the only administrator; promote another account first' });
    }

    // Everything they owned goes with them: projects cascade on to their
    // runs, jobs and artifacts, and their worker tokens are removed.
    // Leaving either behind would be worse than losing it, since an
    // unowned worker token is shared capacity that accepts any project.
    const impact = await impactOf(user.id);
    await users.remove(user.id);
    return reply.send({ deleted: user.id, ...impact });
  });

  async function impactOf(userId) {
    const projects = await db.all('SELECT id FROM projects WHERE owner_id = {id}', { id: userId });
    const runs = await db.get(
      `SELECT COUNT(*) AS c FROM runs r
         JOIN projects p ON p.id = r.project_id WHERE p.owner_id = {id}`,
      { id: userId }
    );
    const tokens = await db.get(
      'SELECT COUNT(*) AS c FROM worker_tokens WHERE owner_id = {id}', { id: userId }
    );
    return {
      projects: projects.map((p) => p.id),
      runs_deleted: runs.c,
      worker_tokens_deleted: tokens.c,
    };
  }

  async function lastAdmin(exceptId) {
    const row = await db.get(
      "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0 AND id <> {id}",
      { id: exceptId }
    );
    return row.c === 0;
  }
}
