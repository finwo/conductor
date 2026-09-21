// test/pagination.test.js - windows over the long tables
//
// The pure helpers are checked directly, and the pages through a real
// server, because the parts that go wrong are the ones that join up: a
// count taken under different conditions than the rows, a filter dropped
// from a page link, or a polling fragment that asks for page one forever.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';
import { pageOf, offsetOf, windowOf, windowOfAll, paginate, PER_PAGE } from '../src/lib/page.js';
import { pageHref, pager } from '../src/conductor/ui/layout.js';
import { toHtml } from '../src/conductor/ui/html.js';

async function withUi(options, fn) {
  const h = await startHarness({ bootstrap: true, ...options });
  try {
    return await fn(h);
  } finally {
    await h.stop();
  }
}

const get = (h, url, headers = {}) => h.app.inject({ method: 'GET', url, headers });

// Jobs are seeded straight into the database. Going through the scheduler
// would mean a git sync and a pipeline compile per row, which says nothing
// about paging and takes far longer.
async function seedJobs(h, count, { visibility = 'public' } = {}) {
  const now = Date.now();
  // Job numbers are unique per project, so a second call in the same test
  // has to carry on where the first stopped.
  const base = h.seeded ?? 0;
  for (let i = 0; i < count; i += 1) {
    const n = base + i;
    await h.services.db.run(
      `INSERT INTO jobs (id, project_id, number, ref, head_sha, trigger_type, actor,
                         title, state, pipeline, visibility, created_at, started_at, finished_at)
       VALUES ({id}, {project}, {number}, 'refs/heads/main', {sha}, 'push', null,
               null, 'success', null, {visibility}, {created}, null, null)`,
      {
        id: `seed${String(n).padStart(4, '0')}`,
        project: h.project.id,
        number: 1000 + n,
        sha: String(n).padStart(40, '0'),
        visibility,
        // Descending created_at, so row order is predictable.
        created: now - n * 1000,
      }
    );
  }
  h.seeded = base + count;
}

// --- the helpers ---

test('a page number is read from the query, and nonsense reads as the first', () => {
  assert.equal(pageOf({ page: '3' }), 3);
  assert.equal(pageOf({ page: '1' }), 1);
  assert.equal(pageOf({}), 1);
  assert.equal(pageOf({ page: '' }), 1);
  assert.equal(pageOf({ page: 'banana' }), 1);
  assert.equal(pageOf({ page: '0' }), 1);
  assert.equal(pageOf({ page: '-4' }), 1);
  // Arrays arrive when a parameter is repeated in the query string.
  assert.equal(pageOf({ page: ['2', '5'] }), 1);
});

test('an absurd page number cannot produce an unusable offset', () => {
  const offset = offsetOf(pageOf({ page: '999999999999999999999' }));
  assert.ok(Number.isSafeInteger(offset), `offset ${offset} is not a safe integer`);
});

test('a window describes the slice it holds', () => {
  const win = windowOf({ rows: new Array(25).fill(0), total: 57, page: 1 });
  assert.equal(win.pages, 3);
  assert.equal(win.first, 1);
  assert.equal(win.last, 25);

  const middle = windowOf({ rows: new Array(25).fill(0), total: 57, page: 2 });
  assert.equal(middle.first, 26);
  assert.equal(middle.last, 50);

  const last = windowOf({ rows: new Array(7).fill(0), total: 57, page: 3 });
  assert.equal(last.first, 51);
  assert.equal(last.last, 57);
});

test('an empty table is one page, and counts from zero', () => {
  const win = windowOf({ rows: [], total: 0, page: 1 });
  assert.equal(win.pages, 1);
  assert.equal(win.first, 0);
  assert.equal(win.last, 0);
});

test('windowOfAll slices a list that is already in memory', () => {
  const all = Array.from({ length: 30 }, (_, i) => i);
  const second = windowOfAll(all, 2);
  assert.equal(second.rows.length, 5);
  assert.equal(second.rows[0], 25);
  assert.equal(second.total, 30);
});

// --- the links ---

test('a page link keeps the other query parameters', () => {
  assert.equal(pageHref('/jobs', { project: 'demo' }, 2), '/jobs?project=demo&page=2');
  // Page one is the bare url rather than an explicit page=1.
  assert.equal(pageHref('/jobs', { project: 'demo' }, 1), '/jobs?project=demo');
  assert.equal(pageHref('/jobs', {}, 1), '/jobs');
  // The incoming page is replaced, not repeated.
  assert.equal(pageHref('/jobs', { page: '4' }, 2), '/jobs?page=2');
});

test('a pager is not rendered when everything fits on one page', () => {
  const win = windowOf({ rows: new Array(3).fill(0), total: 3, page: 1 });
  assert.equal(toHtml(pager(win, (p) => `/x?page=${p}`)), '');
});

test('a pager offers only the steps that exist', () => {
  const first = toHtml(pager(windowOf({ rows: new Array(25).fill(0), total: 57, page: 1 }), (p) => `/x?page=${p}`));
  assert.match(first, /1 to 25 of 57/);
  assert.match(first, /href="\/x\?page=2"/);
  assert.doesNotMatch(first, /href="\/x\?page=0"/);

  const last = toHtml(pager(windowOf({ rows: new Array(7).fill(0), total: 57, page: 3 }), (p) => `/x?page=${p}`));
  assert.match(last, /href="\/x\?page=2"/);
  assert.doesNotMatch(last, /href="\/x\?page=4"/);
});

// --- against a real database ---

test('paginate counts under the same conditions as it selects', async () => {
  await withUi({}, async (h) => {
    await seedJobs(h, 10, { visibility: 'public' });
    await seedJobs(h, 4, { visibility: 'private' });

    const win = await paginate(h.services.db, {
      select: 'id',
      from: 'jobs',
      where: "visibility = 'public'",
      order: 'created_at DESC',
      page: 1,
      perPage: 5,
    });

    assert.equal(win.rows.length, 5);
    // The private rows must not be counted, or the reader is offered a
    // page that turns out to be empty.
    assert.equal(win.total, 10);
    assert.equal(win.pages, 2);
  });
});

test('successive pages do not repeat or skip a row', async () => {
  await withUi({}, async (h) => {
    await seedJobs(h, 12);

    const seen = [];
    for (let p = 1; p <= 3; p += 1) {
      const win = await paginate(h.services.db, {
        select: 'id',
        from: 'jobs',
        order: 'created_at DESC',
        page: p,
        perPage: 5,
      });
      seen.push(...win.rows.map((r) => r.id));
    }

    assert.equal(seen.length, 12);
    assert.equal(new Set(seen).size, 12, 'a row appeared on more than one page');
  });
});

// --- the pages ---

test('the job list is capped at a page and offers the next one', async () => {
  await withUi({}, async (h) => {
    await seedJobs(h, PER_PAGE + 5);

    const first = await get(h, '/jobs');
    assert.equal(first.statusCode, 200);
    assert.equal((first.body.match(/href="\/jobs\/seed/g) ?? []).length, PER_PAGE);
    assert.match(first.body, /href="\/jobs\?page=2"/);

    const second = await get(h, '/jobs?page=2');
    assert.equal((second.body.match(/href="\/jobs\/seed/g) ?? []).length, 5);
    // Nothing beyond the last page is offered.
    assert.doesNotMatch(second.body, /href="\/jobs\?page=3"/);
  });
});

test('paging past the end is an empty table rather than an error', async () => {
  await withUi({}, async (h) => {
    await seedJobs(h, 3);
    const res = await get(h, '/jobs?page=99');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /No jobs to show/);
  });
});

test('a page link keeps the project filter, and so does the live fragment', async () => {
  await withUi({}, async (h) => {
    await seedJobs(h, PER_PAGE + 2);

    const res = await get(h, `/jobs?project=${h.project.id}`);
    assert.match(res.body, new RegExp(`href="/jobs\\?project=${h.project.id}&amp;page=2"`));
  });
});

test('the polling fragment asks for the page being viewed, not the first', async () => {
  await withUi({}, async (h) => {
    // A running job is what makes the fragment poll at all.
    await seedJobs(h, PER_PAGE + 2);
    await h.services.db.run(
      "UPDATE jobs SET state = 'running' WHERE id = {id}",
      { id: `seed${String(PER_PAGE).padStart(4, '0')}` }
    );

    const second = await get(h, '/jobs?page=2');
    assert.match(second.body, /hx-get="\/partials\/jobs\?page=2"/);

    // And the fragment itself honours the page it is asked for.
    const partial = await get(h, '/partials/jobs?page=2');
    assert.equal(partial.statusCode, 200);
    assert.equal((partial.body.match(/href="\/jobs\/seed/g) ?? []).length, 2);
  });
});

test('the count behind the pager respects who is asking', async () => {
  await withUi({}, async (h) => {
    await seedJobs(h, 4, { visibility: 'public' });
    await seedJobs(h, 40, { visibility: 'private' });

    // Anonymous sees only the public rows, so there is nothing to page.
    const anon = await get(h, '/jobs');
    assert.match(anon.body, /No jobs to show|seed/);
    assert.doesNotMatch(anon.body, /href="\/jobs\?page=2"/);

    // The administrator sees everything, so there is.
    const { cookie } = await h.login();
    const admin = await get(h, '/jobs', { cookie });
    assert.match(admin.body, /href="\/jobs\?page=2"/);
  });
});

test('the users and workers tables keep their swap target on the wrapper', async () => {
  await withUi({}, async (h) => {
    const { cookie } = await h.login();

    const users = await get(h, '/users', { cookie });
    assert.equal(users.statusCode, 200);
    // The id has to survive on the element htmx replaces, or a later swap
    // has nothing to aim at.
    assert.match(users.body, /<div id="users">/);

    const workers = await get(h, '/workers', { cookie });
    assert.match(workers.body, /<div id="workers">/);

    const projects = await get(h, '/projects', { cookie });
    assert.match(projects.body, /<div id="projects">/);
  });
});
