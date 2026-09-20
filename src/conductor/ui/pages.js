// src/conductor/ui/pages.js - the pages and the fragments they poll
//
// Each live region follows the same htmx pattern: the fragment carries its
// own polling attribute only while there is something left to happen. When
// the job or task finishes, the replacement fragment has no trigger, so
// polling stops by itself rather than needing to be cancelled.

import { html, raw } from './html.js';
import { badge, notice, oneTimeSecret, shortSha, ago, duration, ACTIVE_JOB_STATES, ACTIVE_TASK_STATES } from './layout.js';

const poll = (url, seconds = 3) => raw(`hx-get="${url}" hx-trigger="every ${seconds}s" hx-swap="outerHTML"`);

// --- jobs ---

export function jobsPage({ jobs, user, anonymous }) {
  return html`
    <h2>Jobs</h2>
    ${anonymous ? html`<p class="muted">Showing public jobs. <a href="/login">Sign in</a> to see your own.</p>` : ''}
    ${jobsTable(jobs)}
  `;
}

export function jobsTable(jobs) {
  const live = jobs.some((r) => ACTIVE_JOB_STATES.includes(r.state));
  return html`<div id="jobs" ${live ? poll('/partials/jobs', 4) : ''}>
    <table>
      <thead><tr>
        <th>job</th><th>project</th><th>ref</th><th>commit</th><th>state</th><th>started</th>
      </tr></thead>
      <tbody>
        ${jobs.length === 0
    ? html`<tr><td colspan="6" class="muted">No jobs to show.</td></tr>`
    : jobs.map((job) => html`<tr>
            <td><a href="/jobs/${job.id}">#${job.number}</a></td>
            <td>${job.project_id}</td>
            <td class="muted">${(job.ref ?? '').replace('refs/heads/', '')}</td>
            <td class="mono muted">${shortSha(job.head_sha)}</td>
            <td>${badge(job.state)}</td>
            <td class="muted">${ago(job.created_at)}</td>
          </tr>`)}
      </tbody>
    </table>
  </div>`;
}

export function jobPage({ job, tasks, canManage }) {
  return html`
    <div class="panel">
      <h2>${job.title || `Job #${job.number}`}</h2>
      <div class="row">
        ${field('project', html`<a href="/jobs?project=${job.project_id}">${job.project_id}</a>`)}
        ${field('state', badge(job.state))}
        ${field('ref', (job.ref ?? '').replace('refs/heads/', '') || '-')}
        ${field('commit', html`<span class="mono">${shortSha(job.head_sha)}</span>`)}
        ${field('trigger', `${job.trigger_type}${job.actor ? ` by ${job.actor}` : ''}`)}
        ${field('visibility', job.visibility)}
        ${field('duration', duration(job.started_at, job.finished_at))}
      </div>
      ${canManage ? html`<div class="actions">
        ${job.state === 'running'
    ? html`<button hx-post="/jobs/${job.id}/cancel" hx-target="#tasks" hx-swap="outerHTML">cancel</button>`
    : ''}
        <button hx-post="/jobs/${job.id}/retry" hx-swap="none">run again</button>
      </div>` : ''}
    </div>
    ${tasksTable(job, tasks)}
  `;
}

export function tasksTable(job, tasks) {
  const live = ACTIVE_JOB_STATES.includes(job.state);

  // Grouped by graph depth, which is how the pipeline reads.
  const byId = new Map(tasks.map((j) => [j.id, j]));
  const depthOf = (task, seen = new Set()) => {
    if (seen.has(task.id)) return 0;
    seen.add(task.id);
    const deps = (task.needs ?? []).map((id) => byId.get(id)).filter(Boolean);
    return deps.length === 0 ? 0 : Math.max(...deps.map((d) => depthOf(d, seen) + 1));
  };

  const stages = new Map();
  for (const task of tasks) {
    const depth = depthOf(task);
    if (!stages.has(depth)) stages.set(depth, []);
    stages.get(depth).push(task);
  }

  return html`<div id="tasks" ${live ? poll(`/partials/jobs/${job.id}/tasks`, 3) : ''}>
    ${[...stages.keys()].sort((a, b) => a - b).map((depth) => html`
      <div class="stage">
        <h3>stage ${depth + 1}</h3>
        <table><tbody>
          ${stages.get(depth).sort((a, b) => a.name.localeCompare(b.name)).map((task) => html`<tr>
            <td><a href="/tasks/${task.id}">${task.name}</a></td>
            <td>${badge(task.state)}</td>
            <td class="muted">${task.arch ?? ''}</td>
            <td class="muted">${task.worker_name ?? ''}</td>
            <td class="muted">${duration(task.started_at, task.finished_at)}</td>
            <td class="muted">${task.exit_code === null ? '' : `exit ${task.exit_code}`}</td>
          </tr>`)}
        </tbody></table>
      </div>`)}
  </div>`;
}

// --- tasks ---

export function taskPage({ task, artifacts, log }) {
  return html`
    <div class="panel">
      <h2>${task.name}</h2>
      <div class="row">
        ${field('state', badge(task.state))}
        ${field('job', html`<a href="/jobs/${task.job_id}">back to job</a>`)}
        ${field('image', html`<span class="mono">${task.image}</span>`)}
        ${field('arch', task.arch ?? '-')}
        ${field('attempt', `${task.attempt} of ${task.max_attempts}`)}
        ${field('worker', task.worker_name ?? '-')}
        ${field('duration', duration(task.started_at, task.finished_at))}
      </div>
      ${task.error ? notice(task.error) : ''}
    </div>

    <h3>log</h3>
    <div class="logpane">${taskLog(task, log)}</div>

    ${artifacts.length === 0 ? '' : html`
      <h3>artifacts</h3>
      <table><tbody>
        ${artifacts.map((a) => html`<tr>
          <td><a href="/api/v1/projects/${task.project_id}/jobs/${task.job_id}/tasks/${task.id}/artifacts/${a.id}">${a.path}</a></td>
          <td class="muted">${a.size} bytes</td>
          <td class="mono muted">${a.sha256.slice(0, 12)}</td>
        </tr>`)}
      </tbody></table>`}
  `;
}

export function taskLog(task, log) {
  const live = ACTIVE_TASK_STATES.includes(task.state);
  return html`<pre id="log" class="log" ${live ? poll(`/partials/tasks/${task.id}/log`, 2) : ''}>${
    log || (live ? 'Waiting for output.' : 'No output.')
  }</pre>`;
}

// --- login ---

export function loginPage({ error }) {
  return html`<div class="center">
    <div class="panel narrow">
      <h2>Sign in</h2>
      ${notice(error)}
      <form hx-post="/login" hx-target="body" hx-swap="none">
        <label>username<input name="username" autocomplete="username" required autofocus></label>
        <label>password<input name="password" type="password" autocomplete="current-password" required></label>
        <div class="actions"><button type="submit">sign in</button></div>
      </form>
    </div>
  </div>`;
}

// --- projects ---

export function projectsPage({ projects, user }) {
  return html`
    <h2>Projects</h2>

    <div class="panel">
      <h3>Add a project</h3>
      <form hx-post="/projects" hx-target="body" hx-swap="none">
        <div class="grid">
          <label>id<input name="id" placeholder="my-project" required></label>
          <label>repository<input name="repo_url" placeholder="https://git.example.com/repo.git" required></label>
          <label>pipeline file<input name="config_path" value=".conductor.yml"></label>
          <label>visibility
            <select name="visibility">
              <option value="private">private</option>
              <option value="public">public</option>
            </select>
          </label>
        </div>
        <div class="actions"><button type="submit">create</button></div>
      </form>
    </div>

    ${projectsTable(projects, user)}
  `;
}

export function projectsTable(projects, user) {
  return html`<table id="projects">
    <thead><tr><th>project</th><th>repository</th><th>visibility</th><th>owner</th><th>jobs</th><th></th></tr></thead>
    <tbody>
      ${projects.length === 0
    ? html`<tr><td colspan="6" class="muted">No projects yet.</td></tr>`
    : projects.map((p) => html`<tr>
          <td><a href="/projects/${p.id}">${p.id}</a></td>
          <td class="muted mono">${p.repo_url}</td>
          <td>${badge(p.visibility === 'public' ? 'success' : 'skipped')}<span class="muted"> ${p.visibility}</span></td>
          <td class="muted">${p.owner_id === null ? 'shared' : (p.owner_id === user.id ? 'you' : p.owner_id)}</td>
          <td class="muted">${p.run_counter}</td>
          <td><a href="/projects/${p.id}">manage</a></td>
        </tr>`)}
    </tbody>
  </table>`;
}

export function projectPage({ project, variables, triggerUrl, secret, user, retention }) {
  return html`
    <h2>${project.id}</h2>
    ${secret ? oneTimeSecret(
    'Trigger secret',
    secret,
    'Set this as CONDUCTOR_SECRET in the post-receive hook. It is shown here once.'
  ) : ''}

    <div class="panel">
      <div class="row">
        ${field('repository', html`<span class="mono">${project.repo_url}</span>`)}
        ${field('pipeline', html`<span class="mono">${project.config_path}</span>`)}

        ${field('owner', project.owner_id === null ? 'shared' : (project.owner_id === user.id ? 'you' : project.owner_id))}
        ${field('jobs', project.run_counter)}
      </div>
      <p class="muted">Trigger endpoint</p>
      <input class="wide mono" type="text" readonly value="${triggerUrl}" onclick="this.select()">
    </div>

    <div class="panel">
      <h3>Settings</h3>
      <form hx-patch="/projects/${project.id}" hx-target="body" hx-swap="none">
        <div class="grid">
          <label>visibility
            <select name="visibility">
              <option value="private" ${project.visibility === 'private' ? 'selected' : ''}>private</option>
              <option value="public" ${project.visibility === 'public' ? 'selected' : ''}>public</option>
            </select>
          </label>
          <label>enabled
            <select name="enabled">
              <option value="true" ${project.enabled === 1 ? 'selected' : ''}>yes</option>
              <option value="false" ${project.enabled === 1 ? '' : 'selected'}>no</option>
            </select>
          </label>
          <label>working directory
            <input name="workdir" class="mono" placeholder="${retention.workdir}"
                   value="${project.workdir ?? ''}">
          </label>
        </div>
        <p class="muted">
          A pipeline may override visibility per commit with a top level
          visibility key, and the working directory with a workdir key.
          Left empty, tasks run in ${retention.workdir}.
        </p>
        <div class="actions"><button type="submit">save</button></div>
      </form>
    </div>

    <div class="panel">
      <h3>Retention</h3>
      <p class="muted">
        Leave a field empty to follow the server default, shown as the
        placeholder. Zero keeps things forever.
      </p>
      <form hx-patch="/projects/${project.id}/retention" hx-target="body" hx-swap="none">
        <div class="grid">
          <label>keep artifacts for jobs
            <input name="artifact_keep_jobs" type="number" min="0" inputmode="numeric"
                   placeholder="${retention.artifact_keep_jobs}"
                   value="${project.artifact_keep_jobs ?? ''}">
          </label>
          <label>keep artifacts for days
            <input name="artifact_keep_days" type="number" min="0" inputmode="numeric"
                   placeholder="${retention.artifact_keep_days}"
                   value="${project.artifact_keep_days ?? ''}">
          </label>
          <label>keep logs for days
            <input name="log_keep_days" type="number" min="0" inputmode="numeric"
                   placeholder="${retention.log_keep_days}"
                   value="${project.log_keep_days ?? ''}">
          </label>
        </div>
        <p class="muted">
          An artifact is kept if either rule wants it, so the last
          ${project.artifact_keep_jobs ?? retention.artifact_keep_jobs} jobs survive
          whatever their age. The most recent successful job is always kept. A task
          that sets artifacts.expire overrides all of this.
        </p>
        <div class="actions"><button type="submit">save</button></div>
      </form>
    </div>

    <div class="panel">
      <h3>Variables</h3>
      <p class="muted">Injected into every task. Masked values are redacted from logs.</p>
      ${variablesTable(project, variables)}
      <form hx-put="/projects/${project.id}/variables" hx-target="#variables" hx-swap="outerHTML">
        <div class="grid">
          <label>name<input name="name" placeholder="DEPLOY_TOKEN" required></label>
          <label>value<input name="value" type="password" required></label>
          <label>masked
            <select name="masked"><option value="true">yes</option><option value="false">no</option></select>
          </label>
        </div>
        <div class="actions"><button type="submit">set</button></div>
      </form>
    </div>

    <div class="panel">
      <h3>Danger</h3>
      <div class="actions">
        <button hx-post="/projects/${project.id}/trigger-secret" hx-target="body" hx-swap="none">
          rotate trigger secret
        </button>
        <button class="danger"
          hx-delete="/projects/${project.id}"
          hx-confirm="Delete ${project.id} and all of its jobs?"
          hx-swap="none">delete project</button>
      </div>
    </div>
  `;
}

export function variablesTable(project, variables) {
  return html`<table id="variables"><tbody>
    ${variables.length === 0
    ? html`<tr><td class="muted">None.</td></tr>`
    : variables.map((v) => html`<tr>
        <td class="mono">${v.name}</td>
        <td class="muted">${v.masked ? 'masked' : 'visible'}</td>
        <td class="muted">${v.plaintext_at_rest ? 'stored in the clear' : 'encrypted'}</td>
        <td><button class="link"
          hx-delete="/projects/${project.id}/variables/${encodeURIComponent(v.name)}"
          hx-target="#variables" hx-swap="outerHTML">remove</button></td>
      </tr>`)}
  </tbody></table>`;
}

// --- workers ---

export function workersPage({ tokens, user, created }) {
  return html`
    <h2>Workers</h2>
    <p class="muted">
      A worker you register only ever receives tasks from your own projects.
      ${user.role === 'admin' ? 'A shared worker receives tasks from any project.' : ''}
    </p>
    ${created ? oneTimeSecret(
    `Worker token for ${created.name}`,
    created.token,
    'Put this in the worker configuration. It is shown once and stored only as a hash.'
  ) : ''}

    <div class="panel">
      <h3>Register a worker</h3>
      <form hx-post="/workers" hx-target="body" hx-swap="none">
        <div class="grid">
          <label>name<input name="name" placeholder="my-laptop" required></label>
          ${user.role === 'admin' ? html`<label>shared
            <select name="shared"><option value="false">no, mine</option><option value="true">yes, any project</option></select>
          </label>` : ''}
        </div>
        <div class="actions"><button type="submit">create token</button></div>
      </form>
    </div>

    ${workersTable(tokens, user)}
  `;
}

export function workersTable(tokens, user) {
  return html`<table id="workers">
    <thead><tr><th>name</th><th>scope</th><th>state</th><th>last seen</th><th>address</th><th></th></tr></thead>
    <tbody>
      ${tokens.length === 0
    ? html`<tr><td colspan="6" class="muted">No workers registered.</td></tr>`
    : tokens.map((t) => html`<tr>
          <td>${t.name}</td>
          <td class="muted">${t.owner_id === null ? 'shared' : (t.owner_id === user.id ? 'yours' : t.owner_id)}</td>
          <td>${t.enabled === 1 ? badge('success') : badge('skipped')}</td>
          <td class="muted">${t.last_seen_at ? ago(t.last_seen_at) : 'never'}</td>
          <td class="muted mono">${t.last_ip ?? ''}</td>
          <td class="row-actions">
            <button class="link" hx-patch="/workers/${t.id}" hx-vals='{"enabled": ${t.enabled === 1 ? 'false' : 'true'}}'
              hx-target="#workers" hx-swap="outerHTML">${t.enabled === 1 ? 'disable' : 'enable'}</button>
            <button class="link danger" hx-delete="/workers/${t.id}"
              hx-confirm="Remove ${t.name}?" hx-target="#workers" hx-swap="outerHTML">remove</button>
          </td>
        </tr>`)}
    </tbody>
  </table>`;
}

// --- users ---

export function usersPage({ users, localLogin }) {
  return html`
    <h2>Users</h2>
    ${localLogin ? '' : html`<p class="muted">
      Authentication goes through the identity provider, so these accounts are inactive.
    </p>`}

    <div class="panel">
      <h3>Add a user</h3>
      <form hx-post="/users" hx-target="body" hx-swap="none">
        <div class="grid">
          <label>username<input name="username" required></label>
          <label>password<input name="password" type="password" required></label>
          <label>role
            <select name="role"><option value="user">user</option><option value="admin">admin</option></select>
          </label>
        </div>
        <div class="actions"><button type="submit">create</button></div>
      </form>
    </div>

    ${usersTable(users)}
  `;
}

export function usersTable(users) {
  return html`<table id="users">
    <thead><tr>
      <th>username</th><th>role</th><th>state</th><th>owns</th><th>last login</th><th></th>
    </tr></thead>
    <tbody>
      ${users.map((u) => html`<tr>
        <td>${u.username}</td>
        <td>${u.role}</td>
        <td>${u.disabled === 1 ? badge('skipped') : badge('success')}</td>
        <td class="muted">${u.project_count} project(s), ${u.worker_count} worker(s)</td>
        <td class="muted">${u.last_login_at ? ago(u.last_login_at) : 'never'}</td>
        <td class="row-actions">
          <button class="link" hx-patch="/users/${u.id}" hx-vals='{"disabled": ${u.disabled === 1 ? 'false' : 'true'}}'
            hx-target="#users" hx-swap="outerHTML">${u.disabled === 1 ? 'enable' : 'disable'}</button>
          <button class="link danger" hx-delete="/users/${u.id}"
            hx-confirm="${deleteWarning(u)}" hx-target="#users" hx-swap="outerHTML">remove</button>
        </td>
      </tr>`)}
    </tbody>
  </table>`;
}

// Removing an account takes everything it owns with it, so the
// confirmation says so plainly rather than asking a vague question.
function deleteWarning(user) {
  if (user.project_count === 0 && user.worker_count === 0) {
    return `Remove ${user.username}? They own nothing.`;
  }
  const parts = [];
  if (user.project_count > 0) {
    parts.push(`${user.project_count} project(s) and all of their job history`);
  }
  if (user.worker_count > 0) parts.push(`${user.worker_count} worker token(s)`);
  return `Remove ${user.username}? This also deletes ${parts.join(' and ')}. This cannot be undone.`;
}

function field(label, value) {
  return html`<div><span class="label">${label}</span><span>${value}</span></div>`;
}
