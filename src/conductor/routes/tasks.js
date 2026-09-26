// src/conductor/routes/tasks.js - reading a task back
//
//   GET /tasks/:task                    a task id is unique on its own
//   GET /projects/:project/tasks/:task  the same task, project asserted
//
// The worker protocol lives in routes/agent.js, a separate plugin so its
// worker-token hook cannot reach these routes.
//
// A public task reads without a session; a private one needs a session that
// may manage the project. Absent and forbidden are both 404.
//
// env, services and script are deliberately omitted: all three can carry
// project variables, and a public job may be built from a private repository.

import { canManageProject } from '../../lib/projects.js';
import { ok } from './envelope.js';
import { UnknownTask } from '../../lib/errors.js';
import { outputAad } from '../../lib/outputs.js';
import { limitOf, offsetOfQuery, pageBlock, paginateOffset } from '../../lib/page.js';

const LOG_WINDOW = 256 * 1024;

export default async function taskRoutes(fastify, { cfg, db, logs, storage, projects, secrets, auth = null }) {
  const base = cfg.server.public_url.replace(/\/+$/, '');

  // Explicit columns rather than t.*, which would pull spec and
  // worker_token_id into scope and leave one careless spread away from
  // publishing them.
  const TASK_QUERY = `
    SELECT t.id, t.name, t.base_name, t.state, t.arch, t.image,
           t.attempt, t.max_attempts, t.allow_failure, t.exit_code, t.error,
           t.worker_name, t.timeout, t.spec, t.log_size, t.log_key, t.log_expired_at,
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
  function readOutput(row) {
    const masked = row.masked === 1;
    if (masked) return { name: row.name, masked, value: null };

    let value = null;
    try {
      value = secrets.open(row.value, outputAad(row.task_id, row.name));
    } catch {
      value = null;
    }
    return { name: row.name, masked, value };
  }

  function represent(reply, row) {
    const spec = readSpec(row.spec);

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
        // What it was told to collect, not what it managed to store.
        artifact_paths: spec.artifactPaths,
        log_size: row.log_size,
        log_expired: row.log_expired_at !== null,
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
    });
  }

  // Naming a project asserts it rather than decorating the path.
  async function readableTask(req) {
    const row = await db.get(`${TASK_QUERY} WHERE t.id = {id}`, { id: req.params.task });
    if (!row) throw new UnknownTask();
    if (req.params.project !== undefined && req.params.project !== row.project_id) throw new UnknownTask();

    if (row.visibility !== 'public') {
      const project = await projects.get(row.project_id);
      if (!canManageProject(await currentUser(req), project)) throw new UnknownTask();
    }
    return row;
  }

  function both(suffix, handler) {
    fastify.get(`/tasks/:task${suffix}`, handler);
    fastify.get(`/projects/:project/tasks/:task${suffix}`, handler);
  }

  both('', async (req, reply) => represent(reply, await readableTask(req)));

  both('/outputs', async (req, reply) => {
    const task = await readableTask(req);
    const window = await paginateOffset(db, {
      select: 'task_id, name, value, masked',
      from: 'task_outputs',
      where: 'task_id = {task}',
      order: 'name',
      params: { task: task.id },
      offset: offsetOfQuery(req.query),
      limit: limitOf(req.query),
    });

    return ok(reply, window.rows.map(readOutput), pageBlock({ ...window, url: base + req.url }));
  });

  both('/artifacts', async (req, reply) => {
    const task = await readableTask(req);
    const window = await paginateOffset(db, {
      select: 'id, path, size, sha256, created_at, expires_at',
      from: 'artifacts',
      where: 'task_id = {task}',
      order: 'path',
      params: { task: task.id },
      offset: offsetOfQuery(req.query),
      limit: limitOf(req.query),
    });

    const rows = window.rows.map((a) => ({
      ...a,
      // A convenience, not the permission: the download route checks again.
      url: `${base}/api/v1/projects/${encodeURIComponent(task.project_id)}/jobs/${task.job_id}`
        + `/tasks/${task.id}/artifacts/${a.id}`,
    }));

    return ok(reply, rows, pageBlock({ ...window, url: base + req.url }));
  });

  both('/log', async (req, reply) => {
    const task = await readableTask(req);
    const offset = offsetOfQuery(req.query);
    const limit = limitOf(req.query, LOG_WINDOW, LOG_WINDOW);

    if (task.log_expired_at !== null) {
      return ok(reply, { offset: 0, size: 0, data: '', expired: true });
    }

    // The spool only exists until the task finishes; after that the log is
    // in storage under log_key.
    if (!task.log_key) {
      const chunk = await logs.read(task.job_id, task.id, { offset, limit });
      return ok(reply, {
        offset: chunk.offset,
        size: chunk.size,
        data: chunk.data.toString('utf8'),
        expired: false,
      });
    }

    const size = task.log_size ?? 0;
    if (offset >= size) return ok(reply, { offset: size, size, data: '', expired: false });

    const object = await storage.get(task.log_key, { range: { start: offset, end: Math.min(offset + limit, size) - 1 } });
    const parts = [];
    for await (const part of object.stream) parts.push(part);

    return ok(reply, {
      offset,
      size,
      data: Buffer.concat(parts).toString('utf8'),
      expired: false,
    });
  });
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
