// test/only.test.js - restricting tasks to particular refs

import test from 'node:test';
import assert from 'node:assert/strict';

import { compilePipeline, refMatches, PipelineError } from '../src/lib/pipeline/index.js';

const PIPELINE = `
version: 1
defaults:
  image: alpine:3
tasks:
  build:
    script: ['make']
  publish:
    needs: [build]
    only:
      refs: [refs/heads/main, 'refs/tags/v*']
    script: ['make publish']
`;

function names(text, ref) {
  return compilePipeline(text, { ref }).tasks.map((j) => j.name).sort();
}

test('a pattern without a star matches exactly', () => {
  assert.ok(refMatches('refs/heads/main', 'refs/heads/main'));
  assert.ok(!refMatches('refs/heads/main', 'refs/heads/main-2'));
  assert.ok(!refMatches('refs/heads/main', 'refs/heads/mai'));

  // A pattern is matched against the whole ref, so a branch name on its
  // own is not enough.
  assert.ok(!refMatches('main', 'refs/heads/main'));
});

test('a star matches any job of characters', () => {
  assert.ok(refMatches('refs/tags/v*', 'refs/tags/v1.2.0'));
  assert.ok(refMatches('refs/tags/v*', 'refs/tags/v'));
  assert.ok(!refMatches('refs/tags/v*', 'refs/heads/v1'));
  assert.ok(refMatches('*', 'refs/heads/anything'));
  assert.ok(refMatches('refs/*/main', 'refs/heads/main'));
});

test('the rest of a pattern is literal, not a regular expression', () => {
  // A dot is a dot. Were this compiled straight to a regular expression,
  // v1.2.0 would also match v1x2x0.
  assert.ok(refMatches('refs/tags/v1.2.0', 'refs/tags/v1.2.0'));
  assert.ok(!refMatches('refs/tags/v1.2.0', 'refs/tags/v1x2x0'));

  // And these would be quantifiers rather than characters.
  assert.ok(refMatches('refs/heads/fix+', 'refs/heads/fix+'));
  assert.ok(!refMatches('refs/heads/fix+', 'refs/heads/fixx'));
});

test('a restricted task is left out of jobs for other refs', () => {
  assert.deepEqual(names(PIPELINE, 'refs/heads/main'), ['build', 'publish']);
  assert.deepEqual(names(PIPELINE, 'refs/tags/v1.2.0'), ['build', 'publish']);
  assert.deepEqual(names(PIPELINE, 'refs/heads/feature'), ['build']);
});

test('it is left out rather than recorded as skipped', () => {
  // A skipped task satisfies needs, so recording it that way would let the
  // steps below a never-intended publish run anyway.
  const { tasks } = compilePipeline(PIPELINE, { ref: 'refs/heads/feature' });
  assert.ok(!tasks.some((j) => j.name === 'publish'));
});

test('tasks depending on an excluded task are excluded too', () => {
  const text = `
version: 1
defaults:
  image: alpine:3
tasks:
  build:
    script: ['make']
  publish:
    needs: [build]
    only:
      refs: [refs/heads/main]
    script: ['make publish']
  announce:
    needs: [publish]
    script: ['make announce']
`;
  // announce carries no rule of its own, but running it without publish
  // would mean running it without something it declared it needed.
  assert.deepEqual(names(text, 'refs/heads/feature'), ['build']);
  assert.deepEqual(names(text, 'refs/heads/main'), ['announce', 'build', 'publish']);
});

test('depth and ordering describe the job that will happen', () => {
  const { tasks } = compilePipeline(PIPELINE, { ref: 'refs/heads/feature' });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].name, 'build');
  assert.equal(tasks[0].depth, 0);
});

test('without a ref nothing is filtered, so a pipeline can still be validated', () => {
  const { tasks } = compilePipeline(PIPELINE);
  assert.deepEqual(tasks.map((j) => j.name).sort(), ['build', 'publish']);
});

test('a restricted task cannot match a job that has no ref', () => {
  assert.deepEqual(names(PIPELINE, ''), ['build']);
});

test('a malformed rule is reported rather than ignored', () => {
  const cases = [
    ['only: refs/heads/main', 'must be a mapping'],
    ['only:\n      branches: [main]', 'unknown key'],
    ['only:\n      refs: []', 'at least one'],
    ['only: {}', 'needs a refs list'],
  ];

  for (const [fragment, expected] of cases) {
    const text = `
version: 1
defaults:
  image: alpine:3
tasks:
  publish:
    script: ['make publish']
    ${fragment}
`;
    assert.throws(
      () => compilePipeline(text, { ref: 'refs/heads/main' }),
      (error) => {
        assert.ok(error instanceof PipelineError, `${fragment}: expected PipelineError`);
        const text = error.errors.map((e) => e.message).join('; ');
        assert.match(text, new RegExp(expected), `${fragment}: got ${text}`);
        return true;
      },
      `expected ${JSON.stringify(fragment)} to be rejected`,
    );
  }
});

test('the rule is not inherited from defaults', () => {
  // Inheriting it would restrict every task at once, which is a hard
  // mistake to spot when the symptom is an empty job.
  const text = `
version: 1
defaults:
  image: alpine:3
  only:
    refs: [refs/heads/main]
tasks:
  build:
    script: ['make']
`;
  assert.throws(
    () => compilePipeline(text, { ref: 'refs/heads/main' }),
    (error) => {
      assert.ok(error instanceof PipelineError);
      const message = error.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
      assert.match(message, /defaults\.only/, `expected defaults.only to be rejected, got ${message}`);
      return true;
    },
  );
});

test('a task that only comes after an excluded one still runs', () => {
  const text = `
version: 1
defaults:
  image: alpine:3
tasks:
  build:
    script: ['make']
  publish:
    needs: [build]
    only:
      refs: [refs/heads/main]
    script: ['make publish']
  notify:
    after: [publish]
    script: ['make notify']
`;
  // notify asked to run after publish, not to be fed by it. On a branch
  // where publish never happens there is nothing to wait for, so the edge
  // goes and notify stays.
  assert.deepEqual(names(text, 'refs/heads/feature'), ['build', 'notify']);
  assert.deepEqual(names(text, 'refs/heads/main'), ['build', 'notify', 'publish']);
});

test('an after edge into an excluded task is pruned, not left dangling', () => {
  // The scheduler resolves these names to task ids, so one pointing at a
  // task that is not in the job would be written as a broken edge.
  const { tasks } = compilePipeline(`
version: 1
defaults:
  image: alpine:3
tasks:
  build:
    script: ['make']
  publish:
    only:
      refs: [refs/heads/main]
    script: ['make publish']
  notify:
    after: [build, publish]
    script: ['make notify']
`, { ref: 'refs/heads/feature' });

  const present = new Set(tasks.map((t) => t.name));
  const notify = tasks.find((t) => t.name === 'notify');
  assert.deepEqual(notify.after, ['build']);
  for (const dep of notify.after) assert.ok(present.has(dep), `${dep} should be in the job`);
});
