// src/lib/db/migrate-cli.js - apply pending migrations
//
// Usage: npm run migrate
//
// The conductor also migrates on startup. This exists for deployments that
// want the schema change to be a separate, reviewable step.

import { loadConfig, ensureStateDirs } from '../config.js';
import { openDatabase } from './index.js';
import { runMigrations } from './migrate.js';

const cfg = loadConfig();
ensureStateDirs(cfg);

const db = await openDatabase(cfg);
try {
  console.log(`[migrate] dialect ${db.dialect}`);
  const result = await runMigrations(db);
  if (result.applied.length === 0) console.log('[migrate] nothing to do');
} catch (e) {
  console.error(`[migrate] ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
