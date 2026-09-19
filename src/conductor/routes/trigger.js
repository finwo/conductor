// src/conductor/routes/trigger.js - push notifications
//
// Accepts the generic payload produced by hooks/post-receive, and the push
// payloads of GitHub, Gitea and GitLab, since they all carry the same three
// facts. Nothing in the payload is trusted beyond which commit to look at:
// the pipeline is always read from the repository at that commit.
//
// A project with a trigger secret requires a valid signature. A project
// without one accepts unsigned triggers, which is convenient on a private
// network and a bad idea anywhere else, so it is logged.

import crypto from 'node:crypto';
import { SHA_PATTERN } from '../../lib/git.js';
import { PipelineError } from '../../lib/pipeline/index.js';

const ZERO_SHA = '0'.repeat(40);

export default async function triggerRoutes(fastify, { projects, scheduler, logger }) {
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

  fastify.post('/projects/:project/trigger', async (req, reply) => {
    const project = await projects.get(req.params.project);
    if (!project) return reply.code(404).send({ error: 'unknown project' });
    if (project.enabled !== 1) return reply.code(409).send({ error: 'project is disabled' });

    const secret = projects.triggerSecret(project);
    if (secret) {
      if (!verifySignature(req, secret)) {
        return reply.code(401).send({ error: 'invalid or missing signature' });
      }
    } else {
      logger.warn?.(`project ${project.id} accepted an unsigned trigger; set a trigger secret`);
    }

    const push = normalizePush(req.body);
    if (!push) {
      return reply.code(400).send({
        error: 'could not read a commit from the payload; expected sha, or a GitHub, Gitea or GitLab push event',
      });
    }
    if (push.sha === ZERO_SHA) {
      return reply.send({ status: 'ignored', reason: 'branch deletion' });
    }
    if (!SHA_PATTERN.test(push.sha)) {
      return reply.code(400).send({ error: `not a full commit id: ${JSON.stringify(push.sha)}` });
    }

    try {
      const { runId, jobCount } = await scheduler.createRun(project, {
        ref: push.ref,
        baseSha: push.base,
        headSha: push.sha,
        trigger: 'push',
        actor: push.actor,
      });
      return reply.send({ status: 'created', run_id: runId, jobs: jobCount });
    } catch (e) {
      if (e instanceof PipelineError) {
        // A broken pipeline is the pusher's problem, not a server fault.
        return reply.code(422).send({ error: 'invalid pipeline', detail: e.message, problems: e.errors });
      }
      req.log.error({ err: e }, `trigger failed for ${project.id}`);
      return reply.code(500).send({ error: 'could not create run', detail: String(e.message ?? e) });
    }
  });
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
