// src/conductor/routes/runs.js - read access to runs, jobs and logs
//
// These routes are read only and carry no secrets, so the read-api service
// will mount the same handlers in phase 6. Anything that mutates state lives
// under the admin routes instead.

import { StorageNotFound } from '../../lib/storage/index.js';

const MAX_TAIL = 1024 * 1024;

export default async function runRoutes(fastify, { db, logs, storage }) {
  fastify.get('/runs', async (req, reply) => {
    const limit = clamp(req.query.limit, 1, 200, 50);
    const project = typeof req.query.project === 'string' ? req.query.project : null;

    const rows = project
      ? await db.all(
        `SELECT id, project_id, number, ref, base_sha, head_sha, trigger_type, actor,
                title, state, created_at, started_at, finished_at
           FROM runs WHERE project_id = {project}
          ORDER BY created_at DESC LIMIT {limit}`,
        { project, limit }
      )
      : await db.all(
        `SELECT id, project_id, number, ref, base_sha, head_sha, trigger_type, actor,
                title, state, created_at, started_at, finished_at
           FROM runs ORDER BY created_at DESC LIMIT {limit}`,
        { limit }
      );

    return reply.send({ runs: rows });
  });

  fastify.get('/runs/:id', async (req, reply) => {
    const run = await db.get(
      `SELECT id, project_id, number, ref, base_sha, head_sha, trigger_type, actor,
              title, state, error, created_at, started_at, finished_at
         FROM runs WHERE id = {id}`,
      { id: req.params.id }
    );
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

    return reply.send({
      run,
      jobs: jobs.map((j) => ({ ...j, needs: needs.get(j.id) ?? [] })),
    });
  });

  fastify.get('/jobs/:id', async (req, reply) => {
    const job = await db.get(
      `SELECT id, run_id, name, base_name, arch, image, requires, spec, state, allow_failure,
              attempt, max_attempts, exit_code, error, log_size, worker_name, timeout,
              created_at, started_at, finished_at
         FROM jobs WHERE id = {id}`,
      { id: req.params.id }
    );
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
    const job = await db.get(
      'SELECT id, run_id, state, log_key, log_size FROM jobs WHERE id = {id}',
      { id: req.params.id }
    );
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
      const end = offset + limit - 1;
      const object = await storage.get(job.log_key, { range: { start: offset, end } });
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
    const artifact = await db.get(
      'SELECT id, job_id, run_id, path, storage_key, size, sha256 FROM artifacts WHERE id = {id}',
      { id: req.params.id }
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

// These routes are mounted by the read-api, which is meant to be exposed
// publicly, so the job environment is never returned. It is the one field
// that carries project variables once a job is dispatched, and there is no
// use for it here that is worth the risk. Everything else in the spec
// already appears in the log or the pipeline file.
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
