// test/pipeline.test.js - parsing, validation and expansion of .conductor.yml

import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePipeline, parsePipeline, PipelineError } from '../src/lib/pipeline/index.js';

const MINIMAL = `
version: 1
tasks:
  build:
    image: alpine
    script: [make]
`;

function errorPaths(fn) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof PipelineError, `expected PipelineError, got ${e}`);
    return e.errors.map((x) => x.path);
  }
  throw new Error('expected the pipeline to be rejected');
}

function byName(pipeline) {
  return Object.fromEntries(pipeline.tasks.map((j) => [j.name, j]));
}

test('a minimal pipeline compiles', () => {
  const p = compilePipeline(MINIMAL);
  assert.equal(p.tasks.length, 1);
  assert.equal(p.tasks[0].name, 'build');
  assert.deepEqual(p.tasks[0].script, ['make']);
  assert.equal(p.tasks[0].depth, 0);
});

test('version is required and pinned', () => {
  assert.deepEqual(errorPaths(() => compilePipeline('tasks:\n  a:\n    image: x\n    script: [y]\n')), ['version']);
  assert.deepEqual(errorPaths(() => compilePipeline('version: 2\ntasks:\n  a:\n    image: x\n    script: [y]\n')), ['version']);
});

test('empty and malformed documents are rejected clearly', () => {
  assert.throws(() => compilePipeline(''), /file is empty/);
  assert.throws(() => compilePipeline('- a\n- b\n'), /expected a mapping at the top level/);
  assert.throws(() => compilePipeline('version: 1\ntasks: {\n'), /not valid YAML/);
});

test('image and script are required', () => {
  const paths = errorPaths(() => compilePipeline('version: 1\ntasks:\n  a: {}\n'));
  assert.deepEqual(paths.sort(), ['tasks.a.image', 'tasks.a.script']);
});

test('image may come from defaults', () => {
  const p = compilePipeline('version: 1\ndefaults:\n  image: alpine\ntasks:\n  a:\n    script: [x]\n');
  assert.equal(p.tasks[0].image, 'alpine');
});

test('unknown keys are rejected, with a suggestion when close', () => {
  try {
    compilePipeline('version: 1\ntasks:\n  a:\n    image: x\n    script: [y]\n    scripts: [z]\n');
    throw new Error('expected rejection');
  } catch (e) {
    assert.match(e.message, /tasks\.a\.scripts: unknown key, did you mean script/);
  }
});

test('all problems are reported at once', () => {
  const paths = errorPaths(() => compilePipeline(`
version: 1
tasks:
  a:
    script: [x]
  b:
    image: y
`));
  assert.ok(paths.includes('tasks.a.image'));
  assert.ok(paths.includes('tasks.b.script'));
});

test('durations accept seconds, units and composites', () => {
  const p = compilePipeline(`
version: 1
tasks:
  a: { image: x, script: [y], timeout: 90 }
  b: { image: x, script: [y], timeout: 30m }
  c: { image: x, script: [y], timeout: 1h30m }
`);
  const tasks = byName(p);
  assert.equal(tasks.a.timeout, 90);
  assert.equal(tasks.b.timeout, 1800);
  assert.equal(tasks.c.timeout, 5400);
});

test('durations accept day and week units', () => {
  const p = compilePipeline(`
version: 1
tasks:
  a:
    image: x
    script: [y]
    artifacts:
      paths: [d]
      expire: 30d
  b:
    image: x
    script: [y]
    artifacts:
      paths: [d]
      expire: 2w
`);
  const tasks = byName(p);
  assert.equal(tasks.a.artifacts.expire, 30 * 86400);
  assert.equal(tasks.b.artifacts.expire, 14 * 86400);
});

test('a malformed duration is rejected', () => {
  assert.deepEqual(
    errorPaths(() => compilePipeline('version: 1\ntasks:\n  a: { image: x, script: [y], timeout: soon }\n')),
    ['tasks.a.timeout']
  );
});

test('arch expands into one task per architecture', () => {
  const p = compilePipeline('version: 1\ntasks:\n  b:\n    image: x\n    script: [y]\n    arch: [x86_64, aarch64]\n');
  assert.deepEqual(p.tasks.map((j) => j.name).sort(), ['b:arch=aarch64', 'b:arch=x86_64']);
  assert.equal(byName(p)['b:arch=x86_64'].env.ARCH, 'x86_64');
});

test('a matrix expands to the cartesian product', () => {
  const p = compilePipeline(`
version: 1
tasks:
  p:
    image: x
    script: [y]
    matrix:
      pkg: [musl, busybox]
      mode: [debug, release]
`);
  assert.equal(p.tasks.length, 4);
  // Dimensions keep their declaration order, so names are predictable.
  assert.deepEqual(p.tasks.map((j) => j.name).sort(), [
    'p:pkg=busybox,mode=debug',
    'p:pkg=busybox,mode=release',
    'p:pkg=musl,mode=debug',
    'p:pkg=musl,mode=release',
  ]);
  const one = byName(p)['p:pkg=musl,mode=debug'];
  assert.equal(one.env.MATRIX_PKG, 'musl');
  assert.equal(one.env.MATRIX_MODE, 'debug');
});

test('needs match on shared dimensions rather than fanning out', () => {
  const p = compilePipeline(`
version: 1
tasks:
  build:
    image: x
    script: [y]
    arch: [x86_64, aarch64]
  package:
    image: x
    script: [y]
    arch: [x86_64, aarch64]
    matrix:
      pkg: [musl]
    needs: [build]
`);
  const tasks = byName(p);
  assert.deepEqual(tasks['package:arch=x86_64,pkg=musl'].needs, ['build:arch=x86_64']);
  assert.deepEqual(tasks['package:arch=aarch64,pkg=musl'].needs, ['build:arch=aarch64']);
});

test('a task without the shared dimension depends on every instance', () => {
  const p = compilePipeline(`
version: 1
tasks:
  build:
    image: x
    script: [y]
    arch: [x86_64, aarch64]
  publish:
    image: x
    script: [y]
    needs: [build]
`);
  assert.deepEqual(byName(p).publish.needs, ['build:arch=aarch64', 'build:arch=x86_64']);
});

test('match all opts out of dimension matching', () => {
  const p = compilePipeline(`
version: 1
tasks:
  build:
    image: x
    script: [y]
    arch: [x86_64, aarch64]
  check:
    image: x
    script: [y]
    arch: [x86_64, aarch64]
    needs:
      - task: build
        match: all
`);
  assert.deepEqual(byName(p)['check:arch=x86_64'].needs, ['build:arch=aarch64', 'build:arch=x86_64']);
});

test('needs may name one concrete instance', () => {
  const p = compilePipeline(`
version: 1
tasks:
  build:
    image: x
    script: [y]
    arch: [x86_64, aarch64]
  docs:
    image: x
    script: [y]
    needs: ['build:arch=x86_64']
`);
  assert.deepEqual(byName(p).docs.needs, ['build:arch=x86_64']);
});

test('an unsatisfiable dimension match is reported, not silently dropped', () => {
  try {
    compilePipeline(`
version: 1
tasks:
  build:
    image: x
    script: [y]
    arch: [x86_64]
  package:
    image: x
    script: [y]
    arch: [riscv64]
    needs: [build]
`);
    throw new Error('expected rejection');
  } catch (e) {
    assert.match(e.message, /no instance of "build" matches package:arch=riscv64 on arch/);
    assert.match(e.message, /match: all/);
  }
});

test('needs on an unknown task lists what is defined', () => {
  try {
    compilePipeline('version: 1\ntasks:\n  a:\n    image: x\n    script: [y]\n    needs: [nope]\n');
    throw new Error('expected rejection');
  } catch (e) {
    assert.match(e.message, /refers to unknown task "nope"/);
  }
});

test('self dependency is rejected', () => {
  assert.throws(
    () => compilePipeline('version: 1\ntasks:\n  a:\n    image: x\n    script: [y]\n    needs: [a]\n'),
    /cannot depend on itself/
  );
});

test('a dependency cycle names the cycle', () => {
  assert.throws(() => compilePipeline(`
version: 1
tasks:
  a: { image: x, script: [s], needs: [c] }
  b: { image: x, script: [s], needs: [a] }
  c: { image: x, script: [s], needs: [b] }
`), /dependency cycle: (a -> c -> b -> a|b -> a -> c -> b|c -> b -> a -> c)/);
});

test('interpolation substitutes arch and matrix values', () => {
  const p = compilePipeline(`
version: 1
tasks:
  b:
    image: 'builder:\${{ arch }}'
    arch: [x86_64]
    matrix:
      pkg: [musl]
    script: ['build \${{ matrix.pkg }} for \${{ arch }}']
    env:
      TAG: '\${{ matrix.pkg }}-\${{ arch }}'
`);
  const task = p.tasks[0];
  assert.equal(task.image, 'builder:x86_64');
  assert.deepEqual(task.script, ['build musl for x86_64']);
  assert.equal(task.env.TAG, 'musl-x86_64');
});

test('interpolating an undefined dimension is an error', () => {
  try {
    compilePipeline('version: 1\ntasks:\n  a:\n    image: x\n    script: ["\${{ matrix.nope }}"]\n');
    throw new Error('expected rejection');
  } catch (e) {
    assert.match(e.message, /matrix\.nope \}\} which the task does not define/);
  }
});

test('referring to arch without declaring one is an error', () => {
  assert.throws(
    () => compilePipeline('version: 1\ntasks:\n  a:\n    image: "x:\${{ arch }}"\n    script: [y]\n'),
    /the task declares no arch/
  );
});

test('matrix values must be safe for use in a task name', () => {
  assert.deepEqual(
    errorPaths(() => compilePipeline('version: 1\ntasks:\n  a:\n    image: x\n    script: [y]\n    matrix:\n      k: ["has space"]\n')),
    ['tasks.a.matrix.k[0]']
  );
});

test('arch may not also be a matrix dimension', () => {
  assert.deepEqual(
    errorPaths(() => compilePipeline('version: 1\ntasks:\n  a:\n    image: x\n    script: [y]\n    matrix:\n      arch: [x86_64]\n')),
    ['tasks.a.matrix.arch']
  );
});

test('services get a derived alias and reject duplicates', () => {
  const p = compilePipeline(`
version: 1
tasks:
  a:
    image: x
    script: [y]
    services:
      - docker:dind
      - image: registry.example.com/team/postgres:16
        alias: db
`);
  assert.deepEqual(p.tasks[0].services.map((s) => s.alias), ['docker', 'db']);

  assert.throws(() => compilePipeline(`
version: 1
tasks:
  a:
    image: x
    script: [y]
    services: [docker:dind, docker:24-dind]
`), /duplicate service alias/);
});

test('artifacts accept a bare list and reject absolute paths', () => {
  const p = compilePipeline('version: 1\ntasks:\n  a:\n    image: x\n    script: [y]\n    artifacts: [dist/**]\n');
  assert.deepEqual(p.tasks[0].artifacts.paths, ['dist/**']);
  assert.equal(p.tasks[0].artifacts.when, 'on_success');

  assert.deepEqual(
    errorPaths(() => compilePipeline('version: 1\ntasks:\n  a:\n    image: x\n    script: [y]\n    artifacts: [/etc/passwd]\n')),
    ['tasks.a.artifacts.paths[0]']
  );
});

test('artifact when is constrained', () => {
  assert.deepEqual(
    errorPaths(() => compilePipeline('version: 1\ntasks:\n  a:\n    image: x\n    script: [y]\n    artifacts:\n      paths: [d]\n      when: maybe\n')),
    ['tasks.a.artifacts.when']
  );
});

test('defaults are inherited and overridden per task', () => {
  const p = compilePipeline(`
version: 1
defaults:
  image: base
  timeout: 10m
  env:
    SHARED: yes
  requires: [docker]
tasks:
  a:
    script: [x]
  b:
    image: custom
    timeout: 1h
    script: [x]
    env:
      OWN: no
`);
  const tasks = byName(p);
  assert.equal(tasks.a.image, 'base');
  assert.equal(tasks.a.timeout, 600);
  assert.deepEqual(tasks.a.requires, ['docker']);
  assert.equal(tasks.b.image, 'custom');
  assert.equal(tasks.b.timeout, 3600);
  assert.equal(tasks.b.env.SHARED, 'yes');
  assert.equal(tasks.b.env.OWN, 'no');
});

test('env values must be scalars with valid names', () => {
  const paths = errorPaths(() => compilePipeline(`
version: 1
tasks:
  a:
    image: x
    script: [y]
    env:
      'bad name': 1
      GOOD: { nested: true }
`));
  assert.deepEqual(paths.sort(), ['tasks.a.env.GOOD', 'tasks.a.env.bad name']);
});

test('parsePipeline normalizes without expanding', () => {
  const doc = parsePipeline(MINIMAL);
  assert.equal(doc.version, 1);
  assert.deepEqual(Object.keys(doc.tasks), ['build']);
  assert.deepEqual(doc.tasks.build.needs, []);
});

test('a realistic distribution pipeline produces the expected graph', () => {
  const p = compilePipeline(`
version: 1
defaults:
  image: debian:bookworm-slim
tasks:
  lint:
    script: [make lint]
  build:
    arch: [x86_64, aarch64]
    script: ['./mk/build.sh $ARCH']
  package:
    needs: [build]
    arch: [x86_64, aarch64]
    matrix:
      pkg: [musl, busybox]
    requires: [sign-key]
    script: ['./mk/pkg.sh $MATRIX_PKG $ARCH']
  publish:
    needs: [package, lint]
    script: [./mk/publish.sh]
`);

  assert.equal(p.tasks.length, 1 + 2 + 4 + 1);
  const tasks = byName(p);
  assert.equal(tasks.publish.needs.length, 5);
  assert.equal(tasks.publish.depth, 2);
  assert.deepEqual(tasks['package:arch=aarch64,pkg=musl'].requires, ['sign-key']);
});
