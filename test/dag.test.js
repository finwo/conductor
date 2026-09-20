// test/dag.test.js - dependency graph traversal
//
// These cover the two scheduling defects carried over from the prototype:
// serialized dispatch, and a failure cascade that only skipped direct
// dependents.

import test from 'node:test';
import assert from 'node:assert/strict';
import { topologicalOrder, depths, transitiveDependents, runnable, CycleError } from '../src/lib/pipeline/dag.js';

// a -> b -> d, a -> c -> d, plus an unrelated island.
const GRAPH = [
  { name: 'a', needs: [] },
  { name: 'b', needs: ['a'] },
  { name: 'c', needs: ['a'] },
  { name: 'd', needs: ['b', 'c'] },
  { name: 'island', needs: [] },
];

function states(overrides = {}) {
  const map = new Map(GRAPH.map((j) => [j.name, 'queued']));
  for (const [k, v] of Object.entries(overrides)) map.set(k, v);
  return map;
}

test('topological order places dependencies first', () => {
  const order = topologicalOrder(GRAPH).map((j) => j.name);
  assert.ok(order.indexOf('a') < order.indexOf('b'));
  assert.ok(order.indexOf('a') < order.indexOf('c'));
  assert.ok(order.indexOf('b') < order.indexOf('d'));
  assert.ok(order.indexOf('c') < order.indexOf('d'));
});

test('topological order is deterministic', () => {
  const first = topologicalOrder(GRAPH).map((j) => j.name);
  const shuffled = [...GRAPH].reverse();
  assert.deepEqual(topologicalOrder(shuffled).map((j) => j.name), first);
});

test('a cycle is detected and named', () => {
  const cyclic = [
    { name: 'x', needs: ['z'] },
    { name: 'y', needs: ['x'] },
    { name: 'z', needs: ['y'] },
  ];
  assert.throws(() => topologicalOrder(cyclic), CycleError);
  try {
    topologicalOrder(cyclic);
  } catch (e) {
    // The reported path returns to where it started.
    assert.equal(e.cycle[0], e.cycle[e.cycle.length - 1]);
  }
});

test('depth reflects the longest path, not insertion order', () => {
  const d = depths(GRAPH);
  assert.equal(d.get('a'), 0);
  assert.equal(d.get('island'), 0);
  assert.equal(d.get('b'), 1);
  assert.equal(d.get('d'), 2);
});

test('independent tasks are runnable at the same time', () => {
  // The prototype could only ever return one task here.
  const ready = runnable(GRAPH, states()).map((j) => j.name);
  assert.deepEqual(ready.sort(), ['a', 'island']);
});

test('a task becomes runnable only once every dependency succeeds', () => {
  assert.deepEqual(
    runnable(GRAPH, states({ a: 'success', b: 'success' })).map((j) => j.name).sort(),
    ['c', 'island']
  );
  assert.deepEqual(
    runnable(GRAPH, states({ a: 'success', b: 'success', c: 'success', island: 'success' })).map((j) => j.name),
    ['d']
  );
});

test('a running dependency does not release its dependents', () => {
  assert.equal(runnable(GRAPH, states({ a: 'running' })).some((j) => j.name === 'b'), false);
});

test('failure skips transitive dependents, not just direct ones', () => {
  // This is the prototype bug: it would have skipped only b and c, leaving
  // d queued and dispatchable with its inputs missing.
  const skipped = transitiveDependents(GRAPH, ['a']);
  assert.deepEqual([...skipped].sort(), ['b', 'c', 'd']);
  assert.equal(skipped.has('island'), false);
});

test('a skipped dependency never releases a dependent', () => {
  assert.equal(runnable(GRAPH, states({ a: 'failed' })).some((j) => j.name === 'b'), false);
  assert.equal(runnable(GRAPH, states({ a: 'skipped' })).some((j) => j.name === 'b'), false);
});

test('allowed failures can satisfy a dependency when asked to', () => {
  const ready = runnable(GRAPH, states({ a: 'failed' }), { satisfied: ['success', 'failed'] });
  assert.deepEqual(ready.map((j) => j.name).sort(), ['b', 'c', 'island']);
});

test('transitive dependents of a leaf is empty', () => {
  assert.equal(transitiveDependents(GRAPH, ['d']).size, 0);
});

test('graph helpers tolerate dependencies outside the set', () => {
  const partial = [{ name: 'only', needs: ['absent'] }];
  assert.deepEqual(topologicalOrder(partial).map((j) => j.name), ['only']);
  assert.equal(depths(partial).get('only'), 0);
});
