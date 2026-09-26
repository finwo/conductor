// test/ascii.test.js - enforces the repository wide ASCII rule
//
// Every source and documentation file must be plain ASCII. This is a hard
// project requirement rather than a style preference, so it is tested rather
// than left to review. Smart quotes, dashes and arrows pasted in from a
// browser are the usual cause of a failure here.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The rule is about code we write, not about a build output or a
// dependency. This walks the filesystem, so .gitignore does not apply.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);
const CHECK_EXT = new Set([
  '.js', '.mjs', '.cjs', '.json', '.md', '.sql', '.yml', '.yaml',
  '.html', '.css', '.sh', '.txt',
]);
const CHECK_NAMES = new Set(['.editorconfig', '.gitignore', '.dockerignore', 'post-receive']);

// Dockerfile, Dockerfile.worker, and anything else in that family.
const CHECK_PREFIXES = ['Dockerfile'];

function shouldCheck(file) {
  const base = path.basename(file);
  if (CHECK_EXT.has(path.extname(file))) return true;
  if (CHECK_NAMES.has(base)) return true;
  return CHECK_PREFIXES.some((prefix) => base.startsWith(prefix));
}

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      yield path.join(dir, entry.name);
    }
  }
}

function describeChar(ch) {
  const code = ch.codePointAt(0);
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')} ${JSON.stringify(ch)}`;
}

test('every tracked text file is pure ASCII', async () => {
  const offences = [];

  for await (const file of walk(ROOT)) {
    if (!shouldCheck(file)) continue;

    const text = await fs.readFile(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      for (const ch of lines[i]) {
        const code = ch.codePointAt(0);
        // Tab, and the printable range. Newlines are already stripped.
        if (code === 9 || (code >= 32 && code <= 126)) continue;
        offences.push(`${path.relative(ROOT, file)}:${i + 1}: ${describeChar(ch)}`);
        break;
      }
    }
  }

  assert.deepEqual(offences, [], `non-ASCII characters found:\n${offences.join('\n')}`);
});

test('no file uses CRLF line endings or trailing whitespace', async () => {
  const offences = [];

  for await (const file of walk(ROOT)) {
    if (!shouldCheck(file)) continue;

    const text = await fs.readFile(file, 'utf8');
    const rel = path.relative(ROOT, file);
    if (text.includes('\r')) offences.push(`${rel}: contains a carriage return`);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (/[ \t]+$/.test(lines[i])) offences.push(`${rel}:${i + 1}: trailing whitespace`);
    }
    if (text.length > 0 && !text.endsWith('\n')) offences.push(`${rel}: missing final newline`);
  }

  assert.deepEqual(offences, [], `formatting problems found:\n${offences.join('\n')}`);
});
