// test/examples.test.js - the shipped examples must stay valid
//
// Documentation that no longer parses is worse than no documentation, so
// every example is compiled as part of the suite.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePipeline } from '../src/lib/pipeline/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = path.join(ROOT, 'examples');

test('every example pipeline compiles', async () => {
  const files = (await fs.readdir(EXAMPLES)).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  assert.ok(files.length > 0, 'expected at least one example');

  for (const file of files) {
    const text = await fs.readFile(path.join(EXAMPLES, file), 'utf8');
    const pipeline = compilePipeline(text, { source: file });
    assert.ok(pipeline.jobs.length > 0, `${file} produced no jobs`);
  }
});

test('the distribution example fans in per architecture', async () => {
  const text = await fs.readFile(path.join(EXAMPLES, 'distro.conductor.yml'), 'utf8');
  const pipeline = compilePipeline(text, { source: 'distro.conductor.yml' });
  const jobs = Object.fromEntries(pipeline.jobs.map((j) => [j.name, j]));

  // check, two toolchains, twelve packages, two images, one publish.
  assert.equal(pipeline.jobs.length, 18);

  // A package waits only on its own architecture's toolchain.
  assert.deepEqual(jobs['package:arch=aarch64,pkg=musl'].needs, ['toolchain:arch=aarch64']);
  assert.deepEqual(jobs['package:arch=x86_64,pkg=grub'].needs, ['toolchain:arch=x86_64']);

  // An image waits on every package for its architecture, and no others.
  const imageNeeds = jobs['image:arch=x86_64'].needs;
  assert.equal(imageNeeds.length, 6);
  assert.ok(imageNeeds.every((n) => n.includes('arch=x86_64')));

  // publish has no architecture, so it waits for both, plus check.
  assert.equal(jobs.publish.needs.length, 3);
  assert.equal(jobs.publish.depth, 3);
});

test('the node example wires services and features', async () => {
  const text = await fs.readFile(path.join(EXAMPLES, 'node-app.conductor.yml'), 'utf8');
  const pipeline = compilePipeline(text, { source: 'node-app.conductor.yml' });
  const jobs = Object.fromEntries(pipeline.jobs.map((j) => [j.name, j]));

  assert.deepEqual(jobs['test:suite=unit'].services.map((s) => s.alias), ['postgres']);
  assert.deepEqual(jobs.image.requires, ['docker']);
  assert.equal(jobs['test:suite=integration'].artifacts.when, 'always');
});
