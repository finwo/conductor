// src/lib/pipeline/only.js - restricting jobs to particular refs
//
// A job carrying an `only` rule runs when the ref that triggered the run
// matches one of its patterns, and is left out of the run entirely when it
// does not. Left out rather than recorded as skipped, because the
// scheduler treats a skipped job as a reason to fail the run: that is the
// right reading when a dependency collapsed, and the wrong one for a
// publish step that was never meant to run on this branch.
//
// Anything depending on an excluded job is excluded with it. The
// alternative, quietly dropping the dependency, would let a job run
// without something it declared it needed, which is a worse surprise than
// the job not running.

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

export function jobRunsOnRef(job, ref) {
  if (!job.only) return true;

  // A run with no ref at all, which a manual or api trigger may produce,
  // cannot match a ref pattern. Restricted jobs stay out rather than
  // being handed a ref they were never written for.
  if (typeof ref !== 'string' || ref === '') return false;

  return job.only.refs.some((pattern) => refMatches(pattern, ref));
}

// The jobs that belong in a run for this ref, in their original order.
export function selectForRef(jobs, ref) {
  const excluded = new Set(jobs.filter((job) => !jobRunsOnRef(job, ref)).map((job) => job.name));
  if (excluded.size === 0) return jobs;

  for (const name of transitiveDependents(jobs, [...excluded])) excluded.add(name);

  return jobs.filter((job) => !excluded.has(job.name));
}
