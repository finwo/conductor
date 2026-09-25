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

// Both halves may contain dots, so the split is on the last `.outputs.`.
export const OUTPUT_REF = /^tasks\.(.+)\.outputs((?:\.[A-Za-z_][A-Za-z0-9_-]*)+)$/;

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

    // Left in place: the value only exists once the other task has run, so
    // this is resolved again when the task is dispatched.
    const outputMatch = OUTPUT_REF.exec(expr);
    if (outputMatch) {
      if (!context.outputs) {
        problems.add(
          path,
          `cannot read \${{ ${expr} }} here; a task output is not known until the ` +
          'task is dispatched, and this is needed before that'
        );
        return whole;
      }
      context.outputs.add(outputMatch[1]);
      return whole;
    }

    problems.add(
      path,
      `unknown expression \${{ ${expr} }}; expected arch, matrix.<name> or ` +
      'tasks.<task>.outputs.<name>'
    );
    return whole;
  });
}

// Every unresolved task-output reference in a string.
export function outputRefsIn(text) {
  const found = [];
  for (const [whole, expr] of String(text).matchAll(INTERPOLATION)) {
    const match = OUTPUT_REF.exec(expr.trim());
    if (match) found.push({ whole, ref: match[1], key: match[2].slice(1) });
  }
  return found;
}

// Replaces them once their values are known, keyed by the whole expression.
export function fillOutputs(value, values) {
  if (typeof value === 'string') {
    if (values.size === 0) return value;
    return value.replace(INTERPOLATION, (whole) => (values.has(whole) ? values.get(whole) : whole));
  }
  if (Array.isArray(value)) return value.map((v) => fillOutputs(v, values));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillOutputs(v, values)]));
  }
  return value;
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

      const outputs = new Set();
      const context = { arch, matrix, outputs };
      // requires picks the worker, which happens before any output exists.
      const early = { arch, matrix, outputs: null };
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
        requires: task.requires.map((r, i) => interpolate(problems, `${path}.requires[${i}]`, r, early)),
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
        outputRefs: outputs,
        output_refs: {},
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

      // Reading a task's output is a reason to wait for it.
      instance.output_refs = resolveOutputRefs(problems, { byBase, byName, baseName, instance });
      delete instance.outputRefs;
      const needs = new Set([...instance.needs, ...Object.values(instance.output_refs).flat()]);
      instance.needs = [...needs].sort();

      // Naming the same dependency both ways is held to the stricter
      // reading, since needs already implies after.
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
    const names = matchTask(problems, path, need.task, need.match, { byBase, byName, baseName, instance });
    for (const name of names ?? []) resolved.add(name);
  }

  return [...resolved].sort();
}

// The concrete instances one written reference means, or null when it could
// not be resolved and the reason has been recorded.
function matchTask(problems, path, ref, match, { byBase, byName, baseName, instance }) {
  // An exact concrete task name wins, which is the escape hatch for
  // depending on one specific combination.
  if (byName.has(ref)) {
    if (ref === instance.name) {
      problems.add(path, `task ${JSON.stringify(baseName)} cannot depend on itself`);
      return null;
    }
    return [ref];
  }

  const target = byBase.get(ref);
  if (!target) {
    const known = [...byBase.keys()].filter((n) => n !== baseName);
    problems.add(
      path,
      `refers to unknown task ${JSON.stringify(ref)}` +
      (known.length > 0 ? `; defined tasks are ${known.join(', ')}` : '')
    );
    return null;
  }
  if (ref === baseName) {
    problems.add(path, `task ${JSON.stringify(baseName)} cannot depend on itself`);
    return null;
  }

  let candidates = target.instances;
  if (match === 'shared') {
    const shared = target.dimensionNames.filter((d) => Object.hasOwn(instance.dims, d));
    if (shared.length > 0) {
      candidates = candidates.filter((c) => shared.every((d) => c.dims[d] === instance.dims[d]));
      if (candidates.length === 0) {
        problems.add(
          path,
          `no instance of ${JSON.stringify(ref)} matches ${instance.name} on ` +
          `${shared.join(', ')}; add the missing value, or use { task: ${ref}, match: all }`
        );
        return null;
      }
    }
  }

  return candidates.map((c) => c.name);
}

// A reference may name a matrix task, in which case every instance of it is
// waited for and searched: each one names its outputs differently, so the
// name picks the instance out at dispatch.
function resolveOutputRefs(problems, { byBase, byName, baseName, instance }) {
  const path = `tasks.${baseName}`;
  const out = {};

  for (const ref of instance.outputRefs) {
    const names = matchTask(problems, path, ref, 'shared', { byBase, byName, baseName, instance });
    if (names !== null) out[ref] = [...names].sort();
  }

  return out;
}
