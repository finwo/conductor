// src/worker/source.js - getting the tree into the workspace
//
// Two modes, chosen per project by the conductor:
//
//   archive  download a tarball of the exact commit from the conductor and
//            unpack it. The worker needs no repository credentials and can
//            reach no ref other than the one it was given work for.
//   clone    git clone the repository directly, for repositories large
//            enough that a tarball per job is wasteful.
//
// Unpacking shells out to the host tar. Both GNU and BSD tar accept these
// arguments; availability is checked once at startup.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const execFileAsync = promisify(execFile);

export async function hasTar() {
  try {
    await execFileAsync('tar', ['--version'], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

export async function hasGit() {
  try {
    await execFileAsync('git', ['--version'], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

// Streams a gzipped tar into a directory without staging it on disk.
export async function extractTarGz(stream, directory) {
  const child = spawn('tar', ['-xzf', '-', '-C', directory, '--no-same-owner'], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString().slice(0, 4096); });

  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${stderr.trim()}`));
    });
  });

  const source = stream instanceof Readable ? stream : Readable.fromWeb(stream);
  await Promise.all([pipeline(source, child.stdin), exited]);
}

export async function fetchSource(client, job, workspace, { timeout = 600000 } = {}) {
  const source = job.source ?? {};

  if (source.mode === 'clone') {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' };
    await execFileAsync('git', ['clone', '--quiet', '--no-checkout', '--', source.repo_url, workspace], { timeout, env });
    await execFileAsync('git', ['-C', workspace, 'checkout', '--quiet', source.sha], { timeout, env });
    return { mode: 'clone' };
  }

  if (source.mode === 'archive') {
    const body = await client.source(source.url);
    await extractTarGz(body, workspace);
    return { mode: 'archive' };
  }

  throw new Error(`unsupported source mode: ${JSON.stringify(source.mode)}`);
}
