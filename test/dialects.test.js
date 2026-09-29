// test/dialects.test.js - the same behaviour on postgres and mysql
//
// Everything else jobs on sqlite, so the other two dialects were only
// exercised by reading them. This applies every migration against a real
// server and then jobs the retention sweep, which is the query that most
// depends on the dialect: it joins, filters on nulls, orders, and binds a
// LIMIT, and the drivers do not all accept those the same way. Paging is
// checked here for the same reason, since it binds an OFFSET as well.
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
import { paginateOffset, pageBlock } from '../src/lib/page.js';
import { createStorage } from '../src/lib/storage/index.js';
import { createLogStore } from '../src/lib/log.js';
import { createRetention } from '../src/conductor/retention.js';
import { createWorkerTokens } from '../src/lib/workers.js';
import { createRefreshTokens } from '../src/lib/auth/refresh.js';
import { createScheduler } from '../src/conductor/scheduler.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

// The same shape the sqlite tests use, so the expectations below can be
// compared against what that dialect already proves.
async function seed(db, storage) {
  await db.run(
    `INSERT INTO projects (id, name, repo_url, enabled, job_counter, created_at, updated_at)
     VALUES ('demo', 'Demo', '/tmp/repo', 1, 0, {now}, {now})`,
    { now: NOW }
  );

  for (let i = 1; i <= 5; i += 1) {
    // Job 5 is recent; the rest are long past.
    const at = NOW - (i === 5 ? 1 : 100) * DAY;
    await db.run(
      `INSERT INTO jobs (id, project_id, number, head_sha, trigger_type, state,
                         visibility, created_at, started_at, finished_at)
       VALUES ({id}, 'demo', {number}, {sha}, 'push', 'failed', 'public', {at}, {at}, {at})`,
      { id: `r${i}`, number: i, sha: 'a'.repeat(40), at }
    );
    await db.run(
      `INSERT INTO tasks (id, job_id, name, base_name, image, requires, spec, state,
                         allow_failure, attempt, max_attempts, timeout,
                         log_key, log_size, created_at, finished_at)
       VALUES ({id}, {job}, 'build', 'build', 'alpine:3', '[]', '{}', 'failed',
               0, 1, 1, 3600, {logKey}, 10, {at}, {at})`,
      { id: `r${i}:build`, job: `r${i}`, logKey: `logs/r${i}`, at }
    );
    await db.run(
      `INSERT INTO artifacts (id, task_id, job_id, path, storage_key, size, sha256,
                              created_at, expires_at)
       VALUES ({id}, {task}, {job}, 'out.txt', {key}, 5, {sha}, {at}, {expires})`,
      {
        id: `a${i}`,
        task: `r${i}:build`,
        job: `r${i}`,
        key: `art/r${i}`,
        sha: 'b'.repeat(64),
        at,
        // Job 1 carries an explicit deadline, which nothing protects.
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
        artifact_keep_jobs: 2,
        artifact_keep_days: 7,
        log_keep_days: 7,
        worker_agent_keep_hours: 24,
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

      // Paging binds both LIMIT and OFFSET, and reads a COUNT back. The
      // count has to arrive as a number: postgres returns int8, which the
      // driver would otherwise hand over as a string and turn the page
      // arithmetic into concatenation. Checked before the sweep, while
      // all five jobs are still there.
      const firstPage = await paginateOffset(db, {
        select: 'id', from: 'jobs', order: 'number', offset: 0, limit: 2,
      });
      assert.equal(firstPage.rows.length, 2);
      assert.equal(typeof firstPage.total, 'number', 'COUNT came back as a string');
      assert.equal(firstPage.total, 5);

      const lastPage = await paginateOffset(db, {
        select: 'id', from: 'jobs', order: 'number', offset: 4, limit: 2,
      });
      assert.deepEqual(lastPage.rows.map((r) => r.id), ['r5'], 'the offset landed wrong');

      const window = await paginateOffset(db, {
        select: 'id', from: 'jobs', order: 'number', offset: 2, limit: 2,
      });
      assert.deepEqual(window.rows.map((r) => r.id), ['r3', 'r4']);
      assert.equal(typeof window.total, 'number', 'COUNT came back as a string');
      assert.equal(window.total, 5);

      const tail = await paginateOffset(db, {
        select: 'id', from: 'jobs', order: 'number', offset: 4, limit: 2,
      });
      assert.deepEqual(tail.rows.map((r) => r.id), ['r5']);
      assert.ok(!('next' in pageBlock({ url: 'https://x.test/j', ...tail })), 'that was the last page');

      // The unique index is what makes a repeat claim update, not duplicate.
      const workerTokens = createWorkerTokens({ db });
      const token = await workerTokens.create('dialect-worker');

      await workerTokens.recordAgent({ tokenId: token.id, name: 'builder-01', arches: ['x86_64'], features: ['dind'] });
      await workerTokens.recordAgent({ tokenId: token.id, name: 'builder-01', arches: ['x86_64'], features: ['dind', 'sign'] });
      await workerTokens.recordAgent({ tokenId: token.id, name: 'builder-02', arches: [], features: [] });

      const agents = await workerTokens.agentsFor(token.id);
      assert.deepEqual(agents.map((a) => a.name).sort(), ['builder-01', 'builder-02']);
      assert.deepEqual(
        agents.find((a) => a.name === 'builder-01').features,
        ['dind', 'sign'],
        'the repeat claim should have updated in place'
      );

      await db.run(
        "UPDATE worker_agents SET last_seen_at = {then} WHERE name = 'builder-02'",
        { then: NOW - 2 * DAY }
      );
      await db.run(
        "UPDATE worker_agents SET last_seen_at = {then} WHERE name = 'builder-01'",
        { then: NOW - 1000 }
      );

      const retention = createRetention({
        cfg, db, storage, logs, refreshTokens: createRefreshTokens({ db }), logger: {},
      });

      const first = await retention.sweep({ now: NOW });

      assert.equal(first.agents, 1, 'only the machine that stopped claiming should go');
      assert.deepEqual((await workerTokens.agentsFor(token.id)).map((a) => a.name), ['builder-01']);

      // Job 1 by its own deadline, jobs 2 and 3 by policy. Jobs 4 and 5
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

      const withLogs = await db.all('SELECT id FROM tasks WHERE log_key IS NOT NULL ORDER BY id', {});
      assert.deepEqual(withLogs.map((r) => r.id), ['r5:build'], 'only the recent job keeps its log');

      // The tasks themselves are history and stay.
      const tasks = await db.get('SELECT COUNT(*) AS c FROM tasks', {});
      assert.equal(Number(tasks.c), 5, 'sweeping a log must not remove the task');
    } finally {
      await db?.close().catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
      await server.stop();
    }
  });

  // Snapshot-at-first-read dialects only; sqlite serialises and cannot reach this.
  test(`simultaneous completions settle the job on ${dialect}`, { skip: !dialectAvailable(dialect) }, async () => {
    const server = await startDatabase(dialect);
    const cfg = { database: { url: server.url, dialect: dialectFromUrl(server.url) } };
    const width = 8;

    let db;
    try {
      db = await openDatabase(cfg);
      await runMigrations(db, { logger: () => {} });

      await db.run(
        `INSERT INTO projects (id, name, repo_url, enabled, job_counter, created_at, updated_at)
         VALUES ('demo', 'Demo', '/tmp/repo', 1, 0, {now}, {now})`,
        { now: NOW }
      );
      await db.run(
        `INSERT INTO jobs (id, project_id, number, head_sha, trigger_type, state,
                           visibility, created_at, started_at)
         VALUES ('j1', 'demo', 1, {sha}, 'push', 'running', 'public', {now}, {now})`,
        { sha: 'a'.repeat(40), now: NOW }
      );
      for (let i = 0; i < width; i += 1) {
        await db.run(
          `INSERT INTO tasks (id, job_id, name, base_name, image, requires, spec, state,
                              allow_failure, attempt, max_attempts, timeout, log_size, created_at)
           VALUES ({id}, 'j1', {name}, {name}, 'alpine:3', '[]', '{}', 'running',
                   0, 1, 1, 3600, 0, {now})`,
          { id: `t${i}`, name: `build-${i}`, now: NOW }
        );
      }

      const scheduler = createScheduler({
        cfg: { ...cfg, scheduler: {} },
        db,
        git: {}, logs: {}, storage: {}, projects: {}, secrets: {},
        logger: { warn() {}, error() {}, info() {}, debug() {} },
      });

      // Started together so every snapshot predates every commit; sequential
      // completion hides the bug.
      const outcomes = await Promise.all(
        Array.from({ length: width }, (_, i) => scheduler.complete(`t${i}`, { success: true }))
      );
      assert.ok(outcomes.every((o) => o.ok), 'every completion should be accepted');

      const job = await db.get("SELECT state FROM jobs WHERE id = 'j1'", {});
      assert.equal(job.state, 'success', 'the last completion has to settle the job');
      assert.equal(
        outcomes.filter((o) => o.jobState === 'success').length, 1,
        'exactly one completion should report the settle'
      );
    } finally {
      await db?.close().catch(() => {});
      await server.stop();
    }
  });
}
