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
  jobsPage, jobsTable, jobPage, tasksTable, taskPage, taskLog, loginPage,
  projectsPage, projectPage, variablesTable, workersPage, workersTable, workerPage,
  usersPage, usersTable,
} from './pages.js';
import { canManageProject, canViewProject, VISIBILITIES } from '../../lib/projects.js';
import { canManageWorker } from '../../lib/workers.js';
import { paginate, pageOf, windowOfAll } from '../../lib/page.js';
import { issueToken, sessionCookie, clearedCookie } from '../../lib/auth/index.js';
import { createState, verifyState } from '../../lib/auth/state.js';
import { PipelineError, DEFAULT_WORKDIR } from '../../lib/pipeline/index.js';
import { outputAad } from '../../lib/outputs.js';

const LOG_TAIL_BYTES = 256 * 1024;

export default async function uiRoutes(fastify, services) {
  const { cfg, db, auth, users, projects, workerTokens, variables, secrets, logs, scheduler } = services;
  const secure = cfg.server.public_url.startsWith('https://');
  const oidcRedirectUri = `${cfg.server.public_url.replace(/\/+$/, '')}/oidc/callback`;

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
    return send(reply, layout({ title, user, body, active, localLogin: auth.localLogin }));
  }

  const currentUser = (req) => auth.identify(req).catch(() => null);

  // Only a path on this conductor, so a crafted link cannot bounce someone
  // to another site after signing in.
  function safeReturnTo(value) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
    return value;
  }

  // Where to send the browser to sign in, with the page to come back to
  // carried in the signed state.
  function beginOidcLogin(returnTo) {
    const state = createState(cfg.auth.session_secret, safeReturnTo(returnTo));
    return auth.oidc.authorizationUrl({ redirectUri: oidcRedirectUri, state });
  }

  function signInError(reply, message) {
    return page(reply, {
      title: 'sign in',
      user: null,
      body: html`<div class="center"><div class="panel narrow">
        <h2>Sign in</h2>
        <p class="error">${message}</p>
        <p><a href="/login">Try again</a></p>
      </div></div>`,
    });
  }

  // A signed in user, or a redirect to sign in. With OIDC that means the
  // provider; otherwise the built-in sign in page.
  async function required(req, reply) {
    const user = await currentUser(req);
    if (user) return user;

    if (auth.oidc) {
      let url;
      try {
        url = await beginOidcLogin(req.url);
      } catch {
        reply.code(502);
        signInError(reply, 'The identity provider could not be reached. Try again shortly.');
        return null;
      }
      if (req.headers['hx-request']) reply.header('hx-redirect', url).code(204).send();
      else reply.redirect(url, 302);
      return null;
    }

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

  // --- jobs ---

  async function visibleJobs(user, { projectId = null, page: pageNo = 1 } = {}) {
    const scope = user && user.role === 'admin'
      ? { sql: '1 = 1', params: {} }
      : user
        ? { sql: "(j.visibility = 'public' OR p.owner_id = {viewerId})", params: { viewerId: user.id } }
        : { sql: "j.visibility = 'public'", params: {} };

    return paginate(db, {
      select: `j.id, j.project_id, j.number, j.ref, j.head_sha, j.state, j.visibility,
               j.title, j.created_at, j.started_at, j.finished_at`,
      from: 'jobs j JOIN projects p ON p.id = j.project_id',
      where: `${scope.sql}${projectId ? ' AND j.project_id = {project}' : ''}`,
      order: 'j.created_at DESC',
      params: { ...scope.params, ...(projectId ? { project: projectId } : {}) },
      page: pageNo,
    });
  }

  // The project filter and the page both live in the query string, so the
  // polling fragment can be asked for exactly what is on screen.
  function jobsQuery(req) {
    return {
      projectId: typeof req.query.project === 'string' ? req.query.project : null,
      page: pageOf(req.query),
    };
  }

  async function jobsView(req, reply) {
    const user = await currentUser(req);
    const jobs = await visibleJobs(user, jobsQuery(req));
    return page(reply, {
      title: 'jobs',
      user,
      active: 'jobs',
      body: jobsPage({ jobs, user, anonymous: !user, query: req.query }),
    });
  }

  fastify.get('/', jobsView);
  fastify.get('/jobs', jobsView);

  fastify.get('/partials/jobs', async (req, reply) => {
    const user = await currentUser(req);
    return send(reply, jobsTable(await visibleJobs(user, jobsQuery(req)), req.query));
  });

  // Loads a job the caller may see, along with whether they may act on it.
  async function jobFor(req, reply) {
    const user = await currentUser(req);
    const job = await db.get('SELECT * FROM jobs WHERE id = {id}', { id: req.params.id });
    if (!job) {
      reply.code(404);
      return { user, job: null };
    }
    const project = await projects.get(job.project_id);
    if (job.visibility !== 'public' && !canManageProject(user, project)) {
      reply.code(404);
      return { user, job: null };
    }
    return { user, job, project, canManage: canManageProject(user, project) };
  }

  // Masked values are never unsealed here: the page shows that one exists.
  async function outputsOf(taskId) {
    const rows = await db.all(
      'SELECT task_id, name, value, masked FROM task_outputs WHERE task_id = {task} ORDER BY name',
      { task: taskId }
    );
    return rows.map((row) => {
      const masked = row.masked === 1;
      if (masked) return { name: row.name, masked, value: null };
      try {
        return { name: row.name, masked, value: secrets.open(row.value, outputAad(row.task_id, row.name)) };
      } catch {
        return { name: row.name, masked, value: null };
      }
    });
  }

  async function tasksOf(jobId) {
    const tasks = await db.all(
      `SELECT id, name, arch, state, worker_name, started_at, finished_at
         FROM tasks WHERE job_id = {job} ORDER BY name`,
      { job: jobId }
    );
    const deps = await db.all(
      `SELECT d.task_id, d.depends_on_id, d.kind FROM task_deps d
         JOIN tasks t ON t.id = d.task_id WHERE t.job_id = {job}`,
      { job: jobId }
    );
    const edges = new Map(tasks.map((t) => [t.id, { needs: [], after: [] }]));
    for (const d of deps) edges.get(d.task_id)?.[d.kind === 'after' ? 'after' : 'needs'].push(d.depends_on_id);
    return tasks.map((j) => ({ ...j, ...(edges.get(j.id) ?? { needs: [], after: [] }) }));
  }

  fastify.get('/jobs/:id', async (req, reply) => {
    const { user, job, canManage } = await jobFor(req, reply);
    if (!job) return page(reply, { title: 'not found', user, body: html`<p class="error">No such job.</p>` });

    return page(reply, {
      title: `job #${job.number}`,
      user,
      active: 'jobs',
      body: jobPage({ job, tasks: await tasksOf(job.id), canManage }),
    });
  });

  fastify.get('/partials/jobs/:id/tasks', async (req, reply) => {
    const { job } = await jobFor(req, reply);
    if (!job) return reply.send('');
    return send(reply, tasksTable(job, await tasksOf(job.id)));
  });

  fastify.post('/jobs/:id/cancel', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    const user = await required(req, reply);
    if (!user) return reply;

    const { job, canManage } = await jobFor(req, reply);
    if (!job || !canManage) return fail(reply, 'Not yours to manage.', 403);

    await scheduler.cancelJob(job.id, `cancelled by ${user.username}`);
    const fresh = await db.get('SELECT * FROM jobs WHERE id = {id}', { id: job.id });
    return send(reply, tasksTable(fresh, await tasksOf(job.id)));
  });

  fastify.post('/jobs/:id/retry', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    const user = await required(req, reply);
    if (!user) return reply;

    const { job, project, canManage } = await jobFor(req, reply);
    if (!job || !canManage) return fail(reply, 'Not yours to manage.', 403);

    try {
      const created = await scheduler.createJob(project, {
        ref: job.ref,
        baseSha: job.base_sha,
        headSha: job.head_sha,
        trigger: 'manual',
        actor: user.username,
      });
      return refresh(reply, `/jobs/${created.jobId}`);
    } catch (e) {
      return fail(reply, e instanceof PipelineError ? e.message : String(e.message ?? e), 422);
    }
  });

  // --- tasks ---

  fastify.get('/tasks/:id', async (req, reply) => {
    const user = await currentUser(req);
    const task = await db.get(
      `SELECT t.*, j.visibility, j.project_id FROM tasks t
         JOIN jobs j ON j.id = t.job_id WHERE t.id = {id}`,
      { id: req.params.id }
    );
    if (!task) return page(reply, { title: 'not found', user, body: html`<p class="error">No such task.</p>` });

    const project = await projects.get(task.project_id);
    if (task.visibility !== 'public' && !canManageProject(user, project)) {
      return page(reply, { title: 'not found', user, body: html`<p class="error">No such task.</p>` });
    }

    const artifacts = await paginate(db, {
      select: 'id, path, size, sha256',
      from: 'artifacts',
      where: 'task_id = {task}',
      order: 'path',
      params: { task: task.id },
      page: pageOf(req.query),
    });

    return page(reply, {
      title: task.name,
      user,
      active: 'jobs',
      body: taskPage({
        task,
        artifacts,
        outputs: await outputsOf(task.id),
        log: await tailOf(task),
        query: req.query,
      }),
    });
  });

  fastify.get('/partials/tasks/:id/log', async (req, reply) => {
    const user = await currentUser(req);
    const task = await db.get(
      `SELECT t.*, j.visibility, j.project_id FROM tasks t
         JOIN jobs j ON j.id = t.job_id WHERE t.id = {id}`,
      { id: req.params.id }
    );
    if (!task) return reply.send('');

    const project = await projects.get(task.project_id);
    if (task.visibility !== 'public' && !canManageProject(user, project)) return reply.send('');

    return send(reply, taskLog(task, await tailOf(task)));
  });

  // The last window of output. Replacing the whole pane each poll keeps the
  // fragment self contained, and a cap keeps a runaway log from being
  // re-sent in full every two seconds.
  async function tailOf(task) {
    if (!task.log_key) {
      const size = await logs.size(task.job_id, task.id);
      const offset = Math.max(0, size - LOG_TAIL_BYTES);
      const chunk = await logs.read(task.job_id, task.id, { offset, limit: LOG_TAIL_BYTES });
      return chunk.data.toString('utf8');
    }
    try {
      const start = Math.max(0, (task.log_size ?? 0) - LOG_TAIL_BYTES);
      const object = await services.storage.get(task.log_key, { range: { start } });
      const parts = [];
      for await (const part of object.stream) parts.push(part);
      return Buffer.concat(parts).toString('utf8');
    } catch {
      return '';
    }
  }

  // --- session ---

  fastify.get('/login', async (req, reply) => {
    const user = await currentUser(req);
    if (user) return reply.redirect('/', 302);

    // With the provider in charge, asking for the sign in page is asking to
    // sign in there.
    if (auth.oidc) {
      try {
        const to = typeof req.query.redirect === 'string' ? req.query.redirect : '/';
        return reply.redirect(await beginOidcLogin(to), 302);
      } catch {
        reply.code(502);
        return signInError(reply, 'The identity provider could not be reached. Try again shortly.');
      }
    }

    return page(reply, {
      title: 'sign in',
      user: null,
      body: loginPage({}),
    });
  });

  // The provider sends the browser back here with an authorization code.
  fastify.get('/oidc/callback', async (req, reply) => {
    if (typeof req.query.error === 'string') {
      reply.code(400);
      return signInError(reply, `The provider refused the sign in: ${req.query.error}`);
    }

    const state = auth.oidc ? verifyState(cfg.auth.session_secret, String(req.query.state ?? '')) : null;
    if (!state) {
      reply.code(400);
      return signInError(reply, 'This sign in did not start here, or took too long. Try again.');
    }

    try {
      const tokens = await auth.oidc.exchangeCode({
        code: String(req.query.code ?? ''),
        redirectUri: oidcRedirectUri,
      });
      if (typeof tokens.id_token !== 'string') {
        throw new Error('the token response contained no id_token');
      }

      const profile = await auth.oidc.verify(tokens.id_token);
      const account = await users.upsertExternal({
        externalId: `${profile.issuer}|${profile.subject}`,
        username: profile.username,
        role: profile.role,
      });
      if (account.disabled === 1) {
        reply.code(403);
        return signInError(reply, 'This account is disabled.');
      }

      // The id_token is the session. Every later request re-verifies it, so
      // a role revoked at the provider takes effect at once.
      const ttl = Number.isInteger(tokens.expires_in) && tokens.expires_in > 0
        ? tokens.expires_in
        : cfg.auth.session_ttl;
      reply.header('set-cookie', sessionCookie(tokens.id_token, { ttl, secure }));
      return reply.redirect(state.url, 302);
    } catch (e) {
      req.log.error?.(`oidc callback failed: ${e.message}`);
      reply.code(400);
      return signInError(reply, 'Sign in failed. Please try again.');
    }
  });

  fastify.post('/login', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    if (!auth.localLogin) return fail(reply, 'This conductor authenticates through its identity provider.');

    const { username, password } = req.body ?? {};
    const user = await users.authenticate(String(username ?? ''), String(password ?? ''));
    if (!user) {
      return page(reply, {
        title: 'sign in',
        user: null,
        body: loginPage({ error: 'Invalid username or password.' }),
      });
    }

    const ttl = cfg.auth.session_ttl;
    const token = issueToken(cfg.auth.session_secret, { sub: user.id, name: user.username, role: user.role }, { ttl });
    reply.header('set-cookie', sessionCookie(token, { ttl, secure }));
    return refresh(reply, '/');
  });

  fastify.post('/logout', async (req, reply) => {
    reply.header('set-cookie', clearedCookie());

    // End the provider session too, so signing out is not immediately
    // undone by a silent re-login on the next visit.
    if (auth.oidc) {
      try {
        const url = await auth.oidc.endSessionUrl({
          postLogoutRedirectUri: cfg.server.public_url.replace(/\/+$/, ''),
        });
        if (url) return refresh(reply, url);
      } catch {
        // The provider is unreachable; the local session is still gone.
      }
    }
    return refresh(reply, '/');
  });

  // --- projects ---

  fastify.get('/projects', async (req, reply) => {
    const user = await required(req, reply);
    if (!user) return reply;
    const rows = await projects.pageManagedBy(user, pageOf(req.query));
    return page(reply, {
      title: 'projects',
      user,
      active: 'projects',
      body: projectsPage({ projects: rows, user, query: req.query }),
    });
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
        triggerUrl: `${cfg.server.public_url.replace(/\/+$/, '')}/api/v1/projects/${project.id}/trigger`,
        secret,
        // What an empty field falls back to, so the form can say so
        // rather than looking unset.
        // Defaults the form shows as placeholders, so an empty field
        // reads as "inherited" rather than "unset".
        retention: { ...cfg.retention, workdir: DEFAULT_WORKDIR },
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
      // An empty field means the project has no opinion, which is a null
      // rather than an empty string.
      if (Object.hasOwn(body, 'workdir')) {
        await projects.setWorkdir(found.project.id, String(body.workdir ?? '').trim() || null);
      }
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
    for (const key of ['artifact_keep_jobs', 'artifact_keep_days', 'log_keep_days']) {
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
      body: workersPage({ tokens: await workerTokens.pageVisible(user, pageOf(req.query)), user, query: req.query }),
    });
  });

  fastify.get('/workers/:id', async (req, reply) => {
    const user = await required(req, reply);
    if (!user) return reply;

    const token = await workerTokens.get(req.params.id);
    if (!token || !canManageWorker(user, token)) {
      reply.code(404);
      return page(reply, { title: 'not found', user, active: 'workers', body: html`<p class="error">No such worker.</p>` });
    }

    const tasks = await paginate(db, {
      select: 'id, name, state, arch, worker_name, claimed_at, started_at, finished_at',
      from: 'tasks',
      where: 'worker_token_id = {worker}',
      order: 'claimed_at DESC',
      params: { worker: token.id },
      page: pageOf(req.query),
    });

    return page(reply, {
      title: token.name,
      user,
      active: 'workers',
      body: workerPage({
        token,
        agents: await workerTokens.agentsFor(token.id),
        tasks,
        user,
        staleAfter: cfg.scheduler.heartbeat_timeout * 1000,
        query: req.query,
      }),
    });
  });

  fastify.post('/workers', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    const user = await required(req, reply);
    if (!user) return reply;

    const name = String(req.body?.name ?? '').trim();
    if (!name) return fail(reply, 'A name is required.');

    // Only an administrator can create capacity that jobs anyone's work.
    const shared = user.role === 'admin' && req.body?.shared === 'true';
    const created = await workerTokens.create(name, { ownerId: shared ? null : user.id });

    return page(reply, {
      title: 'workers',
      user,
      active: 'workers',
      body: workersPage({
        tokens: await workerTokens.pageVisible(user, pageOf(req.query)),
        user,
        query: req.query,
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
    return send(reply, workersTable(await workerTokens.pageVisible(user, pageOf(req.query)), user, req.query));
  });

  fastify.delete('/workers/:id', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    const user = await required(req, reply);
    if (!user) return reply;

    const token = await workerTokens.get(req.params.id);
    if (!token || !canManageWorker(user, token)) return fail(reply, 'No such worker.', 404);

    await workerTokens.remove(token.id);
    return send(reply, workersTable(await workerTokens.pageVisible(user, pageOf(req.query)), user, req.query));
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
      body: usersPage({ users: await users.pageWithHoldings(pageOf(req.query)), localLogin: auth.localLogin, query: req.query }),
    });
  });

  fastify.post('/users', async (req, reply) => {
    if (!fromUi(req, reply)) return reply;
    if (!(await adminOnly(req, reply))) return reply;

    try {
      await users.create({
        username: String(req.body?.username ?? ''),
        password: String(req.body?.password ?? ''),
        role: req.body?.role === 'admin' ? 'admin' : 'user',
      });
    } catch (e) {
      return page(reply, {
        title: 'users',
        user: await currentUser(req),
        active: 'users',
        body: usersPage({
          users: await users.pageWithHoldings(pageOf(req.query)),
          localLogin: auth.localLogin,
          query: req.query,
          error: e.message,
        }),
      });
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
    return send(reply, usersTable(await users.pageWithHoldings(pageOf(req.query)), req.query));
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
    return send(reply, usersTable(await users.pageWithHoldings(pageOf(req.query)), req.query));
  });

  async function lastAdmin(exceptId) {
    const row = await db.get(
      "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0 AND id <> {id}",
      { id: exceptId }
    );
    return row.c === 0;
  }
}
