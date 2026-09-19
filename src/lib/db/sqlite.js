// src/lib/db/sqlite.js - sqlite driver built on node:sqlite
//
// node:sqlite is synchronous. The methods here are async purely so that
// callers can treat every dialect identically; there is no thread pool behind
// them. Because each statement runs to completion before the event loop
// turns, a transaction on this driver cannot interleave with another within
// the same process.

import { DatabaseSync } from 'node:sqlite';
import { compileCached, bindParams } from './query.js';

export function openSqlite(cfg) {
  const db = new DatabaseSync(cfg.database.path);

  // WAL keeps readers from blocking the writer.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');

  const statements = new Map();

  function prepare(sql) {
    const compiled = compileCached(sql, 'sqlite');
    let stmt = statements.get(compiled.sql);
    if (!stmt) {
      stmt = db.prepare(compiled.sql);
      statements.set(compiled.sql, stmt);
    }
    return { stmt, keys: compiled.keys };
  }

  function fail(e, sql) {
    const err = new Error(`sqlite: ${e.message}\n  sql: ${sql.trim().split('\n')[0]}`);
    err.cause = e;
    err.code = e.code;
    throw err;
  }

  // node:sqlite hands back null prototype objects. mysql2 and pg both return
  // ordinary objects, so rows are converted here rather than leaving callers
  // to discover the difference.
  const toPlain = (row) => (row === undefined ? undefined : { ...row });

  const api = {
    dialect: 'sqlite',

    async all(sql, params = {}) {
      const { stmt, keys } = prepare(sql);
      const values = bindParams(keys, params, sql);
      try {
        return stmt.all(...values).map(toPlain);
      } catch (e) {
        fail(e, sql);
      }
    },

    async get(sql, params = {}) {
      const { stmt, keys } = prepare(sql);
      const values = bindParams(keys, params, sql);
      try {
        return toPlain(stmt.get(...values));
      } catch (e) {
        fail(e, sql);
      }
    },

    async run(sql, params = {}) {
      const { stmt, keys } = prepare(sql);
      const values = bindParams(keys, params, sql);
      try {
        const r = stmt.run(...values);
        return {
          changes: Number(r.changes),
          lastInsertId: r.lastInsertRowid === undefined ? null : Number(r.lastInsertRowid),
        };
      } catch (e) {
        fail(e, sql);
      }
    },

    // Raw DDL, no bind markers are interpreted.
    async exec(sql) {
      try {
        db.exec(sql);
      } catch (e) {
        fail(e, sql);
      }
    },

    async close() {
      statements.clear();
      db.close();
    },
  };

  // Nesting uses savepoints so that a helper which opens a transaction can be
  // composed inside a larger one.
  let depth = 0;
  api.transaction = async function transaction(fn) {
    const name = `sp_${depth}`;
    if (depth === 0) db.exec('BEGIN IMMEDIATE');
    else db.exec(`SAVEPOINT ${name}`);
    depth += 1;
    try {
      const result = await fn(api);
      depth -= 1;
      if (depth === 0) db.exec('COMMIT');
      else db.exec(`RELEASE ${name}`);
      return result;
    } catch (e) {
      depth -= 1;
      try {
        if (depth === 0) db.exec('ROLLBACK');
        else db.exec(`ROLLBACK TO ${name}`);
      } catch {
        // The original error is more useful than a rollback failure.
      }
      throw e;
    }
  };

  return api;
}
