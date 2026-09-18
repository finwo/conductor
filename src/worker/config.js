// src/worker/config.js - worker configuration
//
// The worker deliberately has no npm dependencies, so that a third party can
// copy src/worker into a host and run it with nothing but node and a
// container runtime. JSON is therefore the native config format. YAML is
// accepted too, but only when the yaml package happens to be resolvable,
// which it is in the official image.
//
// Features are the important part. A feature is a name the worker
// advertises, plus whatever local resources a job asking for it should get:
// mounts, environment, or a privileged container. The conductor only ever
// sees the name, so a signing key can be handed to a build without the
// server holding it.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULTS = {
  conductor_url: 'http://127.0.0.1:8080',
  name: os.hostname(),
  token: null,
  token_file: null,
  arches: [],
  features: {},
  concurrency: 1,
  poll_interval: 5,
  // Container runtime CLI. Podman and nerdctl are argument compatible.
  docker: 'docker',
  // Shell used to run a job script inside its image.
  shell: 'sh',
  workspace_root: null,
  cache_root: null,
  // Applied when a job does not ask for something longer.
  default_timeout: 3600,
};

const ENV_MAP = [
  ['CONDUCTOR_URL', 'conductor_url', String],
  ['CONDUCTOR_WORKER_NAME', 'name', String],
  ['CONDUCTOR_WORKER_TOKEN', 'token', String],
  ['CONDUCTOR_WORKER_TOKEN_FILE', 'token_file', String],
  ['CONDUCTOR_WORKER_ARCHES', 'arches', (v) => splitList(v)],
  ['CONDUCTOR_WORKER_CONCURRENCY', 'concurrency', toInt],
  ['CONDUCTOR_WORKER_POLL_INTERVAL', 'poll_interval', toInt],
  ['CONDUCTOR_WORKER_DOCKER', 'docker', String],
  ['CONDUCTOR_WORKER_SHELL', 'shell', String],
  ['CONDUCTOR_WORKER_WORKSPACE', 'workspace_root', String],
  ['CONDUCTOR_WORKER_CACHE', 'cache_root', String],
];

function splitList(value) {
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

function toInt(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`expected an integer, got ${JSON.stringify(v)}`);
  return n;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

async function readConfigFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) return JSON.parse(text);

  try {
    const YAML = (await import('yaml')).default;
    return YAML.parse(text);
  } catch (e) {
    if (e instanceof SyntaxError || e.name === 'YAMLParseError') throw e;
    throw new Error(
      `cannot read ${file}: the yaml package is not installed. ` +
      'Install it, or use a .json config file.',
      { cause: e }
    );
  }
}

// A feature maps a name onto local resources. Everything is optional, so
// `{ "dind": {} }` is a valid way to advertise a capability that needs no
// setup of its own.
function normalizeFeature(name, raw, problems) {
  if (raw === null || raw === undefined) return { mounts: [], env: {}, privileged: false, devices: [] };
  if (!isPlainObject(raw)) {
    problems.push(`features.${name}: expected a mapping`);
    return null;
  }

  const allowed = ['mounts', 'env', 'privileged', 'devices'];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) problems.push(`features.${name}.${key}: unknown key`);
  }

  const mounts = [];
  for (const [i, mount] of (raw.mounts ?? []).entries()) {
    if (typeof mount !== 'string' || !mount.includes(':')) {
      problems.push(`features.${name}.mounts[${i}]: expected "host:container" or "host:container:ro"`);
      continue;
    }
    mounts.push(mount);
  }

  const env = {};
  for (const [key, value] of Object.entries(raw.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      problems.push(`features.${name}.env.${key}: not a valid environment variable name`);
      continue;
    }
    env[key] = String(value);
  }

  return {
    mounts,
    env,
    privileged: raw.privileged === true,
    devices: (raw.devices ?? []).map(String),
  };
}

export async function loadWorkerConfig(explicitPath) {
  const file = explicitPath || process.env.CONDUCTOR_WORKER_CONFIG || null;
  let cfg = { ...DEFAULTS };

  if (file) {
    if (!fs.existsSync(file)) throw new Error(`worker config not found: ${file}`);
    const parsed = await readConfigFile(file);
    if (!isPlainObject(parsed)) throw new Error(`${file} must contain a mapping at the top level`);
    cfg = { ...cfg, ...parsed };
  }

  for (const [env, key, parse] of ENV_MAP) {
    const raw = process.env[env];
    if (raw === undefined || raw === '') continue;
    try {
      cfg[key] = parse(raw);
    } catch (e) {
      throw new Error(`invalid value for ${env}: ${e.message}`);
    }
  }

  const problems = [];

  if (typeof cfg.conductor_url !== 'string') problems.push('conductor_url must be a string');
  else {
    try {
      new URL(cfg.conductor_url);
    } catch {
      problems.push(`conductor_url must be an absolute URL, got ${JSON.stringify(cfg.conductor_url)}`);
    }
  }

  if (!Array.isArray(cfg.arches)) {
    problems.push('arches must be a list');
    cfg.arches = [];
  }
  if (!Number.isInteger(cfg.concurrency) || cfg.concurrency < 1 || cfg.concurrency > 64) {
    problems.push(`concurrency must be between 1 and 64, got ${cfg.concurrency}`);
  }
  if (!Number.isInteger(cfg.poll_interval) || cfg.poll_interval < 1) {
    problems.push(`poll_interval must be at least 1 second, got ${cfg.poll_interval}`);
  }

  const features = {};
  if (!isPlainObject(cfg.features)) {
    problems.push('features must be a mapping of feature name to definition');
  } else {
    for (const [name, raw] of Object.entries(cfg.features)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
        problems.push(`features.${name}: invalid feature name`);
        continue;
      }
      const feature = normalizeFeature(name, raw, problems);
      if (feature) features[name] = feature;
    }
  }
  cfg.features = features;

  // The token may be inline, in a file, or in the environment. A file is
  // preferred so it never appears in the process list or in `docker inspect`.
  if (!cfg.token && cfg.token_file) {
    try {
      cfg.token = fs.readFileSync(cfg.token_file, 'utf8').trim();
    } catch (e) {
      problems.push(`cannot read token_file ${cfg.token_file}: ${e.message}`);
    }
  }
  if (!cfg.token) problems.push('no worker token: set token, token_file, or CONDUCTOR_WORKER_TOKEN');

  cfg.workspace_root = path.resolve(cfg.workspace_root || path.join(os.tmpdir(), 'conductor-work'));
  cfg.cache_root = path.resolve(cfg.cache_root || path.join(os.tmpdir(), 'conductor-cache'));
  cfg.conductor_url = String(cfg.conductor_url).replace(/\/+$/, '');

  if (problems.length > 0) {
    throw new Error(`invalid worker configuration:\n  - ${problems.join('\n  - ')}`);
  }

  return cfg;
}

export function featureNames(cfg) {
  return Object.keys(cfg.features).sort();
}
