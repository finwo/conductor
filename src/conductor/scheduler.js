// src/conductor/scheduler.js - run creation, dispatch and completion
//
// Scheduling reads the dependency edges in job_deps directly. Two defects in
// the prototype came from not doing that:
//
//   Dispatch was serialized. A single integer level per job was compared
//   against the lowest queued level, so only one job could run at a time
//   even when the graph allowed the whole width of it. Here any job whose
//   dependencies are all satisfied is eligible, and several workers can
//   claim different jobs concurrently.
//
//   Failure skipped only direct dependents. Transitive dependents stayed
//   queued and were later dispatched with their inputs missing. Here the
//   whole reachable set is skipped.
//
// Claiming is a conditional UPDATE guarded on the previous state, so two
// workers polling at the same instant cannot both win the same job.

import { compilePipeline, PipelineError, transitiveDependents } from '../lib/pipeline/index.js';
import { inClause } from '../lib/db/query.js';
import { newRunId, jobId as makeJobId } from '../lib/ids.js';
import { keys as storageKeys } from '../lib/storage/index.js';

export const RUN_STATES = ['pending', 'running', 'success', 'failed', 'cancelled'];
export const JOB_STATES = ['queued', 'running', 'success', 'failed', 'skipped', 'cancelled'];

// States that let a dependent proceed.
const TERMINAL = ['success', 'failed', 'skipped', 'cancelled'];

export function createScheduler({ cfg, db, git, logs, storage, projects, variables = null, logger = console }) {
  // A job is eligible when it is queued, its run is live, and no dependency
  // is outstanding. A failed dependency marked allow_failure still counts as
  // satisfied, which is the whole point of the flag.
  const ELIGIBLE = `
    SELECT j.id, j.run_id, j.name, j.arch, j.image, j.requires, j.spec,
           j.timeout, j.attempt, j.max_attempts,
           r.head_sha, r.project_id, r.ref, r.number
      FROM jobs j
      JOIN runs r ON r.id = j.run_id
     WHERE j.state = 'queued'
       AND r.state = 'running'
       AND NOT EXISTS (
             SELECT 1
               FROM job_deps d
               JOIN jobs dj ON dj.id = d.depends_on_id
              WHERE d.job_id = j.id
                AND dj.state <> 'success'
                AND NOT (dj.state = 'failed' AND dj.allow_failure = 1)
           )
  `;

  async function loadGraph(tx, runId) {
    const jobs = await tx.all(
      'SELECT id, name, state, allow_failure FROM jobs WHERE run_id = {run}',
      { run: runId }
    );
    const deps = await tx.all(
      `SELECT d.job_id, d.depends_on_id
         FROM job_deps d
         JOIN jobs j ON j.id = d.job_id
        WHERE j.run_id = {run}`,
      { run: runId }
    );
    const needs = new Map(jobs.map((j) => [j.id, []]));
    for (const d of deps) needs.get(d.job_id)?.push(d.depends_on_id);
    return jobs.map((j) => ({ ...j, needs: needs.get(j.id) ?? [] }));
  }

  // Marks the run finished once nothing is left to do.
  async function settleRun(tx, runId) {
    const outstanding = await tx.get(
      "SELECT COUNT(*) AS c FROM jobs WHERE run_id = {run} AND state IN ('queued', 'running')",
      { run: runId }
    );
    if (outstanding.c > 0) return null;

    const bad = await tx.get(
      `SELECT COUNT(*) AS c FROM jobs
        WHERE run_id = {run}
          AND (state IN ('skipped', 'cancelled')
               OR (state = 'failed' AND allow_failure = 0))`,
      { run: runId }
    );
    const state = bad.c > 0 ? 'failed' : 'success';
    await tx.run(
      "UPDATE runs SET state = {state}, finished_at = {now} WHERE id = {run} AND state = 'running'",
      { state, run: runId, now: Date.now() }
    );
    return state;
  }

  return {
    // Reads the pipeline at the pushed commit and records the run. The
    // repository is the source of truth, so nothing the trigger claims about
    // the contents is trusted.
    async createRun(project, { ref, baseSha, headSha, trigger = 'push', actor = null }) {
      await git.sync(project, { force: true });

      if (!(await git.hasCommit(project, headSha))) {
        throw new Error(`commit ${headSha} is not present in the mirror of ${project.id}`);
      }

      const text = await git.readFile(project, headSha, project.config_path);
      if (text === null) {
        throw new PipelineError(
          [{ path: '', message: `${project.config_path} not found at ${headSha.slice(0, 12)}` }],
          project.config_path
        );
      }

      const pipeline = compilePipeline(text, {
        source: project.config_path,
        defaultTimeout: cfg.scheduler.default_job_timeout,
        defaultAttempts: 1,
      });

      const info = await git.commitInfo(project, headSha).catch(() => ({ subject: null }));
      const runId = newRunId();
      const now = Date.now();

      await db.transaction(async (tx) => {
        const number = await projects.nextRunNumber(tx, project.id);
        const empty = pipeline.jobs.length === 0;

        await tx.run(
          `INSERT INTO runs
             (id, project_id, number, ref, base_sha, head_sha, trigger_type, actor,
              title, state, pipeline, created_at, started_at, finished_at)
           VALUES
             ({id}, {project}, {number}, {ref}, {base}, {head}, {trigger}, {actor},
              {title}, {state}, {pipeline}, {now}, {now}, {finished})`,
          {
            id: runId,
            project: project.id,
            number,
            ref: ref ?? null,
            base: baseSha ?? null,
            head: headSha,
            trigger,
            actor,
            title: info.subject ?? null,
            state: empty ? 'success' : 'running',
            pipeline: JSON.stringify({ version: pipeline.version, jobs: pipeline.jobs }),
            now,
            finished: empty ? now : null,
          }
        );

        const idByName = new Map(pipeline.jobs.map((j) => [j.name, makeJobId(runId, j.name)]));

        for (const job of pipeline.jobs) {
          await tx.run(
            `INSERT INTO jobs
               (id, run_id, name, base_name, arch, image, requires, spec, state,
                allow_failure, attempt, max_attempts, timeout, log_size, created_at)
             VALUES
               ({id}, {run}, {name}, {base}, {arch}, {image}, {requires}, {spec}, 'queued',
                {allow}, 0, {attempts}, {timeout}, 0, {now})`,
            {
              id: idByName.get(job.name),
              run: runId,
              name: job.name,
              base: job.baseName,
              arch: job.arch,
              image: job.image,
              requires: JSON.stringify(job.requires),
              spec: JSON.stringify({
                script: job.script,
                env: job.env,
                services: job.services,
                artifacts: job.artifacts,
                cache: job.cache,
                matrix: job.matrix,
                needs: job.needs,
                depth: job.depth,
              }),
              allow: job.allow_failure ? 1 : 0,
              attempts: job.max_attempts,
              timeout: job.timeout,
              now,
            }
          );
        }

        for (const job of pipeline.jobs) {
          for (const need of job.needs) {
            await tx.run(
              'INSERT INTO job_deps (job_id, depends_on_id) VALUES ({job}, {dep})',
              { job: idByName.get(job.name), dep: idByName.get(need) }
            );
          }
        }
      });

      logger.info?.(`run ${runId} created for ${project.id} with ${pipeline.jobs.length} job(s)`);
      return { runId, jobCount: pipeline.jobs.length };
    },

    // Hands one job to a worker. The worker advertises what it can run;
    // jobs asking for anything it lacks are passed over.
    async claim({ arches = [], features = [], tokenId, workerName }) {
      const archFilter = inClause('arch', arches);
      const featureSet = new Set(features);

      // Oldest run first, so a queue drains in order rather than starving
      // whichever run happens to sort last.
      const candidates = await db.all(
        `${ELIGIBLE}
           AND (j.arch IS NULL${archFilter.empty ? '' : ` OR j.arch IN (${archFilter.sql})`})
         ORDER BY r.created_at ASC, j.created_at ASC
         LIMIT 100`,
        { ...archFilter.params }
      );

      for (const candidate of candidates) {
        let requires;
        try {
          requires = JSON.parse(candidate.requires);
        } catch {
          requires = [];
        }
        if (!requires.every((f) => featureSet.has(f))) continue;

        const now = Date.now();
        const claimed = await db.run(
          `UPDATE jobs
              SET state = 'running', attempt = attempt + 1, worker_token_id = {token},
                  worker_name = {worker}, claimed_at = {now}, heartbeat_at = {now},
                  started_at = {now}
            WHERE id = {id} AND state = 'queued'`,
          { id: candidate.id, token: tokenId, worker: workerName ?? null, now }
        );
        // Lost the race to another worker; try the next candidate.
        if (claimed.changes !== 1) continue;

        const spec = JSON.parse(candidate.spec);
        const attempt = candidate.attempt + 1;

        // Project variables are resolved at dispatch and handed to the
        // worker, never written into the jobs table, so the only place a
        // secret rests is project_variables.
        let injected = { env: {}, masked: [] };
        if (variables) {
          try {
            injected = await variables.resolve(candidate.project_id);
          } catch (e) {
            logger.warn?.(`could not resolve variables for ${candidate.project_id}: ${e.message}`);
          }
        }

        return {
          id: candidate.id,
          run_id: candidate.run_id,
          project_id: candidate.project_id,
          name: candidate.name,
          arch: candidate.arch,
          image: candidate.image,
          sha: candidate.head_sha,
          ref: candidate.ref,
          requires,
          timeout: candidate.timeout,
          attempt,
          max_attempts: candidate.max_attempts,
          script: spec.script,
          // Values the worker must redact from the log stream.
          masked: injected.masked,
          // Project variables, then pipeline env, then the facts about this
          // run. Ordered so a pipeline cannot quietly redefine the last
          // group, and a variable cannot shadow an explicit job setting.
          env: {
            ...injected.env,
            ...spec.env,
            CONDUCTOR_PROJECT: candidate.project_id,
            CONDUCTOR_RUN_ID: candidate.run_id,
            CONDUCTOR_RUN_NUMBER: String(candidate.number),
            CONDUCTOR_JOB: candidate.name,
            CONDUCTOR_JOB_ID: candidate.id,
            CONDUCTOR_SHA: candidate.head_sha,
            CONDUCTOR_REF: candidate.ref ?? '',
            CONDUCTOR_ATTEMPT: String(attempt),
          },
          services: spec.services,
          artifacts: spec.artifacts,
          cache: spec.cache,
        };
      }

      return null;
    },

    async heartbeat(jobId, tokenId) {
      const job = await db.get(
        'SELECT id, state, worker_token_id FROM jobs WHERE id = {id}',
        { id: jobId }
      );
      if (!job) return { known: false };
      if (job.worker_token_id !== tokenId) return { known: false };

      if (job.state === 'running') {
        await db.run('UPDATE jobs SET heartbeat_at = {now} WHERE id = {id}', { id: jobId, now: Date.now() });
        return { known: true, cancelled: false };
      }
      // The job was cancelled or reaped out from under the worker, which is
      // how a worker learns to stop.
      return { known: true, cancelled: true, state: job.state };
    },

    // Records the outcome, retries if attempts remain, and otherwise skips
    // everything downstream.
    async complete(jobId, { success, exitCode = null, error = null, tokenId = null }) {
      return db.transaction(async (tx) => {
        const job = await tx.get(
          `SELECT id, run_id, name, state, attempt, max_attempts, allow_failure, worker_token_id
             FROM jobs WHERE id = {id}`,
          { id: jobId }
        );
        if (!job) return { ok: false, reason: 'unknown job' };
        if (tokenId !== null && job.worker_token_id !== tokenId) {
          return { ok: false, reason: 'job belongs to another worker' };
        }
        if (job.state !== 'running') {
          return { ok: false, reason: `job is ${job.state}, not running` };
        }

        const now = Date.now();

        if (success) {
          await tx.run(
            "UPDATE jobs SET state = 'success', exit_code = {code}, finished_at = {now} WHERE id = {id}",
            { id: jobId, code: exitCode, now }
          );
          const runState = await settleRun(tx, job.run_id);
          return { ok: true, state: 'success', runState };
        }

        // Transient failure with attempts left: back to the queue rather
        // than failing the run.
        if (job.attempt < job.max_attempts) {
          await tx.run(
            `UPDATE jobs
                SET state = 'queued', exit_code = {code}, error = {error},
                    worker_token_id = NULL, worker_name = NULL,
                    claimed_at = NULL, heartbeat_at = NULL, started_at = NULL
              WHERE id = {id}`,
            { id: jobId, code: exitCode, error }
          );
          return { ok: true, state: 'queued', retry: true, attempt: job.attempt };
        }

        await tx.run(
          "UPDATE jobs SET state = 'failed', exit_code = {code}, error = {error}, finished_at = {now} WHERE id = {id}",
          { id: jobId, code: exitCode, error, now }
        );

        let skipped = [];
        if (!job.allow_failure) {
          skipped = await skipDependents(tx, job.run_id, [jobId], now);
        }

        const runState = await settleRun(tx, job.run_id);
        return { ok: true, state: 'failed', skipped, runState };
      });
    },

    // Every job reachable from the failed ones, not just their immediate
    // dependents.
    async skipDependents(runId, fromJobIds) {
      return db.transaction((tx) => skipDependents(tx, runId, fromJobIds, Date.now()));
    },

    // Requeues or fails jobs whose worker stopped reporting.
    async reap() {
      const cutoff = Date.now() - cfg.scheduler.heartbeat_timeout * 1000;
      const stale = await db.all(
        `SELECT id, run_id, name, attempt, max_attempts, worker_name
           FROM jobs
          WHERE state = 'running' AND heartbeat_at IS NOT NULL AND heartbeat_at < {cutoff}`,
        { cutoff }
      );

      const results = [];
      for (const job of stale) {
        const outcome = await this.complete(job.id, {
          success: false,
          error: `worker ${job.worker_name ?? 'unknown'} stopped reporting for more than ` +
                 `${cfg.scheduler.heartbeat_timeout}s`,
        });
        if (outcome.ok) {
          logger.warn?.(`reaped ${job.name} (${job.id}): ${outcome.retry ? 'requeued' : 'failed'}`);
          results.push({ id: job.id, ...outcome });
        }
      }
      return results;
    },

    async cancelRun(runId, reason = 'cancelled by request') {
      return db.transaction(async (tx) => {
        const run = await tx.get('SELECT id, state FROM runs WHERE id = {id}', { id: runId });
        if (!run) return { ok: false, reason: 'unknown run' };
        if (run.state !== 'running') return { ok: false, reason: `run is ${run.state}` };

        const now = Date.now();
        await tx.run(
          `UPDATE jobs SET state = 'cancelled', error = {reason}, finished_at = {now}
            WHERE run_id = {run} AND state IN ('queued', 'running')`,
          { run: runId, reason, now }
        );
        await tx.run(
          "UPDATE runs SET state = 'cancelled', finished_at = {now} WHERE id = {run}",
          { run: runId, now }
        );
        return { ok: true };
      });
    },

    // Called once a job finishes so the live log stops being the spool copy.
    async finalizeLog(runId, jobId) {
      const key = storageKeys.log(runId, jobId);
      const { size } = await logs.finalize(runId, jobId, storage, key);
      if (size > 0) {
        await db.run('UPDATE jobs SET log_key = {key}, log_size = {size} WHERE id = {id}',
          { id: jobId, key, size });
      }
      return { key, size };
    },

    TERMINAL,
  };

  async function skipDependents(tx, runId, fromJobIds, now) {
    const graph = await loadGraph(tx, runId);
    const reachable = transitiveDependents(
      graph.map((j) => ({ name: j.id, needs: j.needs })),
      fromJobIds
    );
    if (reachable.size === 0) return [];

    const queued = new Set(graph.filter((j) => j.state === 'queued').map((j) => j.id));
    const toSkip = [...reachable].filter((id) => queued.has(id));

    for (const id of toSkip) {
      await tx.run(
        `UPDATE jobs SET state = 'skipped', error = {error}, finished_at = {now}
          WHERE id = {id} AND state = 'queued'`,
        { id, error: 'skipped because a dependency did not succeed', now }
      );
    }
    return toSkip;
  }
}
