// test/db.test.js - sqlite driver and migration runner
//
// The mysql and postgres drivers share the query compiler and parameter
// handling that is exercised here. Their wire behaviour is covered by the
// integration suite, which needs a live server.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, runMigrations } from '../src/lib/db/index.js';
import { splitStatements } from '../src/lib/db/migrate.js';
import { dialectFromUrl } from '../src/lib/db/dialect.js';

const quiet = () => {};

async function tempDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-db-'));
  const cfg = { database: { dialect: 'sqlite', path: path.join(dir, 'test.db') } };
  const db = await openDatabase(cfg);
  return { db, dir, cleanup: async () => { await db.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}

test('dialect detection covers every supported scheme', () => {
  assert.equal(dialectFromUrl(null), 'sqlite');
  assert.equal(dialectFromUrl('mysql://u:p@h/db'), 'mysql');
  assert.equal(dialectFromUrl('postgres://u:p@h/db'), 'postgres');
  assert.equal(dialectFromUrl('postgresql://u:p@h/db'), 'postgres');
  assert.equal(dialectFromUrl('mongodb://h/db'), null);
});

test('statement splitter respects literals and comments', () => {
  const sql = [
    "INSERT INTO t VALUES ('a;b');",
    '-- a comment with ; in it',
    'CREATE TABLE u (id TEXT);',
  ].join('\n');
  const parts = splitStatements(sql, 'sqlite');
  assert.equal(parts.length, 2);
  assert.ok(parts[0].includes("'a;b'"));
  assert.ok(parts[1].startsWith('CREATE TABLE u'));
});

test('statement splitter keeps postgres dollar quoted bodies whole', () => {
  const sql = "CREATE FUNCTION f() RETURNS void AS $$ BEGIN a; b; END $$ LANGUAGE plpgsql;";
  assert.equal(splitStatements(sql, 'postgres').length, 1);
});

test('migrations apply once and are idempotent', async () => {
  const { db, cleanup } = await tempDb();
  try {
    const first = await runMigrations(db, { logger: quiet });
    assert.ok(first.applied.length > 0, 'expected the schema to be created');
    assert.equal(first.applied.length, first.total, 'a fresh database applies every migration');

    const second = await runMigrations(db, { logger: quiet });
    assert.equal(second.applied.length, 0, 'a second job must do nothing');
    assert.equal(second.total, first.total);
  } finally {
    await cleanup();
  }
});

test('an edited migration is refused rather than silently diverging', async () => {
  const { db, dir, cleanup } = await tempDb();
  try {
    const custom = path.join(dir, 'migrations');
    await fs.mkdir(custom);
    await fs.writeFile(path.join(custom, '001_a.sql'), 'CREATE TABLE a (id TEXT);');
    await runMigrations(db, { dir: custom, logger: quiet });

    await fs.writeFile(path.join(custom, '001_a.sql'), 'CREATE TABLE a (id TEXT, extra TEXT);');
    await assert.rejects(
      runMigrations(db, { dir: custom, logger: quiet }),
      /was modified after it was applied/
    );
  } finally {
    await cleanup();
  }
});

test('a migration removed from disk is reported', async () => {
  const { db, dir, cleanup } = await tempDb();
  try {
    const custom = path.join(dir, 'migrations');
    await fs.mkdir(custom);
    await fs.writeFile(path.join(custom, '001_a.sql'), 'CREATE TABLE a (id TEXT);');
    await runMigrations(db, { dir: custom, logger: quiet });
    await fs.rm(path.join(custom, '001_a.sql'));

    await assert.rejects(runMigrations(db, { dir: custom, logger: quiet }), /missing from/);
  } finally {
    await cleanup();
  }
});

test('rows come back as ordinary objects', async () => {
  const { db, cleanup } = await tempDb();
  try {
    await runMigrations(db, { logger: quiet });
    const now = Date.now();
    await db.run(
      'INSERT INTO projects (id, name, repo_url, created_at, updated_at) VALUES ({id}, {n}, {u}, {t}, {t})',
      { id: 'p1', n: 'P', u: 'https://example.invalid/p.git', t: now }
    );
    const row = await db.get('SELECT * FROM projects WHERE id = {id}', { id: 'p1' });
    assert.equal(Object.getPrototypeOf(row), Object.prototype);
    assert.equal(row.name, 'P');
    assert.equal(row.enabled, 1);
  } finally {
    await cleanup();
  }
});

test('a conditional update claims exactly once', async () => {
  const { db, cleanup } = await tempDb();
  try {
    await runMigrations(db, { logger: quiet });
    const t = Date.now();
    await db.run('INSERT INTO projects (id,name,repo_url,created_at,updated_at) VALUES ({i},{n},{u},{t},{t})',
      { i: 'p', n: 'p', u: 'u', t });
    await db.run('INSERT INTO jobs (id,project_id,number,head_sha,created_at) VALUES ({i},{p},{n},{s},{t})',
      { i: 'r', p: 'p', n: 1, s: 'sha', t });
    await db.run(
      'INSERT INTO tasks (id,job_id,name,base_name,image,requires,spec,timeout,created_at) ' +
      'VALUES ({i},{r},{n},{n},{img},{req},{spec},{to},{t})',
      { i: 'r:b', r: 'r', n: 'b', img: 'alpine', req: '[]', spec: '{}', to: 60, t }
    );

    const claim = 'UPDATE tasks SET state = {to} WHERE id = {id} AND state = {from}';
    const first = await db.run(claim, { to: 'running', id: 'r:b', from: 'queued' });
    const second = await db.run(claim, { to: 'running', id: 'r:b', from: 'queued' });
    assert.equal(first.changes, 1);
    assert.equal(second.changes, 0);
  } finally {
    await cleanup();
  }
});

test('deleting a job cascades to its tasks', async () => {
  const { db, cleanup } = await tempDb();
  try {
    await runMigrations(db, { logger: quiet });
    const t = Date.now();
    await db.run('INSERT INTO projects (id,name,repo_url,created_at,updated_at) VALUES ({i},{n},{u},{t},{t})',
      { i: 'p', n: 'p', u: 'u', t });
    await db.run('INSERT INTO jobs (id,project_id,number,head_sha,created_at) VALUES ({i},{p},{n},{s},{t})',
      { i: 'r', p: 'p', n: 1, s: 'sha', t });
    await db.run(
      'INSERT INTO tasks (id,job_id,name,base_name,image,requires,spec,timeout,created_at) ' +
      'VALUES ({i},{r},{n},{n},{img},{req},{spec},{to},{t})',
      { i: 'r:b', r: 'r', n: 'b', img: 'alpine', req: '[]', spec: '{}', to: 60, t }
    );

    await db.run('DELETE FROM jobs WHERE id = {id}', { id: 'r' });
    assert.equal((await db.get('SELECT COUNT(*) AS c FROM tasks', {})).c, 0);
  } finally {
    await cleanup();
  }
});

test('a failed transaction rolls back, and a failed savepoint keeps the outer work', async () => {
  const { db, cleanup } = await tempDb();
  try {
    await runMigrations(db, { logger: quiet });
    const t = Date.now();
    const insert = 'INSERT INTO projects (id,name,repo_url,created_at,updated_at) VALUES ({i},{n},{u},{t},{t})';

    await assert.rejects(db.transaction(async (tx) => {
      await tx.run(insert, { i: 'rolled', n: 'x', u: 'u', t });
      throw new Error('boom');
    }), /boom/);
    assert.equal((await db.get('SELECT COUNT(*) AS c FROM projects', {})).c, 0);

    await db.transaction(async (tx) => {
      await tx.run(insert, { i: 'kept', n: 'x', u: 'u', t });
      await assert.rejects(tx.transaction(async (inner) => {
        await inner.run(insert, { i: 'inner', n: 'x', u: 'u', t });
        throw new Error('inner failed');
      }), /inner failed/);
    });

    const ids = (await db.all('SELECT id FROM projects ORDER BY id', {})).map((r) => r.id);
    assert.deepEqual(ids, ['kept']);
  } finally {
    await cleanup();
  }
});

test('an existing database gains the dependency kind, defaulting to needs', async () => {
  // The edges recorded before there were two kinds all meant needs, and a
  // database upgraded in place has to keep meaning that.
  const { db, dir, cleanup } = await tempDb();
  try {
    const real = path.join(process.cwd(), 'migrations', 'sqlite');
    const staged = path.join(dir, 'migrations');
    await fs.mkdir(staged);

    const all = (await fs.readdir(real)).filter((f) => f.endsWith('.sql')).sort();
    const kindMigration = all.find((f) => f.includes('task_dep_kind'));
    assert.ok(kindMigration, 'expected a migration adding the edge kind');

    for (const file of all.filter((f) => f !== kindMigration)) {
      await fs.copyFile(path.join(real, file), path.join(staged, file));
    }
    await runMigrations(db, { dir: staged, logger: quiet });

    const now = Date.now();
    await db.run(
      `INSERT INTO projects (id, name, repo_url, created_at, updated_at)
       VALUES ('p1', 'p', 'git://x', {now}, {now})`, { now });
    await db.run(
      `INSERT INTO jobs (id, project_id, number, head_sha, created_at)
       VALUES ('j1', 'p1', 1, 'abc', {now})`, { now });
    for (const id of ['t1', 't2']) {
      await db.run(
        `INSERT INTO tasks (id, job_id, name, base_name, image, requires, spec, timeout, created_at)
         VALUES ({id}, 'j1', {id}, {id}, 'alpine', '[]', '{}', 60, {now})`, { id, now });
    }
    await db.run("INSERT INTO task_deps (task_id, depends_on_id) VALUES ('t2', 't1')");

    await fs.copyFile(path.join(real, kindMigration), path.join(staged, kindMigration));
    const upgrade = await runMigrations(db, { dir: staged, logger: quiet });
    assert.deepEqual(upgrade.applied, [kindMigration]);

    const edge = await db.get('SELECT kind FROM task_deps WHERE task_id = {t}', { t: 't2' });
    assert.equal(edge.kind, 'needs');
  } finally {
    await cleanup();
  }
});

test('an existing database gains task outputs, and drops them with the task', async () => {
  const { db, dir, cleanup } = await tempDb();
  try {
    const real = path.join(process.cwd(), 'migrations', 'sqlite');
    const staged = path.join(dir, 'migrations');
    await fs.mkdir(staged);

    const all = (await fs.readdir(real)).filter((f) => f.endsWith('.sql')).sort();
    const outputsMigration = all.find((f) => f.includes('task_outputs'));
    assert.ok(outputsMigration, 'expected a migration adding task outputs');

    for (const file of all.filter((f) => f !== outputsMigration)) {
      await fs.copyFile(path.join(real, file), path.join(staged, file));
    }
    await runMigrations(db, { dir: staged, logger: quiet });

    const now = Date.now();
    await db.run(
      `INSERT INTO projects (id, name, repo_url, created_at, updated_at)
       VALUES ('p1', 'p', 'git://x', {now}, {now})`, { now });
    await db.run(
      `INSERT INTO jobs (id, project_id, number, head_sha, created_at)
       VALUES ('j1', 'p1', 1, 'abc', {now})`, { now });
    await db.run(
      `INSERT INTO tasks (id, job_id, name, base_name, image, requires, spec, timeout, created_at)
       VALUES ('t1', 'j1', 't1', 't1', 'alpine', '[]', '{}', 60, {now})`, { now });

    await fs.copyFile(path.join(real, outputsMigration), path.join(staged, outputsMigration));
    const upgrade = await runMigrations(db, { dir: staged, logger: quiet });
    assert.deepEqual(upgrade.applied, [outputsMigration]);

    await db.run(
      `INSERT INTO task_outputs (task_id, name, value, masked, created_at)
       VALUES ('t1', 'tag', 'sealed', 1, {now})`, { now });
    const stored = await db.get('SELECT masked FROM task_outputs WHERE task_id = {t}', { t: 't1' });
    assert.equal(stored.masked, 1, 'masked by default, as a variable is');

    await db.run("DELETE FROM tasks WHERE id = 't1'");
    const left = await db.all('SELECT name FROM task_outputs');
    assert.deepEqual(left, [], 'outputs go with the task they came from');
  } finally {
    await cleanup();
  }
});
