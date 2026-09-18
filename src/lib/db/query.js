// src/lib/db/query.js - named placeholder compilation
//
// Queries are written once, against every dialect, using {name} markers:
//
//   db.get('SELECT * FROM jobs WHERE run_id = {run} AND state = {state}',
//          { run: runId, state: 'queued' })
//
// The marker is compiled to whatever the driver wants (? for sqlite and
// mysql, $n for postgres) and the values are collected into a positional
// array in order of appearance. Binding by name rather than by position
// removes the class of bug where a query gains a clause and every later
// argument silently shifts.
//
// Markers are only recognised in ordinary SQL text. Anything inside a string
// literal, a quoted identifier, a dollar quoted block or a comment is passed
// through untouched, so a JSON literal such as '{}' is safe. Outside those,
// braces are escaped by doubling, so {{name}} emits the literal text {name}.
//
// Dotted names address nested values, so {actor.name} reads params.actor.name.
// A key that exists verbatim on the object wins over path traversal, which
// lets callers pass an already flattened object if they prefer.

import { normalizeValue } from './params.js';

const NAME = /^\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\}/;

// Per dialect lexing rules. Everything here is about deciding what to skip.
export const RULES = {
  sqlite: { hash: false, backtick: true, backslash: false, dollar: false, nestedBlock: false },
  mysql: { hash: true, backtick: true, backslash: true, dollar: false, nestedBlock: false },
  postgres: { hash: false, backtick: false, backslash: false, dollar: true, nestedBlock: true },
};

function placeholder(dialect, index) {
  return dialect === 'postgres' ? `$${index}` : '?';
}

export function compileQuery(sql, dialect) {
  const rules = RULES[dialect];
  if (!rules) throw new Error(`unknown dialect: ${dialect}`);

  let out = '';
  const keys = [];
  let i = 0;

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if ((c === '-' && next === '-') || (rules.hash && c === '#')) {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      out += sql.slice(i, end);
      i = end;
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
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    if (c === "'" || c === '"' || (rules.backtick && c === '`')) {
      const quote = c;
      let j = i + 1;
      while (j < sql.length) {
        if (rules.backslash && quote !== '`' && sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === quote) {
          // A doubled quote is an escaped quote, not a terminator.
          if (sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    if (rules.dollar && c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        out += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }

    // Doubling escapes a brace, so {{name}} yields the literal text {name}.
    if (c === '}' && next === '}') {
      out += '}';
      i += 2;
      continue;
    }

    if (c === '{') {
      if (next === '{') {
        out += '{';
        i += 2;
        continue;
      }
      const m = NAME.exec(sql.slice(i));
      if (!m) {
        throw new Error(
          `malformed bind marker at offset ${i} in query:\n  ${sql.trim()}\n` +
          'Expected {name} or {outer.inner}; write {{ for a literal brace.'
        );
      }
      keys.push(m[1]);
      out += placeholder(dialect, keys.length);
      i += m[0].length;
      continue;
    }

    out += c;
    i += 1;
  }

  return { sql: out, keys };
}

// Compilation is pure and queries come from source code, so the set is finite.
const cache = new Map();

export function compileCached(sql, dialect) {
  const cacheKey = `${dialect}\u0000${sql}`;
  let entry = cache.get(cacheKey);
  if (!entry) {
    entry = compileQuery(sql, dialect);
    cache.set(cacheKey, entry);
  }
  return entry;
}

function resolve(params, key) {
  // An exact property wins, so a pre-flattened object works unchanged.
  if (params != null && Object.hasOwn(params, key)) {
    return { found: true, value: params[key] };
  }
  if (!key.includes('.')) return { found: false };

  let cur = params;
  for (const part of key.split('.')) {
    if (cur == null || typeof cur !== 'object') return { found: false };
    if (!Object.hasOwn(cur, part)) return { found: false };
    cur = cur[part];
  }
  return { found: true, value: cur };
}

export function bindParams(keys, params, sql) {
  if (keys.length === 0) return [];

  if (params == null || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error(
      `bind parameters must be an object, got ${Array.isArray(params) ? 'an array' : typeof params}\n` +
      `  query: ${sql.trim().split('\n')[0]}\n` +
      `  expected keys: ${[...new Set(keys)].join(', ')}`
    );
  }

  const missing = [];
  const values = keys.map((key) => {
    const hit = resolve(params, key);
    if (!hit.found) {
      missing.push(key);
      return null;
    }
    return normalizeValue(hit.value, key);
  });

  if (missing.length > 0) {
    throw new Error(
      `missing bind parameter(s): ${[...new Set(missing)].join(', ')}\n` +
      `  query: ${sql.trim().split('\n')[0]}\n` +
      `  supplied: ${Object.keys(params).join(', ') || '(none)'}`
    );
  }

  return values;
}
