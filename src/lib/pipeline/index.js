// src/lib/pipeline/index.js - pipeline compilation
//
// compilePipeline turns the text of a .conductor.yml into the concrete task
// graph the scheduler stores. Every failure mode raises PipelineError with
// the full list of problems, so a bad pipeline is reported once rather than
// one mistake per push.

import { parsePipeline } from './parse.js';
import { expandPipeline } from './expand.js';
import { topologicalOrder, depths, CycleError } from './dag.js';
import { selectForRef } from './only.js';
import { PipelineError } from './schema.js';

export { parsePipeline } from './parse.js';
export { expandPipeline, interpolate, outputRefsIn, fillOutputs } from './expand.js';
export { topologicalOrder, depths, transitiveDependents, runnable, CycleError } from './dag.js';
export { refMatches, taskRunsOnRef, selectForRef } from './only.js';
export { PipelineError } from './schema.js';
export { SUPPORTED_VERSION, VISIBILITIES, DEFAULT_WORKDIR, parseWorkdir } from './parse.js';

export function compilePipeline(text, options = {}) {
  const pipeline = parsePipeline(text, options);
  const expanded = expandPipeline(pipeline, options);

  // Tasks restricted to other refs drop out before the graph is checked, so
  // ordering and depth describe the run that will actually happen. Without
  // a ref nothing is filtered, which keeps validation of a pipeline
  // separate from deciding what one push will run.
  const tasks = options.ref === undefined ? expanded : selectForRef(expanded, options.ref);

  try {
    topologicalOrder(tasks);
  } catch (e) {
    if (e instanceof CycleError) {
      throw new PipelineError([{ path: 'tasks', message: e.message }], pipeline.source);
    }
    throw e;
  }

  const depth = depths(tasks);
  for (const task of tasks) task.depth = depth.get(task.name);

  return {
    version: pipeline.version,
    source: pipeline.source,
    visibility: pipeline.visibility,
    workdir: pipeline.workdir,
    tasks,
  };
}
