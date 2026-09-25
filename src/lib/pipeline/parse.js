// src/lib/pipeline/parse.js - reads and validates a .conductor.yml
//
// Produces a normalized document: every task has every field filled in from
// defaults, so later stages never have to ask whether something was set.
// Nothing here expands matrices or resolves dependencies; see expand.js.

import YAML from 'yaml';
import {
  PipelineError,
  Problems,
  isPlainObject,
  checkUnknown,
  asString,
  asName,
  asBoolean,
  asInteger,
  asStringList,
  asEnvMap,
  asDuration,
  typeName,
  MATRIX_KEY_PATTERN,
  NAME_PATTERN,
} from './schema.js';

const TOP_KEYS = ['version', 'visibility', 'workdir', 'defaults', 'tasks'];

// A repository decides whether its own build results are readable without
// signing in. Unset means the project's setting stands.
export const VISIBILITIES = ['public', 'private'];

// Where the tree is put inside a task container, and the directory every
// script starts in. Unset means the project's setting stands, and failing
// that the server default.
export const DEFAULT_WORKDIR = '/work';

// An absolute path of ordinary directory names. The tree is delivered by
// unpacking an archive at the container's root, so the path is built from
// the archive's own entries: anything that could climb out of it, or that
// is not a plain name, is refused rather than sanitised.
export function parseWorkdir(problems, path, raw) {
  const value = asString(problems, path, raw);
  if (typeof value !== 'string') return null;

  if (!value.startsWith('/')) {
    problems.add(path, `must be an absolute path, got ${JSON.stringify(value)}`);
    return null;
  }

  const segments = value.split('/').filter(Boolean);
  if (segments.length === 0) {
    problems.add(path, 'must name a directory, not the container root');
    return null;
  }

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      problems.add(path, `must not contain ${JSON.stringify(segment)}`);
      return null;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
      problems.add(path, `${JSON.stringify(segment)} is not a usable directory name`);
      return null;
    }
  }

  return `/${segments.join('/')}`;
}

const JOB_KEYS = [
  'image', 'script', 'needs', 'after', 'arch', 'matrix', 'requires', 'services',
  'env', 'artifacts', 'allow_failure', 'timeout', 'max_attempts',
  'only',
];

// Fields a task may inherit from defaults.
const DEFAULT_KEYS = [
  'image', 'arch', 'requires', 'env', 'services',
  'allow_failure', 'timeout', 'max_attempts',
];

const ONLY_KEYS = ['refs'];
const ARTIFACT_KEYS = ['paths', 'expire', 'when'];
const ARTIFACT_WHEN = ['on_success', 'on_failure', 'always'];

const SERVICE_KEYS = ['image', 'alias', 'env', 'entrypoint', 'command'];

export const SUPPORTED_VERSION = 1;

export function parsePipeline(text, options = {}) {
  const source = options.source || '.conductor.yml';
  const problems = new Problems();

  let doc;
  try {
    doc = YAML.parse(text, { prettyErrors: true });
  } catch (e) {
    throw new PipelineError([{ path: '', message: `not valid YAML: ${e.message}` }], source);
  }

  if (doc === null || doc === undefined) {
    throw new PipelineError([{ path: '', message: 'file is empty' }], source);
  }
  if (!isPlainObject(doc)) {
    throw new PipelineError([{ path: '', message: `expected a mapping at the top level, got ${typeName(doc)}` }], source);
  }

  // The key was called jobs before a job became the thing that contains
  // these. Named outright rather than left to checkUnknown, whose nearest
  // match would be a guess at a word that used to be correct.
  if (doc.jobs !== undefined && doc.tasks === undefined) {
    throw new PipelineError(
      [{ path: 'jobs', message: 'was renamed to tasks; a job is now the pipeline run that these tasks belong to' }],
      source
    );
  }

  checkUnknown(problems, '', doc, TOP_KEYS);

  if (doc.version === undefined) {
    problems.add('version', `is required; this conductor understands version ${SUPPORTED_VERSION}`);
  } else if (doc.version !== SUPPORTED_VERSION) {
    problems.add('version', `unsupported version ${JSON.stringify(doc.version)}, expected ${SUPPORTED_VERSION}`);
  }

  let visibility = null;
  if (doc.visibility !== undefined) {
    const value = asString(problems, 'visibility', doc.visibility);
    if (value !== undefined && !VISIBILITIES.includes(value)) {
      problems.add('visibility', `expected one of ${VISIBILITIES.join(', ')}, got ${JSON.stringify(value)}`);
    } else if (value !== undefined) {
      visibility = value;
    }
  }

  const defaults = parseDefaults(problems, doc.defaults);

  if (doc.tasks === undefined) {
    problems.add('tasks', 'is required');
  } else if (!isPlainObject(doc.tasks)) {
    problems.add('tasks', `expected a mapping of task names, got ${typeName(doc.tasks)}`);
  } else if (Object.keys(doc.tasks).length === 0) {
    problems.add('tasks', 'must define at least one task');
  }

  const tasks = {};
  if (isPlainObject(doc.tasks)) {
    for (const [name, raw] of Object.entries(doc.tasks)) {
      const path = `tasks.${name}`;
      if (!NAME_PATTERN.test(name) || name.length > 100) {
        problems.add(path, 'task name must start with a letter or digit and contain only letters, digits, underscore, dot and hyphen');
        continue;
      }
      if (!isPlainObject(raw)) {
        problems.add(path, `expected a mapping, got ${typeName(raw)}`);
        continue;
      }
      tasks[name] = parseTask(problems, path, raw, defaults);
    }
  }

  const workdir = doc.workdir === undefined ? null : parseWorkdir(problems, 'workdir', doc.workdir);

  problems.throwIfAny(source);
  return { version: SUPPORTED_VERSION, visibility, workdir, defaults, tasks, source };
}

function parseDefaults(problems, raw) {
  const empty = {
    image: undefined,
    arch: undefined,
    requires: [],
    env: {},
    services: [],
    allow_failure: false,
    timeout: undefined,
    max_attempts: undefined,
  };
  if (raw === undefined) return empty;
  if (!isPlainObject(raw)) {
    problems.add('defaults', `expected a mapping, got ${typeName(raw)}`);
    return empty;
  }

  checkUnknown(problems, 'defaults', raw, DEFAULT_KEYS);

  return {
    image: raw.image === undefined ? undefined : asString(problems, 'defaults.image', raw.image),
    arch: raw.arch === undefined ? undefined : parseArch(problems, 'defaults.arch', raw.arch),
    requires: asStringList(problems, 'defaults.requires', raw.requires),
    env: asEnvMap(problems, 'defaults.env', raw.env),
    services: parseServices(problems, 'defaults.services', raw.services),
    allow_failure: raw.allow_failure === undefined ? false : asBoolean(problems, 'defaults.allow_failure', raw.allow_failure) ?? false,
    timeout: raw.timeout === undefined ? undefined : asDuration(problems, 'defaults.timeout', raw.timeout),
    max_attempts: raw.max_attempts === undefined ? undefined : asInteger(problems, 'defaults.max_attempts', raw.max_attempts, { min: 1, max: 10 }),
  };
}

function parseArch(problems, path, raw) {
  const list = asStringList(problems, path, raw, { max: 32 });
  const out = [];
  list.forEach((value, i) => {
    if (!NAME_PATTERN.test(value)) {
      problems.add(`${path}[${i}]`, `${JSON.stringify(value)} is not a valid architecture name`);
      return;
    }
    if (out.includes(value)) {
      problems.add(`${path}[${i}]`, `duplicate architecture ${JSON.stringify(value)}`);
      return;
    }
    out.push(value);
  });
  return out;
}

function parseTask(problems, path, raw, defaults) {
  checkUnknown(problems, path, raw, JOB_KEYS);

  const image = raw.image === undefined ? defaults.image : asString(problems, `${path}.image`, raw.image);
  if (image === undefined) {
    problems.add(`${path}.image`, 'is required; set it on the task or under defaults');
  }

  if (raw.script === undefined) {
    problems.add(`${path}.script`, 'is required');
  }
  const script = asStringList(problems, `${path}.script`, raw.script, { max: 65536 });
  if (raw.script !== undefined && script.length === 0) {
    problems.add(`${path}.script`, 'must contain at least one command');
  }

  const arch = raw.arch === undefined ? (defaults.arch ?? []) : parseArch(problems, `${path}.arch`, raw.arch);
  const matrix = parseMatrix(problems, `${path}.matrix`, raw.matrix);

  if (matrix.arch !== undefined) {
    problems.add(`${path}.matrix.arch`, 'use the arch key instead of a matrix dimension named arch');
  }

  return {
    image,
    script,
    needs: parseDeps(problems, `${path}.needs`, raw.needs),
    after: parseDeps(problems, `${path}.after`, raw.after),
    arch,
    matrix,
    requires: raw.requires === undefined ? defaults.requires : asStringList(problems, `${path}.requires`, raw.requires, { max: 64 }),
    services: raw.services === undefined ? defaults.services : parseServices(problems, `${path}.services`, raw.services),
    env: { ...defaults.env, ...asEnvMap(problems, `${path}.env`, raw.env) },
    artifacts: parseArtifacts(problems, `${path}.artifacts`, raw.artifacts),
    allow_failure: raw.allow_failure === undefined
      ? defaults.allow_failure
      : asBoolean(problems, `${path}.allow_failure`, raw.allow_failure) ?? false,
    timeout: raw.timeout === undefined ? defaults.timeout : asDuration(problems, `${path}.timeout`, raw.timeout),
    max_attempts: raw.max_attempts === undefined
      ? defaults.max_attempts
      : asInteger(problems, `${path}.max_attempts`, raw.max_attempts, { min: 1, max: 10 }),
    only: parseOnly(problems, `${path}.only`, raw.only),
  };
}

// Restricts a task to certain refs. Deliberately not inheritable from
// defaults: a rule that silently applied to every task is the kind of thing
// that stops a pipeline running at all and takes an afternoon to find.
//
//   only:
//     refs: [refs/heads/main, 'refs/tags/v*']
//
// Patterns match the whole ref, so refs/heads/main rather than main, with
// * standing for any run of characters. Absent means the task always runs.
function parseOnly(problems, path, raw) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    problems.add(path, 'must be a mapping, for example: only: { refs: [refs/heads/main] }');
    return null;
  }

  for (const key of Object.keys(raw)) {
    if (!ONLY_KEYS.includes(key)) {
      problems.add(`${path}.${key}`, `unknown key, expected one of: ${ONLY_KEYS.join(', ')}`);
    }
  }

  if (raw.refs === undefined) {
    problems.add(path, 'needs a refs list, otherwise it restricts nothing');
    return null;
  }

  const refs = asStringList(problems, `${path}.refs`, raw.refs, { max: 64 });
  if (refs.length === 0) {
    problems.add(`${path}.refs`, 'must list at least one ref pattern');
    return null;
  }

  return { refs };
}

// A dependency is either a task name, or a mapping for the cases where the
// default dimension matching is not what is wanted. `needs` and `after` take
// the same forms and differ only in what the scheduler makes of the edge.
function parseDeps(problems, path, raw) {
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];

  list.forEach((item, i) => {
    const itemPath = `${path}[${i}]`;
    if (typeof item === 'string') {
      out.push({ task: item, match: 'shared' });
      return;
    }
    if (!isPlainObject(item)) {
      problems.add(itemPath, `expected a task name or a mapping, got ${typeName(item)}`);
      return;
    }
    checkUnknown(problems, itemPath, item, ['task', 'match']);
    const task = asString(problems, `${itemPath}.task`, item.task);
    const match = item.match === undefined ? 'shared' : asString(problems, `${itemPath}.match`, item.match);
    if (match !== undefined && !['shared', 'all'].includes(match)) {
      problems.add(`${itemPath}.match`, `expected shared or all, got ${JSON.stringify(match)}`);
      return;
    }
    if (task !== undefined) out.push({ task, match: match ?? 'shared' });
  });

  return out;
}

function parseMatrix(problems, path, raw) {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    problems.add(path, `expected a mapping of dimension names to value lists, got ${typeName(raw)}`);
    return {};
  }

  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const keyPath = `${path}.${key}`;
    if (!MATRIX_KEY_PATTERN.test(key)) {
      problems.add(keyPath, 'dimension name must be a valid environment variable name');
      continue;
    }
    if (!Array.isArray(value)) {
      problems.add(keyPath, `expected a list of values, got ${typeName(value)}`);
      continue;
    }
    if (value.length === 0) {
      problems.add(keyPath, 'must contain at least one value');
      continue;
    }

    const values = [];
    value.forEach((item, i) => {
      if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
        problems.add(`${keyPath}[${i}]`, `expected a scalar value, got ${typeName(item)}`);
        return;
      }
      const s = String(item);
      if (!NAME_PATTERN.test(s)) {
        problems.add(
          `${keyPath}[${i}]`,
          `${JSON.stringify(s)} may only contain letters, digits, underscore, dot and hyphen, ` +
          'because it becomes part of the task name'
        );
        return;
      }
      if (values.includes(s)) {
        problems.add(`${keyPath}[${i}]`, `duplicate value ${JSON.stringify(s)}`);
        return;
      }
      values.push(s);
    });
    out[key] = values;
  }
  return out;
}

function parseServices(problems, path, raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.add(path, `expected a list of services, got ${typeName(raw)}`);
    return [];
  }

  const out = [];
  const aliases = new Set();
  raw.forEach((item, i) => {
    const itemPath = `${path}[${i}]`;
    const service = typeof item === 'string' ? { image: item } : item;
    if (!isPlainObject(service)) {
      problems.add(itemPath, `expected an image name or a mapping, got ${typeName(item)}`);
      return;
    }
    checkUnknown(problems, itemPath, service, SERVICE_KEYS);

    const image = asString(problems, `${itemPath}.image`, service.image);
    if (image === undefined) return;

    // Default alias is the image name without registry, path or tag, which
    // is what a task would naturally use as a hostname.
    const derived = image.split('/').pop().split(':')[0];
    const alias = service.alias === undefined
      ? derived
      : asName(problems, `${itemPath}.alias`, service.alias, { max: 63 });
    if (alias === undefined) return;
    if (aliases.has(alias)) {
      problems.add(`${itemPath}.alias`, `duplicate service alias ${JSON.stringify(alias)}`);
      return;
    }
    aliases.add(alias);

    out.push({
      image,
      alias,
      env: asEnvMap(problems, `${itemPath}.env`, service.env),
      entrypoint: asStringList(problems, `${itemPath}.entrypoint`, service.entrypoint),
      command: asStringList(problems, `${itemPath}.command`, service.command),
    });
  });
  return out;
}

function parseArtifacts(problems, path, raw) {
  if (raw === undefined) return null;

  // The common case is a bare list of paths.
  const spec = Array.isArray(raw) ? { paths: raw } : raw;
  if (!isPlainObject(spec)) {
    problems.add(path, `expected a list of paths or a mapping, got ${typeName(raw)}`);
    return null;
  }
  checkUnknown(problems, path, spec, ARTIFACT_KEYS);

  const paths = asStringList(problems, `${path}.paths`, spec.paths, { max: 512 });
  if (paths.length === 0) {
    problems.add(`${path}.paths`, 'must list at least one path');
    return null;
  }
  paths.forEach((p, i) => {
    if (p.startsWith('/')) problems.add(`${path}.paths[${i}]`, 'must be relative to the workspace');
  });

  const when = spec.when === undefined ? 'on_success' : asString(problems, `${path}.when`, spec.when);
  if (when !== undefined && !ARTIFACT_WHEN.includes(when)) {
    problems.add(`${path}.when`, `expected one of ${ARTIFACT_WHEN.join(', ')}, got ${JSON.stringify(when)}`);
  }

  return {
    paths,
    when: ARTIFACT_WHEN.includes(when) ? when : 'on_success',
    expire: spec.expire === undefined ? null : asDuration(problems, `${path}.expire`, spec.expire, { max: 365 * 24 * 3600 }),
  };
}


