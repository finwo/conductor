// src/lib/db/migrate.js - forward-only migration runner
//
// Migrations live in migrations/<dialect>/NNN_name.sql and are applied in
// filename order. Each applied file is recorded with a checksum, so editing a
// migration that has already run is reported as an error rather than silently
// diverging between environments.
//
// Note on atomicity: sqlite and postgres both run DDL inside a transaction,
// so a failed migration rolls back completely there. MySQL and TiDB implicitly
// commit on DDL, so a file that fails halfway can leave its earlier statements
// applied. The surrounding transaction is still worth having on those, since
// it keeps the bookkeeping insert and any DML atomic. Keep one logical change
// per file so a partial apply stays easy to reason about.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RULES } from './query.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_ROOT = path.resolve(HERE, '../../../migrations');

const DDL = {
  sqlite: `
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      executed_at INTEGER NOT NULL
    )
  `,
  mysql: `
    CREATE TABLE IF NOT EXISTS _migrations (
      filename VARCHAR(255) NOT NULL PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      executed_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `,
  postgres: `
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT NOT NULL PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      executed_at BIGINT NOT NULL
    )
  `,
};

// Splits a SQL file into statements on semicolons, while respecting string
// literals, quoted identifiers and comments. Splitting on a bare semicolon,
// as the prototype did, corrupts any statement containing one inside a
// literal. Lexing rules are per dialect, shared with the query compiler.
export function splitStatements(sql, dialect = 'sqlite') {
  const rules = RULES[dialect];
  if (!rules) throw new Error(`unknown dialect: ${dialect}`);

  const out = [];
  let cur = '';
  let i = 0;

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if ((c === '-' && next === '-') || (rules.hash && c === '#')) {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) break;
      cur += '\n';
      i = nl + 1;
      continue;
    }

    if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (rules.nestedBlock && sql[j] === '/' && sql[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      cur += ' ';
      i = j;
      continue;
    }

    if (c === "'" || c === '"' || (rules.backtick && c === '`')) {
      const quote = c;
      cur += c;
      i += 1;
      while (i < sql.length) {
        // Backslash escapes apply to MySQL string literals, not to backtick
        // quoted identifiers.
        if (rules.backslash && quote !== '`' && sql[i] === '\\') {
          cur += sql[i] + (sql[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          // A doubled quote is a literal quote, not a terminator.
          if (sql[i + 1] === quote) {
            cur += quote + quote;
            i += 2;
            continue;
          }
          cur += quote;
          i += 1;
          break;
        }
        cur += sql[i];
        i += 1;
      }
      continue;
    }

    // Dollar quoted bodies routinely contain semicolons.
    if (rules.dollar && c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        cur += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }

    if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i += 1;
      continue;
    }

    cur += c;
    i += 1;
  }

  if (cur.trim()) out.push(cur.trim());
  return out;
}

function checksum(sql) {
  // Normalize line endings so a CRLF checkout does not invalidate history.
  return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export async function runMigrations(db, options = {}) {
  const dir = options.dir || path.join(MIGRATIONS_ROOT, db.dialect);
  const log = options.logger || ((m) => console.log(`[migrate] ${m}`));

  await db.exec(DDL[db.dialect]);

  const appliedRows = await db.all('SELECT filename, checksum FROM _migrations');
  const applied = new Map(appliedRows.map((r) => [r.filename, r.checksum]));

  let files;
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`no migrations directory for dialect ${db.dialect}: ${dir}`);
    throw e;
  }

  const pending = [];
  for (const file of files) {
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    const sum = checksum(sql);
    const prev = applied.get(file);
    if (prev === undefined) {
      pending.push({ file, sql, sum });
      continue;
    }
    if (prev !== sum) {
      throw new Error(
        `migration ${file} was modified after it was applied\n` +
        `  recorded: ${prev}\n` +
        `  on disk:  ${sum}\n` +
        'Add a new migration instead of editing an applied one.'
      );
    }
  }

  // Detect files removed from disk but still recorded, which usually means a
  // downgrade or a bad merge.
  for (const name of applied.keys()) {
    if (!files.includes(name)) {
      throw new Error(`migration ${name} is recorded as applied but is missing from ${dir}`);
    }
  }

  if (pending.length === 0) {
    log(`up to date (${files.length} applied)`);
    return { applied: [], total: files.length };
  }

  const done = [];
  for (const { file, sql, sum } of pending) {
    log(`applying ${file}`);
    const statements = splitStatements(sql, db.dialect);
    if (statements.length === 0) throw new Error(`migration ${file} contains no statements`);
    await db.transaction(async (tx) => {
      for (const stmt of statements) await tx.exec(stmt);
      await tx.run(
        'INSERT INTO _migrations (filename, checksum, executed_at) VALUES ({file}, {sum}, {at})',
        { file, sum, at: Date.now() }
      );
    });
    done.push(file);
  }

  log(`applied ${done.length} migration(s)`);
  return { applied: done, total: files.length };
}
