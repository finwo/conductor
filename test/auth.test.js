// test/auth.test.js - password hashing, access tokens and role mapping

import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, validatePassword, generatePassword } from '../src/lib/auth/password.js';
import { signToken, verifyToken } from '../src/lib/auth/token.js';
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

const ACCESS = { use: 'access', iss: 'https://ci.example', aud: 'conductor' };

test('an access token round trips its claims', () => {
  const token = signToken('secret', { ...ACCESS, sub: 'u1', name: 'alice', role: 'admin', ttl: 900 });
  const claims = verifyToken('secret', token, ACCESS);
  assert.equal(claims.sub, 'u1');
  assert.equal(claims.name, 'alice');
  assert.equal(claims.role, 'admin');
});

test('a token signed with another secret is refused', () => {
  const token = signToken('secret', { ...ACCESS, sub: 'u1', ttl: 900 });
  assert.equal(verifyToken('other-secret', token, ACCESS), null);
});

test('a tampered payload is refused', () => {
  const token = signToken('secret', { ...ACCESS, sub: 'u1', role: 'user', ttl: 900 });
  const [header, payload, signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    role: 'admin',
  })).toString('base64url');

  assert.equal(verifyToken('secret', `${header}.${forged}.${signature}`, ACCESS), null);
});

test('an expired token is refused', () => {
  const token = signToken('secret', { ...ACCESS, sub: 'u1', ttl: 60 });
  assert.ok(verifyToken('secret', token, ACCESS));
  assert.equal(verifyToken('secret', token, { ...ACCESS, now: Date.now() + 61_000 }), null);
});

test('a malformed token is refused rather than throwing', () => {
  for (const bad of ['', 'a.b', 'a.b.c.d', 'not-a-token', null, undefined, 12]) {
    assert.equal(verifyToken('secret', bad, ACCESS), null);
  }
});

// A worker token shares the Authorization header with these.
test('an opaque worker token never parses as an access token', () => {
  assert.equal(verifyToken('secret', 'a'.repeat(64), ACCESS), null);
});

// Both are signed with the same secret, so only _tu keeps them apart.
test('an authorization code cannot be spent as an access token', () => {
  const code = signToken('secret', { ...ACCESS, use: 'code', sub: 'u1', ttl: 60 });

  assert.ok(verifyToken('secret', code, { ...ACCESS, use: 'code' }));
  assert.equal(verifyToken('secret', code, ACCESS), null);
});

test('an access token cannot be redeemed as an authorization code', () => {
  const token = signToken('secret', { ...ACCESS, sub: 'u1', ttl: 900 });
  assert.equal(verifyToken('secret', token, { ...ACCESS, use: 'code' }), null);
});

test('a token minted for another issuer or client is refused', () => {
  const token = signToken('secret', { ...ACCESS, sub: 'u1', ttl: 900 });
  assert.equal(verifyToken('secret', token, { ...ACCESS, iss: 'https://evil.example' }), null);
  assert.equal(verifyToken('secret', token, { ...ACCESS, aud: 'other-client' }), null);
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
