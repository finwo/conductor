// test/api.test.js - the response envelope and its pagination
//
// The error names asserted here are the wire contract. They come from the
// class names in lib/errors.js, so a rename has to fail something rather
// than quietly change what clients read.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, data, apiError } from './helpers/harness.js';
import { pageBlock, limitOf, offsetOfQuery, API_LIMIT, API_MAX_LIMIT } from '../src/lib/page.js';

async function withApi(options, fn) {
  const h = await startHarness(options);
  try {
    await fn(h);
  } finally {
    await h.stop();
  }
}

// --- the envelope ---

test('a success carries ok and data, and nothing else', async () => {
  await withApi({ visibility: 'public' }, async (h) => {
    const res = await h.app.inject({ method: 'GET', url: '/health' });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(res.json()).sort(), ['data', 'ok']);
    assert.equal(res.json().ok, true);
  });
});

test('a failure carries a name, a message and the matching status', async () => {
  await withApi({ visibility: 'public' }, async (h) => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/tasks/m2y0000000000000nope' });

    assert.equal(res.statusCode, 404);
    const error = apiError(res);
    assert.equal(error.name, 'UnknownTask');
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0, 'a message is for a person to read');
  });
});

test('details are absent rather than null when there are none', async () => {
  await withApi({ visibility: 'public' }, async (h) => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/tasks/m2y0000000000000nope' });

    assert.deepEqual(Object.keys(apiError(res)).sort(), ['message', 'name']);
  });
});

test('a url under the api that matches no route is enveloped too', async () => {
  await withApi({ visibility: 'public' }, async (h) => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/no/such/thing' });

    assert.equal(res.statusCode, 404);
    assert.equal(apiError(res).name, 'NotFound');
  });
});

// The envelope handlers sit on the api plugin alone, or a browser asking
// for a page would be handed JSON.
test('a page request outside the api is answered with the application', async () => {
  await withApi({ visibility: 'public' }, async (h) => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/no/such/page',
      headers: { accept: 'text/html' },
    });

    assert.ok(!res.body.includes('"ok":false'), 'a browser must not be handed the api envelope');
  });
});

test('a malformed body is refused by name', async () => {
  await withApi({ visibility: 'public' }, async (h) => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/demo/jobs',
      headers: { 'content-type': 'application/json' },
      payload: '{"sha": not json}',
    });

    assert.equal(res.statusCode, 400);
    assert.equal(apiError(res).name, 'MalformedJson');
  });
});

test('the worker protocol reports its refusals by name', async () => {
  await withApi({ visibility: 'public' }, async (h) => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/tasks/claim',
      headers: { authorization: 'Bearer nonsense', 'content-type': 'application/json' },
      payload: '{}',
    });

    assert.equal(res.statusCode, 401);
    assert.equal(apiError(res).name, 'InvalidWorkerToken');
  });
});

// A stack names files, versions and the shape of the tree, and CORS here is
// open to any origin, so it belongs in the log and nowhere else.
test('no error body carries a stack', async () => {
  await withApi({ visibility: 'public' }, async (h) => {
    for (const url of ['/api/v1/tasks/m2y0000000000000nope', '/api/v1/no/such/thing']) {
      const res = await h.app.inject({ method: 'GET', url });
      assert.ok(!/\bstack\b/i.test(res.body), `${url} leaked a stack`);
      assert.ok(!res.body.includes('.js:'), `${url} leaked a source location`);
    }
  });
});

// --- pagination ---

test('a page reports where it sits and how many there are', async () => {
  await withApi({ visibility: 'public' }, async (h) => {
    const job = data(await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).job_id;
    await h.waitForJob(job);

    const res = await h.app.inject({ method: 'GET', url: `/api/v1/jobs/${job}/tasks?limit=2` });
    assert.equal(res.statusCode, 200, res.body);

    const body = res.json();
    assert.equal(body.data.tasks.length, 2, 'the limit is honoured');
    assert.equal(body.pagination.offset, 0);
    assert.ok(body.pagination.total > 2, 'the total counts past the page');
    assert.match(body.pagination.next, /offset=2/);
    assert.match(body.pagination.next, /limit=2/);
  });
});

test('following next walks the whole collection exactly once', async () => {
  await withApi({ visibility: 'public' }, async (h) => {
    const job = data(await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).job_id;
    await h.waitForJob(job);

    const seen = [];
    let url = `/api/v1/jobs/${job}/tasks?limit=2`;
    for (let i = 0; i < 20 && url; i += 1) {
      const res = await h.app.inject({ method: 'GET', url });
      const body = res.json();
      seen.push(...body.data.tasks.map((t) => t.id));
      // next is absolute, and inject wants a path.
      url = body.pagination.next ? new URL(body.pagination.next).pathname
        + new URL(body.pagination.next).search : null;
    }

    const total = seen.length;
    assert.ok(total > 2, 'the walk should have needed more than one page');
    assert.equal(new Set(seen).size, total, 'no task appeared on two pages');
  });
});

test('next is absent on the last page', async () => {
  await withApi({ visibility: 'public' }, async (h) => {
    const job = data(await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).job_id;
    await h.waitForJob(job);

    const res = await h.app.inject({ method: 'GET', url: `/api/v1/jobs/${job}/tasks` });
    const { pagination } = res.json();

    assert.equal(pagination.offset, 0);
    assert.ok(!('next' in pagination), 'a single page has nothing after it');
  });
});

test('an unusable offset or limit falls back rather than failing', async () => {
  await withApi({ visibility: 'public' }, async (h) => {
    const job = data(await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).job_id;
    await h.waitForJob(job);

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${job}/tasks?offset=-5&limit=banana`,
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().pagination.offset, 0);
  });
});

test('a task reports its artifacts as a page', async () => {
  await withApi({ visibility: 'public' }, async (h) => {
    const job = data(await h.trigger({ sha: h.sha, ref: 'refs/heads/main' })).job_id;
    await h.waitForJob(job);
    const task = data(await h.claim({})).task;

    const res = await h.app.inject({ method: 'GET', url: `/api/v1/tasks/${task.id}/artifacts` });
    assert.equal(res.statusCode, 200, res.body);

    const body = res.json();
    assert.ok(Array.isArray(body.data));
    assert.equal(body.pagination.offset, 0);
    assert.equal(body.pagination.total, body.data.length);
  });
});

// --- the helpers underneath ---

test('a limit is clamped to the cap, and a missing one defaults', () => {
  assert.equal(limitOf({}), API_LIMIT);
  assert.equal(limitOf({ limit: '10' }), 10);
  assert.equal(limitOf({ limit: '100000' }), API_MAX_LIMIT);
  assert.equal(limitOf({ limit: '0' }), API_LIMIT);
  assert.equal(limitOf({ limit: 'banana' }), API_LIMIT);
});

test('an offset reads as zero unless it is a usable number', () => {
  assert.equal(offsetOfQuery({}), 0);
  assert.equal(offsetOfQuery({ offset: '25' }), 25);
  assert.equal(offsetOfQuery({ offset: '-1' }), 0);
  assert.equal(offsetOfQuery({ offset: 'banana' }), 0);
  assert.ok(Number.isSafeInteger(offsetOfQuery({ offset: String(Number.MAX_VALUE) })));
});

test('next preserves the other query parameters', () => {
  const block = pageBlock({
    url: 'https://ci.example.com/api/v1/tasks/t1?project=demo&offset=0&limit=2',
    offset: 0,
    limit: 2,
    total: 9,
  });

  const next = new URL(block.next);
  assert.equal(next.searchParams.get('project'), 'demo', 'a filter must survive the page turn');
  assert.equal(next.searchParams.get('offset'), '2');
  assert.equal(next.searchParams.get('limit'), '2');
});

test('the key order is next, offset, total', () => {
  const block = pageBlock({ url: 'https://ci.example.com/x', offset: 0, limit: 2, total: 9 });
  assert.deepEqual(Object.keys(block), ['next', 'offset', 'total']);
});
