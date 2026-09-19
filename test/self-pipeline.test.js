// test/self-pipeline.test.js - the pipeline this project runs on itself
//
// .conductor.yml is not covered by examples.test.js, and it is the one
// pipeline whose breakage stops the project from building at all. It also
// encodes decisions that are easy to undo by accident: which jobs may run
// on any worker, and which need a docker socket.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compilePipeline } from '../src/lib/pipeline/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function selfPipeline(arches = ['x86_64'], ref = 'refs/heads/main') {
  const text = await fs.readFile(path.join(ROOT, '.conductor.yml'), 'utf8');
  return compilePipeline(text, { source: '.conductor.yml', arches, ref });
}

test('the pipeline this project runs on itself compiles', async () => {
  const { jobs } = await selfPipeline();
  assert.ok(jobs.length > 0, '.conductor.yml produced no jobs');
});

test('its jobs declare the features they actually need', async () => {
  const { jobs } = await selfPipeline();
  const byName = new Map(jobs.map((job) => [job.name, job]));

  for (const name of ['style', 'test', 'integration', 'images', 'smoke', 'publish']) {
    assert.ok(byName.has(name), `expected a ${name} job`);
  }

  // The fast job has to actually skip the container-backed tests, or it
  // fails on any worker without a docker socket.
  assert.equal(byName.get('test').env.CONDUCTOR_TEST_NO_DOCKER, '1');

  // Anything starting containers has to say so, otherwise it gets handed
  // to a worker that cannot run it.
  for (const name of ['integration', 'images', 'smoke', 'publish']) {
    assert.ok(
      byName.get(name).requires.includes('docker'),
      `${name} starts containers and must require the docker feature`,
    );
  }

  // Conversely, the jobs meant to run anywhere must not demand features.
  for (const name of ['style', 'test']) {
    assert.deepEqual(byName.get(name).requires, [], `${name} should run on any worker`);
  }
});

test('publishing is restricted to main and release tags', async () => {
  // The cost of getting this wrong is a branch build overwriting :latest
  // on Docker Hub, which is not something a test should leave to trust.
  const onMain = await selfPipeline();
  assert.ok(onMain.jobs.some((j) => j.name === 'publish'));

  for (const ref of ['refs/heads/feature', 'refs/heads/main-2', 'refs/pull/7/head', '']) {
    const { jobs } = compilePipeline(
      await fs.readFile(path.join(ROOT, '.conductor.yml'), 'utf8'),
      { source: '.conductor.yml', arches: ['x86_64'], ref },
    );
    assert.ok(
      !jobs.some((j) => j.name === 'publish'),
      `publish must not run for ${JSON.stringify(ref)}`,
    );
    // The rest of the pipeline still has to run on a branch.
    assert.ok(jobs.some((j) => j.name === 'test'), `test should still run for ${JSON.stringify(ref)}`);
  }

  for (const ref of ['refs/heads/main', 'refs/tags/v1.2.0']) {
    const { jobs } = compilePipeline(
      await fs.readFile(path.join(ROOT, '.conductor.yml'), 'utf8'),
      { source: '.conductor.yml', arches: ['x86_64'], ref },
    );
    assert.ok(jobs.some((j) => j.name === 'publish'), `publish should run for ${ref}`);
  }
});
