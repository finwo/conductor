// src/conductor/ui/routes.js - the server rendered interface
//
// Pages are rendered here rather than in a client application, so the
// interface has the same view of who you are and what you may see as the
// rest of the conductor. There is one visibility rule, in one place.
//
// Mutations require the HX-Request header, which htmx sets on every request
// it makes and which a cross site form post cannot set. Together with the
// SameSite cookie that is the CSRF defence.

import crypto from 'node:crypto';
import { toHtml, html } from './html.js';
import { layout } from './layout.js';
import {
  runsPage, runsTable, runPage, jobsTable, jobPage, jobLog, loginPage,
  projectsPage, projectPage, variablesTable, workersPage, workersTable,
  usersPage, usersTable,
} from './pages.js';
import { canManageProject, canViewProject, VISIBILITIES } from '../../lib/projects.js';
import { canManageWorker } from '../../lib/workers.js';
import { issueToken, sessionCookie, clearedCookie } from '../../lib/auth/index.js';
import { PipelineError } from '../../lib/pipeline/index.js';

const LOG_TAIL_BYTES = 256 * 1024;

export default async function uiRoutes(fastify, services) {
  const { cfg, db, auth, users, projects, workerTokens, variables, logs, scheduler } = services;
  const secure = cfg.server.public_url.startsWith('https://');

  // Forms post urlencoded bodies; htmx hx-vals posts json.
  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (req, body, done) => {
      const out = {};
      for (const [key, value] of new URLSearchParams(body)) out[key] = value;
      done(null, out);
    }
  );

  function send(reply, node) {
    reply.header('content-type', 'text/html; charset=utf-8');
    return reply.send(toHtml(node));
  }

  function page(reply, { title, user, body, active }) {
    return send(reply, layout({ title, user, body, active }));
  }

  const viewer = (req) => auth.identify(req).catch(() => null);

  // A signed in user, or a redirect to the sign in page.
  async function required(req, reply) {
    const user = await viewer(req);
    if (user) return user;
    if (req.headers['hx-request']) reply.header('hx-redirect', '/login').code(204).send();
    else reply.redirect('/login', 302);
    return null;
  }

  // State changing requests must come from our own interface.
  function fromUi(req, reply) {
    if (req.headers['hx-request']) return true;
    reply.code(400).send('this endpoint is for the conductor interface');
    return false;
  }

  // Tells htmx to reload, which is the simplest correct thing after a
  // change that affects more of the page than the triggering element.
  function refresh(reply, to = null) {
    if (to) reply.header('hx-redirect', to);
    else reply.header('hx-refresh', 'true');
    return reply.code(204).send();
  }

  function fail(reply, message, code = 400) {
    return reply.code(code).header('content-type', 'text/html; charset=utf-8')
      .send(toHtml(html`<p class="error">${message}</p>`));
  }

  // --- runs ---

  async function visibleRuns(user, projectId = null) {
    const scope = user && user.role === 'admin'
      ? { sql: '1 = 1', params: {} }
      : user
        ? { sql: "(r.visibility = 'public' OR p.owner_id = {viewerId})", params: { viewerId: user.id } }
        : { sql: "r.visibility = 'public'", params: {} };

    return db.all(
      `SELECT r.id, r.project_id, r.number, r.ref, r.head_sha, r.state, r.visibility,
              r.title, r.created_at, r.started_at, r.finished_at
         FROM runs r JOIN projects p ON p.id = r.project_id
        WHERE ${scope.sql} ${projectId ? 'AND r.project_id = {project}' : ''}
        ORDER BY r.created_at DESC LIMIT 50`,
      { ...scope.params, ...(projectId ? { project: projectId } : {}) }
    );
  }

  fastify.get('/', async (req, reply) => {
    const user = await viewer(req);
    const runs = await visibleRuns(user, typeof req.query.project === 'string' ? req.query.project : null);
    return page(reply, {
      title: 'runs',
      user,
      active: 'runs',
      body: runsPage({ runs, user, anonymous: !user }),
    });
  });

  fastify.get('/runs', async (req, reply) => {
    const user = await viewer(req);
    const runs = await visibleRuns(user, typeof req.query.project === 'string' ? req.query.project : null);
    return page(reply, { title: 'runs', user, active: 'runs', body: runsPage({ runs, user, anonymous: !user }) });
  });

  fastify.get('/partials/runs', async (req, reply) => {
    const user = await viewer(req);
    return send(reply, runsTable(await visibleRuns(user)));
  });

  // Loads a run the caller may see, along with whether they may act on it.
  async function runFor(req, reply) {
    const user = await viewer(req);
    const run = await db.get('SELECT * FROM runs WHERE id = {id}', { id: req.params.id });
    if (!run) {
      reply.code(404);
      return { user, run: null };
    }
    const project = await projects.get(run.project_id);
    if (run.visibility !== 'public' && !canManageProject(user, project)) {
      reply.code(404);
      return { user, run: null };
    }
    return { user, run, project, canManage: canManageProject(user, project) };
  }

  async function jobsOf(runId) {
    const jobs = await db.all(
      `SELECT id, name, arch, state, worker_name, exit_code, started_at, finished_at
         FROM jobs WHERE run_id = {run} ORDER BY name`,
      { run: runId }
    );
    const deps = await db.all(
      `SELECT d.job_id, d.depends_on_id FROM job_deps d
         JOIN jobs j ON j.id = d.job_id WHERE j.run_id = {run}`,
      { run: runId }
    );
    const needs = new Map(jobs.map((j) => [j.id, []]));
    for (const d of deps) needs.get(d.job_id)?.push(d.depends_on_id);
    return jobs.map((j) => ({ ...j, needs: needs.get(j.id) ?? [] }));
  }

  fastify.get('/runs/:id', async (req, reply) => {
    const { user, run, canManage } = await runFor(req, reply);
    if (!run) return page(reply, { title: 'not found', user, body: html`<p class="error">No such run.</p>` });

    return page(reply, {
      title: `run #${run.number}`,
      user,
      active: 'runs',
      body: runPage({ run, jobs: await jobsOf(run.id), canManage }),
    });
  });

  fastify.get('/partials/runs/:id/jobs', async (req, reply) => {
    const { run } = await runFor(req, reply);
    if (!run) return reply.send('');
    return send(reply, jobsTable(run, await jobsOf(run.id)));
  });

  fastify.post('/runs/:id/cancel', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    const user = await required(req, reply);
    if (!user) return reply;

    const { run, canManage } = await runFor(req, reply);
    if (!run || !canManage) return fail(reply, 'Not yours to manage.', 403);

    await scheduler.cancelRun(run.id, `cancelled by ${user.username}`);
    const fresh = await db.get('SELECT * FROM runs WHERE id = {id}', { id: run.id });
    return send(reply, jobsTable(fresh, await jobsOf(run.id)));
  });

  fastify.post('/runs/:id/retry', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    const user = await required(req, reply);
    if (!user) return reply;

    const { run, project, canManage } = await runFor(req, reply);
    if (!run || !canManage) return fail(reply, 'Not yours to manage.', 403);

    try {
      const created = await scheduler.createRun(project, {
        ref: run.ref,
        baseSha: run.base_sha,
        headSha: run.head_sha,
        trigger: 'manual',
        actor: user.username,
      });
      return refresh(reply, `/runs/${created.runId}`);
    } catch (e) {
      return fail(reply, e instanceof PipelineError ? e.message : String(e.message ?? e), 422);
    }
  });

  // --- jobs ---

  fastify.get('/jobs/:id', async (req, reply) => {
    const user = await viewer(req);
    const job = await db.get(
      `SELECT j.*, r.visibility, r.project_id FROM jobs j
         JOIN runs r ON r.id = j.run_id WHERE j.id = {id}`,
      { id: req.params.id }
    );
    if (!job) return page(reply, { title: 'not found', user, body: html`<p class="error">No such job.</p>` });

    const project = await projects.get(job.project_id);
    if (job.visibility !== 'public' && !canManageProject(user, project)) {
      return page(reply, { title: 'not found', user, body: html`<p class="error">No such job.</p>` });
    }

    const artifacts = await db.all(
      'SELECT id, path, size, sha256 FROM artifacts WHERE job_id = {job} ORDER BY path',
      { job: job.id }
    );

    return page(reply, {
      title: job.name,
      user,
      active: 'runs',
      body: jobPage({ job, artifacts, log: await tailOf(job) }),
    });
  });

  fastify.get('/partials/jobs/:id/log', async (req, reply) => {
    const user = await viewer(req);
    const job = await db.get(
      `SELECT j.*, r.visibility, r.project_id FROM jobs j
         JOIN runs r ON r.id = j.run_id WHERE j.id = {id}`,
      { id: req.params.id }
    );
    if (!job) return reply.send('');

    const project = await projects.get(job.project_id);
    if (job.visibility !== 'public' && !canManageProject(user, project)) return reply.send('');

    return send(reply, jobLog(job, await tailOf(job)));
  });

  // The last window of output. Replacing the whole pane each poll keeps the
  // fragment self contained, and a cap keeps a runaway log from being
  // re-sent in full every two seconds.
  async function tailOf(job) {
    if (!job.log_key) {
      const size = await logs.size(job.run_id, job.id);
      const offset = Math.max(0, size - LOG_TAIL_BYTES);
      const chunk = await logs.read(job.run_id, job.id, { offset, limit: LOG_TAIL_BYTES });
      return chunk.data.toString('utf8');
    }
    try {
      const start = Math.max(0, (job.log_size ?? 0) - LOG_TAIL_BYTES);
      const object = await services.storage.get(job.log_key, { range: { start } });
      const parts = [];
      for await (const part of object.stream) parts.push(part);
      return Buffer.concat(parts).toString('utf8');
    } catch {
      return '';
    }
  }

  // --- session ---

  fastify.get('/login', async (req, reply) => {
    const user = await viewer(req);
    if (user) return reply.redirect('/', 302);
    return page(reply, {
      title: 'sign in',
      user: null,
      body: loginPage({ localLogin: auth.localLogin, issuer: cfg.auth.oidc.issuer }),
    });
  });

  fastify.post('/login', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    if (!auth.localLogin) return fail(reply, 'This conductor authenticates through its identity provider.');

    const { username, password } = req.body ?? {};
    const user = await users.authenticate(String(username ?? ''), String(password ?? ''));
    if (!user) {
      return reply.code(401).header('content-type', 'text/html; charset=utf-8')
        .send(toHtml(loginPage({ error: 'Invalid username or password.', localLogin: true })));
    }

    const ttl = cfg.auth.session_ttl;
    const token = issueToken(cfg.auth.session_secret, { sub: user.id, name: user.username, role: user.role }, { ttl });
    reply.header('set-cookie', sessionCookie(token, { ttl, secure }));
    return refresh(reply, '/');
  });

  fastify.post('/logout', async (req, reply) => {
    reply.header('set-cookie', clearedCookie());
    return refresh(reply, '/');
  });

  // --- projects ---

  fastify.get('/projects', async (req, reply) => {
    const user = await required(req, reply);
    if (!user) return reply;
    const rows = user.role === 'admin' ? await projects.list() : await projects.listOwnedBy(user.id);
    return page(reply, { title: 'projects', user, active: 'projects', body: projectsPage({ projects: rows, user }) });
  });

  fastify.post('/projects', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    const user = await required(req, reply);
    if (!user) return reply;

    const body = req.body ?? {};
    if (!body.repo_url) return fail(reply, 'A repository URL is required.');
    if (body.visibility && !VISIBILITIES.includes(body.visibility)) return fail(reply, 'Invalid visibility.');

    const secret = crypto.randomUUID().replace(/-/g, '');
    try {
      const project = await projects.create({
        id: body.id,
        name: body.name || body.id,
        repo_url: body.repo_url,
        config_path: body.config_path || '.conductor.yml',
        visibility: body.visibility || 'private',
        owner_id: user.id,
        trigger_secret: secret,
      });
      // The secret is shown once, on the page that follows.
      return refresh(reply, `/projects/${project.id}?created=1`);
    } catch (e) {
      return fail(reply, e.message);
    }
  });

  async function projectFor(req, reply) {
    const user = await required(req, reply);
    if (!user) return null;
    const project = await projects.get(req.params.id);
    if (!project || !canManageProject(user, project)) {
      fail(reply, 'No such project.', 404);
      return null;
    }
    return { user, project };
  }

  fastify.get('/projects/:id', async (req, reply) => {
    const user = await required(req, reply);
    if (!user) return reply;
    const project = await projects.get(req.params.id);
    if (!project || !canManageProject(user, project)) {
      return page(reply, { title: 'not found', user, body: html`<p class="error">No such project.</p>` });
    }

    // Revealed only on the redirect that follows creating or rotating it,
    // so an ordinary visit to the page never shows the value.
    const secret = req.query.created === '1' ? projects.triggerSecret(project) : null;

    return page(reply, {
      title: project.id,
      user,
      active: 'projects',
      body: projectPage({
        project,
        user,
        variables: await variables.list(project.id),
        triggerUrl: `${cfg.server.public_url.replace(/\/+$/, '')}/api/trigger/${project.id}`,
        secret,
        // What an empty field falls back to, so the form can say so
        // rather than looking unset.
        retention: cfg.retention,
      }),
    });
  });

  fastify.patch('/projects/:id', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    const found = await projectFor(req, reply);
    if (!found) return reply;

    const body = req.body ?? {};
    try {
      if (body.visibility) await projects.setVisibility(found.project.id, body.visibility);
      if (body.enabled !== undefined) await projects.setEnabled(found.project.id, body.enabled === 'true' || body.enabled === true);
    } catch (e) {
      return fail(reply, e.message);
    }
    return refresh(reply);
  });

  fastify.patch('/projects/:id/retention', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    const found = await projectFor(req, reply);
    if (!found) return reply;

    const body = req.body ?? {};
    const values = {};
    for (const key of ['artifact_keep_runs', 'artifact_keep_days', 'log_keep_days']) {
      if (!Object.hasOwn(body, key)) continue;
      const raw = String(body[key] ?? '').trim();
      // An empty field means "follow the server default", which is a null
      // rather than a zero. A form cannot express that difference on its
      // own, so it is decided here.
      if (raw === '') {
        values[key] = null;
        continue;
      }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return fail(reply, `${key} must be a whole number of zero or more, or empty to follow the default`);
      }
      values[key] = parsed;
    }

    try {
      await projects.setRetention(found.project.id, values);
    } catch (e) {
      return fail(reply, e.message);
    }
    return refresh(reply);
  });

  fastify.post('/projects/:id/trigger-secret', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    const found = await projectFor(req, reply);
    if (!found) return reply;

    await projects.setTriggerSecret(found.project.id, crypto.randomUUID().replace(/-/g, ''));
    return refresh(reply, `/projects/${found.project.id}?created=1`);
  });

  fastify.delete('/projects/:id', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    const found = await projectFor(req, reply);
    if (!found) return reply;

    await projects.remove(found.project.id);
    return refresh(reply, '/projects');
  });

  fastify.put('/projects/:id/variables', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    const found = await projectFor(req, reply);
    if (!found) return reply;

    const { name, value, masked } = req.body ?? {};
    try {
      await variables.set(found.project.id, String(name ?? ''), String(value ?? ''), {
        masked: masked !== 'false' && masked !== false,
      });
    } catch (e) {
      return fail(reply, e.message);
    }
    return send(reply, variablesTable(found.project, await variables.list(found.project.id)));
  });

  fastify.delete('/projects/:id/variables/:name', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    const found = await projectFor(req, reply);
    if (!found) return reply;

    await variables.remove(found.project.id, req.params.name);
    return send(reply, variablesTable(found.project, await variables.list(found.project.id)));
  });

  // --- workers ---

  fastify.get('/workers', async (req, reply) => {
    const user = await required(req, reply);
    if (!user) return reply;
    return page(reply, {
      title: 'workers',
      user,
      active: 'workers',
      body: workersPage({ tokens: await workerTokens.listVisible(user), user }),
    });
  });

  fastify.post('/workers', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    const user = await required(req, reply);
    if (!user) return reply;

    const name = String(req.body?.name ?? '').trim();
    if (!name) return fail(reply, 'A name is required.');

    // Only an administrator can create capacity that runs anyone's work.
    const shared = user.role === 'admin' && req.body?.shared === 'true';
    const created = await workerTokens.create(name, { ownerId: shared ? null : user.id });

    return page(reply, {
      title: 'workers',
      user,
      active: 'workers',
      body: workersPage({
        tokens: await workerTokens.listVisible(user),
        user,
        created: { name: created.name, token: created.token },
      }),
    });
  });

  fastify.patch('/workers/:id', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    const user = await required(req, reply);
    if (!user) return reply;

    const token = await workerTokens.get(req.params.id);
    if (!token || !canManageWorker(user, token)) return fail(reply, 'No such worker.', 404);

    await workerTokens.setEnabled(token.id, req.body?.enabled === true || req.body?.enabled === 'true');
    return send(reply, workersTable(await workerTokens.listVisible(user), user));
  });

  fastify.delete('/workers/:id', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    const user = await required(req, reply);
    if (!user) return reply;

    const token = await workerTokens.get(req.params.id);
    if (!token || !canManageWorker(user, token)) return fail(reply, 'No such worker.', 404);

    await workerTokens.remove(token.id);
    return send(reply, workersTable(await workerTokens.listVisible(user), user));
  });

  // --- users ---

  async function adminOnly(req, reply) {
    const user = await required(req, reply);
    if (!user) return null;
    if (user.role !== 'admin') {
      fail(reply, 'Administrator role required.', 403);
      return null;
    }
    return user;
  }

  fastify.get('/users', async (req, reply) => {
    const user = await required(req, reply);
    if (!user) return reply;
    if (user.role !== 'admin') {
      return page(reply, { title: 'users', user, body: html`<p class="error">Administrator role required.</p>` });
    }
    return page(reply, {
      title: 'users',
      user,
      active: 'users',
      body: usersPage({ users: await users.listWithHoldings(), localLogin: auth.localLogin }),
    });
  });

  fastify.post('/users', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    if (!(await adminOnly(req, reply))) return reply;

    try {
      await users.create({
        username: String(req.body?.username ?? ''),
        password: String(req.body?.password ?? ''),
        role: req.body?.role === 'admin' ? 'admin' : 'viewer',
      });
    } catch (e) {
      return fail(reply, e.message);
    }
    return refresh(reply);
  });

  fastify.patch('/users/:id', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    if (!(await adminOnly(req, reply))) return reply;

    const target = await users.get(req.params.id);
    if (!target) return fail(reply, 'No such user.', 404);

    const disabled = req.body?.disabled === true || req.body?.disabled === 'true';
    if (disabled && target.role === 'admin' && await lastAdmin(target.id)) {
      return fail(reply, 'This is the only administrator.');
    }
    await users.setDisabled(target.id, disabled);
    return send(reply, usersTable(await users.listWithHoldings()));
  });

  fastify.delete('/users/:id', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    if (!(await adminOnly(req, reply))) return reply;

    const target = await users.get(req.params.id);
    if (!target) return fail(reply, 'No such user.', 404);
    if (target.role === 'admin' && await lastAdmin(target.id)) {
      return fail(reply, 'This is the only administrator.');
    }

    await users.remove(target.id);
    return send(reply, usersTable(await users.listWithHoldings()));
  });

  async function lastAdmin(exceptId) {
    const row = await db.get(
      "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0 AND id <> {id}",
      { id: exceptId }
    );
    return row.c === 0;
  }
}
