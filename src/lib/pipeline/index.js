// src/lib/pipeline/index.js - pipeline compilation
//
// compilePipeline turns the text of a .conductor.yml into the concrete job
// graph the scheduler stores. Every failure mode raises PipelineError with
// the full list of problems, so a bad pipeline is reported once rather than
// one mistake per push.

import { parsePipeline } from './parse.js';
import { expandPipeline } from './expand.js';
import { topologicalOrder, depths, CycleError } from './dag.js';
import { PipelineError } from './schema.js';

export { parsePipeline } from './parse.js';
export { expandPipeline, interpolate } from './expand.js';
export { topologicalOrder, depths, transitiveDependents, runnable, CycleError } from './dag.js';
export { PipelineError } from './schema.js';
export { SUPPORTED_VERSION } from './parse.js';

export function compilePipeline(text, options = {}) {
  const pipeline = parsePipeline(text, options);
  const jobs = expandPipeline(pipeline, options);

  try {
    topologicalOrder(jobs);
  } catch (e) {
    if (e instanceof CycleError) {
      throw new PipelineError([{ path: 'jobs', message: e.message }], pipeline.source);
    }
    throw e;
  }

  const depth = depths(jobs);
  for (const job of jobs) job.depth = depth.get(job.name);

  return { version: pipeline.version, source: pipeline.source, jobs };
}
