// src/conductor/scheduler.js - job creation, dispatch and completion
//
// A trigger creates a job. Compiling the repository's pipeline turns that job
// into tasks, and a task is what a worker runs.
//
// Scheduling reads the dependency edges in task_deps directly. Two defects in
// the prototype came from not doing that:
//
//   Dispatch was serialized. A single integer level per task was compared
//   against the lowest queued level, so only one task could run at a time
//   even when the graph allowed the whole width of it. Here any task whose
//   dependencies are all satisfied is eligible, and several workers can
//   claim different tasks concurrently.
//
//   Failure skipped only direct dependents. Transitive dependents stayed
//   queued and were later dispatched with their inputs missing. Here the
//   whole reachable set is skipped.
//
// Claiming is a conditional UPDATE guarded on the previous state, so two
// workers polling at the same instant cannot both win the same task.

import { compilePipeline, PipelineError, transitiveDependents, DEFAULT_WORKDIR } from '../lib/pipeline/index.js';
import { inClause } from '../lib/db/query.js';
import { newJobId, newTaskId } from '../lib/ids.js';
import { keys as storageKeys } from '../lib/storage/index.js';

export const JOB_STATES = ['pending', 'running', 'success', 'failed', 'cancelled'];
export const TASK_STATES = ['queued', 'running', 'success', 'failed', 'skipped', 'cancelled'];

// States that let a dependent proceed.
const TERMINAL = ['success', 'failed', 'skipped', 'cancelled'];

// The two spellings a repository may use without being configured for it.
export const CONVENTIONAL_CONFIG_PATHS = ['.conductor.yml', '.conductor.yaml'];

export function createScheduler({ cfg, db, git, logs, storage, projects, variables = null, logger = console }) {
  // A task is eligible when it is queued, its job is live, and no dependency
  // is outstanding. A failed dependency marked allow_failure still counts as
  // satisfied, which is the whole point of the flag.
  const ELIGIBLE = `
    SELECT t.id, t.job_id, t.name, t.arch, t.image, t.requires, t.spec,
           t.timeout, t.attempt, t.max_attempts,
           j.head_sha, j.project_id, j.ref, j.number
      FROM tasks t
      JOIN jobs j ON j.id = t.job_id
      JOIN projects p ON p.id = j.project_id
     WHERE t.state = 'queued'
       AND j.state = 'running'
       AND NOT EXISTS (
             SELECT 1
               FROM task_deps d
               JOIN tasks dt ON dt.id = d.depends_on_id
              WHERE d.task_id = t.id
                AND dt.state <> 'success'
                AND NOT (dt.state = 'failed' AND dt.allow_failure = 1)
           )
  `;

  async function loadGraph(tx, jobId) {
    const tasks = await tx.all(
      'SELECT id, name, state, allow_failure FROM tasks WHERE job_id = {job}',
      { job: jobId }
    );
    const deps = await tx.all(
      `SELECT d.task_id, d.depends_on_id
         FROM task_deps d
         JOIN tasks t ON t.id = d.task_id
        WHERE t.job_id = {job}`,
      { job: jobId }
    );
    const needs = new Map(tasks.map((t) => [t.id, []]));
    for (const d of deps) needs.get(d.task_id)?.push(d.depends_on_id);
    return tasks.map((t) => ({ ...t, needs: needs.get(t.id) ?? [] }));
  }

  // Reads the pipeline file at a commit.
  //
  // A project that has not been told otherwise accepts either conventional
  // spelling, so a repository may use .conductor.yml or .conductor.yaml
  // without anyone configuring it. Only the conventional names get that
  // fallback: a project pointed at ci/build.yml means that file and nothing
  // else. Finding both is an error rather than a coin toss, since two
  // pipelines in one repository will disagree sooner or later.
  async function readPipelineFile(project, sha) {
    const wanted = project.config_path;
    const alternate = CONVENTIONAL_CONFIG_PATHS.find((p) => p !== wanted);
    const candidates = CONVENTIONAL_CONFIG_PATHS.includes(wanted) ? [wanted, alternate] : [wanted];

    const found = [];
    for (const path of candidates) {
      const text = await git.readFile(project, sha, path);
      if (text !== null) found.push({ path, text });
    }

    if (found.length > 1) {
      throw new PipelineError(
        [{
          path: '',
          message: `${found.map((f) => f.path).join(' and ')} both exist at ` +
            `${sha.slice(0, 12)}; keep one`,
        }],
        wanted
      );
    }
    return found[0] ?? null;
  }

  // Marks the job finished once nothing is left to do.
  async function settleJob(tx, jobId) {
    const outstanding = await tx.get(
      "SELECT COUNT(*) AS c FROM tasks WHERE job_id = {job} AND state IN ('queued', 'running')",
      { job: jobId }
    );
    if (outstanding.c > 0) return null;

    const bad = await tx.get(
      `SELECT COUNT(*) AS c FROM tasks
        WHERE job_id = {job}
          AND (state IN ('skipped', 'cancelled')
               OR (state = 'failed' AND allow_failure = 0))`,
      { job: jobId }
    );
    const state = bad.c > 0 ? 'failed' : 'success';
    await tx.run(
      "UPDATE jobs SET state = {state}, finished_at = {now} WHERE id = {job} AND state = 'running'",
      { state, job: jobId, now: Date.now() }
    );
    return state;
  }

  // Background compilation: git sync, pipeline read/compile, task creation.
  // Updates the job from 'pending' to either 'running' (with tasks) or
  // 'failed' (with an error). This is what lets a push hook return immediately.
  async function compileAndDispatch(project, jobId, { ref, baseSha, headSha }) {
    try {
      await git.sync(project, { force: true });

      if (!(await git.hasCommit(project, headSha))) {
        throw new Error(`commit ${headSha} is not present in the mirror of ${project.id}`);
      }

      const found = await readPipelineFile(project, headSha);
      if (found === null) {
        throw new PipelineError(
          [{ path: '', message: `${project.config_path} not found at ${headSha.slice(0, 12)}` }],
          project.config_path
        );
      }

      const pipeline = compilePipeline(found.text, {
        source: found.path,
        defaultTimeout: cfg.scheduler.default_task_timeout,
        defaultAttempts: 1,
        ref: ref ?? '',
      });

      const info = await git.commitInfo(project, headSha).catch(() => ({ subject: null }));
      const now = Date.now();
      const visibility = pipeline.visibility ?? project.visibility ?? 'private';
      const workdir = pipeline.workdir ?? project.workdir ?? DEFAULT_WORKDIR;

      await db.transaction(async (tx) => {
        const empty = pipeline.tasks.length === 0;

        await tx.run(
          `UPDATE jobs
              SET title = {title}, state = {state}, pipeline = {pipeline},
                  visibility = {visibility}, started_at = {started}, finished_at = {finished}
            WHERE id = {id}`,
          {
            id: jobId,
            title: info.subject ?? null,
            state: empty ? 'success' : 'running',
            pipeline: JSON.stringify({ version: pipeline.version, tasks: pipeline.tasks }),
            visibility,
            started: now,
            finished: empty ? now : null,
          }
        );

        const idByName = new Map(pipeline.tasks.map((t) => [t.name, newTaskId()]));

        for (const task of pipeline.tasks) {
          await tx.run(
            `INSERT INTO tasks
               (id, job_id, name, base_name, arch, image, requires, spec, state,
                allow_failure, attempt, max_attempts, timeout, log_size, created_at)
             VALUES
               ({id}, {job}, {name}, {base}, {arch}, {image}, {requires}, {spec}, 'queued',
                {allow}, 0, {attempts}, {timeout}, 0, {now})`,
            {
              id: idByName.get(task.name),
              job: jobId,
              name: task.name,
              base: task.baseName,
              arch: task.arch,
              image: task.image,
              requires: JSON.stringify(task.requires),
              spec: JSON.stringify({
                script: task.script,
                env: task.env,
                services: task.services,
                artifacts: task.artifacts,
                matrix: task.matrix,
                needs: task.needs,
                depth: task.depth,
                workdir,
              }),
              allow: task.allow_failure ? 1 : 0,
              attempts: task.max_attempts,
              timeout: task.timeout,
              now,
            }
          );
        }

        for (const task of pipeline.tasks) {
          for (const need of task.needs) {
            await tx.run(
              'INSERT INTO task_deps (task_id, depends_on_id) VALUES ({task}, {dep})',
              { task: idByName.get(task.name), dep: idByName.get(need) }
            );
          }
        }
      });

      logger.info?.(`job ${jobId} ready with ${pipeline.tasks.length} task(s)`);
    } catch (e) {
      await db.run(
        `UPDATE jobs SET state = 'failed', error = {error}, finished_at = {now} WHERE id = {id}`,
        { id: jobId, error: String(e.message ?? e).slice(0, 1024), now: Date.now() }
      );
    }
  }

  return {
    // Records a job as 'pending' and returns immediately. Git sync and pipeline
    // compilation happen in the background via compileAndDispatch, which updates
    // the job to 'running' (with tasks) or 'failed' once done. This ensures a
    // push hook never blocks on fetching or parsing.
    async createJob(project, { ref, baseSha, headSha, trigger = 'push', actor = null }) {
      const jobId = newJobId();
      const now = Date.now();

      await db.transaction(async (tx) => {
        const number = await projects.nextJobNumber(tx, project.id);

        await tx.run(
          `INSERT INTO jobs
             (id, project_id, number, ref, base_sha, head_sha, trigger_type, actor,
              title, state, pipeline, visibility, created_at, started_at, finished_at)
           VALUES
             ({id}, {project}, {number}, {ref}, {base}, {head}, {trigger}, {actor},
              {title}, {state}, {pipeline}, {visibility}, {now}, {started}, {finished})`,
          {
            id: jobId,
            project: project.id,
            number,
            ref: ref ?? null,
            base: baseSha ?? null,
            head: headSha,
            trigger,
            actor,
            title: null,
            state: 'pending',
            pipeline: null,
            visibility: project.visibility ?? 'private',
            now,
            started: null,
            finished: null,
          }
        );
      });

      logger.info?.(`job ${jobId} recorded for ${project.id}`);

      compileAndDispatch(project, jobId, { ref, baseSha, headSha });

      return { jobId };
    },

    // Hands one task to a worker. The worker advertises what it can run;
    // tasks asking for anything it lacks are passed over.
    //
    // ownerId scopes the worker to one user's projects. That is the whole
    // basis of letting people contribute their own hardware: a worker
    // someone registers is never offered anybody else's work. A worker
    // with no owner is shared capacity and sees everything.
    async claim({ arches = [], features = [], tokenId, workerName, ownerId = null }) {
      const archFilter = inClause('arch', arches);
      const featureSet = new Set(features);

      // Oldest job first, so a queue drains in order rather than starving
      // whichever job happens to sort last.
      const candidates = await db.all(
        `${ELIGIBLE}
           AND (t.arch IS NULL${archFilter.empty ? '' : ` OR t.arch IN (${archFilter.sql})`})
           ${ownerId === null ? '' : 'AND p.owner_id = {owner}'}
         ORDER BY j.created_at ASC, t.created_at ASC
         LIMIT 100`,
        { ...archFilter.params, ...(ownerId === null ? {} : { owner: ownerId }) }
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
          `UPDATE tasks
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
        // worker, never written into the tasks table, so the only place a
        // secret rests is project_variables.
        let injected = { env: {}, masked: [] };
        if (variables) {
          try {
            injected = await variables.resolve(candidate.project_id);
          } catch (e) {
            logger.warn?.(`could not resolve variables for ${candidate.project_id}: ${e.message}`);
          }
        }

        // project_id and job_id are returned for the route to use, not for
        // the worker. What the worker is handed is assembled in the route,
        // and deliberately carries neither.
        return {
          id: candidate.id,
          job_id: candidate.job_id,
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
          // task. Ordered so a pipeline cannot quietly redefine the last
          // group, and a variable cannot shadow an explicit task setting.
          //
          // These name the project and job the worker is not told about,
          // which is deliberate: they are opaque strings bound for the
          // script, and the worker only copies them into the container.
          env: {
            ...injected.env,
            ...spec.env,
            CONDUCTOR_PROJECT: candidate.project_id,
            CONDUCTOR_JOB_ID: candidate.job_id,
            CONDUCTOR_JOB_NUMBER: String(candidate.number),
            CONDUCTOR_TASK: candidate.name,
            CONDUCTOR_TASK_ID: candidate.id,
            CONDUCTOR_SHA: candidate.head_sha,
            CONDUCTOR_REF: candidate.ref ?? '',
            CONDUCTOR_ATTEMPT: String(attempt),
          },
          services: spec.services,
          artifacts: spec.artifacts,
          workdir: spec.workdir ?? DEFAULT_WORKDIR,
        };
      }

      return null;
    },

    async heartbeat(taskId, tokenId) {
      const task = await db.get(
        'SELECT id, state, worker_token_id FROM tasks WHERE id = {id}',
        { id: taskId }
      );
      if (!task) return { known: false };
      if (task.worker_token_id !== tokenId) return { known: false };

      if (task.state === 'running') {
        await db.run('UPDATE tasks SET heartbeat_at = {now} WHERE id = {id}', { id: taskId, now: Date.now() });
        return { known: true, cancelled: false };
      }
      // The task was cancelled or reaped out from under the worker, which is
      // how a worker learns to stop.
      return { known: true, cancelled: true, state: task.state };
    },

    // Records the outcome, retries if attempts remain, and otherwise skips
    // everything downstream.
    async complete(taskId, { success, exitCode = null, error = null, tokenId = null }) {
      return db.transaction(async (tx) => {
        const task = await tx.get(
          `SELECT id, job_id, name, state, attempt, max_attempts, allow_failure, worker_token_id
             FROM tasks WHERE id = {id}`,
          { id: taskId }
        );
        // cause is the stable half of this: reason is prose and may be
        // reworded, so nothing downstream should be reading it to branch on.
        if (!task) return { ok: false, cause: 'unknown-task', reason: 'unknown task' };
        if (tokenId !== null && task.worker_token_id !== tokenId) {
          return { ok: false, cause: 'not-held', reason: 'task belongs to another worker' };
        }
        if (task.state !== 'running') {
          return { ok: false, cause: 'not-running', reason: `task is ${task.state}, not running` };
        }

        const now = Date.now();

        if (success) {
          await tx.run(
            "UPDATE tasks SET state = 'success', exit_code = {code}, finished_at = {now} WHERE id = {id}",
            { id: taskId, code: exitCode, now }
          );
          const jobState = await settleJob(tx, task.job_id);
          return { ok: true, state: 'success', jobState };
        }

        // Transient failure with attempts left: back to the queue rather
        // than failing the job.
        if (task.attempt < task.max_attempts) {
          await tx.run(
            `UPDATE tasks
                SET state = 'queued', exit_code = {code}, error = {error},
                    worker_token_id = NULL, worker_name = NULL,
                    claimed_at = NULL, heartbeat_at = NULL, started_at = NULL
              WHERE id = {id}`,
            { id: taskId, code: exitCode, error }
          );
          return { ok: true, state: 'queued', retry: true, attempt: task.attempt };
        }

        await tx.run(
          "UPDATE tasks SET state = 'failed', exit_code = {code}, error = {error}, finished_at = {now} WHERE id = {id}",
          { id: taskId, code: exitCode, error, now }
        );

        let skipped = [];
        if (!task.allow_failure) {
          skipped = await skipDependents(tx, task.job_id, [taskId], now);
        }

        const jobState = await settleJob(tx, task.job_id);
        return { ok: true, state: 'failed', skipped, jobState };
      });
    },

    // Every task reachable from the failed ones, not just their immediate
    // dependents.
    async skipDependents(jobId, fromTaskIds) {
      return db.transaction((tx) => skipDependents(tx, jobId, fromTaskIds, Date.now()));
    },

    // Requeues or fails tasks whose worker stopped reporting.
    async reap() {
      const cutoff = Date.now() - cfg.scheduler.heartbeat_timeout * 1000;
      const stale = await db.all(
        `SELECT id, job_id, name, attempt, max_attempts, worker_name
           FROM tasks
          WHERE state = 'running' AND heartbeat_at IS NOT NULL AND heartbeat_at < {cutoff}`,
        { cutoff }
      );

      const results = [];
      for (const task of stale) {
        const outcome = await this.complete(task.id, {
          success: false,
          error: `worker ${task.worker_name ?? 'unknown'} stopped reporting for more than ` +
                 `${cfg.scheduler.heartbeat_timeout}s`,
        });
        if (outcome.ok) {
          logger.warn?.(`reaped ${task.name} (${task.id}): ${outcome.retry ? 'requeued' : 'failed'}`);
          results.push({ id: task.id, ...outcome });
        }
      }
      return results;
    },

    async cancelJob(jobId, reason = 'cancelled by request') {
      return db.transaction(async (tx) => {
        const job = await tx.get('SELECT id, state FROM jobs WHERE id = {id}', { id: jobId });
        if (!job) return { ok: false, reason: 'unknown job' };
        if (job.state !== 'running') return { ok: false, reason: `job is ${job.state}` };

        const now = Date.now();
        await tx.run(
          `UPDATE tasks SET state = 'cancelled', error = {reason}, finished_at = {now}
            WHERE job_id = {job} AND state IN ('queued', 'running')`,
          { job: jobId, reason, now }
        );
        await tx.run(
          "UPDATE jobs SET state = 'cancelled', finished_at = {now} WHERE id = {job}",
          { job: jobId, now }
        );
        return { ok: true };
      });
    },

    // Called once a task finishes so the live log stops being the spool copy.
    async finalizeLog(jobId, taskId) {
      const key = storageKeys.log(jobId, taskId);
      const { size } = await logs.finalize(jobId, taskId, storage, key);
      if (size > 0) {
        await db.run('UPDATE tasks SET log_key = {key}, log_size = {size} WHERE id = {id}',
          { id: taskId, key, size });
      }
      return { key, size };
    },

    TERMINAL,
  };

  async function skipDependents(tx, jobId, fromTaskIds, now) {
    const graph = await loadGraph(tx, jobId);
    const reachable = transitiveDependents(
      graph.map((t) => ({ name: t.id, needs: t.needs })),
      fromTaskIds
    );
    if (reachable.size === 0) return [];

    const queued = new Set(graph.filter((t) => t.state === 'queued').map((t) => t.id));
    const toSkip = [...reachable].filter((id) => queued.has(id));

    for (const id of toSkip) {
      await tx.run(
        `UPDATE tasks SET state = 'skipped', error = {error}, finished_at = {now}
          WHERE id = {id} AND state = 'queued'`,
        { id, error: 'skipped because a dependency did not succeed', now }
      );
    }
    return toSkip;
  }
}
