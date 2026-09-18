// src/lib/config.js - configuration loading for all conductor services
//
// Resolution order, lowest precedence first:
//   1. built-in defaults (see DEFAULTS)
//   2. YAML file, from CONDUCTOR_CONFIG or ./conductor.yaml when present
//   3. environment variables (see ENV_MAP)
//
// Two capabilities switch on automatically when configured, and fall back
// otherwise:
//   storage.s3.bucket set  -> S3 object storage, else local filesystem
//   auth.oidc.issuer set   -> OIDC bearer auth, else built-in user accounts

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { dialectFromUrl } from './db/dialect.js';

const DEFAULTS = {
  server: {
    host: '0.0.0.0',
    port: 8080,
    // Absolute URL this conductor is reachable at. Used when handing workers
    // callback URLs, so it must be correct behind a reverse proxy.
    public_url: 'http://127.0.0.1:8080',
  },
  read_api: {
    host: '0.0.0.0',
    port: 8081,
  },
  database: {
    // Unset means sqlite at database.path. Otherwise the scheme selects the
    // dialect: mysql:// or postgres:// (postgresql:// is accepted too).
    url: null,
    path: './data/conductor.db',
    // Pool sizing for the networked dialects, ignored by sqlite.
    connection_limit: 10,
  },
  storage: {
    path: './data/storage',
    s3: {
      endpoint: null,
      region: 'us-east-1',
      bucket: null,
      access_key_id: null,
      secret_access_key: null,
      // Garage and MinIO need path style addressing.
      force_path_style: true,
    },
  },
  auth: {
    // Signs built-in session tokens. Random per boot when unset, which
    // invalidates existing sessions on restart.
    session_secret: null,
    session_ttl: 43200,
    oidc: {
      issuer: null,
      audience: null,
      admin_role: 'conductor-admin',
    },
    // Created on first boot when the users table is empty.
    bootstrap_admin: {
      username: 'admin',
      password: null,
    },
  },
  secrets: {
    // 32 bytes, hex or base64, for AES-256-GCM encryption of project
    // variables at rest. Required only once project variables are used.
    encryption_key: null,
  },
  git: {
    mirror_path: './data/mirrors',
    // Seconds before a cached mirror fetch is considered stale.
    fetch_interval: 60,
    timeout: 300,
  },
  log: {
    spool_path: './data/logs',
    // Refuse log appends past this size, to bound a runaway job.
    max_size: 64 * 1024 * 1024,
  },
  scheduler: {
    // A claimed job whose worker stops sending heartbeats for this long is
    // considered lost and is requeued or failed.
    heartbeat_timeout: 120,
    reap_interval: 30,
    default_job_timeout: 3600,
    max_attempts: 3,
  },
};

// [environment variable, dotted config path, parser]
const ENV_MAP = [
  ['CONDUCTOR_HOST',                 'server.host',                 String],
  ['CONDUCTOR_PORT',                 'server.port',                 toInt],
  ['CONDUCTOR_PUBLIC_URL',           'server.public_url',           String],
  ['CONDUCTOR_READ_API_HOST',        'read_api.host',               String],
  ['CONDUCTOR_READ_API_PORT',        'read_api.port',               toInt],
  ['CONDUCTOR_DATABASE_URL',         'database.url',                String],
  ['CONDUCTOR_DATABASE_PATH',        'database.path',               String],
  ['CONDUCTOR_STORAGE_PATH',         'storage.path',                String],
  ['CONDUCTOR_S3_ENDPOINT',          'storage.s3.endpoint',         String],
  ['CONDUCTOR_S3_REGION',            'storage.s3.region',           String],
  ['CONDUCTOR_S3_BUCKET',            'storage.s3.bucket',           String],
  ['CONDUCTOR_S3_ACCESS_KEY_ID',     'storage.s3.access_key_id',    String],
  ['CONDUCTOR_S3_SECRET_ACCESS_KEY', 'storage.s3.secret_access_key', String],
  ['CONDUCTOR_S3_FORCE_PATH_STYLE',  'storage.s3.force_path_style', toBool],
  ['CONDUCTOR_SESSION_SECRET',       'auth.session_secret',         String],
  ['CONDUCTOR_OIDC_ISSUER',          'auth.oidc.issuer',            String],
  ['CONDUCTOR_OIDC_AUDIENCE',        'auth.oidc.audience',          String],
  ['CONDUCTOR_OIDC_ADMIN_ROLE',      'auth.oidc.admin_role',        String],
  ['CONDUCTOR_ADMIN_USERNAME',       'auth.bootstrap_admin.username', String],
  ['CONDUCTOR_ADMIN_PASSWORD',       'auth.bootstrap_admin.password', String],
  ['CONDUCTOR_SECRET_KEY',           'secrets.encryption_key',      String],
  ['CONDUCTOR_MIRROR_PATH',          'git.mirror_path',             String],
  ['CONDUCTOR_LOG_PATH',             'log.spool_path',              String],
];

// Paths resolved relative to the config file directory, or cwd when there is
// no config file.
const PATH_KEYS = ['database.path', 'storage.path', 'git.mirror_path', 'log.spool_path'];

function toInt(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`expected an integer, got ${JSON.stringify(v)}`);
  return n;
}

function toBool(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  throw new Error(`expected a boolean, got ${JSON.stringify(v)}`);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, overlay) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(overlay || {})) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  const last = keys.pop();
  let cur = obj;
  for (const k of keys) {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[last] = value;
}

function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (isPlainObject(v) || Array.isArray(v)) deepFreeze(v);
  }
  return Object.freeze(obj);
}

// Reads a 32 byte key given as hex or base64. Returns a Buffer, or null.
export function parseKey(value, label) {
  if (!value) return null;
  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) buf = Buffer.from(value, 'hex');
  else buf = Buffer.from(value, 'base64');
  if (buf.length !== 32) {
    throw new Error(`${label} must decode to 32 bytes, got ${buf.length}; use 64 hex chars or base64`);
  }
  return buf;
}

function validate(cfg) {
  const errors = [];

  // Port 0 asks the operating system for a free port, which is useful in
  // tests and for ephemeral instances.
  for (const key of ['server.port', 'read_api.port']) {
    const port = getPath(cfg, key);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      errors.push(`${key} must be between 0 and 65535, got ${port}`);
    }
  }
  if (cfg.database.url && dialectFromUrl(cfg.database.url) === null) {
    errors.push(
      `database.url has an unsupported scheme: ${String(cfg.database.url).split(':')[0]}; ` +
      'use mysql://, postgres:// or leave it unset for sqlite'
    );
  }

  const s3 = cfg.storage.s3;
  const s3Given = [s3.endpoint, s3.bucket, s3.access_key_id, s3.secret_access_key].filter(Boolean);
  if (s3Given.length > 0 && s3Given.length < 4) {
    errors.push(
      'storage.s3 is partially configured; endpoint, bucket, access_key_id and ' +
      'secret_access_key are all required, or leave them all unset for local storage'
    );
  }

  if (cfg.auth.oidc.issuer) {
    try {
      new URL(cfg.auth.oidc.issuer);
    } catch {
      errors.push(`auth.oidc.issuer must be an absolute URL, got ${JSON.stringify(cfg.auth.oidc.issuer)}`);
    }
  }

  try {
    new URL(cfg.server.public_url);
  } catch {
    errors.push(`server.public_url must be an absolute URL, got ${JSON.stringify(cfg.server.public_url)}`);
  }

  try {
    parseKey(cfg.secrets.encryption_key, 'secrets.encryption_key');
  } catch (e) {
    errors.push(e.message);
  }

  if (cfg.scheduler.heartbeat_timeout <= cfg.scheduler.reap_interval) {
    errors.push(
      `scheduler.heartbeat_timeout (${cfg.scheduler.heartbeat_timeout}) must be greater than ` +
      `scheduler.reap_interval (${cfg.scheduler.reap_interval}), or healthy jobs will be reaped`
    );
  }

  if (errors.length > 0) {
    throw new Error(`invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
}

export function loadConfig(explicitPath) {
  const file = explicitPath || process.env.CONDUCTOR_CONFIG || 'conductor.yaml';
  let cfg = structuredClone(DEFAULTS);
  let baseDir = process.cwd();
  let source = null;

  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    let parsed;
    try {
      parsed = YAML.parse(text) || {};
    } catch (e) {
      throw new Error(`failed to parse config file ${file}: ${e.message}`);
    }
    if (!isPlainObject(parsed)) {
      throw new Error(`config file ${file} must contain a YAML mapping at the top level`);
    }
    cfg = deepMerge(cfg, parsed);
    baseDir = path.dirname(path.resolve(file));
    source = path.resolve(file);
  } else if (explicitPath || process.env.CONDUCTOR_CONFIG) {
    throw new Error(`config file not found: ${file}`);
  }

  for (const [env, dotted, parse] of ENV_MAP) {
    const raw = process.env[env];
    if (raw === undefined || raw === '') continue;
    try {
      setPath(cfg, dotted, parse(raw));
    } catch (e) {
      throw new Error(`invalid value for ${env}: ${e.message}`);
    }
  }

  // A sqlite: or file: url is just another way of spelling database.path.
  // Collapse it now so that everything downstream sees one representation.
  if (cfg.database.url && /^(sqlite|file):/i.test(cfg.database.url)) {
    const raw = cfg.database.url.replace(/^(sqlite|file):(\/\/)?/i, '');
    if (!raw) throw new Error(`database.url ${cfg.database.url} does not contain a file path`);
    cfg.database.path = raw;
    cfg.database.url = null;
  }

  for (const key of PATH_KEYS) {
    const v = getPath(cfg, key);
    if (typeof v === 'string' && v.length > 0) setPath(cfg, key, path.resolve(baseDir, v));
  }

  validate(cfg);

  // Derived flags, so callers never re-implement the fallback rules.
  cfg.source = source;
  cfg.database.dialect = dialectFromUrl(cfg.database.url);
  cfg.storage.driver = cfg.storage.s3.bucket ? 's3' : 'local';
  cfg.auth.mode = cfg.auth.oidc.issuer ? 'oidc' : 'local';

  if (!cfg.auth.session_secret) {
    cfg.auth.session_secret = crypto.randomBytes(32).toString('hex');
    cfg.auth.session_secret_ephemeral = true;
  }

  return deepFreeze(cfg);
}

// Directories that must exist before a service starts. Which ones matter
// depends on the selected drivers, so this is derived rather than fixed.
export function stateDirs(cfg) {
  const dirs = [cfg.git.mirror_path, cfg.log.spool_path];
  if (cfg.storage.driver === 'local') dirs.push(cfg.storage.path);
  if (cfg.database.dialect === 'sqlite') dirs.push(path.dirname(cfg.database.path));
  return [...new Set(dirs)];
}

export function ensureStateDirs(cfg) {
  for (const dir of stateDirs(cfg)) fs.mkdirSync(dir, { recursive: true });
}
