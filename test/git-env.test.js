// test/git-env.test.js - reading repositories the conductor does not own
//
// Project paths belong to whoever put them on disk, and in a container the
// conductor is a different user again. Git calls that "dubious ownership"
// and refuses. This went unnoticed for a while because the old image ran
// as uid 1000, which happened to match the repositories being read, so it
// worked by coincidence rather than by design.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { gitEnv } from '../src/lib/git.js';

const execFileAsync = promisify(execFile);

test('git runs with safe.directory set', () => {
  const env = gitEnv({});
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, 'safe.directory');
  assert.equal(env.GIT_CONFIG_VALUE_0, '*');
});

test('it appends to configuration already in the environment', () => {
  const env = gitEnv({
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.version',
    GIT_CONFIG_VALUE_0: 'HTTP/1.1',
    GIT_CONFIG_KEY_1: 'core.quotePath',
    GIT_CONFIG_VALUE_1: 'false',
  });

  // Git reads indices 0..count-1, so ours has to land at the end and the
  // count has to grow rather than be replaced.
  assert.equal(env.GIT_CONFIG_COUNT, '3');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.version');
  assert.equal(env.GIT_CONFIG_KEY_1, 'core.quotePath');
  assert.equal(env.GIT_CONFIG_KEY_2, 'safe.directory');
  assert.equal(env.GIT_CONFIG_VALUE_2, '*');
});

test('a count that is not a number does not corrupt the sequence', () => {
  for (const bad of ['', 'garbage', '-1', '0']) {
    const env = gitEnv({ GIT_CONFIG_COUNT: bad });
    assert.equal(env.GIT_CONFIG_COUNT, '1', `count ${JSON.stringify(bad)}`);
    assert.equal(env.GIT_CONFIG_KEY_0, 'safe.directory');
  }
});

test('git accepts the environment we build', async () => {
  // Proves the variables are actually well formed. A malformed set makes
  // git fail outright, which is what this would catch.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-gitenv-'));
  try {
    const env = gitEnv(process.env);
    await execFileAsync('git', ['init', '-q', '-b', 'main', dir], { env });
    const { stdout } = await execFileAsync(
      'git', ['-C', dir, 'config', '--get', 'safe.directory'], { env },
    );
    assert.equal(stdout.trim(), '*');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a file missing from a commit reads as missing, whatever sits in the working directory', async () => {
  // Given --git-dir, git treats the process working directory as a work
  // tree and changes its wording when a file of that name happens to be
  // there: "exists on disk, but not in <sha>" rather than a plain
  // absence. The conductor decides a project has no pipeline from that
  // message, so the wrong wording turned a missing pipeline into a 500.
  // Reproduced here rather than left to the happy accident that the test
  // suite runs from a directory containing a .conductor.yml.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-cwd-'));
  const work = path.join(dir, 'work');
  const mirror = path.join(dir, 'mirror.git');
  const env = gitEnv(process.env);

  try {
    await fs.mkdir(work);
    await execFileAsync('git', ['init', '-q', '-b', 'main', work], { env });
    await execFileAsync('git', ['-C', work, 'config', 'user.email', 't@example.invalid'], { env });
    await execFileAsync('git', ['-C', work, 'config', 'user.name', 'test'], { env });
    await fs.writeFile(path.join(work, 'other.txt'), 'present\n');
    await execFileAsync('git', ['-C', work, 'add', '-A'], { env });
    await execFileAsync('git', ['-C', work, 'commit', '-q', '-m', 'only other.txt'], { env });
    await execFileAsync('git', ['clone', '-q', '--mirror', work, mirror], { env });

    const { stdout } = await execFileAsync('git', ['--git-dir', mirror, 'rev-parse', 'HEAD'], { env });
    const sha = stdout.trim();

    // A name that is absent from the commit but present in the directory
    // the suite runs from.
    const decoy = 'package.json';
    assert.ok(existsSync(path.join(process.cwd(), decoy)), `expected ${decoy} in the working directory`);

    let stderr = '';
    try {
      await execFileAsync(
        'git', ['--git-dir', mirror, 'cat-file', 'blob', `${sha}:${decoy}`],
        { env, cwd: mirror },
      );
      assert.fail('expected git to report the path as absent');
    } catch (error) {
      stderr = error.stderr ?? '';
    }

    // Run inside the bare mirror there is no work tree to confuse it.
    assert.match(stderr, /does not exist/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
