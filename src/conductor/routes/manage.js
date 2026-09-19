// src/conductor/routes/manage.js - projects and workers, scoped by owner
//
// Any signed in user may register their own projects and their own workers.
// They see and act on what they own; administrators see and act on
// everything. A project with no owner belongs to the installation and is
// administrable only by an administrator.
//
// Secrets are write only throughout: a trigger secret, a worker token and a
// variable can each be set, but are returned exactly once, at the moment
// they are created.

import crypto from 'node:crypto';
import { requireUser } from '../../lib/auth/index.js';
import { VISIBILITIES, canManageProject } from '../../lib/projects.js';
import { canManageWorker } from '../../lib/workers.js';
import { PipelineError, DEFAULT_WORKDIR } from '../../lib/pipeline/index.js';

export default async function manageRoutes(fastify, services) {
  const { cfg, auth, projects, workerTokens, variables } = services;

  fastify.addHook('preHandler', requireUser(auth));

  const triggerUrl = (id) => `${cfg.server.public_url.replace(/\/+$/, '')}/api/trigger/${id}`;

  const asPublic = (p) => ({
    id: p.id,
    name: p.name,
    repo_url: p.repo_url,
    default_branch: p.default_branch,
    config_path: p.config_path,

    visibility: p.visibility,
    enabled: p.enabled === 1,
    owner_id: p.owner_id,
    // Null means the repository decides, and failing that the server.
    workdir: p.workdir ?? null,
    has_trigger_secret: Boolean(p.trigger_secret),
    run_count: p.run_counter,
    // Null means the server default applies, which the caller cannot see
    // from here; GET /api/retention reports what those defaults are.
    artifact_keep_runs: p.artifact_keep_runs ?? null,
    artifact_keep_days: p.artifact_keep_days ?? null,
    log_keep_days: p.log_keep_days ?? null,
    created_at: p.created_at,
  });

  // Loads a project and confirms the caller may act on it. Replies and
  // returns null when they may not.
  async function manageable(req, reply) {
    const project = await projects.get(req.params.id);
    if (!project) {
      reply.code(404).send({ error: 'unknown project' });
      return null;
    }
    if (!canManageProject(req.user, project)) {
      reply.code(403).send({ error: 'not yours to manage' });
      return null;
    }
    return project;
  }

  // --- projects ---

  fastify.get('/projects', async (req, reply) => {
    const rows = req.user.role === 'admin'
      ? await projects.list()
      : await projects.listOwnedBy(req.user.id);
    return reply.send({ projects: rows.map(asPublic) });
  });

  fastify.post('/projects', async (req, reply) => {
    const body = req.body ?? {};
    if (typeof body.repo_url !== 'string' || body.repo_url.length === 0) {
      return reply.code(400).send({ error: 'repo_url is required' });
    }
    if (body.visibility && !VISIBILITIES.includes(body.visibility)) {
      return reply.code(400).send({ error: `visibility must be one of ${VISIBILITIES.join(', ')}` });
    }

    // Generated when not supplied, because an unauthenticated trigger
    // endpoint is rarely what anyone actually wants.
    const secret = typeof body.trigger_secret === 'string' && body.trigger_secret.length > 0
      ? body.trigger_secret
      : crypto.randomBytes(24).toString('hex');

    // Only an administrator may hand a project to someone else, or create
    // one that belongs to the installation rather than a person.
    let owner = req.user.id;
    if (req.user.role === 'admin' && Object.hasOwn(body, 'owner_id')) owner = body.owner_id ?? null;

    try {
      const project = await projects.create({ ...body, owner_id: owner, trigger_secret: secret });
      return reply.code(201).send({
        project: asPublic(project),
        trigger_url: triggerUrl(project.id),
        trigger_secret: secret,
      });
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  fastify.get('/projects/:id', async (req, reply) => {
    const project = await manageable(req, reply);
    if (!project) return reply;
    return reply.send({ project: asPublic(project), trigger_url: triggerUrl(project.id) });
  });

  // What a null on a project means. Needed to render "inherited (30 days)"
  // rather than an empty box that looks like nothing is set.
  fastify.get('/retention', async (req, reply) => reply.send({
    defaults: {
      artifact_keep_runs: cfg.retention.artifact_keep_runs,
      artifact_keep_days: cfg.retention.artifact_keep_days,
      log_keep_days: cfg.retention.log_keep_days,
    },
    sweep_interval: cfg.retention.sweep_interval,
    workdir: DEFAULT_WORKDIR,
  }));

  fastify.patch('/projects/:id', async (req, reply) => {
    const project = await manageable(req, reply);
    if (!project) return reply;
    const body = req.body ?? {};

    try {
      if (typeof body.enabled === 'boolean') await projects.setEnabled(project.id, body.enabled);
      if (typeof body.visibility === 'string') await projects.setVisibility(project.id, body.visibility);
      if (Object.hasOwn(body, 'workdir')) await projects.setWorkdir(project.id, body.workdir);

      const retention = {};
      for (const key of ['artifact_keep_runs', 'artifact_keep_days', 'log_keep_days']) {
        if (Object.hasOwn(body, key)) retention[key] = body[key];
      }
      if (Object.keys(retention).length > 0) await projects.setRetention(project.id, retention);

      if (Object.hasOwn(body, 'owner_id')) {
        if (req.user.role !== 'admin') throw new Error('only an administrator may change the owner');
        await projects.setOwner(project.id, body.owner_id ?? null);
      }
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }

    return reply.send({ project: asPublic(await projects.get(project.id)) });
  });

  fastify.post('/projects/:id/trigger-secret', async (req, reply) => {
    const project = await manageable(req, reply);
    if (!project) return reply;

    const secret = typeof req.body?.secret === 'string' && req.body.secret.length > 0
      ? req.body.secret
      : crypto.randomBytes(24).toString('hex');

    await projects.setTriggerSecret(project.id, secret);
    return reply.send({ trigger_url: triggerUrl(project.id), trigger_secret: secret });
  });

  fastify.delete('/projects/:id', async (req, reply) => {
    const project = await manageable(req, reply);
    if (!project) return reply;
    // Runs, jobs and artifacts cascade with the project.
    await projects.remove(project.id);
    return reply.send({ deleted: project.id });
  });

  // --- project variables ---

  fastify.get('/projects/:id/variables', async (req, reply) => {
    const project = await manageable(req, reply);
    if (!project) return reply;
    return reply.send({ variables: await variables.list(project.id) });
  });

  fastify.put('/projects/:id/variables/:name', async (req, reply) => {
    const project = await manageable(req, reply);
    if (!project) return reply;
    if (!cfg.secrets.encryption_key) {
      req.log.warn('storing a project variable without secrets.encryption_key; it is kept in the clear');
    }

    const value = req.body?.value;
    if (typeof value !== 'string') return reply.code(400).send({ error: 'value must be a string' });

    try {
      const result = await variables.set(project.id, req.params.name, value, {
        masked: req.body?.masked !== false,
      });
      return reply.send({ variable: result });
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  fastify.delete('/projects/:id/variables/:name', async (req, reply) => {
    const project = await manageable(req, reply);
    if (!project) return reply;
    const removed = await variables.remove(project.id, req.params.name);
    if (!removed) return reply.code(404).send({ error: 'unknown variable' });
    return reply.send({ deleted: req.params.name });
  });

  // --- worker tokens ---

  fastify.get('/worker-tokens', async (req, reply) => {
    const rows = await workerTokens.listVisible(req.user);
    return reply.send({
      worker_tokens: rows.map((t) => ({
        id: t.id,
        name: t.name,
        enabled: t.enabled === 1,
        owner_id: t.owner_id,
        shared: t.owner_id === null,
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

    // A worker belongs to whoever registered it. Only an administrator may
    // create shared capacity, which runs any project.
    let owner = req.user.id;
    if (req.user.role === 'admin' && req.body?.shared === true) owner = null;

    const created = await workerTokens.create(name, { ownerId: owner });
    return reply.code(201).send({
      worker_token: { id: created.id, name: created.name, owner_id: owner, shared: owner === null },
      token: created.token,
      note: 'store this now; it cannot be shown again',
    });
  });

  fastify.patch('/worker-tokens/:id', async (req, reply) => {
    const token = await workerTokens.get(req.params.id);
    if (!token) return reply.code(404).send({ error: 'unknown worker token' });
    if (!canManageWorker(req.user, token)) return reply.code(403).send({ error: 'not yours to manage' });
    if (typeof req.body?.enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled must be a boolean' });
    }

    await workerTokens.setEnabled(token.id, req.body.enabled);
    return reply.send({ id: token.id, enabled: req.body.enabled });
  });

  fastify.delete('/worker-tokens/:id', async (req, reply) => {
    const token = await workerTokens.get(req.params.id);
    if (!token) return reply.code(404).send({ error: 'unknown worker token' });
    if (!canManageWorker(req.user, token)) return reply.code(403).send({ error: 'not yours to manage' });

    await workerTokens.remove(token.id);
    return reply.send({ deleted: token.id });
  });

  // --- runs ---

  // Loads a run whose project the caller may manage.
  async function manageableRun(req, reply) {
    const run = await services.db.get(
      'SELECT id, project_id, ref, base_sha, head_sha FROM runs WHERE id = {id}',
      { id: req.params.id }
    );
    if (!run) {
      reply.code(404).send({ error: 'unknown run' });
      return null;
    }
    const project = await projects.get(run.project_id);
    if (!canManageProject(req.user, project)) {
      reply.code(403).send({ error: 'not yours to manage' });
      return null;
    }
    return { run, project };
  }

  fastify.post('/runs/:id/cancel', async (req, reply) => {
    const found = await manageableRun(req, reply);
    if (!found) return reply;

    const result = await services.scheduler.cancelRun(found.run.id, `cancelled by ${req.user.username}`);
    if (!result.ok) return reply.code(409).send({ error: result.reason });
    return reply.send({ cancelled: found.run.id });
  });

  // Re-runs the same commit as a new run, rather than mutating history.
  fastify.post('/runs/:id/retry', async (req, reply) => {
    const found = await manageableRun(req, reply);
    if (!found) return reply;

    try {
      const created = await services.scheduler.createRun(found.project, {
        ref: found.run.ref,
        baseSha: found.run.base_sha,
        headSha: found.run.head_sha,
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
}
