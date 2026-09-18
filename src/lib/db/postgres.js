// src/lib/db/postgres.js - PostgreSQL driver built on pg
//
// pg is an optional dependency: it is only required when database.url uses a
// postgres scheme.
//
// Two adaptations are made so that portable queries keep working:
//   - {name} markers compile to $n, see query.js
//   - int8 is parsed to Number, since epoch millisecond timestamps are well
//     inside the safe integer range and pg returns int8 as a string otherwise
//
// lastInsertId is always null here. The schema uses application generated
// string identifiers throughout, so nothing depends on it; retrieving one
// would need a RETURNING clause the other dialects do not accept.

import { compileCached, bindParams } from './query.js';

async function loadDriver() {
  try {
    return (await import('pg')).default;
  } catch (e) {
    throw new Error(
      'database.url uses a postgres scheme but the pg package is not installed. ' +
      'Run `npm install pg`, or unset database.url to use sqlite.',
      { cause: e }
    );
  }
}

function fail(e, sql) {
  const err = new Error(`postgres: ${e.message}\n  sql: ${sql.trim().split('\n')[0]}`);
  err.cause = e;
  err.code = e.code;
  throw err;
}

// Wraps either the pool or a single transaction client.
function wrap(runner) {
  function compile(sql, params) {
    const compiled = compileCached(sql, 'postgres');
    return { text: compiled.sql, values: bindParams(compiled.keys, params, sql) };
  }

  return {
    dialect: 'postgres',

    async all(sql, params = {}) {
      const { text, values } = compile(sql, params);
      try {
        const res = await runner.query(text, values);
        return res.rows;
      } catch (e) {
        fail(e, sql);
      }
    },

    async get(sql, params = {}) {
      const { text, values } = compile(sql, params);
      try {
        const res = await runner.query(text, values);
        return res.rows[0];
      } catch (e) {
        fail(e, sql);
      }
    },

    async run(sql, params = {}) {
      const { text, values } = compile(sql, params);
      try {
        const res = await runner.query(text, values);
        return { changes: res.rowCount ?? 0, lastInsertId: null };
      } catch (e) {
        fail(e, sql);
      }
    },

    // Raw DDL, no bind markers are interpreted.
    async exec(sql) {
      try {
        await runner.query(sql);
      } catch (e) {
        fail(e, sql);
      }
    },
  };
}

export async function openPostgres(cfg) {
  const pg = await loadDriver();

  // int8 (oid 20) would otherwise arrive as a string.
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

  const pool = new pg.Pool({
    connectionString: cfg.database.url,
    max: cfg.database.connection_limit,
  });

  const api = wrap(pool);

  api.transaction = async function transaction(fn) {
    const client = await pool.connect();
    const tx = wrap(client);
    let depth = 0;

    tx.transaction = async (inner) => {
      const name = `sp_${depth}`;
      depth += 1;
      await client.query(`SAVEPOINT ${name}`);
      try {
        const r = await inner(tx);
        await client.query(`RELEASE SAVEPOINT ${name}`);
        depth -= 1;
        return r;
      } catch (e) {
        try {
          await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        } catch {
          // Preserve the original failure.
        }
        depth -= 1;
        throw e;
      }
    };

    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw e;
    } finally {
      client.release();
    }
  };

  api.close = async () => {
    await pool.end();
  };

  return api;
}
