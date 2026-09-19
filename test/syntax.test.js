// test/syntax.test.js - every JavaScript file parses
//
// Most modules are covered because a test imports them, but entry points
// and the dashboard are never imported by anything: the entry points start
// listeners, and the dashboard only ever runs in a browser. A syntax error
// in either would otherwise reach a deployment.
//
// node --check parses without executing, which is what makes this safe to
// run over files that would start a server on import.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['.git', 'node_modules', 'data', 'tmp']);

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue;
      yield* walk(path.join(dir, entry.name));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      yield path.join(dir, entry.name);
    }
  }
}

test('every javascript file parses', async () => {
  const files = [];
  for await (const file of walk(ROOT)) files.push(file);
  assert.ok(files.length > 20, `expected to find source files, found ${files.length}`);

  const failures = [];
  // Batched, since each check is a process.
  for (let i = 0; i < files.length; i += 8) {
    const batch = files.slice(i, i + 8).map(async (file) => {
      try {
        await execFileAsync(process.execPath, ['--check', file], { timeout: 20000 });
      } catch (e) {
        failures.push(`${path.relative(ROOT, file)}: ${(e.stderr || e.message).trim().split('\n').slice(0, 3).join(' ')}`);
      }
    });
    await Promise.all(batch);
  }

  assert.deepEqual(failures, [], `files failed to parse:\n${failures.join('\n')}`);
});

test('the shell scripts parse', async () => {
  const failures = [];
  for (const script of ['hooks/post-receive']) {
    try {
      await execFileAsync('sh', ['-n', path.join(ROOT, script)], { timeout: 20000 });
    } catch (e) {
      failures.push(`${script}: ${(e.stderr || e.message).trim()}`);
    }
  }
  assert.deepEqual(failures, []);
});
