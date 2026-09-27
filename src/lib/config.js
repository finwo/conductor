// src/lib/config.js - configuration loading for all conductor services
//
// Resolution order, lowest precedence first:
//   1. built-in defaults (see DEFAULTS)
//   2. YAML file, from CONDUCTOR_CONFIG or ./conductor.yaml when present
//   3. environment variables (see ENV_MAP)
//
// Two capabilities switch on automatically when configured, and fall back
// otherwise:
//   storage.s3.bucket set       -> S3 object storage, else local filesystem
//   auth.oidc.discovery_url set -> OIDC, else built-in user accounts

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
    // Random per boot when unset, which invalidates existing sessions.
    session_secret: null,
    access_ttl: 900,
    refresh_ttl: 2592000,
    refresh_sliding: true,
    local: {
      enabled: null,
      redirect_uris: null,
    },
    oidc: {
      // The provider's OpenID configuration document. Its issuer and every
      // endpoint are read from here rather than configured separately.
      discovery_url: null,
      client_id: null,
      scopes: 'openid profile email',
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
  // What happens to build output over time. A project may override any of
  // these; see migrations/sqlite/001_initial.sql for how the artifact
  // rules combine. Zero means keep forever.
  retention: {
    // The last this many runs keep their artifacts whatever their age.
    artifact_keep_jobs: 10,
    // Artifacts younger than this are kept whatever has followed them.
    artifact_keep_days: 30,
    // Logs go purely by age, and are the reason this exists at all: they
    // are written for every job, read for almost none, and never stop.
    log_keep_days: 14,
    // A machine that stops claiming for this long is forgotten.
    worker_agent_keep_hours: 24,
    // How often to sweep. Deleting is not urgent, and a sweep walks every
    // project, so this is deliberately not the scheduler's interval.
    sweep_interval: 3600,
    // How much to delete in one pass, so a first sweep over a large
    // backlog cannot monopolise the database or the object store.
    batch: 500,
  },
  scheduler: {
    // A claimed job whose worker stops sending heartbeats for this long is
    // considered lost and is requeued or failed.
    heartbeat_timeout: 120,
    reap_interval: 30,
    default_task_timeout: 3600,
    max_attempts: 1,
  },
};

// [environment variable, dotted config path, parser]
const ENV_MAP = [
  ['CONDUCTOR_RETENTION_ARTIFACT_JOBS', 'retention.artifact_keep_jobs', toInt],
  ['CONDUCTOR_RETENTION_ARTIFACT_DAYS', 'retention.artifact_keep_days', toInt],
  ['CONDUCTOR_RETENTION_LOG_DAYS',      'retention.log_keep_days',      toInt],
  ['CONDUCTOR_RETENTION_WORKER_AGENT_HOURS', 'retention.worker_agent_keep_hours', toInt],
  ['CONDUCTOR_RETENTION_SWEEP_INTERVAL','retention.sweep_interval',     toInt],
  ['CONDUCTOR_HOST',                 'server.host',                 String],
  ['CONDUCTOR_PORT',                 'server.port',                 toInt],
  ['CONDUCTOR_PUBLIC_URL',           'server.public_url',           String],
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
  ['CONDUCTOR_ACCESS_TTL',           'auth.access_ttl',             toInt],
  ['CONDUCTOR_REFRESH_TTL',          'auth.refresh_ttl',            toInt],
  ['CONDUCTOR_REFRESH_SLIDING',      'auth.refresh_sliding',        toBool],
  ['CONDUCTOR_LOCAL_AUTH',           'auth.local.enabled',          toBool],
  ['CONDUCTOR_LOCAL_REDIRECT_URIS',  'auth.local.redirect_uris',    String],
  ['CONDUCTOR_OIDC_DISCOVERY_URL',   'auth.oidc.discovery_url',     String],
  ['CONDUCTOR_OIDC_CLIENT_ID',       'auth.oidc.client_id',         String],
  ['CONDUCTOR_OIDC_SCOPES',          'auth.oidc.scopes',            String],
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

// Comma separated from the environment, a list from a config file.
function redirectUris(value, publicUrl) {
  const given = Array.isArray(value) ? value : String(value ?? '').split(',');
  const uris = given.map((u) => String(u).trim().replace(/\/+$/, '')).filter(Boolean);
  if (uris.length === 0) return [publicUrl.replace(/\/+$/, '')];
  return uris.includes('*') ? ['*'] : uris;
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
  const port = cfg.server.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    errors.push(`server.port must be between 0 and 65535, got ${port}`);
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

  if (cfg.auth.oidc.discovery_url) {
    try {
      new URL(cfg.auth.oidc.discovery_url);
    } catch {
      errors.push(
        `auth.oidc.discovery_url must be an absolute URL, got ${JSON.stringify(cfg.auth.oidc.discovery_url)}`
      );
    }
    if (!cfg.auth.oidc.client_id) {
      errors.push('auth.oidc.client_id is required when auth.oidc.discovery_url is set');
    }
  } else if (cfg.auth.local.enabled === false) {
    errors.push('auth.local.enabled is false and no auth.oidc.discovery_url is set, so nobody could sign in');
  }

  // A bare host:port parses with a nonsense scheme and would match nothing.
  for (const uri of redirectUris(cfg.auth.local.redirect_uris, cfg.server.public_url)) {
    if (uri === '*') continue;
    let parsed = null;
    try {
      parsed = new URL(uri);
    } catch { /* reported below */ }

    if (!parsed || !parsed.protocol.startsWith('http')) {
      errors.push(
        `auth.local.redirect_uris entry ${JSON.stringify(uri)} must be an absolute http or https URL, `
        + 'such as https://ci.example.com, or * to allow any origin'
      );
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

  // Retention deletes things, so a nonsensical value here is worth
  // refusing at startup rather than discovering from missing artifacts.
  for (const key of ['artifact_keep_jobs', 'artifact_keep_days', 'log_keep_days', 'worker_agent_keep_hours']) {
    const value = cfg.retention[key];
    if (!Number.isInteger(value) || value < 0) {
      errors.push(`retention.${key} must be a whole number of zero or more, got ${JSON.stringify(value)}`);
    }
  }

  if (!Number.isInteger(cfg.retention.sweep_interval) || cfg.retention.sweep_interval < 60) {
    errors.push(
      `retention.sweep_interval must be at least 60 seconds, got ${JSON.stringify(cfg.retention.sweep_interval)}`
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

  // The discovery document names one provider, so these two always agree.
  if (cfg.auth.local.enabled === null) cfg.auth.local.enabled = !cfg.auth.oidc.discovery_url;
  cfg.auth.mode = cfg.auth.local.enabled ? 'local' : 'oidc';
  cfg.auth.local.redirect_uris = redirectUris(cfg.auth.local.redirect_uris, cfg.server.public_url);

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
