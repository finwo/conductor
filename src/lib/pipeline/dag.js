// src/lib/pipeline/dag.js - dependency graph checks and traversal
//
// The prototype stored a single integer level per job and treated the lowest
// queued level as the next runnable job. That serialized every run and, on
// failure, only skipped direct dependents, so a transitive dependent could
// still be dispatched with its dependency missing. Both problems come from
// throwing the graph away, so the graph is kept here and used directly.

export class CycleError extends Error {
  constructor(cycle) {
    super(`pipeline contains a dependency cycle: ${cycle.join(' -> ')}`);
    this.name = 'CycleError';
    this.cycle = cycle;
  }
}

// Returns the jobs in an order where every dependency precedes its
// dependents. Throws CycleError naming the cycle when none exists.
export function topologicalOrder(jobs) {
  const byName = new Map(jobs.map((j) => [j.name, j]));
  const state = new Map();
  const order = [];
  const stack = [];

  function visit(name) {
    const current = state.get(name);
    if (current === 'done') return;
    if (current === 'active') {
      const from = stack.indexOf(name);
      throw new CycleError([...stack.slice(from), name]);
    }

    state.set(name, 'active');
    stack.push(name);
    for (const dep of byName.get(name).needs) {
      if (byName.has(dep)) visit(dep);
    }
    stack.pop();
    state.set(name, 'done');
    order.push(name);
  }

  // Sorted so that an unchanged pipeline always produces the same order.
  for (const name of [...byName.keys()].sort()) visit(name);
  return order.map((name) => byName.get(name));
}

// Depth of each job, where a job with no dependencies is 0. Used only for
// display; scheduling reads the edges, never the depth.
export function depths(jobs) {
  const byName = new Map(jobs.map((j) => [j.name, j]));
  const out = new Map();
  for (const job of topologicalOrder(jobs)) {
    const deps = job.needs.filter((d) => byName.has(d));
    out.set(job.name, deps.length === 0 ? 0 : Math.max(...deps.map((d) => out.get(d))) + 1);
  }
  return out;
}

// Every job reachable by following dependents from the given names. This is
// what a failure must skip: direct dependents alone leave transitive ones
// runnable against a dependency that never produced anything.
export function transitiveDependents(jobs, startNames) {
  const dependents = new Map(jobs.map((j) => [j.name, []]));
  for (const job of jobs) {
    for (const dep of job.needs) {
      if (dependents.has(dep)) dependents.get(dep).push(job.name);
    }
  }

  const seen = new Set();
  const queue = [...startNames];
  while (queue.length > 0) {
    const name = queue.shift();
    for (const child of dependents.get(name) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return seen;
}

// Jobs whose dependencies have all reached a satisfying state. Passed the
// current state of every job by name.
export function runnable(jobs, stateByName, { satisfied = ['success'] } = {}) {
  return jobs.filter((job) => {
    if (stateByName.get(job.name) !== 'queued') return false;
    return job.needs.every((dep) => satisfied.includes(stateByName.get(dep)));
  });
}
