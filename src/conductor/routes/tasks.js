// src/conductor/routes/tasks.js - the API workers poll and report to
//
// Every route here requires a worker token. A worker may only touch a task it
// currently holds, which is checked against worker_token_id rather than
// trusting the task id it sends.
//
// A worker is handed a context and a script and nothing else. It is never
// told which project or job a task belongs to, and the task id it receives
// carries no structure it could read that out of. The identifiers a build
// legitimately wants are in the task's environment, where the worker treats
// them as opaque strings on their way into the container.

import { pipeline as streamPipeline } from 'node:stream/promises';
import { LogOffsetError } from '../../lib/log.js';
import { hashingTransform } from '../../lib/stream.js';
import { sanitizeRelativePath, keys as storageKeys } from '../../lib/storage/index.js';
import { maskBuffer } from '../../lib/variables.js';
import { newArtifactId } from '../../lib/ids.js';

// Log chunks are small and frequent; artifacts are streamed, so this only
// bounds a single log append.
const LOG_CHUNK_LIMIT = 1024 * 1024;

export default async function taskRoutes(fastify, { cfg, db, git, logs, storage, projects, scheduler, workerTokens, variables }) {
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

  // Confirms the task exists and is held by the calling worker.
  async function heldTask(req, reply) {
    const task = await db.get(
      `SELECT t.id, t.job_id, t.name, t.state, t.worker_token_id, t.log_size, t.spec,
              j.project_id, j.head_sha
         FROM tasks t JOIN jobs j ON j.id = t.job_id
        WHERE t.id = {id}`,
      { id: req.params.task }
    );
    if (!task) {
      reply.code(404).send({ error: 'unknown task' });
      return null;
    }
    if (task.worker_token_id !== req.worker.id) {
      reply.code(403).send({ error: 'task is not held by this worker' });
      return null;
    }
    return task;
  }

  fastify.addHook('preHandler', requireWorker);

  // Ask for work. The worker describes what it can run; the scheduler
  // decides. Returns 204 when there is nothing to do.
  fastify.post('/tasks/claim', async (req, reply) => {
    const body = req.body ?? {};
    const arches = splitList(body.arches);
    const features = splitList(body.features);
    const name = typeof body.name === 'string' ? body.name.slice(0, 255) : req.worker.name;

    const task = await scheduler.claim({
      arches,
      features,
      tokenId: req.worker.id,
      workerName: name,
      // A worker registered by a user only ever sees that user's projects.
      ownerId: req.worker.owner_id ?? null,
    });
    if (!task) return reply.code(204).send();

    const base = cfg.server.public_url.replace(/\/+$/, '');
    const at = (suffix) => `${base}/api/v1/tasks/${task.id}/${suffix}`;

    return reply.send({
      task: {
        id: task.id,
        name: task.name,
        arch: task.arch,
        image: task.image,
        // The worker maps these onto its own local mounts, environment and
        // privileges. Without them no feature is applied at all.
        requires: task.requires,
        script: task.script,
        env: task.env,
        services: task.services,
        artifacts: task.artifacts,
        // Where the tree is unpacked and the script runs. Resolved when
        // the job was created, so it does not shift under a retry.
        workdir: task.workdir,
        timeout: task.timeout,
        attempt: task.attempt,
        sha: task.sha,
        ref: task.ref,
        // Values the worker must redact from the log stream. Populated
        // once project variables exist; masking also happens on ingest.
        masked: task.masked ?? [],
        // Derived from the server's own timeout so a worker never has to
        // guess how often it is expected to check in.
        heartbeat_interval: Math.max(5, Math.floor(cfg.scheduler.heartbeat_timeout / 4)),
        endpoints: {
          // The tree comes from the conductor, so a worker never needs
          // credentials for the repository and cannot reach any commit
          // other than the one it was given work for.
          source: at('source.tar.gz'),
          log: at('log'),
          artifact: at('artifacts'),
          heartbeat: at('heartbeat'),
          done: at('complete'),
        },
      },
    });
  });

  // The tree at the task's commit, as a gzipped tar.
  fastify.get('/tasks/:task/source.tar.gz', async (req, reply) => {
    const task = await heldTask(req, reply);
    if (!task) return reply;

    const project = await projects.get(task.project_id);
    if (!project) return reply.code(404).send({ error: 'unknown project' });

    // The tree rooted at the archive, with no wrapping directory: a
    // worker extracts it at whatever path the task is to run in, and
    // docker creates that path on the way.
    reply.header('content-type', 'application/gzip');
    reply.header('content-disposition', `attachment; filename="${task.head_sha.slice(0, 12)}.tar.gz"`);
    return reply.send(git.archiveStream(project, task.head_sha));
  });

  // Append to the live log. X-Log-Offset makes a retry after a dropped
  // connection safe.
  fastify.post('/tasks/:task/log', { bodyLimit: LOG_CHUNK_LIMIT }, async (req, reply) => {
    const task = await heldTask(req, reply);
    if (!task) return reply;

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

    // The worker masks before sending; this repeats it on ingest so a
    // worker that does not still cannot write a secret to disk. It works
    // within a chunk only, which is why the worker holds back a boundary.
    let payload = Buffer.concat(chunks);
    if (variables) {
      try {
        payload = maskBuffer(payload, await variables.maskedValues(task.project_id));
      } catch (e) {
        req.log.warn({ err: e }, `could not mask log output for ${task.id}`);
      }
    }

    try {
      const result = await logs.append(task.job_id, task.id, payload, offset);
      await db.run('UPDATE tasks SET log_size = {size}, heartbeat_at = {now} WHERE id = {id}',
        { id: task.id, size: result.size, now: Date.now() });
      return reply.send(result);
    } catch (e) {
      if (e instanceof LogOffsetError) {
        // Tell the worker where to resume from.
        return reply.code(409).send({ error: e.message, expected_offset: e.expected });
      }
      throw e;
    }
  });

  // artifacts.expire in the pipeline, as an absolute time. Returns null
  // when the task said nothing, leaving the artifact to the project policy.
  function artifactExpiry(specJson, now) {
    if (!specJson) return null;
    try {
      const spec = typeof specJson === 'string' ? JSON.parse(specJson) : specJson;
      const seconds = spec?.artifacts?.expire;
      if (!Number.isFinite(seconds) || seconds <= 0) return null;
      return now + Math.round(seconds * 1000);
    } catch {
      // A spec that will not parse is a problem, but not this request's
      // problem: the artifact is already stored.
      return null;
    }
  }

  // Upload one artifact. The path is worker supplied, so it is sanitized
  // before it can influence a storage key.
  fastify.post('/tasks/:task/artifacts', async (req, reply) => {
    const task = await heldTask(req, reply);
    if (!task) return reply;

    const relPath = sanitizeRelativePath(req.headers['x-artifact-path']);
    if (!relPath) return reply.code(400).send({ error: 'x-artifact-path is missing or unusable' });

    const declared = Number(req.headers['content-length']);
    if (!Number.isInteger(declared) || declared < 0) {
      return reply.code(411).send({ error: 'content-length is required for artifact uploads' });
    }

    // Hash on the way past, so the digest costs nothing extra even when the
    // backend cannot report one.
    const hasher = hashingTransform();
    const key = storageKeys.artifact(task.job_id, task.id, relPath);

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
    const now = Date.now();

    await db.run(
      `INSERT INTO artifacts (id, task_id, job_id, path, storage_key, size, sha256, created_at, expires_at)
       VALUES ({id}, {task}, {job}, {path}, {key}, {size}, {sha}, {now}, {expires})`,
      {
        id: newArtifactId(),
        task: task.id,
        job: task.job_id,
        path: relPath,
        key,
        size: stored.size ?? declared,
        sha: digest,
        now,
        // An explicit deadline from the pipeline. Absent, the project's
        // retention policy decides, which is the usual case.
        expires: artifactExpiry(task.spec, now),
      }
    );

    return reply.send({ path: relPath, size: stored.size ?? declared, sha256: digest });
  });

  // Keeps the task alive, and is how a worker learns it should stop.
  fastify.post('/tasks/:task/heartbeat', async (req, reply) => {
    const result = await scheduler.heartbeat(req.params.task, req.worker.id);
    if (!result.known) return reply.code(404).send({ error: 'unknown task for this worker' });
    return reply.send({ cancelled: result.cancelled, state: result.state });
  });

  // Report the outcome. The log is copied to storage here, whatever the
  // result, so a failed task keeps its output.
  fastify.post('/tasks/:task/complete', async (req, reply) => {
    const task = await heldTask(req, reply);
    if (!task) return reply;

    const body = req.body ?? {};
    const success = body.success === true;
    const exitCode = Number.isInteger(body.exit_code) ? body.exit_code : null;
    const error = typeof body.error === 'string' ? body.error.slice(0, 4096) : null;

    const outcome = await scheduler.complete(task.id, {
      success,
      exitCode,
      error,
      tokenId: req.worker.id,
    });
    if (!outcome.ok) return reply.code(409).send({ error: outcome.reason });

    // A retry keeps writing to the same log, so only archive it once the
    // task has actually stopped.
    if (outcome.state !== 'queued') {
      try {
        await scheduler.finalizeLog(task.job_id, task.id);
      } catch (e) {
        req.log.error({ err: e }, `failed to archive log for ${task.id}`);
      }
    }

    return reply.send({
      state: outcome.state,
      retry: outcome.retry === true,
      skipped: outcome.skipped ?? [],
      job_state: outcome.jobState ?? null,
    });
  });
}

function splitList(value) {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return items.map((s) => String(s).trim()).filter(Boolean).slice(0, 64);
}
