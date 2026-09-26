// src/conductor/routes/jobs.js - creating jobs, and reading them back
//
// A job is a pipeline run: compiling the repository's .conductor.yml at one
// commit produces the tasks that a worker will later claim. There are two
// ways in, differing only in the shape of what they accept.
//
//   POST /projects/:project/trigger  takes a push payload. It accepts the
//   generic one produced by hooks/post-receive and the push events of
//   GitHub, Gitea and GitLab, since they all carry the same three facts.
//
//   POST /projects/:project/jobs  takes those facts directly, for anything
//   driving the conductor deliberately rather than forwarding a hook.
//
// Nothing in either payload is trusted beyond which commit to look at: the
// pipeline is always read from the repository at that commit.
//
// A project with a trigger secret requires a valid signature. A project
// without one accepts unsigned requests, which is convenient on a private
// network and a bad idea anywhere else, so it is logged.

import { SHA_PATTERN } from '../../lib/git.js';
import { canManageProject } from '../../lib/projects.js';
import { verifySignature } from '../../lib/signature.js';
import { ok } from './envelope.js';
import { visible } from './guard.js';
import {
  Conflict, InvalidSha, InvalidSignature, MalformedJson, NoCommitInPayload,
  NotPermitted, ProjectDisabled, ShaRequired, UnknownJob, UnknownProject,
} from '../../lib/errors.js';
import { limitOf, offsetOfQuery, pageBlock, paginateOffset } from '../../lib/page.js';

const ZERO_SHA = '0'.repeat(40);

export default async function jobRoutes(fastify, { cfg, auth, db, projects, scheduler, logger }) {
  const base = cfg.server.public_url.replace(/\/+$/, '');

  // HMAC is computed over the exact bytes received, so the raw body has to
  // survive JSON parsing.
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body;
    if (body.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch {
      done(new MalformedJson());
    }
  });

  // Shared by both creation routes: resolve the project, check the secret.
  async function authorizedProject(req) {
    const project = await projects.get(req.params.project);
    if (!project) throw new UnknownProject();
    if (project.enabled !== 1) throw new ProjectDisabled();

    const secret = projects.triggerSecret(project);
    if (secret) {
      if (!verifySignature(req, secret)) throw new InvalidSignature();
    } else {
      logger.warn?.(`project ${project.id} accepted an unsigned request; set a trigger secret`);
    }
    return project;
  }

  // Records the job as pending and returns immediately. Pipeline compilation
  // runs in the background; errors surface as the job transitioning to 'failed'.
  async function create(reply, project, { ref, base: baseSha, sha, actor, trigger }) {
    const { jobId } = await scheduler.createJob(project, {
      ref,
      baseSha,
      headSha: sha,
      trigger,
      actor,
    });
    return ok(reply, { status: 'created', job_id: jobId });
  }

  fastify.post('/projects/:project/trigger', async (req, reply) => {
    const project = await authorizedProject(req);

    const push = normalizePush(req.body);
    if (!push) throw new NoCommitInPayload();

    // A branch deletion is not a thing to build, and saying so is more
    // useful than refusing it.
    if (push.sha === ZERO_SHA) {
      return ok(reply, { status: 'ignored', reason: 'branch deletion' });
    }
    if (!SHA_PATTERN.test(push.sha)) {
      throw new InvalidSha(`Not a full commit id: ${JSON.stringify(push.sha)}`);
    }

    return create(reply, project, { ...push, trigger: 'push' });
  });

  // The deliberate form. Same authentication, no payload archaeology: a
  // caller that means to start a build says so, and a missing or malformed
  // commit is an error rather than something to infer.
  fastify.post('/projects/:project/jobs', async (req, reply) => {
    const project = await authorizedProject(req);

    const body = req.body ?? {};
    const sha = typeof body.sha === 'string' ? body.sha : null;
    if (!sha) throw new ShaRequired();
    if (!SHA_PATTERN.test(sha)) {
      throw new InvalidSha(`Not a full commit id: ${JSON.stringify(sha)}`);
    }

    return create(reply, project, {
      sha,
      base: usableSha(body.base),
      ref: typeof body.ref === 'string' ? body.ref : null,
      actor: typeof body.actor === 'string' ? body.actor : null,
      trigger: typeof body.trigger === 'string' ? body.trigger.slice(0, 32) : 'api',
    });
  });

  const JOB_COLUMNS = `j.id, j.project_id, j.number, j.ref, j.base_sha, j.head_sha,
    j.trigger_type, j.actor, j.title, j.state, j.visibility, j.error,
    j.created_at, j.started_at, j.finished_at`;

  // Holding the trigger secret is a third way in, so whatever starts a job
  // can see how it went without also being a signed in user.
  async function mayRead(req, project) {
    const secret = projects.triggerSecret(project);
    if (secret && verifySignature(req, secret)) return true;

    const user = await auth.identify(req).catch(() => null);
    return canManageProject(user, project);
  }

  async function listJobs(req, reply, { project = null } = {}) {
    const user = await auth.identify(req).catch(() => null);
    const scope = project && await mayRead(req, project)
      ? { sql: '1 = 1', params: {} }
      : visible(user, { project: 'p', job: 'j' });

    const filters = [scope.sql];
    const params = { ...scope.params };
    if (project) {
      filters.push('j.project_id = {project}');
      params.project = project.id;
    }
    if (typeof req.query.state === 'string') {
      filters.push('j.state = {state}');
      params.state = req.query.state;
    }

    const window = await paginateOffset(db, {
      select: JOB_COLUMNS,
      from: 'jobs j JOIN projects p ON p.id = j.project_id',
      where: filters.join(' AND '),
      order: 'j.created_at DESC',
      params,
      offset: offsetOfQuery(req.query),
      limit: limitOf(req.query),
    });

    return ok(reply, window.rows, pageBlock({ ...window, url: base + req.url }));
  }

  fastify.get('/jobs', async (req, reply) => listJobs(req, reply));

  fastify.get('/projects/:project/jobs', async (req, reply) => {
    const project = await projects.get(req.params.project);
    if (!project) throw new UnknownProject();
    return listJobs(req, reply, { project });
  });

  // A job id is unique on its own, so it is addressable with or without its
  // project. Spelling the project out asserts it rather than decorating it.
  function both(method, suffix, handler) {
    fastify[method](`/jobs/:job${suffix}`, handler);
    fastify[method](`/projects/:project/jobs/:job${suffix}`, handler);
  }

  // Missing rather than refused, so an id cannot be probed by status code.
  async function readableJob(req) {
    const user = await auth.identify(req).catch(() => null);
    const job = await db.get(
      `SELECT ${JOB_COLUMNS} FROM jobs j WHERE j.id = {id}`,
      { id: req.params.job }
    );
    if (!job) throw new UnknownJob();
    if (req.params.project !== undefined && req.params.project !== job.project_id) throw new UnknownJob();

    const project = await projects.get(job.project_id);
    if (job.visibility !== 'public' && !(await mayRead(req, project))) throw new UnknownJob();
    return { job, project, user };
  }

  both('get', '', async (req, reply) => ok(reply, (await readableJob(req)).job));

  // The edges come with the tasks: the stage graph cannot be drawn without
  // them, and nothing else exposes task_deps.
  both('get', '/tasks', async (req, reply) => {
    const { job } = await readableJob(req);

    const window = await paginateOffset(db, {
      select: `id, name, base_name, state, arch, attempt, exit_code, error,
               worker_name, created_at, started_at, finished_at`,
      from: 'tasks',
      where: 'job_id = {job}',
      order: 'created_at, name',
      params: { job: job.id },
      offset: offsetOfQuery(req.query),
      limit: limitOf(req.query),
    });

    const deps = await db.all(
      `SELECT d.task_id, d.depends_on_id, d.kind
         FROM task_deps d JOIN tasks t ON t.id = d.task_id
        WHERE t.job_id = {job}`,
      { job: job.id }
    );

    return ok(reply, { tasks: window.rows, deps }, pageBlock({ ...window, url: base + req.url }));
  });

  async function manageableJob(req) {
    const { job, project, user } = await readableJob(req);
    if (!canManageProject(user, project)) throw new NotPermitted();
    return { job, project, user };
  }

  both('post', '/cancel', async (req, reply) => {
    const { job, user } = await manageableJob(req);
    const outcome = await scheduler.cancelJob(job.id, `cancelled by ${user.username}`);
    if (!outcome.ok) throw new Conflict(outcome.reason);
    return ok(reply, { id: job.id, cancelled: true });
  });

  // A retry is a new job at the same commit, so the original stays readable.
  both('post', '/retry', async (req, reply) => {
    const { job, project, user } = await manageableJob(req);

    const created = await scheduler.createJob(project, {
      ref: job.ref,
      baseSha: job.base_sha,
      headSha: job.head_sha,
      trigger: 'manual',
      actor: user.username,
    });
    return ok(reply, { status: 'created', job_id: created.jobId });
  });
}

// Reduces the supported payload shapes to { sha, base, ref, actor }.
function normalizePush(body) {
  if (!body || typeof body !== 'object') return null;

  // hooks/post-receive, and anything else driving the API directly.
  if (typeof body.sha === 'string') {
    return {
      sha: body.sha,
      base: usableSha(body.base),
      ref: typeof body.ref === 'string' ? body.ref : null,
      actor: typeof body.actor === 'string' ? body.actor : null,
    };
  }

  // GitLab sends both checkout_sha and after; checkout_sha is the one that
  // refers to the tip of the pushed branch.
  if (typeof body.checkout_sha === 'string') {
    return {
      sha: body.checkout_sha,
      base: usableSha(body.before),
      ref: typeof body.ref === 'string' ? body.ref : null,
      actor: body.user_username ?? body.user_name ?? null,
    };
  }

  // GitHub and Gitea.
  if (typeof body.after === 'string') {
    return {
      sha: body.after,
      base: usableSha(body.before),
      ref: typeof body.ref === 'string' ? body.ref : null,
      actor: body.pusher?.name ?? body.pusher?.login ?? body.sender?.login ?? null,
    };
  }

  return null;
}

// A new branch reports an all zero parent, which is not a commit.
function usableSha(value) {
  if (typeof value !== 'string' || value === ZERO_SHA || !SHA_PATTERN.test(value)) return null;
  return value;
}
