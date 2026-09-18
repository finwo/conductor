// test/secretbox.test.js - encryption at rest for stored secrets

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createSecretBox } from '../src/lib/secretbox.js';
import { jobId, slugify, randomId, timeOrderedId, hashToken, safeEqualHex, JOB_ID_MAX } from '../src/lib/ids.js';

const KEY = crypto.randomBytes(32);

test('seals and opens a value', () => {
  const box = createSecretBox(KEY);
  const sealed = box.seal('hunter2');
  assert.ok(sealed.startsWith('v1.'));
  assert.ok(!sealed.includes('hunter2'));
  assert.equal(box.open(sealed), 'hunter2');
});

test('sealing twice produces different ciphertext', () => {
  const box = createSecretBox(KEY);
  assert.notEqual(box.seal('same'), box.seal('same'));
});

test('without a key, values are stored as marked plaintext', () => {
  const box = createSecretBox(null);
  const stored = box.seal('visible');
  assert.ok(stored.startsWith('plain.'));
  assert.equal(box.open(stored), 'visible');
  assert.equal(box.isPlaintext(stored), true);
});

test('a keyed box can still read values written before a key existed', () => {
  const plain = createSecretBox(null).seal('legacy');
  assert.equal(createSecretBox(KEY).open(plain), 'legacy');
});

test('an unkeyed box refuses encrypted values with an actionable message', () => {
  const sealed = createSecretBox(KEY).seal('secret');
  assert.throws(() => createSecretBox(null).open(sealed), /encryption_key is not configured/);
});

test('the wrong key fails to open', () => {
  const sealed = createSecretBox(KEY).seal('secret');
  assert.throws(() => createSecretBox(crypto.randomBytes(32)).open(sealed), /failed to decrypt/);
});

test('tampering with the ciphertext is detected', () => {
  const box = createSecretBox(KEY);
  const parts = box.seal('secret').split('.');
  const body = Buffer.from(parts[3], 'base64');
  body[0] ^= 0xff;
  parts[3] = body.toString('base64');
  assert.throws(() => box.open(parts.join('.')), /failed to decrypt/);
});

test('associated data binds a secret to its location', () => {
  const box = createSecretBox(KEY);
  const sealed = box.seal('token', 'project:a/var:TOKEN');
  assert.equal(box.open(sealed, 'project:a/var:TOKEN'), 'token');
  assert.throws(() => box.open(sealed, 'project:b/var:TOKEN'), /failed to decrypt/);
});

test('a key of the wrong size is refused at construction', () => {
  assert.throws(() => createSecretBox(crypto.randomBytes(16)), /32 byte Buffer/);
});

test('job ids stay readable and within the column width', () => {
  const runId = timeOrderedId();
  assert.equal(jobId(runId, 'build'), `${runId}:build`);

  const long = 'a'.repeat(300);
  const id = jobId(runId, long);
  assert.ok(id.length <= JOB_ID_MAX, `${id.length} exceeds ${JOB_ID_MAX}`);
  assert.ok(id.startsWith(`${runId}:`));
  // Distinct long names must not collide after truncation.
  assert.notEqual(id, jobId(runId, `${long}b`));
});

test('time ordered ids sort by creation time', () => {
  const early = timeOrderedId(1000000000000);
  const late = timeOrderedId(1000000001000);
  assert.ok(early < late);
  assert.equal(early.length, 20);
});

test('random ids use the expected alphabet', () => {
  assert.match(randomId(32), /^[0-9abcdefghjkmnpqrstvwxyz]{32}$/);
});

test('slugify produces readable project ids and falls back when empty', () => {
  assert.equal(slugify('My Project!'), 'my-project');
  assert.equal(slugify('  --weird--  '), 'weird');
  assert.match(slugify('!!!'), /^[0-9a-z]{16}$/);
});

test('token hashing and constant time comparison', () => {
  const a = hashToken('token-value');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(safeEqualHex(a, hashToken('token-value')), true);
  assert.equal(safeEqualHex(a, hashToken('other')), false);
  assert.equal(safeEqualHex(a, 'short'), false);
});
