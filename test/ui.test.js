// test/ui.test.js - the server rendered interface
//
// The interface is rendered from the same data and the same visibility
// rules as the API, so these check what a page actually contains for a
// given caller rather than that a route merely answers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';
import { html, esc, raw, toHtml, attrs } from '../src/conductor/ui/html.js';
import { tasksTable } from '../src/conductor/ui/pages.js';

async function withUi(options, fn) {
  const h = await startHarness({ bootstrap: true, ...options });
  try {
    return await fn(h);
  } finally {
    await h.stop();
  }
}

const get = (h, url, headers = {}) => h.app.inject({ method: 'GET', url, headers });

// htmx sets this on every request it makes; mutations require it.
const hx = (headers = {}) => ({ ...headers, 'hx-request': 'true' });

function form(headers, fields) {
  return {
    headers: { ...hx(headers), 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  };
}

// --- templating ---

test('interpolated values are escaped by default', () => {
  const evil = '<script>alert(1)</script>';
  const out = toHtml(html`<td>${evil}</td>`);
  assert.equal(out, '<td>&lt;script&gt;alert(1)&lt;/script&gt;</td>');
});

test('quotes and ampersands are escaped inside attributes', () => {
  const out = toHtml(html`<input value="${'a" onload="evil() & more'}">`);
  assert.ok(!out.includes('onload="evil'));
  assert.ok(out.includes('&quot;'));
  assert.ok(out.includes('&amp;'));
});

test('nested templates and arrays are kept, raw is passed through', () => {
  const rows = ['a', 'b'].map((x) => html`<li>${x}</li>`);
  assert.equal(toHtml(html`<ul>${rows}</ul>`), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(toHtml(html`<p>${raw('<b>bold</b>')}</p>`), '<p><b>bold</b></p>');
});

test('null, undefined and false render as nothing', () => {
  assert.equal(toHtml(html`<p>${null}${undefined}${false}</p>`), '<p></p>');
  assert.equal(esc(null), '');
});

test('attrs omits absent values and renders bare booleans', () => {
  assert.equal(toHtml(attrs({ id: 'x', hidden: true, skip: false, gone: null })), 'id="x" hidden');
});

// --- anonymous ---

test('an anonymous visitor sees public jobs and an invitation to sign in', async () => {
  await withUi({ visibility: 'public' }, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);

    const page = await get(h, '/');
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.body, /Sign in/);
    assert.match(page.body, /#1<\/a>/);
    // No management links without a session.
    assert.ok(!page.body.includes('href="/projects"'));
    assert.ok(!page.body.includes('href="/users"'));
  });
});

test('an anonymous visitor cannot see a private job', async () => {
  await withUi({ visibility: 'private' }, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = res.json().data.job_id;
    await h.waitForJob(job);

    const list = await get(h, '/');
    assert.ok(!list.body.includes('#1</a>'));

    const detail = await get(h, `/jobs/${job}`);
    assert.match(detail.body, /No such job/);
  });
});

test('management pages redirect an anonymous visitor to sign in', async () => {
  await withUi({}, async (h) => {
    for (const url of ['/projects', '/workers', '/users']) {
      const res = await get(h, url);
      assert.equal(res.statusCode, 302, `${url} should redirect`);
      assert.equal(res.headers.location, '/login');
    }
  });
});

// --- session ---

test('signing in through the form sets a session and reveals the nav', async () => {
  await withUi({}, async (h) => {
    const bad = await h.app.inject({
      method: 'POST',
      url: '/login',
      ...form({}, { username: 'admin', password: 'wrong' }),
    });
    assert.equal(bad.statusCode, 200);
    assert.match(bad.body, /Invalid username or password/);

    const good = await h.app.inject({
      method: 'POST',
      url: '/login',
      ...form({}, { username: 'admin', password: 'bootstrap-password' }),
    });
    assert.equal(good.statusCode, 204);
    assert.match(good.headers['set-cookie'], /conductor_session=/);

    const cookie = good.headers['set-cookie'].split(';')[0];
    const home = await get(h, '/', { cookie });
    assert.match(home.body, /href="\/projects"/);
    assert.match(home.body, /href="\/users"/);
    assert.match(home.body, /sign out/);
  });
});

// Signs in and returns a cookie header.
async function signIn(h, username = 'admin', password = 'bootstrap-password') {
  const res = await h.app.inject({ method: 'POST', url: '/login', ...form({}, { username, password }) });
  if (res.statusCode !== 204) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return { cookie: res.headers['set-cookie'].split(';')[0] };
}

// --- projects ---

test('a user creates a project through the form and is shown the secret once', async () => {
  await withUi({}, async (h) => {
    const session = await signIn(h);

    const created = await h.app.inject({
      method: 'POST',
      url: '/projects',
      ...form(session, { id: 'from-ui', repo_url: 'https://git.example.com/ui.git', visibility: 'private' }),
    });
    assert.equal(created.statusCode, 204);
    assert.equal(created.headers['hx-redirect'], '/projects/from-ui?created=1');

    const page = await get(h, '/projects/from-ui?created=1', session);
    assert.match(page.body, /Trigger secret/);
    assert.match(page.body, /api\/v1\/projects\/from-ui\/trigger/);

    // The secret is only revealed on that one visit.
    const again = await get(h, '/projects/from-ui', session);
    assert.ok(!again.body.includes('Trigger secret'));
  });
});

test('a project page shows variables and never their values', async () => {
  await withUi({}, async (h) => {
    const session = await signIn(h);
    await h.services.variables.set('demo', 'DEPLOY_TOKEN', 'ui-secret-value');

    const page = await get(h, '/projects/demo', session);
    assert.match(page.body, /DEPLOY_TOKEN/);
    assert.match(page.body, /masked/);
    assert.ok(!page.body.includes('ui-secret-value'), 'a variable value must never be rendered');
  });
});

test('setting and removing a variable returns the updated table', async () => {
  await withUi({}, async (h) => {
    const session = await signIn(h);

    const set = await h.app.inject({
      method: 'PUT',
      url: '/projects/demo/variables',
      ...form(session, { name: 'TOKEN', value: 'abc12345', masked: 'true' }),
    });
    assert.equal(set.statusCode, 200);
    assert.match(set.body, /TOKEN/);
    assert.ok(!set.body.includes('abc12345'));

    const removed = await h.app.inject({
      method: 'DELETE', url: '/projects/demo/variables/TOKEN', headers: hx(session),
    });
    assert.equal(removed.statusCode, 200);
    assert.ok(!removed.body.includes('TOKEN'));
  });
});

test('a user cannot open or delete a project they do not own', async () => {
  await withUi({}, async (h) => {
    const admin = await signIn(h);
    await h.app.inject({
      method: 'POST', url: '/users', ...form(admin, { username: 'mallory', password: 'mallory-password', role: 'user' }),
    });
    const other = await signIn(h, 'mallory', 'mallory-password');

    const page = await get(h, '/projects/demo', other);
    assert.match(page.body, /No such project/);

    const deleted = await h.app.inject({ method: 'DELETE', url: '/projects/demo', headers: hx(other) });
    assert.equal(deleted.statusCode, 404);
    assert.ok(await h.services.projects.get('demo'), 'the project must still exist');
  });
});

// --- workers ---

test('registering a worker shows the token once and lists it', async () => {
  await withUi({}, async (h) => {
    const session = await signIn(h);

    const created = await h.app.inject({
      method: 'POST', url: '/workers', ...form(session, { name: 'my-laptop' }),
    });
    assert.equal(created.statusCode, 200);
    assert.match(created.body, /Worker token for my-laptop/);

    // The token appears exactly once, in the reveal panel.
    const token = /value="([0-9a-f]{64})"/.exec(created.body);
    assert.ok(token, 'expected the token to be shown');

    const list = await get(h, '/workers', session);
    assert.match(list.body, /my-laptop/);
    assert.ok(!list.body.includes(token[1]), 'the token must not be listed again');
  });
});

test('the worker page lists what each machine advertises', async () => {
  await withUi({}, async (h) => {
    const session = await signIn(h);
    await h.claim({ name: 'builder-01', arches: ['x86_64'], features: ['unos-sign-keys', 'dind'] });

    const page = await get(h, `/workers/${h.worker.id}`, session);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /builder-01/);
    assert.match(page.body, /unos-sign-keys, dind/);
    assert.match(page.body, /x86_64/);
  });
});

test('machines sharing a token are listed separately', async () => {
  await withUi({}, async (h) => {
    const session = await signIn(h);
    await h.claim({ name: 'builder-01', features: ['unos-sign-keys'] });
    await h.claim({ name: 'builder-02', features: [] });

    const page = await get(h, `/workers/${h.worker.id}`, session);
    assert.match(page.body, /builder-01/);
    assert.match(page.body, /builder-02/);
    assert.match(page.body, /machines/);
  });
});

test('the workers list links to the worker page', async () => {
  await withUi({}, async (h) => {
    const session = await signIn(h);
    const list = await get(h, '/workers', session);
    assert.match(list.body, new RegExp(`href="/workers/${h.worker.id}"`));
  });
});

test('a worker page is not served to someone who cannot manage it', async () => {
  await withUi({}, async (h) => {
    const admin = await signIn(h);
    await h.app.inject({
      method: 'POST', url: '/users', ...form(admin, { username: 'erin', password: 'erin-password', role: 'user' }),
    });
    const erin = await signIn(h, 'erin', 'erin-password');

    const page = await get(h, `/workers/${h.worker.id}`, erin);
    assert.equal(page.statusCode, 404);
    assert.match(page.body, /No such worker/);
  });
});

test('a feature name is escaped rather than rendered', async () => {
  await withUi({}, async (h) => {
    const session = await signIn(h);
    await h.claim({ name: 'builder-01', features: ['<img src=x onerror=alert(1)>'] });

    const page = await get(h, `/workers/${h.worker.id}`, session);
    assert.ok(!page.body.includes('<img src=x'), 'a feature name must not reach the page as markup');
    assert.match(page.body, /&lt;img src=x/);
  });
});

test('an ordinary user cannot create shared capacity from the form', async () => {
  await withUi({}, async (h) => {
    const admin = await signIn(h);
    await h.app.inject({
      method: 'POST', url: '/users', ...form(admin, { username: 'carol', password: 'carol-password', role: 'user' }),
    });
    const carol = await signIn(h, 'carol', 'carol-password');

    await h.app.inject({ method: 'POST', url: '/workers', ...form(carol, { name: 'sneaky', shared: 'true' }) });

    const rows = await h.services.db.all('SELECT name, owner_id FROM worker_tokens WHERE name = {n}', { n: 'sneaky' });
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].owner_id, null, 'an ordinary user must not create a shared worker');
  });
});

// --- users ---

test('the users page is administrator only and warns about what deletion destroys', async () => {
  await withUi({}, async (h) => {
    const admin = await signIn(h);
    await h.app.inject({
      method: 'POST', url: '/users', ...form(admin, { username: 'dave', password: 'dave-password', role: 'user' }),
    });
    const dave = await h.services.users.byUsername('dave');
    await h.services.projects.setOwner('demo', dave.id);

    const page = await get(h, '/users', admin);
    assert.match(page.body, /dave/);
    // The confirmation has to say what goes with the account.
    assert.match(page.body, /also deletes 1 project\(s\) and all of their job history/);

    const asViewer = await signIn(h, 'dave', 'dave-password');
    const denied = await get(h, '/users', asViewer);
    assert.match(denied.body, /Administrator role required/);
  });
});

// --- live regions ---

test('a running job polls, and a finished one stops', async () => {
  await withUi({ visibility: 'public' }, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    const job = res.json().data.job_id;
    await h.waitForJob(job);

    const running = await get(h, `/jobs/${job}`);
    assert.match(running.body, /hx-get="\/partials\/jobs\/[^"]+\/tasks"/);
    assert.match(running.body, /hx-trigger="every 3s"/);

    await h.services.scheduler.cancelJob(job);

    const finished = await get(h, `/jobs/${job}`);
    assert.ok(!finished.body.includes('/tasks" hx-trigger'), 'a settled job must stop polling');
  });
});

test('a task page streams the log and stops polling once it completes', async () => {
  await withUi({ visibility: 'public' }, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);
    const task = (await h.claim({})).json().data.task;

    await h.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/log`,
      headers: { ...h.auth, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('compiling the thing\n'),
    });

    const live = await get(h, `/tasks/${encodeURIComponent(task.id)}`);
    assert.match(live.body, /compiling the thing/);
    assert.match(live.body, /hx-trigger="every 2s"/);

    await h.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/complete`,
      headers: { ...h.auth, 'content-type': 'application/json' },
      payload: JSON.stringify({ success: true, exit_code: 0 }),
    });

    const done = await get(h, `/tasks/${encodeURIComponent(task.id)}`);
    assert.match(done.body, /compiling the thing/);
    assert.ok(!done.body.includes('hx-trigger="every 2s"'), 'a finished task must stop polling');
  });
});

test('log output is escaped, so a task cannot inject markup into the page', async () => {
  await withUi({ visibility: 'public' }, async (h) => {
    const res = await h.trigger({ sha: h.sha, ref: 'refs/heads/main' });
    await h.waitForJob(res.json().data.job_id);
    const task = (await h.claim({})).json().data.task;

    await h.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/log`,
      headers: { ...h.auth, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('<img src=x onerror="alert(1)">\n'),
    });

    const page = await get(h, `/tasks/${encodeURIComponent(task.id)}`);
    assert.ok(!page.body.includes('<img src=x'), 'task output must not become markup');
    assert.match(page.body, /&lt;img src=x/);
  });
});

// --- csrf ---

test('a mutation without the htmx header is refused', async () => {
  await withUi({}, async (h) => {
    const session = await signIn(h);

    // A cross site form post carries the cookie but cannot set a header.
    const res = await h.app.inject({
      method: 'POST',
      url: '/projects',
      headers: { ...session, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ id: 'csrf', repo_url: 'https://evil.example/x.git' }).toString(),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(await h.services.projects.get('csrf'), undefined);
  });
});

// --- layout details ---

test('the task graph is one table, so columns line up across stages', () => {
  const job = { id: 'j1', state: 'running' };
  const tasks = [
    { id: 't1', name: 'style', state: 'success', arch: 'x86-64', worker_name: 'w1', started_at: 1, finished_at: 2, needs: [] },
    { id: 't2', name: 'test', state: 'success', arch: null, worker_name: 'w2', started_at: 1, finished_at: 2, needs: [] },
    { id: 't3', name: 'images', state: 'queued', arch: null, worker_name: null, started_at: null, finished_at: null, needs: ['t1', 't2'] },
    { id: 't4', name: 'publish', state: 'queued', arch: null, worker_name: null, started_at: null, finished_at: null, needs: ['t3'] },
  ];

  const out = toHtml(tasksTable(job, tasks));

  // Three stages, and one table holding all of them. A table per stage
  // sizes its own columns, which is what put the same field in a
  // different place in every stage.
  assert.equal((out.match(/<tbody/g) ?? []).length, 3, 'expected one row group per stage');
  assert.equal((out.match(/<table/g) ?? []).length, 1, 'stages must share a single table');
  assert.match(out, /stage 1/);
  assert.match(out, /stage 3/);

  // Every task row carries the same five cells, so a column means the same
  // thing all the way down.
  for (const row of out.match(/<tr>\s*<td>.*?<\/tr>/gs) ?? []) {
    assert.equal((row.match(/<td/g) ?? []).length, 5, `row has the wrong cell count: ${row}`);
  }

  // The stage label spans the row, so it must track the column count.
  assert.match(out, /colspan="5"/);
  assert.doesNotMatch(out, /<th>exit<\/th>/, 'the exit code is no longer a column');
});

test('the sign in form is centred rather than stranded at the left edge', async () => {
  await withUi({}, async (h) => {
    const res = await get(h, '/login');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<div class="center">\s*<div class="panel narrow">/);
  });
});

test('row actions stay ordinary table cells, so rows keep one height', async () => {
  await withUi({}, async (h) => {
    const session = await signIn(h);
    await h.app.inject({ method: 'POST', url: '/workers', ...form(session, { name: 'metrics-check' }) });

    for (const url of ['/workers', '/users']) {
      const body = (await get(h, url, session)).body;
      assert.match(body, /<td class="row-actions">/, `${url} should use row-actions`);
      // The flex container used for button bars would break baseline
      // alignment inside a row.
      assert.ok(!body.includes('<td class="actions">'), `${url} must not make a cell a flex container`);
    }
  });
});

// --- assets ---

test('the stylesheet and htmx are served, and nothing else is', async () => {
  await withUi({}, async (h) => {
    assert.equal((await get(h, '/style.css')).statusCode, 200);

    const htmx = await get(h, '/vendor/htmx.min.js');
    assert.equal(htmx.statusCode, 200);
    assert.match(htmx.headers['content-type'], /javascript/);

    for (const url of ['/vendor/../package.json', '/app.js', '/index.html']) {
      assert.equal((await get(h, url)).statusCode, 404, `${url} must not be served`);
    }
  });
});

// --- retention ---

test('the project page shows retention, with server defaults as placeholders', async () => {
  await withUi({
    retention: { artifact_keep_jobs: 8, artifact_keep_days: 25, log_keep_days: 11 },
  }, async (h) => {
    const session = await signIn(h);
    const page = await get(h, `/projects/${h.project.id}`, session);

    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Retention/);

    // An unset field shows the default it inherits rather than an empty
    // box that looks like nothing is configured.
    assert.match(page.body, /name="artifact_keep_jobs"[^>]*placeholder="8"/);
    assert.match(page.body, /name="artifact_keep_days"[^>]*placeholder="25"/);
    assert.match(page.body, /name="log_keep_days"[^>]*placeholder="11"/);
  });
});

test('saving retention through the form stores it, and empty means inherit', async () => {
  await withUi({
    retention: { artifact_keep_jobs: 8, artifact_keep_days: 25, log_keep_days: 11 },
  }, async (h) => {
    const session = await signIn(h);

    const saved = await h.app.inject({
      method: 'PATCH',
      url: `/projects/${h.project.id}/retention`,
      ...form(session, { artifact_keep_jobs: '3', artifact_keep_days: '0', log_keep_days: '' }),
    });
    assert.ok(saved.statusCode < 400, `unexpected ${saved.statusCode}: ${saved.body}`);

    const project = await h.services.projects.get(h.project.id);
    assert.equal(project.artifact_keep_jobs, 3);
    // Zero and empty have to end up different, or a project cannot say
    // "keep forever" as distinct from "use the default".
    assert.equal(project.artifact_keep_days, 0);
    assert.equal(project.log_keep_days, null);

    const page = await get(h, `/projects/${h.project.id}`, session);
    assert.match(page.body, /name="artifact_keep_days"[^>]*value="0"/);
    assert.match(page.body, /name="log_keep_days"[^>]*value=""/);
  });
});

test('a negative retention value is refused by the form', async () => {
  await withUi({}, async (h) => {
    const session = await signIn(h);

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/projects/${h.project.id}/retention`,
      ...form(session, { log_keep_days: '-3' }),
    });

    assert.ok(res.statusCode >= 400, 'a negative value must not be stored');
    const project = await h.services.projects.get(h.project.id);
    assert.equal(project.log_keep_days, null);
  });
});

// --- working directory ---

test('the project page offers a working directory, defaulting to the server one', async () => {
  await withUi({}, async (h) => {
    const session = await signIn(h);
    const page = await get(h, `/projects/${h.project.id}`, session);

    assert.equal(page.statusCode, 200);
    assert.match(page.body, /name="workdir"[^>]*placeholder="\/work"/);
    assert.match(page.body, /name="workdir"[^>]*value=""/, 'unset means inherited');
  });
});

test('saving a working directory stores it, and empty clears it', async () => {
  await withUi({}, async (h) => {
    const session = await signIn(h);

    const saved = await h.app.inject({
      method: 'PATCH',
      url: `/projects/${h.project.id}`,
      ...form(session, { workdir: '/usr/src/app' }),
    });
    assert.ok(saved.statusCode < 400, `unexpected ${saved.statusCode}: ${saved.body}`);
    assert.equal((await h.services.projects.get(h.project.id)).workdir, '/usr/src/app');

    const cleared = await h.app.inject({
      method: 'PATCH',
      url: `/projects/${h.project.id}`,
      ...form(session, { workdir: '  ' }),
    });
    assert.ok(cleared.statusCode < 400);
    assert.equal((await h.services.projects.get(h.project.id)).workdir, null,
      'blank means follow the repository, not a directory named blank');
  });
});

test('an unusable working directory is refused by the form', async () => {
  await withUi({}, async (h) => {
    const session = await signIn(h);

    for (const workdir of ['relative', '/', '/a/../b']) {
      const res = await h.app.inject({
        method: 'PATCH',
        url: `/projects/${h.project.id}`,
        ...form(session, { workdir }),
      });
      assert.ok(res.statusCode >= 400, `expected ${JSON.stringify(workdir)} to be refused`);
      assert.equal((await h.services.projects.get(h.project.id)).workdir, null);
    }
  });
});
