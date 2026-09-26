// test/static.test.js - serving the built application

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import staticRoutes, { contentSecurityPolicy } from '../src/lib/static.js';

async function serve(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-web-'));
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }

  const app = Fastify();
  await app.register(staticRoutes, { dir });
  return { app, cleanup: async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}

const BUNDLE = {
  'index.html': '<!DOCTYPE html><html><body><script src="main.js"></script></body></html>',
  'main.js': 'console.log(1)\n',
  'global.css': 'body{}\n',
  'assets/icon.svg': '<svg></svg>',
};

test('what is on disk is served, with its type and an etag', async () => {
  const { app, cleanup } = await serve(BUNDLE);

  const js = await app.inject({ method: 'GET', url: '/main.js' });
  assert.equal(js.statusCode, 200);
  assert.match(js.headers['content-type'], /text\/javascript/);
  assert.ok(js.headers.etag);

  const css = await app.inject({ method: 'GET', url: '/global.css' });
  assert.match(css.headers['content-type'], /text\/css/);

  const nested = await app.inject({ method: 'GET', url: '/assets/icon.svg' });
  assert.equal(nested.statusCode, 200);
  assert.match(nested.headers['content-type'], /image\/svg/);

  await cleanup();
});

test('an unchanged file is answered with a not modified', async () => {
  const { app, cleanup } = await serve(BUNDLE);

  const first = await app.inject({ method: 'GET', url: '/main.js' });
  const again = await app.inject({
    method: 'GET', url: '/main.js', headers: { 'if-none-match': first.headers.etag },
  });

  assert.equal(again.statusCode, 304);
  assert.equal(again.body, '');
  await cleanup();
});

test('the root serves the index', async () => {
  const { app, cleanup } = await serve(BUNDLE);

  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<!DOCTYPE html>/);
  await cleanup();
});

// The routes are built from what was found, so there is no path to traverse.
test('nothing outside the directory can be requested', async () => {
  const { app, cleanup } = await serve(BUNDLE);

  for (const url of ['/../package.json', '/%2e%2e/package.json', '/assets/../../package.json']) {
    const res = await app.inject({ method: 'GET', url, headers: { accept: 'application/json' } });
    assert.equal(res.statusCode, 404, `${url} must not resolve`);
  }
  await cleanup();
});

test('a deep link is answered with the index, and a missing file is not', async () => {
  const { app, cleanup } = await serve(BUNDLE);

  const page = await app.inject({ method: 'GET', url: '/jobs/abc', headers: { accept: 'text/html' } });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /<!DOCTYPE html>/);

  const asset = await app.inject({ method: 'GET', url: '/missing.js', headers: { accept: '*/*' } });
  assert.equal(asset.statusCode, 404);

  const posted = await app.inject({ method: 'POST', url: '/jobs', headers: { accept: 'text/html' } });
  assert.equal(posted.statusCode, 404);

  await cleanup();
});

test('the index carries a content security policy and other files do not', async () => {
  const { app, cleanup } = await serve(BUNDLE);

  const index = await app.inject({ method: 'GET', url: '/' });
  const policy = index.headers['content-security-policy'];
  assert.ok(policy, 'the index must carry a policy');
  assert.match(policy, /script-src 'self'/);
  assert.ok(!policy.includes('unsafe-inline'), 'nothing in the bundle is inline');

  const js = await app.inject({ method: 'GET', url: '/main.js' });
  assert.equal(js.headers['content-security-policy'], undefined);

  await cleanup();
});

test('a provider origin is allowed to be connected to', () => {
  const policy = contentSecurityPolicy(['https://idp.example.com']);
  assert.match(policy, /connect-src 'self' https:\/\/idp\.example\.com/);
  assert.match(policy, /frame-ancestors 'none'/);
});

test('a tree with no build serves nothing rather than failing', async () => {
  const { app, cleanup } = await serve({});

  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 404);
  await cleanup();
});
