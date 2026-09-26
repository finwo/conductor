// src/conductor/routes/projects.js - managing projects and their variables

import { ok } from './envelope.js';
import { identifies, requireUser, requireAdmin } from './guard.js';
import { BadRequest, Conflict, NotFound, NotPermitted } from '../../lib/errors.js';
import { canManageProject, canViewProject, VISIBILITIES } from '../../lib/projects.js';
import { limitOf, offsetOfQuery, pageBlock } from '../../lib/page.js';
import { newToken } from '../../lib/ids.js';

const RETENTION = ['artifact_keep_jobs', 'artifact_keep_days', 'log_keep_days'];

function present(project) {
  const { trigger_secret: secret, ...rest } = project;
  return { ...rest, has_trigger_secret: secret !== null };
}

export default async function projectRoutes(fastify, { cfg, auth, projects, variables }) {
  const base = cfg.server.public_url.replace(/\/+$/, '');
  identifies(fastify, auth);

  // Missing rather than refused, so an id cannot be probed by status code.
  async function readable(req) {
    const project = await projects.get(req.params.id);
    if (!project || !canViewProject(req.user, project)) throw new NotFound();
    return project;
  }

  async function manageable(req) {
    const project = await projects.get(req.params.id);
    if (!project || !canViewProject(req.user, project)) throw new NotFound();
    if (!canManageProject(req.user, project)) throw new NotPermitted();
    return project;
  }

  fastify.get('/projects', async (req, reply) => {
    const window = await projects.pageVisible(req.user, {
      offset: offsetOfQuery(req.query),
      limit: limitOf(req.query),
    });
    return ok(reply, window.rows.map(present), pageBlock({ ...window, url: base + req.url }));
  });

  // The trigger secret is shown here and never again.
  fastify.post('/projects', async (req, reply) => {
    const user = requireUser(req);
    const body = req.body ?? {};

    const owner = user.role === 'admin' && Object.hasOwn(body, 'owner_id') ? body.owner_id : user.id;
    const secret = body.trigger_secret === null ? null : (body.trigger_secret || newToken());

    let project;
    try {
      project = await projects.create({ ...body, owner_id: owner, trigger_secret: secret });
    } catch (e) {
      throw /already exists/.test(e.message) ? new Conflict(e.message) : new BadRequest(e.message);
    }

    return reply.code(201).send({ ok: true, data: { ...present(project), trigger_secret: secret } });
  });

  fastify.get('/projects/:id', async (req, reply) => ok(reply, present(await readable(req))));

  fastify.patch('/projects/:id', async (req, reply) => {
    const project = await manageable(req);
    const body = req.body ?? {};

    try {
      if (Object.hasOwn(body, 'visibility')) {
        if (!VISIBILITIES.includes(body.visibility)) {
          throw new BadRequest(`visibility must be one of ${VISIBILITIES.join(', ')}`);
        }
        await projects.setVisibility(project.id, body.visibility);
      }
      if (Object.hasOwn(body, 'enabled')) await projects.setEnabled(project.id, Boolean(body.enabled));
      if (Object.hasOwn(body, 'workdir')) await projects.setWorkdir(project.id, body.workdir);

      // Null follows the server default, zero keeps forever. Not the same.
      const retention = {};
      for (const key of RETENTION) if (Object.hasOwn(body, key)) retention[key] = body[key];
      if (Object.keys(retention).length > 0) await projects.setRetention(project.id, retention);

      if (Object.hasOwn(body, 'owner_id')) {
        requireAdmin(req);
        await projects.setOwner(project.id, body.owner_id);
      }
    } catch (e) {
      if (e.name === 'BadRequest' || e.name === 'NotPermitted') throw e;
      throw new BadRequest(e.message);
    }

    return ok(reply, present(await projects.get(project.id)));
  });

  fastify.delete('/projects/:id', async (req, reply) => {
    const project = await manageable(req);
    await projects.remove(project.id);
    return ok(reply, { id: project.id, removed: true });
  });

  fastify.post('/projects/:id/trigger-secret', async (req, reply) => {
    const project = await manageable(req);
    const secret = newToken();
    await projects.setTriggerSecret(project.id, secret);
    return ok(reply, { id: project.id, trigger_secret: secret });
  });

  fastify.get('/projects/:id/variables', async (req, reply) => {
    const project = await manageable(req);
    return ok(reply, await variables.list(project.id));
  });

  fastify.put('/projects/:id/variables/:name', async (req, reply) => {
    const project = await manageable(req);
    const body = req.body ?? {};
    try {
      const saved = await variables.set(project.id, req.params.name, body.value, {
        masked: body.masked !== false,
      });
      return ok(reply, saved);
    } catch (e) {
      throw new BadRequest(e.message);
    }
  });

  fastify.delete('/projects/:id/variables/:name', async (req, reply) => {
    const project = await manageable(req);
    if (!await variables.remove(project.id, req.params.name)) throw new NotFound();
    return ok(reply, { name: req.params.name, removed: true });
  });
}
