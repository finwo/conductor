// src/lib/pipeline/dag.js - dependency graph checks and traversal
//
// The prototype stored a single integer level per task and treated the lowest
// queued level as the next runnable task. That serialized every run and, on
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

// Returns the tasks in an order where every dependency precedes its
// dependents. Throws CycleError naming the cycle when none exists.
export function topologicalOrder(tasks) {
  const byName = new Map(tasks.map((j) => [j.name, j]));
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

// Depth of each task, where a task with no dependencies is 0. Used only for
// display; scheduling reads the edges, never the depth.
export function depths(tasks) {
  const byName = new Map(tasks.map((j) => [j.name, j]));
  const out = new Map();
  for (const task of topologicalOrder(tasks)) {
    const deps = task.needs.filter((d) => byName.has(d));
    out.set(task.name, deps.length === 0 ? 0 : Math.max(...deps.map((d) => out.get(d))) + 1);
  }
  return out;
}

// Every task reachable by following dependents from the given names. This is
// what a failure must skip: direct dependents alone leave transitive ones
// runnable against a dependency that never produced anything.
export function transitiveDependents(tasks, startNames) {
  const dependents = new Map(tasks.map((j) => [j.name, []]));
  for (const task of tasks) {
    for (const dep of task.needs) {
      if (dependents.has(dep)) dependents.get(dep).push(task.name);
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

// Tasks whose dependencies have all reached a satisfying state. Passed the
// current state of every task by name.
export function runnable(tasks, stateByName, { satisfied = ['success'] } = {}) {
  return tasks.filter((task) => {
    if (stateByName.get(task.name) !== 'queued') return false;
    return task.needs.every((dep) => satisfied.includes(stateByName.get(dep)));
  });
}
