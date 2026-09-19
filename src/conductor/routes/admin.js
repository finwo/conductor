// src/conductor/routes/admin.js - administration
//
// Every route here requires the admin role. Secrets are write only: a
// trigger secret or a variable can be set and replaced, but never read
// back, and a worker token is returned exactly once when it is created.

import crypto from 'node:crypto';
import { requireAdmin } from '../../lib/auth/index.js';
import { SOURCE_MODES } from '../../lib/projects.js';
import { ROLES } from '../../lib/users.js';
import { PipelineError } from '../../lib/pipeline/index.js';

export default async function adminRoutes(fastify, services) {
  const { cfg, db, auth, users, projects, workerTokens, variables, scheduler } = services;

  fastify.addHook('preHandler', requireAdmin(auth));

  const triggerUrl = (id) => `${cfg.server.public_url.replace(/\/+$/, '')}/api/trigger/${id}`;

  // --- projects ---

  fastify.get('/projects', async (req, reply) => {
    const rows = await projects.list();
    return reply.send({
      projects: rows.map((p) => ({
        id: p.id,
        name: p.name,
        repo_url: p.repo_url,
        default_branch: p.default_branch,
        config_path: p.config_path,
        source_mode: p.source_mode,
        enabled: p.enabled === 1,
        // Whether a secret is set, never the secret itself.
        has_trigger_secret: Boolean(p.trigger_secret),
        run_count: p.run_counter,
        created_at: p.created_at,
      })),
    });
  });

  fastify.post('/projects', async (req, reply) => {
    const body = req.body ?? {};
    if (typeof body.repo_url !== 'string' || body.repo_url.length === 0) {
      return reply.code(400).send({ error: 'repo_url is required' });
    }
    if (body.source_mode && !SOURCE_MODES.includes(body.source_mode)) {
      return reply.code(400).send({ error: `source_mode must be one of ${SOURCE_MODES.join(', ')}` });
    }

    // Generated when not supplied, because an unauthenticated trigger
    // endpoint is rarely what anyone actually wants.
    const secret = typeof body.trigger_secret === 'string' && body.trigger_secret.length > 0
      ? body.trigger_secret
      : crypto.randomBytes(24).toString('hex');

    try {
      const project = await projects.create({ ...body, trigger_secret: secret });
      return reply.code(201).send({
        project: { id: project.id, name: project.name, repo_url: project.repo_url },
        trigger_url: triggerUrl(project.id),
        // Shown once.
        trigger_secret: secret,
      });
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  fastify.patch('/projects/:id', async (req, reply) => {
    const project = await projects.get(req.params.id);
    if (!project) return reply.code(404).send({ error: 'unknown project' });

    const body = req.body ?? {};
    if (typeof body.enabled === 'boolean') await projects.setEnabled(project.id, body.enabled);
    return reply.send({ project: { ...(await projects.get(project.id)), trigger_secret: undefined } });
  });

  fastify.post('/projects/:id/trigger-secret', async (req, reply) => {
    const project = await projects.get(req.params.id);
    if (!project) return reply.code(404).send({ error: 'unknown project' });

    const secret = typeof req.body?.secret === 'string' && req.body.secret.length > 0
      ? req.body.secret
      : crypto.randomBytes(24).toString('hex');

    await projects.setTriggerSecret(project.id, secret);
    return reply.send({ trigger_url: triggerUrl(project.id), trigger_secret: secret });
  });

  fastify.delete('/projects/:id', async (req, reply) => {
    const project = await projects.get(req.params.id);
    if (!project) return reply.code(404).send({ error: 'unknown project' });
    // Runs, jobs and artifacts cascade with the project.
    await projects.remove(project.id);
    return reply.send({ deleted: project.id });
  });

  // --- project variables ---

  fastify.get('/projects/:id/variables', async (req, reply) => {
    if (!(await projects.get(req.params.id))) return reply.code(404).send({ error: 'unknown project' });
    return reply.send({ variables: await variables.list(req.params.id) });
  });

  fastify.put('/projects/:id/variables/:name', async (req, reply) => {
    if (!(await projects.get(req.params.id))) return reply.code(404).send({ error: 'unknown project' });
    if (!cfg.secrets.encryption_key) {
      req.log.warn('storing a project variable without secrets.encryption_key; it is kept in the clear');
    }

    const value = req.body?.value;
    if (typeof value !== 'string') return reply.code(400).send({ error: 'value must be a string' });

    try {
      const result = await variables.set(req.params.id, req.params.name, value, {
        masked: req.body?.masked !== false,
      });
      return reply.send({ variable: result });
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  fastify.delete('/projects/:id/variables/:name', async (req, reply) => {
    const removed = await variables.remove(req.params.id, req.params.name);
    if (!removed) return reply.code(404).send({ error: 'unknown variable' });
    return reply.send({ deleted: req.params.name });
  });

  // --- worker tokens ---

  fastify.get('/worker-tokens', async (req, reply) => {
    const rows = await workerTokens.list();
    return reply.send({
      worker_tokens: rows.map((t) => ({
        id: t.id,
        name: t.name,
        enabled: t.enabled === 1,
        created_at: t.created_at,
        last_seen_at: t.last_seen_at,
        last_ip: t.last_ip,
      })),
    });
  });

  fastify.post('/worker-tokens', async (req, reply) => {
    const name = req.body?.name;
    if (typeof name !== 'string' || name.length === 0) {
      return reply.code(400).send({ error: 'name is required' });
    }
    const created = await workerTokens.create(name);
    return reply.code(201).send({
      worker_token: { id: created.id, name: created.name },
      // Only time the plaintext exists outside the worker.
      token: created.token,
      note: 'store this now; it cannot be shown again',
    });
  });

  fastify.patch('/worker-tokens/:id', async (req, reply) => {
    if (typeof req.body?.enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled must be a boolean' });
    }
    const ok = await workerTokens.setEnabled(req.params.id, req.body.enabled);
    if (!ok) return reply.code(404).send({ error: 'unknown worker token' });
    return reply.send({ id: req.params.id, enabled: req.body.enabled });
  });

  fastify.delete('/worker-tokens/:id', async (req, reply) => {
    const ok = await workerTokens.remove(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'unknown worker token' });
    return reply.send({ deleted: req.params.id });
  });

  // --- users ---

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
      const user = await users.create(req.body ?? {});
      return reply.code(201).send({ user });
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

  fastify.delete('/users/:id', async (req, reply) => {
    const user = await users.get(req.params.id);
    if (!user) return reply.code(404).send({ error: 'unknown user' });
    if (user.role === 'admin' && await lastAdmin(user.id)) {
      return reply.code(400).send({ error: 'this is the only administrator; promote another account first' });
    }
    await users.remove(user.id);
    return reply.send({ deleted: user.id });
  });

  // --- runs ---

  fastify.post('/runs/:id/cancel', async (req, reply) => {
    const result = await scheduler.cancelRun(req.params.id, `cancelled by ${req.user.username}`);
    if (!result.ok) return reply.code(409).send({ error: result.reason });
    return reply.send({ cancelled: req.params.id });
  });

  // Re-runs the same commit as a new run, rather than mutating history.
  fastify.post('/runs/:id/retry', async (req, reply) => {
    const run = await db.get('SELECT id, project_id, ref, base_sha, head_sha FROM runs WHERE id = {id}',
      { id: req.params.id });
    if (!run) return reply.code(404).send({ error: 'unknown run' });

    const project = await projects.get(run.project_id);
    if (!project) return reply.code(404).send({ error: 'unknown project' });

    try {
      const created = await scheduler.createRun(project, {
        ref: run.ref,
        baseSha: run.base_sha,
        headSha: run.head_sha,
        trigger: 'manual',
        actor: req.user.username,
      });
      return reply.code(201).send({ run_id: created.runId, jobs: created.jobCount });
    } catch (e) {
      if (e instanceof PipelineError) {
        return reply.code(422).send({ error: 'invalid pipeline', detail: e.message, problems: e.errors });
      }
      return reply.code(500).send({ error: String(e.message ?? e) });
    }
  });

  async function lastAdmin(exceptId) {
    const row = await db.get(
      "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0 AND id <> {id}",
      { id: exceptId }
    );
    return row.c === 0;
  }
}
