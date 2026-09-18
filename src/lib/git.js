// src/lib/git.js - repository mirrors
//
// The conductor keeps one bare mirror per project. Everything it needs from
// a push is read out of that mirror: the pipeline file at the pushed commit,
// the commit subject, and the source tarball handed to workers.
//
// Serving the source from here rather than having workers clone means an
// untrusted worker needs no repository credentials and cannot reach any ref
// other than the commit it was given work for. It also means the worker host
// does not need git installed.
//
// Every value interpolated into a git invocation is validated first. Refs
// and object ids arrive from webhooks, and a value beginning with a hyphen
// would otherwise be read as an option.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const SHA_PATTERN = /^[0-9a-f]{40}$/;
export const SHORT_SHA_PATTERN = /^[0-9a-f]{7,40}$/;

// Refuses credential prompts, so a misconfigured private repository fails
// promptly instead of hanging until the request times out.
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  GCM_INTERACTIVE: 'never',
  LC_ALL: 'C',
};

export class GitError extends Error {
  constructor(message, { stderr, code } = {}) {
    super(stderr ? `${message}: ${String(stderr).trim().split('\n').slice(0, 3).join('; ')}` : message);
    this.name = 'GitError';
    this.stderr = stderr;
    this.exitCode = code;
  }
}

export function assertSha(sha, label = 'commit') {
  if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) {
    throw new GitError(`${label} must be a full 40 character hex object id, got ${JSON.stringify(sha)}`);
  }
  return sha;
}

// Refs come straight from a push hook. Reject anything git itself would
// consider malformed, along with leading hyphens.
export function assertRef(ref) {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 255) {
    throw new GitError(`invalid ref: ${JSON.stringify(ref)}`);
  }
  if (ref.startsWith('-') || ref.includes('..') || /[\s~^:?*[\\]/.test(ref) || ref.endsWith('.lock')) {
    throw new GitError(`invalid ref: ${JSON.stringify(ref)}`);
  }
  return ref;
}

// A path inside the repository, used for the pipeline file.
export function assertRepoPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 512) {
    throw new GitError(`invalid repository path: ${JSON.stringify(p)}`);
  }
  if (p.startsWith('/') || p.startsWith('-') || p.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new GitError(`invalid repository path: ${JSON.stringify(p)}`);
  }
  return p;
}

// Serializes work per mirror, so two pushes to one project cannot run
// concurrent fetches into the same directory.
const locks = new Map();

async function withLock(key, fn) {
  const previous = locks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  locks.set(key, previous.then(() => current));
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

export function createGit(cfg) {
  const timeout = cfg.git.timeout * 1000;
  const fetchInterval = cfg.git.fetch_interval * 1000;
  const lastFetch = new Map();

  function mirrorPath(projectId) {
    return path.join(cfg.git.mirror_path, `${projectId}.git`);
  }

  async function run(args, options = {}) {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        env: GIT_ENV,
        timeout,
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
        encoding: options.encoding ?? 'utf8',
      });
      return { stdout, stderr };
    } catch (e) {
      throw new GitError(`git ${args[0]} failed`, { stderr: e.stderr || e.message, code: e.code });
    }
  }

  async function exists(dir) {
    try {
      await fs.stat(path.join(dir, 'HEAD'));
      return true;
    } catch {
      return false;
    }
  }

  return {
    mirrorPath,

    // Clones on first use, then fetches at most once per fetch_interval
    // unless force is set. A trigger always forces, since it needs the
    // commit that was just pushed.
    async sync(project, { force = false } = {}) {
      const dir = mirrorPath(project.id);
      return withLock(dir, async () => {
        if (!(await exists(dir))) {
          await fs.mkdir(path.dirname(dir), { recursive: true });
          await run(['clone', '--mirror', '--quiet', '--', project.repo_url, dir]);
          lastFetch.set(dir, Date.now());
          return dir;
        }

        const since = Date.now() - (lastFetch.get(dir) ?? 0);
        if (!force && since < fetchInterval) return dir;

        await run(['--git-dir', dir, 'fetch', '--prune', '--quiet', 'origin']);
        lastFetch.set(dir, Date.now());
        return dir;
      });
    },

    async hasCommit(project, sha) {
      assertSha(sha);
      try {
        const { stdout } = await run(['--git-dir', mirrorPath(project.id), 'cat-file', '-t', sha]);
        return stdout.trim() === 'commit';
      } catch {
        return false;
      }
    },

    async resolve(project, rev) {
      assertRef(rev);
      const { stdout } = await run(['--git-dir', mirrorPath(project.id), 'rev-parse', '--verify', `${rev}^{commit}`]);
      return stdout.trim();
    },

    // Reads one file at a commit. Returns null when the path is absent,
    // which is how a repository without a pipeline is detected.
    async readFile(project, sha, filePath) {
      assertSha(sha);
      assertRepoPath(filePath);
      try {
        const { stdout } = await run(
          ['--git-dir', mirrorPath(project.id), 'cat-file', 'blob', `${sha}:${filePath}`],
          { maxBuffer: 4 * 1024 * 1024 }
        );
        return stdout;
      } catch (e) {
        if (/does not exist|not a valid object name|Not a valid object/i.test(e.stderr ?? '')) return null;
        throw e;
      }
    },

    async commitInfo(project, sha) {
      assertSha(sha);
      // A unit separator keeps the fields unambiguous when a subject
      // contains anything at all.
      const { stdout } = await run([
        '--git-dir', mirrorPath(project.id),
        'show', '--no-patch', '--format=%s%x1f%an%x1f%ae%x1f%aI', sha,
      ]);
      const [subject = '', authorName = '', authorEmail = '', authoredAt = ''] = stdout.trim().split('\x1f');
      return { subject, authorName, authorEmail, authoredAt };
    },

    // A gzipped tar of the tree at a commit, streamed rather than buffered.
    // The caller pipes this straight to the worker.
    archiveStream(project, sha, { prefix = '' } = {}) {
      assertSha(sha);
      const args = ['--git-dir', mirrorPath(project.id), 'archive', '--format=tar.gz'];
      if (prefix) args.push(`--prefix=${prefix}`);
      args.push(sha);

      const child = spawn('git', args, { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk.toString().slice(0, 4096); });
      child.on('close', (code) => {
        if (code !== 0) child.stdout.destroy(new GitError('git archive failed', { stderr, code }));
      });
      return child.stdout;
    },
  };
}
