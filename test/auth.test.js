// test/auth.test.js - password hashing, session tokens and role mapping

import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, validatePassword, generatePassword } from '../src/lib/auth/password.js';
import { issueToken, verifyToken, parseCookies, sessionCookie, SESSION_COOKIE } from '../src/lib/auth/token.js';
import { createState, verifyState } from '../src/lib/auth/state.js';
import { collectRoles } from '../src/lib/auth/oidc.js';
import { maskBuffer } from '../src/lib/variables.js';

// scrypt is intentionally slow, so these use the smallest sane parameters.
const FAST = { N: 1024, r: 8, p: 1, keylen: 32 };

test('a password round trips and a wrong one is refused', async () => {
  const stored = await hashPassword('correct horse battery', FAST);
  assert.ok(stored.startsWith('scrypt$1024$8$1$'));
  assert.ok(!stored.includes('correct horse battery'));

  assert.equal(await verifyPassword('correct horse battery', stored), true);
  assert.equal(await verifyPassword('wrong', stored), false);
});

test('the same password hashes differently each time', async () => {
  const a = await hashPassword('same password', FAST);
  const b = await hashPassword('same password', FAST);
  assert.notEqual(a, b, 'a per password salt is required');
  assert.equal(await verifyPassword('same password', a), true);
  assert.equal(await verifyPassword('same password', b), true);
});

test('parameters are read back from the stored hash', async () => {
  // A hash written with one cost must still verify after the default changes.
  const stored = await hashPassword('portable', { N: 2048, r: 8, p: 1, keylen: 32 });
  assert.ok(stored.startsWith('scrypt$2048$'));
  assert.equal(await verifyPassword('portable', stored), true);
});

test('a malformed stored hash is refused rather than throwing', async () => {
  for (const bad of ['', 'nonsense', 'scrypt$x$8$1$aa$bb', 'bcrypt$1$2$3$4$5', 'scrypt$1024$8$1$$']) {
    assert.equal(await verifyPassword('anything', bad), false, `${JSON.stringify(bad)} should be refused`);
  }
});

test('password length is bounded', () => {
  assert.match(validatePassword('short'), /at least 8/);
  assert.match(validatePassword('x'.repeat(2000)), /at most/);
  assert.equal(validatePassword('long enough'), null);
  assert.ok(generatePassword().length >= 20);
});

test('a session token round trips its claims', () => {
  const token = issueToken('secret', { sub: 'u1', name: 'alice', role: 'admin' });
  const claims = verifyToken('secret', token);
  assert.equal(claims.sub, 'u1');
  assert.equal(claims.name, 'alice');
  assert.equal(claims.role, 'admin');
});

test('a token signed with another secret is refused', () => {
  const token = issueToken('secret', { sub: 'u1', name: 'a', role: 'admin' });
  assert.equal(verifyToken('other-secret', token), null);
});

test('a tampered payload is refused', () => {
  const token = issueToken('secret', { sub: 'u1', name: 'a', role: 'viewer' });
  const [header, payload, signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    role: 'admin',
  })).toString('base64url');

  assert.equal(verifyToken('secret', `${header}.${forged}.${signature}`), null);
});

test('an expired token is refused', () => {
  const token = issueToken('secret', { sub: 'u1', name: 'a', role: 'admin' }, { ttl: 60 });
  assert.ok(verifyToken('secret', token));
  assert.equal(verifyToken('secret', token, { now: Date.now() + 61_000 }), null);
});

test('a malformed token is refused rather than throwing', () => {
  for (const bad of ['', 'a.b', 'a.b.c.d', 'not-a-token', null, undefined, 12]) {
    assert.equal(verifyToken('secret', bad), null);
  }
});

test('cookies are parsed and issued', () => {
  const cookies = parseCookies(`a=1; ${SESSION_COOKIE}=abc%20def; b=2`);
  assert.equal(cookies[SESSION_COOKIE], 'abc def');
  assert.deepEqual(parseCookies(undefined), {});

  const header = sessionCookie('tok', { ttl: 60, secure: true });
  assert.ok(header.includes('HttpOnly'));
  assert.ok(header.includes('SameSite=Lax'));
  assert.ok(header.includes('Secure'));
  assert.ok(header.includes('Max-Age=60'));
  assert.ok(!sessionCookie('tok', { secure: false }).includes('Secure'));
});

test('the oidc login state round trips with its return path', () => {
  const now = 1_700_000_000_000;
  const state = createState('secret', '/projects?tab=1', { now });
  assert.deepEqual(verifyState('secret', state, { now }), { iat: 1_700_000_000, url: '/projects?tab=1' });
});

test('a missing return path means the root', () => {
  const state = createState('secret', undefined, { now: 1000 });
  assert.deepEqual(verifyState('secret', state, { now: 1000 }), { iat: 1, url: '/' });
});

test('the oidc login state is refused when forged, stale or off-site', () => {
  const now = 1_700_000_000_000;
  const state = createState('secret', '/', { now });

  assert.equal(verifyState('other-secret', state, { now }), null, 'a wrong secret');
  assert.equal(verifyState('secret', `${state}x`, { now }), null, 'a tampered signature');
  assert.equal(verifyState('secret', state, { now: now + 301_000 }), null, 'older than five minutes');
  assert.equal(verifyState('secret', 'garbage', { now }), null, 'malformed');
  assert.equal(verifyState('secret', createState('secret', '//evil.example', { now }), { now }), null, 'off-site');
});

test('oidc roles are collected from the usual claim shapes', () => {
  assert.deepEqual(collectRoles({ roles: ['a'] }), ['a']);
  assert.deepEqual(collectRoles({ realm_access: { roles: ['keycloak-admin'] } }), ['keycloak-admin']);
  assert.deepEqual(collectRoles({ groups: 'single' }), ['single']);

  const combined = collectRoles({
    roles: ['a'],
    groups: ['b'],
    realm_access: { roles: ['c'] },
    resource_access: { app: { roles: ['d'] } },
  });
  assert.deepEqual(combined.sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(collectRoles({}), []);
});

test('mask replaces secrets, longest first', () => {
  const out = maskBuffer(Buffer.from('token=abcdef and abc12345 here'), ['abcdef', 'abc12345']).toString();
  assert.ok(!out.includes('abcdef'));
  assert.ok(!out.includes('abc12345'));
  assert.equal(out, 'token=[masked] and [masked] here');
});

test('mask ignores very short values and leaves clean output alone', () => {
  assert.equal(maskBuffer(Buffer.from('a b c'), ['a']).toString(), 'a b c');
  const clean = Buffer.from('nothing to hide');
  assert.equal(maskBuffer(clean, ['absent-secret']), clean);
  assert.equal(maskBuffer(clean, []), clean);
});
