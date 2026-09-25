// test/refresh.test.js - the refresh token store

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, runMigrations } from '../src/lib/db/index.js';
import { createRefreshTokens } from '../src/lib/auth/refresh.js';
import { newToken, newRefreshTokenId, hashToken } from '../src/lib/ids.js';

const HOUR = 3600_000;

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-refresh-'));
  const db = await openDatabase({ database: { dialect: 'sqlite', path: path.join(dir, 'test.db') } });
  await runMigrations(db, { logger: () => {} });

  await db.run(
    `INSERT INTO users (id, username, password_hash, role, disabled, created_at)
     VALUES ({id}, {u}, 'x', 'user', 0, {now})`,
    { id: 'user-1', u: 'alice', now: Date.now() }
  );
  await db.run(
    `INSERT INTO users (id, username, password_hash, role, disabled, created_at)
     VALUES ({id}, {u}, 'x', 'user', 0, {now})`,
    { id: 'user-2', u: 'bob', now: Date.now() }
  );

  return {
    db,
    store: createRefreshTokens({ db }),
    cleanup: async () => { await db.close(); await fs.rm(dir, { recursive: true, force: true }); },
  };
}

// Issues a session and hands back the raw token, which is never stored.
async function session(store, { userId = 'user-1', ttl = HOUR, now = Date.now(), ...rest } = {}) {
  const token = newToken();
  const row = await store.issue({
    id: newRefreshTokenId(), userId, token, expiresAt: now + ttl, now, ...rest,
  });
  return { token, row };
}

test('a token is stored only as its hash', async () => {
  const { db, store, cleanup } = await fixture();
  const { token, row } = await session(store);

  const stored = await db.get('SELECT token_hash FROM refresh_tokens WHERE id = {id}', { id: row.id });
  assert.equal(stored.token_hash, hashToken(token));
  assert.notEqual(stored.token_hash, token);
  await cleanup();
});

test('claiming finds the row by the raw token alone', async () => {
  const { store, cleanup } = await fixture();
  const { token, row } = await session(store);

  const claimed = await store.claim(token);
  assert.equal(claimed.id, row.id);
  assert.equal(claimed.user_id, 'user-1');
  await cleanup();
});

test('an unknown, empty or non-string token claims nothing', async () => {
  const { store, cleanup } = await fixture();
  await session(store);

  assert.equal(await store.claim(newToken()), null);
  assert.equal(await store.claim(''), null);
  assert.equal(await store.claim(undefined), null);
  assert.equal(await store.claim(null), null);
  await cleanup();
});

test('an expired token claims nothing', async () => {
  const { store, cleanup } = await fixture();
  const now = Date.now();
  const { token } = await session(store, { ttl: HOUR, now: now - 2 * HOUR });

  assert.equal(await store.claim(token, { now }), null);
  await cleanup();
});

// The token is the session. Refreshing does not mint a new one, so two tabs
// refreshing at once cannot race each other into a logout.
test('the token survives a refresh and stays usable', async () => {
  const { store, cleanup } = await fixture();
  const { token, row } = await session(store);

  assert.equal(await store.touch({ id: row.id }), true);
  assert.equal(await store.touch({ id: row.id }), true);

  const again = await store.claim(token);
  assert.equal(again.id, row.id);
  assert.ok(again.last_used_at);
  await cleanup();
});

test('a sliding session moves its deadline forward on use', async () => {
  const { store, cleanup } = await fixture();
  const now = Date.now();
  const { token, row } = await session(store, { ttl: HOUR, now });

  await store.touch({ id: row.id, expiresAt: now + 4 * HOUR, now: now + HOUR / 2 });

  const claimed = await store.claim(token, { now: now + 2 * HOUR });
  assert.equal(claimed.expires_at, now + 4 * HOUR);
  await cleanup();
});

test('an absolute session keeps its original deadline across uses', async () => {
  const { store, cleanup } = await fixture();
  const now = Date.now();
  const { token, row } = await session(store, { ttl: HOUR, now });

  await store.touch({ id: row.id, now: now + HOUR / 2 });

  assert.equal((await store.claim(token, { now: now + HOUR / 2 })).expires_at, now + HOUR);
  assert.equal(await store.claim(token, { now: now + 2 * HOUR }), null);
  await cleanup();
});

test('touching a revoked session reports that it is gone', async () => {
  const { store, cleanup } = await fixture();
  const { row } = await session(store);

  await store.revoke(row.id);
  assert.equal(await store.touch({ id: row.id }), false);
  await cleanup();
});

test('revoking is idempotent and only affects the named row', async () => {
  const { store, cleanup } = await fixture();
  const { token, row } = await session(store);
  const other = await session(store);

  assert.equal(await store.revoke(row.id), true);
  assert.equal(await store.revoke(row.id), false);
  assert.equal(await store.claim(token), null);
  assert.ok(await store.claim(other.token));
  await cleanup();
});

test('revokeAllFor reports how many sessions it ended', async () => {
  const { store, cleanup } = await fixture();
  await session(store);
  await session(store);
  await session(store, { userId: 'user-2' });

  assert.equal(await store.revokeAllFor('user-1'), 2);
  assert.equal(await store.revokeAllFor('user-1'), 0);
  await cleanup();
});

test('paging lists live sessions, newest first, scoped or not', async () => {
  const { store, cleanup } = await fixture();
  const now = Date.now();
  await session(store, { now: now - 2000 });
  const recent = await session(store, { now: now - 1000 });
  await session(store, { userId: 'user-2', now });
  const dead = await session(store);
  await store.revoke(dead.row.id);

  const mine = await store.page({ userId: 'user-1', offset: 0, limit: 10, now });
  assert.equal(mine.total, 2);
  assert.equal(mine.rows[0].id, recent.row.id);

  const all = await store.page({ offset: 0, limit: 10, now });
  assert.equal(all.total, 3);
  await cleanup();
});

test('the agent and address are kept for display', async () => {
  const { store, cleanup } = await fixture();
  await session(store, { userAgent: 'Firefox/1', ip: '10.0.0.1' });

  const listed = await store.page({ userId: 'user-1', offset: 0, limit: 10 });
  assert.equal(listed.rows[0].user_agent, 'Firefox/1');
  assert.equal(listed.rows[0].ip, '10.0.0.1');
  await cleanup();
});

// A train moves between networks and a browser updates itself. Neither is a
// security signal, so both are accepted and the row follows them.
test('roaming to another address and browser still refreshes', async () => {
  const { store, cleanup } = await fixture();
  const { token, row } = await session(store, { userAgent: 'Firefox/1', ip: '10.0.0.1' });

  assert.ok(await store.claim(token));
  await store.touch({ id: row.id, userAgent: 'Firefox/2', ip: '192.0.2.77' });

  assert.ok(await store.claim(token));

  const listed = await store.page({ userId: 'user-1', offset: 0, limit: 10 });
  assert.equal(listed.total, 1);
  assert.equal(listed.rows[0].user_agent, 'Firefox/2');
  assert.equal(listed.rows[0].ip, '192.0.2.77');
  await cleanup();
});

test('sweeping drops expired rows and leaves live ones', async () => {
  const { store, cleanup } = await fixture();
  const now = Date.now();
  await session(store, { ttl: HOUR, now: now - 4 * HOUR });
  const live = await session(store, { ttl: HOUR, now });

  assert.equal(await store.sweep(now - HOUR), 1);
  assert.ok(await store.claim(live.token, { now }));
  await cleanup();
});
