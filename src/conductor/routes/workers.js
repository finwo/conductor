// src/conductor/routes/workers.js - the API workers poll and report to
//
// Every route here requires a worker token. A worker may only touch a job it
// currently holds, which is checked against worker_token_id rather than
// trusting the job id it sends.

import { pipeline as streamPipeline } from 'node:stream/promises';
import { LogOffsetError } from '../../lib/log.js';
import { hashingTransform } from '../../lib/stream.js';
import { sanitizeRelativePath, keys as storageKeys } from '../../lib/storage/index.js';
import { newArtifactId } from '../../lib/ids.js';

// Log chunks are small and frequent; artifacts are streamed, so this only
// bounds a single log append.
const LOG_CHUNK_LIMIT = 1024 * 1024;

export default async function workerRoutes(fastify, { cfg, db, git, logs, storage, projects, scheduler, workerTokens }) {
  // Raw bodies: log chunks and artifacts arrive as octet streams and must
  // not be parsed.
  fastify.addContentTypeParser('application/octet-stream', (req, payload, done) => done(null, payload));

  async function requireWorker(req, reply) {
    const header = req.headers.authorization || '';
    const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const token = await workerTokens.verify(presented, { ip: req.ip });
    if (!token) {
      reply.code(401).send({ error: 'invalid or missing worker token' });
      return;
    }
    req.worker = token;
  }

  // Confirms the job exists and is held by the calling worker.
  async function heldJob(req, reply) {
    const job = await db.get(
      `SELECT j.id, j.run_id, j.name, j.state, j.worker_token_id, j.log_size, r.project_id, r.head_sha
         FROM jobs j JOIN runs r ON r.id = j.run_id
        WHERE j.id = {id}`,
      { id: req.params.id }
    );
    if (!job) {
      reply.code(404).send({ error: 'unknown job' });
      return null;
    }
    if (job.worker_token_id !== req.worker.id) {
      reply.code(403).send({ error: 'job is not held by this worker' });
      return null;
    }
    return job;
  }

  fastify.addHook('preHandler', requireWorker);

  // Ask for work. The worker describes what it can run; the scheduler
  // decides. Returns 204 when there is nothing to do.
  fastify.get('/poll', async (req, reply) => {
    const arches = splitList(req.query.arches);
    const features = splitList(req.query.features);
    const name = typeof req.query.name === 'string' ? req.query.name.slice(0, 255) : req.worker.name;

    const job = await scheduler.claim({
      arches,
      features,
      tokenId: req.worker.id,
      workerName: name,
    });
    if (!job) return reply.code(204).send();

    const project = await projects.get(job.project_id);
    const base = cfg.server.public_url.replace(/\/+$/, '');

    return reply.send({
      job: {
        id: job.id,
        run_id: job.run_id,
        name: job.name,
        arch: job.arch,
        image: job.image,
        script: job.script,
        env: job.env,
        services: job.services,
        artifacts: job.artifacts,
        cache: job.cache,
        timeout: job.timeout,
        attempt: job.attempt,
        sha: job.sha,
        // A worker fetches the tree from the conductor by default, so it
        // never needs repository credentials. Projects set to clone mode
        // get the URL instead.
        source: project.source_mode === 'clone'
          ? { mode: 'clone', repo_url: project.repo_url, sha: job.sha }
          : { mode: 'archive', url: `${base}/api/workers/jobs/${encodeURIComponent(job.id)}/source.tar.gz` },
        endpoints: {
          log: `${base}/api/workers/jobs/${encodeURIComponent(job.id)}/log`,
          artifact: `${base}/api/workers/jobs/${encodeURIComponent(job.id)}/artifact`,
          heartbeat: `${base}/api/workers/jobs/${encodeURIComponent(job.id)}/heartbeat`,
          done: `${base}/api/workers/jobs/${encodeURIComponent(job.id)}/done`,
        },
      },
    });
  });

  // The tree at the job's commit, as a gzipped tar.
  fastify.get('/jobs/:id/source.tar.gz', async (req, reply) => {
    const job = await heldJob(req, reply);
    if (!job) return reply;

    const project = await projects.get(job.project_id);
    if (!project) return reply.code(404).send({ error: 'unknown project' });

    reply.header('content-type', 'application/gzip');
    reply.header('content-disposition', `attachment; filename="${job.head_sha.slice(0, 12)}.tar.gz"`);
    return reply.send(git.archiveStream(project, job.head_sha));
  });

  // Append to the live log. X-Log-Offset makes a retry after a dropped
  // connection safe.
  fastify.post('/jobs/:id/log', { bodyLimit: LOG_CHUNK_LIMIT }, async (req, reply) => {
    const job = await heldJob(req, reply);
    if (!job) return reply;

    const chunks = [];
    let total = 0;
    for await (const chunk of req.body) {
      total += chunk.length;
      if (total > LOG_CHUNK_LIMIT) return reply.code(413).send({ error: 'log chunk too large' });
      chunks.push(chunk);
    }

    const rawOffset = req.headers['x-log-offset'];
    const offset = rawOffset === undefined ? undefined : Number(rawOffset);
    if (offset !== undefined && !Number.isInteger(offset)) {
      return reply.code(400).send({ error: 'x-log-offset must be an integer' });
    }

    try {
      const result = await logs.append(job.run_id, job.id, Buffer.concat(chunks), offset);
      await db.run('UPDATE jobs SET log_size = {size}, heartbeat_at = {now} WHERE id = {id}',
        { id: job.id, size: result.size, now: Date.now() });
      return reply.send(result);
    } catch (e) {
      if (e instanceof LogOffsetError) {
        // Tell the worker where to resume from.
        return reply.code(409).send({ error: e.message, expected_offset: e.expected });
      }
      throw e;
    }
  });

  // Upload one artifact. The path is worker supplied, so it is sanitized
  // before it can influence a storage key.
  fastify.post('/jobs/:id/artifact', async (req, reply) => {
    const job = await heldJob(req, reply);
    if (!job) return reply;

    const relPath = sanitizeRelativePath(req.headers['x-artifact-path']);
    if (!relPath) return reply.code(400).send({ error: 'x-artifact-path is missing or unusable' });

    const declared = Number(req.headers['content-length']);
    if (!Number.isInteger(declared) || declared < 0) {
      return reply.code(411).send({ error: 'content-length is required for artifact uploads' });
    }

    // Hash on the way past, so the digest costs nothing extra even when the
    // backend cannot report one.
    const hasher = hashingTransform();
    const key = storageKeys.artifact(job.run_id, job.id, relPath);

    let stored;
    try {
      [, stored] = await Promise.all([
        streamPipeline(req.body, hasher),
        storage.put(key, hasher, { size: declared }),
      ]);
    } catch (e) {
      // A body shorter or longer than content-length is the worker's
      // mistake, not a server fault.
      if (/size mismatch/.test(e.message)) {
        return reply.code(400).send({ error: e.message });
      }
      throw e;
    }

    const digest = hasher.digest();
    await db.run(
      `INSERT INTO artifacts (id, job_id, run_id, path, storage_key, size, sha256, created_at)
       VALUES ({id}, {job}, {run}, {path}, {key}, {size}, {sha}, {now})`,
      {
        id: newArtifactId(),
        job: job.id,
        run: job.run_id,
        path: relPath,
        key,
        size: stored.size ?? declared,
        sha: digest,
        now: Date.now(),
      }
    );

    return reply.send({ path: relPath, size: stored.size ?? declared, sha256: digest });
  });

  // Keeps the job alive, and is how a worker learns it should stop.
  fastify.post('/jobs/:id/heartbeat', async (req, reply) => {
    const result = await scheduler.heartbeat(req.params.id, req.worker.id);
    if (!result.known) return reply.code(404).send({ error: 'unknown job for this worker' });
    return reply.send({ cancelled: result.cancelled, state: result.state });
  });

  // Report the outcome. The log is copied to storage here, whatever the
  // result, so a failed job keeps its output.
  fastify.post('/jobs/:id/done', async (req, reply) => {
    const job = await heldJob(req, reply);
    if (!job) return reply;

    const body = req.body ?? {};
    const success = body.success === true;
    const exitCode = Number.isInteger(body.exit_code) ? body.exit_code : null;
    const error = typeof body.error === 'string' ? body.error.slice(0, 4096) : null;

    const outcome = await scheduler.complete(job.id, {
      success,
      exitCode,
      error,
      tokenId: req.worker.id,
    });
    if (!outcome.ok) return reply.code(409).send({ error: outcome.reason });

    // A retry keeps writing to the same log, so only archive it once the
    // job has actually stopped.
    if (outcome.state !== 'queued') {
      try {
        await scheduler.finalizeLog(job.run_id, job.id);
      } catch (e) {
        req.log.error({ err: e }, `failed to archive log for ${job.id}`);
      }
    }

    return reply.send({
      state: outcome.state,
      retry: outcome.retry === true,
      skipped: outcome.skipped ?? [],
      run_state: outcome.runState ?? null,
    });
  });
}

function splitList(value) {
  if (typeof value !== 'string') return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 64);
}
