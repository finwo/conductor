// src/conductor/routes/artifacts.js - artifact downloads
//
// The one read endpoint that is not the interface: the task page links here,
// so a browser can download build output without the conductor proxying the
// bytes when the store can presign them.
//
// Visibility matches the interface: a public job is downloadable by anyone,
// a private one by its owner or an administrator. The project, job and task
// in the path must all agree with the artifact, so a guessed identifier
// cannot reach anything.

import { StorageNotFound } from '../../lib/storage/index.js';

export default async function artifactRoutes(fastify, { db, storage, auth = null }) {
  async function currentUser(req) {
    if (!auth) return null;
    try {
      return await auth.identify(req);
    } catch {
      return null;
    }
  }

  function scope(user) {
    if (user && user.role === 'admin') return { sql: '1 = 1', params: {} };
    if (user) {
      return {
        sql: "(j.visibility = 'public' OR p.owner_id = {viewerId})",
        params: { viewerId: user.id },
      };
    }
    return { sql: "j.visibility = 'public'", params: {} };
  }

  fastify.get('/projects/:project/jobs/:job/tasks/:task/artifacts/:artifact', async (req, reply) => {
    const visible = scope(await currentUser(req));
    const artifact = await db.get(
      `SELECT a.id, a.path, a.storage_key, a.size
         FROM artifacts a
         JOIN tasks t ON t.id = a.task_id
         JOIN jobs j ON j.id = a.job_id
         JOIN projects p ON p.id = j.project_id
        WHERE a.id = {id}
          AND a.task_id = {task} AND a.job_id = {job} AND j.project_id = {project}
          AND ${visible.sql}`,
      {
        id: req.params.artifact,
        task: req.params.task,
        job: req.params.job,
        project: req.params.project,
        ...visible.params,
      }
    );
    if (!artifact) return reply.code(404).send({ error: 'unknown artifact' });

    // Hand the client straight to the object store when that is possible.
    const url = await storage.presign(artifact.storage_key, { expires: 300 });
    if (url) return reply.redirect(url, 302);

    try {
      const object = await storage.get(artifact.storage_key);
      reply.header('content-type', 'application/octet-stream');
      reply.header('content-length', String(artifact.size));
      reply.header('content-disposition', `attachment; filename="${encodeURIComponent(basename(artifact.path))}"`);
      return reply.send(object.stream);
    } catch (e) {
      if (e instanceof StorageNotFound) return reply.code(404).send({ error: 'artifact is no longer stored' });
      throw e;
    }
  });
}

function basename(p) {
  return p.split('/').pop() || 'artifact';
}
