// src/conductor/routes/tasks.js - reading a task back
//
// A task is the standalone unit a worker runs, and this is how everyone who
// is not that worker looks at one: its state, and the artifacts it stored.
// routes/workers.js holds the protocol the worker itself speaks, behind a
// worker token. These two files share a URL prefix and nothing else, which
// is why they are separate plugins: the token hook over there covers its
// whole scope, and must not reach these routes.
//
// Two paths, one answer:
//
//   GET /tasks/:task                    a task id is unique on its own
//   GET /projects/:project/tasks/:task  the same task, said in full
//
// They differ only in what may reach a private task. A task id is enough to
// prove nothing, so the bare path accepts a public task or a session that
// may manage the project. The scoped path can look up the project's trigger
// secret, so it also accepts a signature, matching the job read-back it sits
// beside: one credential covers starting a build, watching the job and
// reading any task in it.
//
// Absent and forbidden are both 404, so neither can be used to find out
// which tasks exist.
//
// What is deliberately not here: the task's environment, and its services,
// which carry an environment of their own. Both can hold project variables,
// and a public job is still built from a repository that may be private. The
// script is left out for the same reason. What remains describes what the
// task was and how it went, which is what a caller asking after a task is
// actually asking.

import { canManageProject } from '../../lib/projects.js';
import { verifySignature } from '../../lib/signature.js';
import { ok } from './envelope.js';
import { UnknownTask } from '../../lib/errors.js';
import { outputAad } from '../../lib/outputs.js';
import { limitOf, offsetOfQuery, pageBlock, paginateOffset } from '../../lib/page.js';

export default async function taskRoutes(fastify, { cfg, db, projects, secrets, auth = null }) {
  const base = cfg.server.public_url.replace(/\/+$/, '');

  // Explicit columns rather than t.*, which would pull spec and
  // worker_token_id into scope and leave one careless spread away from
  // publishing them.
  const TASK_QUERY = `
    SELECT t.id, t.name, t.base_name, t.state, t.arch, t.image,
           t.attempt, t.max_attempts, t.allow_failure, t.exit_code, t.error,
           t.worker_name, t.timeout, t.spec, t.log_size,
           t.created_at, t.started_at, t.finished_at,
           j.id AS job_id, j.number AS job_number, j.ref, j.head_sha,
           j.visibility, j.project_id
      FROM tasks t
      JOIN jobs j ON j.id = t.job_id`;

  async function currentUser(req) {
    if (!auth) return null;
    try {
      return await auth.identify(req);
    } catch {
      return null;
    }
  }

  // Names always, values only where the task said they could be shown.
  async function readOutputs(taskId) {
    const rows = await db.all(
      'SELECT task_id, name, value, masked FROM task_outputs WHERE task_id = {task} ORDER BY name',
      { task: taskId }
    );
    return rows.map((row) => {
      const masked = row.masked === 1;
      let value = null;
      if (!masked) {
        try {
          value = secrets.open(row.value, outputAad(row.task_id, row.name));
        } catch {
          value = null;
        }
      }
      return { name: row.name, masked, value };
    });
  }

  // Everything a caller is allowed to see, assembled once so the two routes
  // cannot drift into answering differently.
  async function represent(req, reply, row) {
    const spec = readSpec(row.spec);

    const outputs = await readOutputs(row.id);

    const artifacts = await paginateOffset(db, {
      select: 'id, path, size, sha256, created_at, expires_at',
      from: 'artifacts',
      where: 'task_id = {task}',
      order: 'path',
      params: { task: row.id },
      offset: offsetOfQuery(req.query),
      limit: limitOf(req.query),
    });

    return ok(reply, {
      task: {
        id: row.id,
        name: row.name,
        base_name: row.base_name,
        state: row.state,
        arch: row.arch,
        image: row.image,
        attempt: row.attempt,
        max_attempts: row.max_attempts,
        allow_failure: row.allow_failure === 1,
        exit_code: row.exit_code,
        error: row.error,
        worker_name: row.worker_name,
        timeout: row.timeout,
        // Settled when the job was created, so it is what the task ran in
        // rather than what the pipeline says today.
        workdir: spec.workdir,
        needs: spec.needs,
        after: spec.after,
        matrix: spec.matrix,
        // What the task was told to collect, which is not the same as what
        // it managed to store. The list below is what exists.
        artifact_paths: spec.artifactPaths,
        outputs,
        log_size: row.log_size,
        created_at: row.created_at,
        started_at: row.started_at,
        finished_at: row.finished_at,
        project_id: row.project_id,
        job_id: row.job_id,
        job_number: row.job_number,
        ref: row.ref,
        sha: row.head_sha,
        visibility: row.visibility,
      },
      artifacts: artifacts.rows.map((a) => ({
        id: a.id,
        path: a.path,
        size: a.size,
        sha256: a.sha256,
        created_at: a.created_at,
        expires_at: a.expires_at,
        // Ready to fetch. The download route checks visibility again for
        // itself, so this is a convenience and not the permission.
        url: `${base}/api/v1/projects/${encodeURIComponent(row.project_id)}/jobs/${row.job_id}`
          + `/tasks/${row.id}/artifacts/${a.id}`,
      })),
    }, pageBlock({ ...artifacts, url: base + req.url }));
  }

  // A task id is unique by itself, so the project need not be named. Without
  // one there is no trigger secret to check against, leaving a public task
  // or a session that may manage the project.
  fastify.get('/tasks/:task', async (req, reply) => {
    const row = await db.get(`${TASK_QUERY} WHERE t.id = {id}`, { id: req.params.task });
    if (!row) throw new UnknownTask();

    if (row.visibility !== 'public') {
      const project = await projects.get(row.project_id);
      if (!canManageProject(await currentUser(req), project)) throw new UnknownTask();
    }

    return represent(req, reply, row);
  });

  // The same task named in full. The project in the path must be the one the
  // task belongs to, so a guessed id cannot be read through a project that
  // happens to be readable.
  fastify.get('/projects/:project/tasks/:task', async (req, reply) => {
    const project = await projects.get(req.params.project);
    if (!project) throw new UnknownTask();

    const row = await db.get(
      `${TASK_QUERY} WHERE t.id = {id} AND j.project_id = {project}`,
      { id: req.params.task, project: project.id }
    );
    if (!row) throw new UnknownTask();

    if (row.visibility !== 'public' && !(await mayRead(req, project))) throw new UnknownTask();

    return represent(req, reply, row);
  });

  async function mayRead(req, project) {
    const secret = projects.triggerSecret(project);
    if (secret && verifySignature(req, secret)) return true;

    return canManageProject(await currentUser(req), project);
  }
}

// The stored spec, reduced to the keys that are safe to publish. env and
// services are never read: both can carry project variables.
//
// A spec that will not parse is not this request's problem, and reporting
// the task without its detail beats refusing to report it at all.
function readSpec(raw) {
  let spec;
  try {
    spec = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    spec = null;
  }
  if (!spec || typeof spec !== 'object') {
    return { workdir: null, needs: [], after: [], matrix: {}, artifactPaths: [] };
  }

  const paths = spec.artifacts?.paths;
  return {
    workdir: typeof spec.workdir === 'string' ? spec.workdir : null,
    needs: Array.isArray(spec.needs) ? spec.needs : [],
    after: Array.isArray(spec.after) ? spec.after : [],
    matrix: spec.matrix && typeof spec.matrix === 'object' ? spec.matrix : {},
    artifactPaths: Array.isArray(paths) ? paths : [],
  };
}
