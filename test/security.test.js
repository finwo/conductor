// test/security.test.js - the authentication boundaries, as regressions
//
// Each test here stands for a specific way in that used to work.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, apiError } from './helpers/harness.js';
import { assertRepoUrl } from '../src/lib/projects.js';

async function withHarness(options, fn) {
  const h = await startHarness(options);
  try {
    await fn(h);
  } finally {
    await h.stop();
  }
}

const json = { 'content-type': 'application/json' };
const PUSH = { sha: null, ref: 'refs/heads/main' };

function push(h) {
  return JSON.stringify({ ...PUSH, sha: h.sha });
}

// --- starting a build ---

test('a trigger without a signature or a session is refused', async () => {
  await withHarness({}, async (h) => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/demo/trigger',
      headers: json,
      payload: push(h),
    });
    assert.equal(res.statusCode, 401, res.body);
    assert.equal(apiError(res).name, 'InvalidSignature');
  });
});

test('a project carrying no trigger secret is still not world-buildable', async () => {
  await withHarness({}, async (h) => {
    await h.services.projects.setTriggerSecret('demo', null);

    for (const url of ['/api/v1/projects/demo/trigger', '/api/v1/projects/demo/jobs']) {
      const res = await h.app.inject({ method: 'POST', url, headers: json, payload: push(h) });
      assert.equal(res.statusCode, 401, `${url}: ${res.body}`);
    }
  });
});

test('a valid webhook signature still starts a build', async () => {
  await withHarness({}, async (h) => {
    const body = push(h);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/demo/trigger',
      headers: { ...json, 'x-hub-signature-256': h.sign(body) },
      payload: body,
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().data.status, 'created');
    await h.waitForJob(res.json().data.job_id);
  });
});

test('an owner may trigger with a session and no signature', async () => {
  await withHarness({ bootstrap: true }, async (h) => {
    const { headers } = await h.login();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/demo/trigger',
      headers: { ...headers, ...json },
      payload: push(h),
    });
    assert.equal(res.statusCode, 200, res.body);
    await h.waitForJob(res.json().data.job_id);
  });
});

// --- reading a build back ---

test('a trigger secret does not read a private job', async () => {
  await withHarness({ visibility: 'private' }, async (h) => {
    const body = push(h);
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects/demo/trigger',
      headers: { ...json, 'x-hub-signature-256': h.sign(body) },
      payload: body,
    });
    const jobId = created.json().data.job_id;
    await h.waitForJob(jobId);

    for (const url of [`/api/v1/jobs/${jobId}`, `/api/v1/projects/demo/jobs/${jobId}`]) {
      const res = await h.app.inject({
        method: 'GET',
        url,
        headers: { ...json, 'x-hub-signature-256': h.sign('') },
      });
      assert.equal(res.statusCode, 404, `${url}: ${res.body}`);
    }
  });
});

test('listing the jobs of a private project does not confirm it exists', async () => {
  await withHarness({ visibility: 'private', bootstrap: true }, async (h) => {
    const missing = await h.app.inject({ method: 'GET', url: '/api/v1/projects/nope/jobs' });
    const hidden = await h.app.inject({ method: 'GET', url: '/api/v1/projects/demo/jobs' });

    assert.equal(hidden.statusCode, 404, hidden.body);
    assert.equal(apiError(hidden).name, 'UnknownProject');
    assert.equal(hidden.statusCode, missing.statusCode);
    assert.equal(apiError(hidden).name, apiError(missing).name);

    const { headers } = await h.login();
    const seen = await h.app.inject({ method: 'GET', url: '/api/v1/projects/demo/jobs', headers });
    assert.equal(seen.statusCode, 200, seen.body);
  });
});

// --- repo_url ---

test('assertRepoUrl refuses transports that are not a repository', async () => {
  const refused = [
    "ext::sh -c 'id>/tmp/pwned'",
    'file:///etc/passwd',
    'file:///srv/git/other.git',
    'http://169.254.169.254/latest/meta-data/',
    '--upload-pack=/bin/sh',
    '/srv/git/other.git',
    '',
  ];
  for (const url of refused) {
    assert.throws(() => assertRepoUrl(url), undefined, `${JSON.stringify(url)} should be refused`);
  }

  const accepted = [
    'https://example.com/a/b.git',
    'ssh://git@example.com/a/b.git',
    'git://example.com/a/b.git',
    'git@example.com:a/b.git',
  ];
  for (const url of accepted) {
    assert.equal(assertRepoUrl(url), url);
  }

  // The admin CLI clones from disk; the API never does.
  assert.equal(assertRepoUrl('/srv/git/other.git', { allowLocalPath: true }), '/srv/git/other.git');
});

test('the api refuses a project whose repo_url is a command', async () => {
  await withHarness({ bootstrap: true }, async (h) => {
    const { headers } = await h.login();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { ...headers, ...json },
      payload: JSON.stringify({ id: 'evil', repo_url: "ext::sh -c 'id'" }),
    });
    assert.equal(res.statusCode, 400, res.body);
  });
});

test('a project is never created without a trigger secret', async () => {
  await withHarness({ bootstrap: true }, async (h) => {
    const { headers } = await h.login();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { ...headers, ...json },
      payload: JSON.stringify({
        id: 'nosecret',
        repo_url: 'https://example.com/a/b.git',
        trigger_secret: null,
      }),
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().data.has_trigger_secret, true);
    assert.ok(res.json().data.trigger_secret);
  });
});

// --- passwords ---

test('changing your own password needs the current one', async () => {
  await withHarness({ bootstrap: true }, async (h) => {
    const { headers } = await h.login();

    const bare = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: { ...headers, ...json },
      payload: JSON.stringify({ password: 'a-brand-new-password' }),
    });
    assert.equal(bare.statusCode, 403, bare.body);

    const wrong = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: { ...headers, ...json },
      payload: JSON.stringify({ password: 'a-brand-new-password', current_password: 'nope' }),
    });
    assert.equal(wrong.statusCode, 403, wrong.body);

    const right = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: { ...headers, ...json },
      payload: JSON.stringify({
        password: 'a-brand-new-password',
        current_password: 'bootstrap-password',
      }),
    });
    assert.equal(right.statusCode, 200, right.body);
  });
});

test('an administrator still resets someone else without their password', async () => {
  await withHarness({ bootstrap: true }, async (h) => {
    const { headers } = await h.login();

    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { ...headers, ...json },
      payload: JSON.stringify({ username: 'someone', password: 'their-password' }),
    });
    assert.equal(created.statusCode, 201, created.body);

    const reset = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${created.json().data.id}`,
      headers: { ...headers, ...json },
      payload: JSON.stringify({ password: 'an-imposed-password' }),
    });
    assert.equal(reset.statusCode, 200, reset.body);
  });
});
