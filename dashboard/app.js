// dashboard/app.js - the conductor dashboard
//
// Plain ES modules, no framework and no build step. The whole thing is a
// run list, a run view and a log tail, which does not justify a dependency
// or a toolchain.
//
// All requests are relative, so the same files work whether they are served
// by the conductor or by the read-api. The admin controls appear only when
// the write surface answers, which it does not on the read-api.

const view = document.getElementById('view');
const crumbs = document.getElementById('crumbs');
const session = document.getElementById('session');
const statusLine = document.getElementById('status');

const state = {
  admin: null,   // null until probed, then true or false
  user: null,
  token: sessionStorage.getItem('conductor_token'),
  timers: [],
};

// --- tiny dom helper ---

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function render(...nodes) {
  view.replaceChildren(...nodes.flat().filter(Boolean));
}

function clearTimers() {
  for (const timer of state.timers) clearInterval(timer);
  state.timers = [];
}

function every(ms, fn) {
  state.timers.push(setInterval(fn, ms));
}

// --- formatting ---

const badge = (s) => el('span', { class: `badge ${s}`, text: s });

function ago(ms) {
  if (!ms) return '';
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

function duration(from, to) {
  if (!from) return '';
  const seconds = Math.round(((to ?? Date.now()) - from) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const short = (sha) => (sha ? String(sha).slice(0, 8) : '');

// --- api ---

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (options.body) headers['content-type'] = 'application/json';

  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).error ?? '';
    } catch {
      // Not JSON; the status is enough.
    }
    const error = new Error(detail || `${res.status} ${res.statusText}`);
    error.status = res.status;
    throw error;
  }
  return res.status === 204 ? null : res.json();
}

function note(message, isError = false) {
  statusLine.textContent = message;
  statusLine.className = isError ? 'error' : 'muted';
}

// --- session ---

async function probeAdmin() {
  try {
    const mode = await api('/api/auth/mode');
    state.admin = true;
    state.localLogin = mode.local_login;
  } catch {
    // The read-api does not mount the auth routes at all.
    state.admin = false;
  }
  if (state.admin && state.token) {
    try {
      state.user = (await api('/api/auth/me')).user;
    } catch {
      state.token = null;
      sessionStorage.removeItem('conductor_token');
    }
  }
  renderSession();
}

function renderSession() {
  if (!state.admin) {
    session.replaceChildren(el('span', { class: 'muted', text: 'read only' }));
    return;
  }
  if (state.user) {
    session.replaceChildren(
      el('span', { class: 'muted', text: `${state.user.username} (${state.user.role}) ` }),
      el('button', { onclick: logout, text: 'sign out' })
    );
    return;
  }
  session.replaceChildren(el('button', { onclick: showLogin, text: 'sign in' }));
}

function showLogin() {
  const username = el('input', { placeholder: 'username', autocomplete: 'username' });
  const password = el('input', { type: 'password', placeholder: 'password', autocomplete: 'current-password' });
  const message = el('p', { class: 'error' });

  const submit = async () => {
    try {
      const result = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: username.value, password: password.value }),
      });
      state.token = result.token;
      state.user = result.user;
      sessionStorage.setItem('conductor_token', result.token);
      renderSession();
      route();
    } catch (e) {
      message.textContent = e.message;
    }
  };

  clearTimers();
  render(el('div', { class: 'panel' },
    el('h2', { text: 'Sign in' }),
    el('div', { class: 'actions' }, username, password, el('button', { onclick: submit, text: 'sign in' })),
    message));

  password.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  username.focus();
}

function logout() {
  state.token = null;
  state.user = null;
  sessionStorage.removeItem('conductor_token');
  api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  renderSession();
  route();
}

// --- runs ---

async function showRuns() {
  const body = el('tbody');
  const table = el('table',
    {},
    el('thead', {}, el('tr', {},
      el('th', { text: 'run' }),
      el('th', { text: 'project' }),
      el('th', { text: 'ref' }),
      el('th', { text: 'commit' }),
      el('th', { text: 'state' }),
      el('th', { text: 'started' }))),
    body);

  render(el('h2', { text: 'Runs' }), table);

  async function refresh() {
    try {
      const { runs } = await api('/api/runs?limit=50');
      note(`${runs.length} run(s), updated ${new Date().toLocaleTimeString()}`);
      body.replaceChildren(...runs.map((run) => el('tr', { class: 'clickable', onclick: () => { location.hash = `#/run/${run.id}`; } },
        el('td', {}, el('a', { href: `#/run/${run.id}`, text: `#${run.number}` })),
        el('td', { text: run.project_id }),
        el('td', { class: 'muted', text: (run.ref ?? '').replace('refs/heads/', '') }),
        el('td', { class: 'mono muted', text: short(run.head_sha) }),
        el('td', {}, badge(run.state)),
        el('td', { class: 'muted', text: ago(run.created_at) }))));

      if (runs.length === 0) {
        body.replaceChildren(el('tr', {}, el('td', { colspan: '6', class: 'muted', text: 'No runs yet.' })));
      }
    } catch (e) {
      note(e.message, true);
    }
  }

  await refresh();
  every(5000, refresh);
}

async function showRun(runId) {
  const header = el('div', { class: 'panel' });
  const stages = el('div');
  render(header, stages);

  async function refresh() {
    let data;
    try {
      data = await api(`/api/runs/${encodeURIComponent(runId)}`);
    } catch (e) {
      note(e.message, true);
      render(el('p', { class: 'error', text: `Could not load run: ${e.message}` }));
      clearTimers();
      return;
    }

    const { run, jobs } = data;
    crumbs.replaceChildren(el('a', { href: '#/', text: 'runs' }), document.createTextNode(` / #${run.number}`));

    const info = el('div', { class: 'row' },
      field('project', run.project_id),
      field('state', null, badge(run.state)),
      field('ref', (run.ref ?? '').replace('refs/heads/', '') || '-'),
      field('commit', short(run.head_sha)),
      field('trigger', `${run.trigger_type}${run.actor ? ` by ${run.actor}` : ''}`),
      field('duration', duration(run.started_at, run.finished_at)));

    header.replaceChildren(
      el('h2', { text: run.title || `Run #${run.number}` }),
      info,
      adminActions(run));

    // Jobs are grouped by graph depth, which is how the pipeline reads.
    const byDepth = new Map();
    for (const job of jobs) {
      const depth = job.spec_depth ?? depthOf(job, jobs);
      if (!byDepth.has(depth)) byDepth.set(depth, []);
      byDepth.get(depth).push(job);
    }

    stages.replaceChildren(...[...byDepth.keys()].sort((a, b) => a - b).map((depth) => {
      const rows = byDepth.get(depth).sort((a, b) => a.name.localeCompare(b.name));
      return el('div', { class: 'stage' },
        el('h3', { text: `stage ${depth + 1}` }),
        el('table', {}, el('tbody', {}, ...rows.map(jobRow))));
    }));

    note(`updated ${new Date().toLocaleTimeString()}`);
    if (['success', 'failed', 'cancelled'].includes(run.state)) clearTimers();
  }

  await refresh();
  every(3000, refresh);
}

function jobRow(job) {
  return el('tr', {},
    el('td', {}, el('a', { href: `#/job/${encodeURIComponent(job.id)}`, text: job.name })),
    el('td', {}, badge(job.state)),
    el('td', { class: 'muted', text: job.arch ?? '' }),
    el('td', { class: 'muted', text: job.worker_name ?? '' }),
    el('td', { class: 'muted', text: duration(job.started_at, job.finished_at) }),
    el('td', { class: 'muted', text: job.exit_code === null ? '' : `exit ${job.exit_code}` }));
}

// Depth is not stored on the row, so it is recomputed from the edges.
function depthOf(job, jobs) {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const seen = new Set();
  const walk = (current) => {
    if (seen.has(current.id)) return 0;
    seen.add(current.id);
    const deps = (current.needs ?? []).map((id) => byId.get(id)).filter(Boolean);
    return deps.length === 0 ? 0 : Math.max(...deps.map((d) => walk(d) + 1));
  };
  return walk(job);
}

function field(label, value, node) {
  return el('div', {}, el('span', { class: 'label', text: label }), node ?? el('span', { text: value ?? '' }));
}

function adminActions(run) {
  if (!state.admin || !state.user || state.user.role !== 'admin') return null;

  const actions = el('div', { class: 'actions' });
  if (run.state === 'running') {
    actions.append(el('button', {
      text: 'cancel',
      onclick: async () => {
        try {
          await api(`/api/admin/runs/${encodeURIComponent(run.id)}/cancel`, { method: 'POST', body: '{}' });
          note('run cancelled');
        } catch (e) {
          note(e.message, true);
        }
      },
    }));
  }
  actions.append(el('button', {
    text: 'run again',
    onclick: async () => {
      try {
        const result = await api(`/api/admin/runs/${encodeURIComponent(run.id)}/retry`, { method: 'POST', body: '{}' });
        location.hash = `#/run/${result.run_id}`;
      } catch (e) {
        note(e.message, true);
      }
    },
  }));
  return actions;
}

// --- job and log ---

async function showJob(jobId) {
  const header = el('div', { class: 'panel' });
  const logEl = el('pre', { class: 'log', text: '' });
  const artifactsEl = el('div');
  render(header, el('h3', { text: 'log' }), logEl, artifactsEl);

  let offset = 0;
  let complete = false;
  let following = true;

  logEl.addEventListener('scroll', () => {
    following = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 24;
  });

  async function refreshHeader() {
    const { job, artifacts } = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    crumbs.replaceChildren(
      el('a', { href: '#/', text: 'runs' }),
      document.createTextNode(' / '),
      el('a', { href: `#/run/${job.run_id}`, text: 'run' }),
      document.createTextNode(` / ${job.name}`));

    header.replaceChildren(
      el('h2', { text: job.name }),
      el('div', { class: 'row' },
        field('state', null, badge(job.state)),
        field('image', job.image),
        field('arch', job.arch ?? '-'),
        field('attempt', `${job.attempt} of ${job.max_attempts}`),
        field('worker', job.worker_name ?? '-'),
        field('duration', duration(job.started_at, job.finished_at))),
      job.error ? el('p', { class: 'error', text: job.error }) : null);

    if (artifacts.length > 0) {
      artifactsEl.replaceChildren(
        el('h3', { text: 'artifacts' }),
        el('table', {}, el('tbody', {}, ...artifacts.map((a) => el('tr', {},
          el('td', {}, el('a', { href: `/api/artifacts/${a.id}`, text: a.path })),
          el('td', { class: 'muted', text: `${a.size} bytes` }),
          el('td', { class: 'mono muted', text: a.sha256.slice(0, 12) }))))));
    } else {
      artifactsEl.replaceChildren();
    }

    return job;
  }

  async function tail() {
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/log?offset=${offset}`);
    if (!res.ok) return;
    const text = await res.text();
    if (text.length > 0) {
      logEl.append(document.createTextNode(text));
      if (following) logEl.scrollTop = logEl.scrollHeight;
    }
    offset = Number(res.headers.get('x-log-offset') ?? offset) + new TextEncoder().encode(text).length;
    complete = res.headers.get('x-log-complete') === 'true';
  }

  try {
    const job = await refreshHeader();
    await tail();
    if (complete && ['success', 'failed', 'skipped', 'cancelled'].includes(job.state)) {
      note('job finished');
      return;
    }
  } catch (e) {
    note(e.message, true);
    render(el('p', { class: 'error', text: `Could not load job: ${e.message}` }));
    return;
  }

  every(1500, async () => {
    try {
      const job = await refreshHeader();
      await tail();
      if (complete && ['success', 'failed', 'skipped', 'cancelled'].includes(job.state)) {
        clearTimers();
        note('job finished');
      }
    } catch (e) {
      note(e.message, true);
    }
  });
}

// --- routing ---

function route() {
  clearTimers();
  crumbs.replaceChildren();
  const hash = location.hash.replace(/^#/, '') || '/';

  const runMatch = /^\/run\/(.+)$/.exec(hash);
  const jobMatch = /^\/job\/(.+)$/.exec(hash);

  if (jobMatch) showJob(decodeURIComponent(jobMatch[1]));
  else if (runMatch) showRun(decodeURIComponent(runMatch[1]));
  else showRuns();
}

window.addEventListener('hashchange', route);

await probeAdmin();
route();
