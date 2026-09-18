// test/query.test.js - named bind marker compilation

import test from 'node:test';
import assert from 'node:assert/strict';
import { compileQuery, bindParams } from '../src/lib/db/query.js';

test('compiles markers to the placeholder each dialect expects', () => {
  const sql = 'SELECT * FROM jobs WHERE run_id = {run} AND state = {state}';

  assert.equal(compileQuery(sql, 'sqlite').sql, 'SELECT * FROM jobs WHERE run_id = ? AND state = ?');
  assert.equal(compileQuery(sql, 'mysql').sql, 'SELECT * FROM jobs WHERE run_id = ? AND state = ?');
  assert.equal(compileQuery(sql, 'postgres').sql, 'SELECT * FROM jobs WHERE run_id = $1 AND state = $2');

  assert.deepEqual(compileQuery(sql, 'postgres').keys, ['run', 'state']);
});

test('numbers postgres placeholders per occurrence, including repeats', () => {
  const { sql, keys } = compileQuery('SELECT {a}, {b}, {a}', 'postgres');
  assert.equal(sql, 'SELECT $1, $2, $3');
  assert.deepEqual(keys, ['a', 'b', 'a']);
});

test('ignores markers inside string literals and comments', () => {
  const sql = "SELECT '{notabind}' AS a, {real} -- {alsonot}\n, \"{quoted}\"";
  const { keys } = compileQuery(sql, 'sqlite');
  assert.deepEqual(keys, ['real']);
  assert.ok(compileQuery(sql, 'sqlite').sql.includes("'{notabind}'"));
});

test('a json literal in default text survives untouched', () => {
  const { sql, keys } = compileQuery("UPDATE t SET spec = '{}' WHERE id = {id}", 'postgres');
  assert.equal(sql, "UPDATE t SET spec = '{}' WHERE id = $1");
  assert.deepEqual(keys, ['id']);
});

test('doubling a brace escapes it', () => {
  const { sql, keys } = compileQuery('SELECT {{name}} , {name}', 'sqlite');
  assert.equal(sql, 'SELECT {name} , ?');
  assert.deepEqual(keys, ['name']);
});

test('block comments are skipped, and nest only for postgres', () => {
  assert.deepEqual(compileQuery('SELECT /* {no} */ {yes}', 'mysql').keys, ['yes']);
  assert.deepEqual(compileQuery('SELECT /* a /* {no} */ b */ {yes}', 'postgres').keys, ['yes']);
});

test('postgres dollar quoted bodies are skipped', () => {
  const { keys } = compileQuery('SELECT $tag$ {no} $tag$, {yes}', 'postgres');
  assert.deepEqual(keys, ['yes']);
});

test('mysql backtick identifiers and hash comments are skipped', () => {
  assert.deepEqual(compileQuery('SELECT `col{no}`, {yes} # {alsono}\n', 'mysql').keys, ['yes']);
});

test('a malformed marker is rejected with a useful message', () => {
  assert.throws(() => compileQuery('SELECT {not a name}', 'sqlite'), /malformed bind marker/);
});

test('binds by name, resolving dotted paths', () => {
  const { keys, sql } = compileQuery('SELECT {a}, {nested.deep.value}', 'sqlite');
  assert.deepEqual(bindParams(keys, { a: 1, nested: { deep: { value: 'x' } } }, sql), [1, 'x']);
});

test('an exact key beats path traversal', () => {
  const { keys, sql } = compileQuery('SELECT {a.b}', 'sqlite');
  assert.deepEqual(bindParams(keys, { 'a.b': 'flat', a: { b: 'nested' } }, sql), ['flat']);
});

test('reports every missing key at once', () => {
  const { keys, sql } = compileQuery('SELECT {a}, {b}, {c}', 'sqlite');
  assert.throws(
    () => bindParams(keys, { b: 1 }, sql),
    (e) => /missing bind parameter\(s\): a, c/.test(e.message)
  );
});

test('rejects an array of parameters, which would silently bind by position', () => {
  const { keys, sql } = compileQuery('SELECT {a}', 'sqlite');
  assert.throws(() => bindParams(keys, ['x'], sql), /must be an object/);
});

test('normalizes booleans, dates and null', () => {
  const { keys, sql } = compileQuery('SELECT {t}, {f}, {d}, {n}', 'sqlite');
  const at = new Date('2026-01-02T03:04:05.678Z');
  assert.deepEqual(bindParams(keys, { t: true, f: false, d: at, n: null }, sql), [1, 0, at.getTime(), null]);
});

test('rejects an object value, which is nearly always a forgotten stringify', () => {
  const { keys, sql } = compileQuery('SELECT {spec}', 'sqlite');
  assert.throws(() => bindParams(keys, { spec: { a: 1 } }, sql), /unsupported type object/);
});
