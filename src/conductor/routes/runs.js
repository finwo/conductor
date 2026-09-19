// src/conductor/routes/runs.js - read access to runs, jobs and logs
//
// Read only, and carrying no secrets, so the same routes serve an
// anonymous visitor and an administrator.
//
// Visibility is enforced here rather than at the edge. A caller sees
// public runs, plus the runs of projects they own, plus everything if they
// are an administrator. With no auth service mounted, only public runs
// exist.

import { StorageNotFound } from '../../lib/storage/index.js';

const MAX_TAIL = 1024 * 1024;

export default async function runRoutes(fastify, { db, logs, storage, auth = null }) {
  // Anonymous when no auth service is mounted.
  async function viewer(req) {
    if (!auth) return null;
    try {
      return await auth.identify(req);
    } catch {
      return null;
    }
  }

  // A SQL fragment and its parameters restricting rows to what the caller
  // may see. Applied to every route below, including the log and artifact
  // endpoints, so there is no way in through a guessed identifier.
  function scope(user, alias = 'r') {
    if (user && user.role === 'admin') return { sql: '1 = 1', params: {} };
    if (user) {
      return {
        sql: `(${alias}.visibility = 'public' OR p.owner_id = {viewerId})`,
        params: { viewerId: user.id },
      };
    }
    return { sql: `${alias}.visibility = 'public'`, params: {} };
  }

  fastify.get('/runs', async (req, reply) => {
    const limit = clamp(req.query.limit, 1, 200, 50);
    const project = typeof req.query.project === 'string' ? req.query.project : null;
    const visible = scope(await viewer(req));

    const rows = await db.all(
      `SELECT r.id, r.project_id, r.number, r.ref, r.base_sha, r.head_sha, r.trigger_type,
              r.actor, r.title, r.state, r.visibility, r.created_at, r.started_at, r.finished_at
         FROM runs r
         JOIN projects p ON p.id = r.project_id
        WHERE ${visible.sql}
          ${project === null ? '' : 'AND r.project_id = {project}'}
        ORDER BY r.created_at DESC
        LIMIT {limit}`,
      { ...visible.params, ...(project === null ? {} : { project }), limit }
    );

    return reply.send({ runs: rows });
  });

  fastify.get('/runs/:id', async (req, reply) => {
    const visible = scope(await viewer(req));
    const run = await db.get(
      `SELECT r.id, r.project_id, r.number, r.ref, r.base_sha, r.head_sha, r.trigger_type,
              r.actor, r.title, r.state, r.visibility, r.error,
              r.created_at, r.started_at, r.finished_at
         FROM runs r
         JOIN projects p ON p.id = r.project_id
        WHERE r.id = {id} AND ${visible.sql}`,
      { id: req.params.id, ...visible.params }
    );
    // Deliberately the same answer as a run that does not exist.
    if (!run) return reply.code(404).send({ error: 'unknown run' });

    const jobs = await db.all(
      `SELECT id, name, base_name, arch, image, state, allow_failure, attempt, max_attempts,
              exit_code, error, log_size, worker_name, timeout,
              created_at, started_at, finished_at
         FROM jobs WHERE run_id = {run} ORDER BY name`,
      { run: run.id }
    );

    const deps = await db.all(
      `SELECT d.job_id, d.depends_on_id
         FROM job_deps d JOIN jobs j ON j.id = d.job_id
        WHERE j.run_id = {run}`,
      { run: run.id }
    );
    const needs = new Map(jobs.map((j) => [j.id, []]));
    for (const d of deps) needs.get(d.job_id)?.push(d.depends_on_id);

    return reply.send({ run, jobs: jobs.map((j) => ({ ...j, needs: needs.get(j.id) ?? [] })) });
  });

  // Loads a job the caller is allowed to see, or null.
  async function visibleJob(req, columns) {
    const visible = scope(await viewer(req));
    return db.get(
      `SELECT ${columns}
         FROM jobs j
         JOIN runs r ON r.id = j.run_id
         JOIN projects p ON p.id = r.project_id
        WHERE j.id = {id} AND ${visible.sql}`,
      { id: req.params.id, ...visible.params }
    );
  }

  fastify.get('/jobs/:id', async (req, reply) => {
    const job = await visibleJob(req, `
      j.id, j.run_id, j.name, j.base_name, j.arch, j.image, j.requires, j.spec, j.state,
      j.allow_failure, j.attempt, j.max_attempts, j.exit_code, j.error, j.log_size,
      j.worker_name, j.timeout, j.created_at, j.started_at, j.finished_at
    `);
    if (!job) return reply.code(404).send({ error: 'unknown job' });

    const artifacts = await db.all(
      'SELECT id, path, size, sha256, created_at FROM artifacts WHERE job_id = {job} ORDER BY path',
      { job: job.id }
    );

    return reply.send({ job: publicJob(job), artifacts });
  });

  // Incremental log tail. While a job runs the bytes come from the local
  // spool; once it has finished they come from object storage.
  fastify.get('/jobs/:id/log', async (req, reply) => {
    const job = await visibleJob(req, 'j.id, j.run_id, j.state, j.log_key, j.log_size');
    if (!job) return reply.code(404).send({ error: 'unknown job' });

    const offset = clamp(req.query.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const limit = clamp(req.query.limit, 1, MAX_TAIL, 64 * 1024);

    if (!job.log_key) {
      const chunk = await logs.read(job.run_id, job.id, { offset, limit });
      reply.header('content-type', 'text/plain; charset=utf-8');
      reply.header('x-log-offset', String(chunk.offset));
      reply.header('x-log-size', String(chunk.size));
      // Tells a follower whether to keep polling.
      reply.header('x-log-complete', 'false');
      return reply.send(chunk.data);
    }

    try {
      const object = await storage.get(job.log_key, { range: { start: offset, end: offset + limit - 1 } });
      reply.header('content-type', 'text/plain; charset=utf-8');
      reply.header('x-log-offset', String(offset));
      reply.header('x-log-size', String(job.log_size));
      reply.header('x-log-complete', 'true');
      return reply.send(object.stream);
    } catch (e) {
      if (e instanceof StorageNotFound) return reply.code(404).send({ error: 'log is no longer stored' });
      throw e;
    }
  });

  fastify.get('/artifacts/:id', async (req, reply) => {
    const visible = scope(await viewer(req));
    const artifact = await db.get(
      `SELECT a.id, a.job_id, a.run_id, a.path, a.storage_key, a.size, a.sha256
         FROM artifacts a
         JOIN runs r ON r.id = a.run_id
         JOIN projects p ON p.id = r.project_id
        WHERE a.id = {id} AND ${visible.sql}`,
      { id: req.params.id, ...visible.params }
    );
    if (!artifact) return reply.code(404).send({ error: 'unknown artifact' });

    // Hand the client straight to the object store when that is possible,
    // rather than proxying the bytes through the conductor.
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

// The job environment is never returned. It is the one field that carries
// project variables once a job is dispatched, and there is no use for it
// here worth the risk. Everything else already appears in the log or the
// pipeline file.
function publicJob(job) {
  const spec = safeJson(job.spec, {});
  const { env, ...rest } = job;
  return {
    ...rest,
    requires: safeJson(job.requires, []),
    spec: {
      script: spec.script ?? [],
      needs: spec.needs ?? [],
      matrix: spec.matrix ?? {},
      depth: spec.depth ?? 0,
      cache: spec.cache ? { key: spec.cache.key, paths: spec.cache.paths } : null,
      artifacts: spec.artifacts ?? null,
      services: (spec.services ?? []).map((s) => ({ image: s.image, alias: s.alias })),
    },
  };
}

function clamp(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function basename(p) {
  return p.split('/').pop() || 'artifact';
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
