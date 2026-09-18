// src/lib/pipeline/schema.js - validation primitives for pipeline documents
//
// A .conductor.yml is written by hand and frequently by someone who is not
// watching the conductor log, so validation collects every problem and
// reports them together with a path, rather than failing on the first one.
// Unknown keys are errors, not warnings: a silently ignored typo in a
// pipeline is a bad afternoon.

export class PipelineError extends Error {
  constructor(errors, source) {
    const list = errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
    super(`invalid pipeline${source ? ` in ${source}` : ''}:\n${list}`);
    this.name = 'PipelineError';
    this.errors = errors;
    this.source = source;
  }
}

// Collects errors so that one pass reports everything wrong with a document.
export class Problems {
  constructor() {
    this.items = [];
  }

  add(path, message) {
    this.items.push({ path, message });
    return undefined;
  }

  get length() {
    return this.items.length;
  }

  throwIfAny(source) {
    if (this.items.length > 0) throw new PipelineError(this.items, source);
  }
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function checkUnknown(problems, path, value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const hint = suggest(key, allowed);
      problems.add(`${path}.${key}`, `unknown key${hint ? `, did you mean ${hint}` : ''}`);
    }
  }
}

// Cheap edit distance, only to improve the message on a near miss.
function suggest(key, allowed) {
  let best = null;
  let bestScore = Infinity;
  for (const candidate of allowed) {
    const score = distance(key, candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore <= 2 ? best : null;
}

function distance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return rows[a.length][b.length];
}

export function asString(problems, path, value, { max = 4096 } = {}) {
  if (typeof value !== 'string') return problems.add(path, `expected a string, got ${typeName(value)}`);
  if (value.length === 0) return problems.add(path, 'must not be empty');
  if (value.length > max) return problems.add(path, `must be at most ${max} characters`);
  return value;
}

export function asBoolean(problems, path, value) {
  if (typeof value !== 'boolean') return problems.add(path, `expected true or false, got ${typeName(value)}`);
  return value;
}

export function asInteger(problems, path, value, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return problems.add(path, `expected an integer, got ${typeName(value)}`);
  }
  if (value < min || value > max) return problems.add(path, `must be between ${min} and ${max}`);
  return value;
}

// Accepts a single string as a one element list, which is how people
// naturally write a single value.
export function asStringList(problems, path, value, opts = {}) {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  list.forEach((item, i) => {
    const s = asString(problems, `${path}[${i}]`, item, opts);
    if (s !== undefined) out.push(s);
  });
  return out;
}

// Scalar values only. YAML readily produces numbers and booleans here, and
// silently stringifying them hides mistakes, so they are converted but
// anything structured is rejected.
export function asEnvMap(problems, path, value) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    problems.add(path, `expected a mapping of names to values, got ${typeName(value)}`);
    return {};
  }
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      problems.add(`${path}.${key}`, 'is not a valid environment variable name');
      continue;
    }
    if (raw === null) {
      out[key] = '';
    } else if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      out[key] = String(raw);
    } else {
      problems.add(`${path}.${key}`, `expected a scalar value, got ${typeName(raw)}`);
    }
  }
  return out;
}

export const MAX_DURATION = 7 * 24 * 60 * 60;

// Accepts 90, '90s', '30m', '1h', or a composite such as '1h30m'.
export function asDuration(problems, path, value, { max = MAX_DURATION } = {}) {
  let seconds;

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) return problems.add(path, 'expected a whole number of seconds');
    seconds = value;
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (/^\d+$/.test(text)) {
      seconds = parseInt(text, 10);
    } else {
      const matches = [...text.matchAll(/(\d+)([smh])/g)];
      const consumed = matches.reduce((n, m) => n + m[0].length, 0);
      if (matches.length === 0 || consumed !== text.length) {
        return problems.add(path, `expected a duration such as 90s, 30m or 1h30m, got ${JSON.stringify(value)}`);
      }
      const unit = { s: 1, m: 60, h: 3600 };
      seconds = matches.reduce((n, m) => n + parseInt(m[1], 10) * unit[m[2]], 0);
    }
  } else {
    return problems.add(path, `expected a duration, got ${typeName(value)}`);
  }

  if (seconds < 1) return problems.add(path, 'must be at least 1 second');
  if (seconds > max) return problems.add(path, `must be at most ${max} seconds`);
  return seconds;
}

export function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'a list';
  if (v === undefined) return 'nothing';
  if (typeof v === 'object') return 'a mapping';
  return `a ${typeof v}`;
}

// Job and matrix value names appear in generated job names, storage keys and
// environment variables, so the character set is deliberately narrow.
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const MATRIX_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function asName(problems, path, value, { max = 100 } = {}) {
  const s = asString(problems, path, value, { max });
  if (s === undefined) return undefined;
  if (!NAME_PATTERN.test(s)) {
    return problems.add(
      path,
      `${JSON.stringify(s)} must start with a letter or digit and contain only ` +
      'letters, digits, underscore, dot and hyphen'
    );
  }
  return s;
}
