// src/lib/pipeline/only.js - restricting tasks to particular refs
//
// A task carrying an `only` rule runs when the ref that triggered the run
// matches one of its patterns, and is left out of the run entirely when it
// does not. Left out rather than recorded as skipped, because the
// scheduler treats a skipped task as a reason to fail the run: that is the
// right reading when a dependency collapsed, and the wrong one for a
// publish step that was never meant to run on this branch.
//
// Anything that needs an excluded task is excluded with it. The
// alternative, quietly dropping the dependency, would let a task run
// without something it declared it needed, which is a worse surprise than
// the task not running.
//
// An `after` edge is the other way round. It asks for ordering, not for
// output, and a task that was never going to run has nothing to order
// against, so the edge is dropped and the dependent stays in the run.

import { transitiveDependents } from './dag.js';

// Glob matching over a whole ref. Only * is special, standing for any run
// of characters including none; everything else is literal. Deliberately
// not a regular expression, since these come out of a repository and are
// read by people who are not thinking about regular expression syntax.
export function refMatches(pattern, ref) {
  if (typeof pattern !== 'string' || typeof ref !== 'string') return false;
  if (!pattern.includes('*')) return pattern === ref;

  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(ref);
}

export function taskRunsOnRef(task, ref) {
  if (!task.only) return true;

  // A run with no ref at all, which a manual or api trigger may produce,
  // cannot match a ref pattern. Restricted tasks stay out rather than
  // being handed a ref they were never written for.
  if (typeof ref !== 'string' || ref === '') return false;

  return task.only.refs.some((pattern) => refMatches(pattern, ref));
}

// The tasks that belong in a run for this ref, in their original order.
export function selectForRef(tasks, ref) {
  const excluded = new Set(tasks.filter((task) => !taskRunsOnRef(task, ref)).map((task) => task.name));
  if (excluded.size === 0) return tasks;

  for (const name of transitiveDependents(tasks, [...excluded])) excluded.add(name);

  // Surviving after edges pointing into the excluded set are pruned rather
  // than left dangling, since everything downstream resolves them by name.
  return tasks
    .filter((task) => !excluded.has(task.name))
    .map((task) => (task.after?.some((name) => excluded.has(name))
      ? { ...task, after: task.after.filter((name) => !excluded.has(name)) }
      : task));
}
