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

import crypto from 'node:crypto';
import { SHA_PATTERN } from '../../lib/git.js';
import { PipelineError } from '../../lib/pipeline/index.js';
import { canManageProject } from '../../lib/projects.js';

const ZERO_SHA = '0'.repeat(40);

export default async function jobRoutes(fastify, { auth, db, projects, scheduler, logger }) {
  // HMAC is computed over the exact bytes received, so the raw body has to
  // survive JSON parsing.
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body;
    if (body.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch (e) {
      e.statusCode = 400;
      done(e);
    }
  });

  // Shared by both creation routes: resolve the project, check the secret.
  // Returns null once it has already answered.
  async function authorizedProject(req, reply) {
    const project = await projects.get(req.params.project);
    if (!project) {
      reply.code(404).send({ error: 'unknown project' });
      return null;
    }
    if (project.enabled !== 1) {
      reply.code(409).send({ error: 'project is disabled' });
      return null;
    }

    const secret = projects.triggerSecret(project);
    if (secret) {
      if (!verifySignature(req, secret)) {
        reply.code(401).send({ error: 'invalid or missing signature' });
        return null;
      }
    } else {
      logger.warn?.(`project ${project.id} accepted an unsigned request; set a trigger secret`);
    }
    return project;
  }

  // Compiles the pipeline and records the job, or answers with the reason
  // it could not.
  async function create(reply, req, project, { ref, base, sha, actor, trigger }) {
    try {
      const { jobId, taskCount } = await scheduler.createJob(project, {
        ref,
        baseSha: base,
        headSha: sha,
        trigger,
        actor,
      });
      return reply.send({ status: 'created', job_id: jobId, tasks: taskCount });
    } catch (e) {
      if (e instanceof PipelineError) {
        // A broken pipeline is the caller's problem, not a server fault.
        return reply.code(422).send({ error: 'invalid pipeline', detail: e.message, problems: e.errors });
      }
      req.log.error({ err: e }, `could not create a job for ${project.id}`);
      return reply.code(500).send({ error: 'could not create job', detail: String(e.message ?? e) });
    }
  }

  fastify.post('/projects/:project/trigger', async (req, reply) => {
    const project = await authorizedProject(req, reply);
    if (!project) return reply;

    const push = normalizePush(req.body);
    if (!push) {
      return reply.code(400).send({
        error: 'could not read a commit from the payload; expected sha, or a GitHub, Gitea or GitLab push event',
      });
    }
    // A branch deletion is not a thing to build, and saying so is more
    // useful than refusing it.
    if (push.sha === ZERO_SHA) {
      return reply.send({ status: 'ignored', reason: 'branch deletion' });
    }
    if (!SHA_PATTERN.test(push.sha)) {
      return reply.code(400).send({ error: `not a full commit id: ${JSON.stringify(push.sha)}` });
    }

    return create(reply, req, project, { ...push, trigger: 'push' });
  });

  // The deliberate form. Same authentication, no payload archaeology: a
  // caller that means to start a build says so, and a missing or malformed
  // commit is an error rather than something to infer.
  fastify.post('/projects/:project/jobs', async (req, reply) => {
    const project = await authorizedProject(req, reply);
    if (!project) return reply;

    const body = req.body ?? {};
    const sha = typeof body.sha === 'string' ? body.sha : null;
    if (!sha) return reply.code(400).send({ error: 'sha is required' });
    if (!SHA_PATTERN.test(sha)) {
      return reply.code(400).send({ error: `not a full commit id: ${JSON.stringify(sha)}` });
    }

    return create(reply, req, project, {
      sha,
      base: usableSha(body.base),
      ref: typeof body.ref === 'string' ? body.ref : null,
      actor: typeof body.actor === 'string' ? body.actor : null,
      trigger: typeof body.trigger === 'string' ? body.trigger.slice(0, 32) : 'api',
    });
  });

  // Read one back. A caller that can start a job should be able to see how
  // it went, and scraping the interface for that is no kind of answer.
  //
  // Three ways to be allowed: the job is public, the caller holds the
  // project's trigger secret, or the caller is signed in and may manage the
  // project. Refusal is a 404 either way, so this cannot be used to probe
  // which jobs exist.
  fastify.get('/projects/:project/jobs/:job', async (req, reply) => {
    const project = await projects.get(req.params.project);
    if (!project) return reply.code(404).send({ error: 'unknown job' });

    const job = await db.get(
      `SELECT id, project_id, number, ref, head_sha, trigger_type, actor, title,
              state, visibility, error, created_at, started_at, finished_at
         FROM jobs
        WHERE id = {id} AND project_id = {project}`,
      { id: req.params.job, project: project.id }
    );
    if (!job) return reply.code(404).send({ error: 'unknown job' });

    if (job.visibility !== 'public' && !(await mayRead(req, project))) {
      return reply.code(404).send({ error: 'unknown job' });
    }

    const tasks = await db.all(
      `SELECT id, name, state, arch, attempt, exit_code, error,
              worker_name, created_at, started_at, finished_at
         FROM tasks
        WHERE job_id = {job}
        ORDER BY created_at, name`,
      { job: job.id }
    );

    return reply.send({ job, tasks });
  });

  async function mayRead(req, project) {
    const secret = projects.triggerSecret(project);
    if (secret && verifySignature(req, secret)) return true;

    const user = await auth.identify(req).catch(() => null);
    return canManageProject(user, project);
  }
}

function verifySignature(req, secret) {
  const raw = req.rawBody ?? Buffer.alloc(0);

  // GitHub and Gitea: sha256=<hex> over the body.
  const hubSignature = req.headers['x-hub-signature-256'];
  if (typeof hubSignature === 'string' && hubSignature.length > 0) {
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
    return timingSafeEqual(expected, hubSignature);
  }

  // GitLab: the secret itself, compared rather than signed.
  const gitlabToken = req.headers['x-gitlab-token'];
  if (typeof gitlabToken === 'string' && gitlabToken.length > 0) {
    return timingSafeEqual(secret, gitlabToken);
  }

  return false;
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
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
