// src/conductor/routes/artifacts.js - artifact downloads
//
// The project, job and task in the path must all agree with the artifact, so
// a guessed identifier cannot reach anything.

import { StorageNotFound } from '../../lib/storage/index.js';
import { ArtifactNotStored, UnknownArtifact } from '../../lib/errors.js';
import { visibleSql } from '../../lib/visibility.js';
import { identifies } from './guard.js';

export default async function artifactRoutes(fastify, { db, storage, auth = null }) {
  identifies(fastify, auth);

  fastify.get('/projects/:project/jobs/:job/tasks/:task/artifacts/:artifact', async (req, reply) => {
    const visible = visibleSql(req.user, { visibility: 'j.visibility', owner: 'p.owner_id' });
    const artifact = await db.get(
      `SELECT a.id, a.path, a.storage_key, a.size
         FROM artifacts a
         JOIN tasks t ON t.id = a.task_id
         JOIN jobs j ON j.id = a.job_id
         JOIN projects p ON p.id = j.project_id
        WHERE a.id = {id}
          AND a.task_id = {task} AND a.job_id = {job} AND j.project_id = {project}
          AND ${visible.where}`,
      {
        id: req.params.artifact,
        task: req.params.task,
        job: req.params.job,
        project: req.params.project,
        ...visible.params,
      }
    );
    if (!artifact) throw new UnknownArtifact();

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
      if (e instanceof StorageNotFound) throw new ArtifactNotStored();
      throw e;
    }
  });
}

function basename(p) {
  return p.split('/').pop() || 'artifact';
}
