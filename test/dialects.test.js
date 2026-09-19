// test/dialects.test.js - the same behaviour on postgres and mysql
//
// Everything else runs on sqlite, so the other two dialects were only
// exercised by reading them. This applies every migration against a real
// server and then runs the retention sweep, which is the query that most
// depends on the dialect: it joins, filters on nulls, orders, and binds a
// LIMIT, and the drivers do not all accept those the same way.
//
// Skipped when docker is unavailable, or when the optional drivers are
// not installed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startDatabase, dialectAvailable } from './helpers/database.js';
import { openDatabase, runMigrations, dialectFromUrl } from '../src/lib/db/index.js';
import { createStorage } from '../src/lib/storage/index.js';
import { createLogStore } from '../src/lib/log.js';
import { createRetention } from '../src/conductor/retention.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

// The same shape the sqlite tests use, so the expectations below can be
// compared against what that dialect already proves.
async function seed(db, storage) {
  await db.run(
    `INSERT INTO projects (id, name, repo_url, enabled, run_counter, created_at, updated_at)
     VALUES ('demo', 'Demo', '/tmp/repo', 1, 0, {now}, {now})`,
    { now: NOW }
  );

  for (let i = 1; i <= 5; i += 1) {
    // Run 5 is recent; the rest are long past.
    const at = NOW - (i === 5 ? 1 : 100) * DAY;
    await db.run(
      `INSERT INTO runs (id, project_id, number, head_sha, trigger_type, state,
                         visibility, created_at, started_at, finished_at)
       VALUES ({id}, 'demo', {number}, {sha}, 'push', 'failed', 'public', {at}, {at}, {at})`,
      { id: `r${i}`, number: i, sha: 'a'.repeat(40), at }
    );
    await db.run(
      `INSERT INTO jobs (id, run_id, name, base_name, image, requires, spec, state,
                         allow_failure, attempt, max_attempts, timeout,
                         log_key, log_size, created_at, finished_at)
       VALUES ({id}, {run}, 'build', 'build', 'alpine:3', '[]', '{}', 'failed',
               0, 1, 1, 3600, {logKey}, 10, {at}, {at})`,
      { id: `r${i}:build`, run: `r${i}`, logKey: `logs/r${i}`, at }
    );
    await db.run(
      `INSERT INTO artifacts (id, job_id, run_id, path, storage_key, size, sha256,
                              created_at, expires_at)
       VALUES ({id}, {job}, {run}, 'out.txt', {key}, 5, {sha}, {at}, {expires})`,
      {
        id: `a${i}`,
        job: `r${i}:build`,
        run: `r${i}`,
        key: `art/r${i}`,
        sha: 'b'.repeat(64),
        at,
        // Run 1 carries an explicit deadline, which nothing protects.
        expires: i === 1 ? NOW - 1 : null,
      }
    );
    await storage.put(`art/r${i}`, Buffer.from('artifact'));
    await storage.put(`logs/r${i}`, Buffer.from('log'));
  }
}

for (const dialect of ['postgres', 'mysql']) {
  test(`migrations apply and retention sweeps on ${dialect}`, { skip: !dialectAvailable(dialect) }, async () => {
    const server = await startDatabase(dialect);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `conductor-${dialect}-`));

    const cfg = {
      database: { url: server.url, dialect: dialectFromUrl(server.url) },
      storage: { path: path.join(root, 'storage') },
      log: { spool_path: path.join(root, 'logs'), max_size: 1 << 20 },
      retention: {
        artifact_keep_runs: 2,
        artifact_keep_days: 7,
        log_keep_days: 7,
        sweep_interval: 3600,
        batch: 2,
      },
    };

    let db;
    try {
      db = await openDatabase(cfg);
      await runMigrations(db, { logger: () => {} });

      const storage = await createStorage(cfg);
      const logs = createLogStore(cfg);
      await seed(db, storage);

      const retention = createRetention({ cfg, db, storage, logs, logger: {} });

      const first = await retention.sweep({ now: NOW });

      // Run 1 by its own deadline, runs 2 and 3 by policy. Runs 4 and 5
      // are the last two, so they are kept whatever their age.
      assert.equal(first.artifacts, 3, 'three artifacts should go on the first pass');

      const left = (await db.all('SELECT id FROM artifacts ORDER BY id', {})).map((r) => r.id);
      assert.deepEqual(left, ['a4', 'a5']);

      // Logs are batched, so the four old ones take two passes.
      assert.equal(first.logs, 2, 'the batch limit should hold on this dialect too');
      const second = await retention.sweep({ now: NOW });
      assert.equal(second.artifacts, 0, 'nothing further to delete');
      assert.equal(second.logs, 2);

      const third = await retention.sweep({ now: NOW });
      assert.equal(third.logs, 0, 'a swept log must not be found again');

      const withLogs = await db.all('SELECT id FROM jobs WHERE log_key IS NOT NULL ORDER BY id', {});
      assert.deepEqual(withLogs.map((r) => r.id), ['r5:build'], 'only the recent run keeps its log');

      // The jobs themselves are history and stay.
      const jobs = await db.get('SELECT COUNT(*) AS c FROM jobs', {});
      assert.equal(Number(jobs.c), 5, 'sweeping a log must not remove the job');
    } finally {
      await db?.close().catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
      await server.stop();
    }
  });
}
