// src/lib/pipeline/expand.js - matrix and architecture expansion
//
// Turns each task template into one concrete task per combination of its
// dimensions, then resolves needs and after between the concrete tasks.
//
// Dimension matching is the part worth understanding. When a task declares
// needs on a template that shares a dimension with it, the dependency is
// matched on that dimension rather than fanned out across all of it. So an
// aarch64 package task needs the aarch64 build, not every build. Dimensions
// the dependency has but the dependent does not are fanned out, which is
// what you want when a single publish task waits for every architecture.
// Write `{ task: name, match: all }` to opt out.

import { Problems, MATRIX_KEY_PATTERN } from './schema.js';

// Matches ${{ arch }} and ${{ matrix.pkg }}, tolerating inner whitespace.
const INTERPOLATION = /\$\{\{\s*([^}]*?)\s*\}\}/g;

// tasks.name is 191 characters in the mysql schema.
export const MAX_TASK_NAME = 191;

export function interpolate(problems, path, text, context) {
  if (typeof text !== 'string') return text;

  return text.replace(INTERPOLATION, (whole, expr) => {
    if (expr === 'arch') {
      if (context.arch === null) {
        problems.add(path, 'refers to ${{ arch }} but the task declares no arch');
        return whole;
      }
      return context.arch;
    }

    const matrixMatch = /^matrix\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expr);
    if (matrixMatch) {
      const key = matrixMatch[1];
      if (!Object.hasOwn(context.matrix, key)) {
        const known = Object.keys(context.matrix);
        problems.add(
          path,
          `refers to \${{ matrix.${key} }} which the task does not define` +
          (known.length > 0 ? `; available: ${known.join(', ')}` : '')
        );
        return whole;
      }
      return context.matrix[key];
    }

    problems.add(path, `unknown expression \${{ ${expr} }}; expected arch or matrix.<name>`);
    return whole;
  });
}

function cartesian(dimensions) {
  let rows = [{}];
  for (const [key, values] of dimensions) {
    const next = [];
    for (const row of rows) {
      for (const value of values) next.push({ ...row, [key]: value });
    }
    rows = next;
  }
  return rows;
}

// build:arch=x86_64,pkg=musl
function instanceName(baseName, dims) {
  const entries = Object.entries(dims);
  if (entries.length === 0) return baseName;
  return `${baseName}:${entries.map(([k, v]) => `${k}=${v}`).join(',')}`;
}

function dimensionsOf(task) {
  const dims = [];
  if (task.arch.length > 0) dims.push(['arch', task.arch]);
  for (const [key, values] of Object.entries(task.matrix)) dims.push([key, values]);
  return dims;
}

export function expandPipeline(pipeline, options = {}) {
  const problems = new Problems();
  const defaultTimeout = options.defaultTimeout ?? 3600;
  const defaultAttempts = options.defaultAttempts ?? 1;

  // Pass one: build every concrete task.
  const byBase = new Map();
  const instances = [];

  for (const [baseName, task] of Object.entries(pipeline.tasks)) {
    const dims = dimensionsOf(task);
    const combos = cartesian(dims);
    const made = [];

    for (const combo of combos) {
      const arch = combo.arch ?? null;
      const matrix = { ...combo };
      delete matrix.arch;

      const name = instanceName(baseName, combo);
      const path = `tasks.${baseName}`;
      if (name.length > MAX_TASK_NAME) {
        problems.add(path, `expands to a task name longer than ${MAX_TASK_NAME} characters: ${name}`);
        continue;
      }

      const context = { arch, matrix };
      const env = {};
      for (const [key, value] of Object.entries(task.env)) {
        env[key] = interpolate(problems, `${path}.env.${key}`, value, context);
      }
      // Dimension values are exposed to the script, so a matrix task rarely
      // needs interpolation at all.
      if (arch !== null) env.ARCH = arch;
      for (const [key, value] of Object.entries(matrix)) {
        if (MATRIX_KEY_PATTERN.test(key)) env[`MATRIX_${key.toUpperCase()}`] = value;
      }

      made.push({
        name,
        baseName,
        arch,
        matrix,
        dims: combo,
        image: interpolate(problems, `${path}.image`, task.image, context),
        script: task.script.map((line, i) => interpolate(problems, `${path}.script[${i}]`, line, context)),
        requires: task.requires.map((r, i) => interpolate(problems, `${path}.requires[${i}]`, r, context)),
        services: task.services.map((service, i) => ({
          image: interpolate(problems, `${path}.services[${i}].image`, service.image, context),
          alias: service.alias,
          env: Object.fromEntries(Object.entries(service.env).map(([k, v]) => [
            k, interpolate(problems, `${path}.services[${i}].env.${k}`, v, context),
          ])),
          entrypoint: service.entrypoint,
          command: service.command,
        })),
        env,
        artifacts: task.artifacts
          ? {
            ...task.artifacts,
            paths: task.artifacts.paths.map((p, i) => interpolate(problems, `${path}.artifacts.paths[${i}]`, p, context)),
          }
          : null,
        allow_failure: task.allow_failure,
        timeout: task.timeout ?? defaultTimeout,
        max_attempts: task.max_attempts ?? defaultAttempts,
        // Every instance of a matrix task inherits the ref rule, so a
        // restricted task stays restricted across all of its expansions.
        only: task.only ?? null,
        needs: [],
        after: [],
      });
    }

    byBase.set(baseName, { task, dimensionNames: dims.map(([k]) => k), instances: made });
    instances.push(...made);
  }

  const byName = new Map(instances.map((i) => [i.name, i]));

  // Pass two: resolve dependencies now that every concrete task exists.
  for (const [baseName, entry] of byBase) {
    for (const instance of entry.instances) {
      instance.needs = resolveDeps(problems, { byBase, byName, baseName, entry, instance, field: 'needs' });
      instance.after = resolveDeps(problems, { byBase, byName, baseName, entry, instance, field: 'after' });

      // Naming the same dependency both ways is held to the stricter
      // reading, since needs already implies after.
      const needs = new Set(instance.needs);
      instance.after = instance.after.filter((name) => !needs.has(name));
    }
  }

  problems.throwIfAny(pipeline.source);
  return instances;
}

// One task's declared dependencies, turned into concrete task names. `needs`
// and `after` resolve identically: dimension matching is about which
// instance is meant, not about what waiting on it implies.
function resolveDeps(problems, { byBase, byName, baseName, entry, instance, field }) {
  const resolved = new Set();
  const path = `tasks.${baseName}.${field}`;

  for (const need of entry.task[field]) {
    // An exact concrete task name wins, which is the escape hatch for
    // depending on one specific combination.
    if (byName.has(need.task)) {
      if (need.task === instance.name) {
        problems.add(path, `task ${JSON.stringify(baseName)} cannot depend on itself`);
      } else {
        resolved.add(need.task);
      }
      continue;
    }

    const target = byBase.get(need.task);
    if (!target) {
      const known = [...byBase.keys()].filter((n) => n !== baseName);
      problems.add(
        path,
        `refers to unknown task ${JSON.stringify(need.task)}` +
        (known.length > 0 ? `; defined tasks are ${known.join(', ')}` : '')
      );
      continue;
    }
    if (need.task === baseName) {
      problems.add(path, `task ${JSON.stringify(baseName)} cannot depend on itself`);
      continue;
    }

    let candidates = target.instances;
    if (need.match === 'shared') {
      const shared = target.dimensionNames.filter((d) => Object.hasOwn(instance.dims, d));
      if (shared.length > 0) {
        candidates = candidates.filter((c) => shared.every((d) => c.dims[d] === instance.dims[d]));
        if (candidates.length === 0) {
          problems.add(
            path,
            `no instance of ${JSON.stringify(need.task)} matches ${instance.name} on ` +
            `${shared.join(', ')}; add the missing value, or use { task: ${need.task}, match: all }`
          );
          continue;
        }
      }
    }

    for (const candidate of candidates) resolved.add(candidate.name);
  }

  return [...resolved].sort();
}
