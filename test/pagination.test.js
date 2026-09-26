// test/pagination.test.js - windows over the long tables
//
// Driven through a real server, because the parts that go wrong are the
// ones that join up: a count taken under different conditions than the
// rows, or a next url that drops the filter it was asked for.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';
import { paginateOffset } from '../src/lib/page.js';

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

// Tasks attributed to the harness worker, for the worker page's history.
async function seedWorkerTasks(h, count) {
  await seedJobs(h, 1);
  const job = `seed${String((h.seeded ?? 1) - 1).padStart(4, '0')}`;
  const now = Date.now();
  for (let i = 0; i < count; i += 1) {
    await h.services.db.run(
      `INSERT INTO tasks (id, job_id, name, base_name, image, requires, spec, state,
                          timeout, worker_token_id, worker_name, claimed_at, created_at)
       VALUES ({id}, {job}, {name}, 'build', 'alpine', '[]', '{}', 'success',
               3600, {worker}, 'builder-01', {claimed}, {claimed})`,
      {
        id: `wtask${String(i).padStart(4, '0')}`,
        job,
        name: `build-${i}`,
        worker: h.worker.id,
        claimed: now - i * 1000,
      }
    );
  }
}

// --- against a real database ---

test('a window counts under the same conditions as it selects', async () => {
  await withUi({}, async (h) => {
    await seedJobs(h, 10, { visibility: 'public' });
    await seedJobs(h, 4, { visibility: 'private' });

    const win = await paginateOffset(h.services.db, {
      select: 'id',
      from: 'jobs',
      where: "visibility = 'public'",
      order: 'created_at DESC',
      offset: 0,
      limit: 5,
    });

    assert.equal(win.rows.length, 5);
    // The private rows must not be counted, or the reader is offered a
    // page that turns out to be empty.
    assert.equal(win.total, 10);
  });
});

test('successive windows do not repeat or skip a row', async () => {
  await withUi({}, async (h) => {
    await seedJobs(h, 12);

    const seen = [];
    for (let offset = 0; offset < 15; offset += 5) {
      const win = await paginateOffset(h.services.db, {
        select: 'id',
        from: 'jobs',
        order: 'created_at DESC',
        offset,
        limit: 5,
      });
      seen.push(...win.rows.map((r) => r.id));
    }

    assert.equal(seen.length, 12);
    assert.equal(new Set(seen).size, 12, 'a row appeared in more than one window');
  });
});

// --- the endpoints ---

test('a list is capped at the default limit and hands out a next url', async () => {
  await withUi({}, async (h) => {
    await seedJobs(h, 55);
    const { headers } = await h.login();

    const first = await get(h, `/api/v1/projects/${h.project.id}/jobs`, headers);
    assert.equal(first.statusCode, 200);

    const body = first.json();
    assert.equal(body.data.length, 50);
    assert.equal(body.pagination.offset, 0);
    assert.equal(body.pagination.total, 55);
    assert.ok(body.pagination.next);

    const second = await get(h, new URL(body.pagination.next).pathname + new URL(body.pagination.next).search, headers);
    const rest = second.json();
    assert.equal(rest.data.length, 5);
    assert.equal(rest.pagination.offset, 50);
    assert.equal(rest.pagination.next, undefined);
  });
});

test('following next walks every row exactly once', async () => {
  await withUi({}, async (h) => {
    await seedJobs(h, 23);
    const { headers } = await h.login();

    const seen = [];
    let url = `/api/v1/projects/${h.project.id}/jobs?limit=5`;
    while (url) {
      const body = (await get(h, url, headers)).json();
      seen.push(...body.data.map((row) => row.id));
      url = body.pagination.next ? new URL(body.pagination.next).pathname + new URL(body.pagination.next).search : null;
    }

    assert.equal(seen.length, 23);
    assert.equal(new Set(seen).size, 23, 'a row appeared in more than one window');
  });
});

test('reading past the end is an empty page rather than an error', async () => {
  await withUi({}, async (h) => {
    await seedJobs(h, 3);
    const { headers } = await h.login();

    const res = await get(h, `/api/v1/projects/${h.project.id}/jobs?offset=999`, headers);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data, []);
    assert.equal(res.json().pagination.total, 3);
  });
});

test('the total behind a page respects who is asking', async () => {
  await withUi({}, async (h) => {
    await seedJobs(h, 4, { visibility: 'public' });
    await seedJobs(h, 40, { visibility: 'private' });

    const anon = await get(h, `/api/v1/projects/${h.project.id}/jobs`);
    assert.equal(anon.json().pagination.total, 4);

    const { headers } = await h.login();
    const admin = await get(h, `/api/v1/projects/${h.project.id}/jobs`, headers);
    assert.equal(admin.json().pagination.total, 44);
  });
});

test('a worker pages its task history', async () => {
  await withUi({}, async (h) => {
    const { headers } = await h.login();
    await seedWorkerTasks(h, 28);

    const first = await get(h, `/api/v1/workers/${h.worker.id}/tasks?limit=25`, headers);
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().data.length, 25);
    assert.equal(first.json().pagination.total, 28);

    const second = await get(h, `/api/v1/workers/${h.worker.id}/tasks?limit=25&offset=25`, headers);
    assert.equal(second.json().data.length, 3);
  });
});

test('a limit above the cap is clamped rather than refused', async () => {
  await withUi({}, async (h) => {
    await seedJobs(h, 3);
    const { headers } = await h.login();

    const res = await get(h, `/api/v1/projects/${h.project.id}/jobs?limit=9999`, headers);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.length, 3);
  });
});
