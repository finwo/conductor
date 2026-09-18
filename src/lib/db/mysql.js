// src/lib/db/mysql.js - MySQL and TiDB driver built on mysql2
//
// mysql2 is an optional dependency: it is only required when database.url
// uses a mysql scheme, so a default sqlite install does not need it.

import { compileCached, bindParams } from './query.js';

async function loadDriver() {
  try {
    return (await import('mysql2/promise')).default;
  } catch (e) {
    throw new Error(
      'database.url uses a mysql scheme but the mysql2 package is not installed. ' +
      'Run `npm install mysql2`, or unset database.url to use sqlite.',
      { cause: e }
    );
  }
}

function fail(e, sql) {
  const err = new Error(`mysql: ${e.message}\n  sql: ${sql.trim().split('\n')[0]}`);
  err.cause = e;
  err.code = e.code;
  throw err;
}

// Wraps either the pool or a single transaction connection.
function wrap(runner) {
  function compile(sql, params) {
    const compiled = compileCached(sql, 'mysql');
    return { text: compiled.sql, values: bindParams(compiled.keys, params, sql) };
  }

  return {
    dialect: 'mysql',

    async all(sql, params = {}) {
      const { text, values } = compile(sql, params);
      try {
        const [rows] = await runner.query(text, values);
        return rows;
      } catch (e) {
        fail(e, sql);
      }
    },

    async get(sql, params = {}) {
      const { text, values } = compile(sql, params);
      try {
        const [rows] = await runner.query(text, values);
        return rows[0];
      } catch (e) {
        fail(e, sql);
      }
    },

    async run(sql, params = {}) {
      const { text, values } = compile(sql, params);
      try {
        const [res] = await runner.query(text, values);
        return {
          changes: res.affectedRows ?? 0,
          lastInsertId: res.insertId === undefined || res.insertId === 0 ? null : Number(res.insertId),
        };
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

export async function openMysql(cfg) {
  const mysql = await loadDriver();
  const pool = mysql.createPool({
    uri: cfg.database.url,
    connectionLimit: cfg.database.connection_limit,
    waitForConnections: true,
    // Epoch millisecond timestamps sit well inside the safe integer range,
    // so BIGINT should come back as a number rather than a string.
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: true,
    multipleStatements: false,
  });

  const api = wrap(pool);

  api.transaction = async function transaction(fn) {
    const conn = await pool.getConnection();
    const tx = wrap(conn);
    let depth = 0;

    // Savepoints give the same composability as the other drivers.
    tx.transaction = async (inner) => {
      const name = `sp_${depth}`;
      depth += 1;
      await conn.query(`SAVEPOINT ${name}`);
      try {
        const r = await inner(tx);
        await conn.query(`RELEASE SAVEPOINT ${name}`);
        depth -= 1;
        return r;
      } catch (e) {
        try {
          await conn.query(`ROLLBACK TO SAVEPOINT ${name}`);
        } catch {
          // Preserve the original failure.
        }
        depth -= 1;
        throw e;
      }
    };

    try {
      await conn.beginTransaction();
      const result = await fn(tx);
      await conn.commit();
      return result;
    } catch (e) {
      try {
        await conn.rollback();
      } catch {
        // Preserve the original failure.
      }
      throw e;
    } finally {
      conn.release();
    }
  };

  api.close = async () => {
    await pool.end();
  };

  return api;
}
