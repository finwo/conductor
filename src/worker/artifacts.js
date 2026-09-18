// src/worker/artifacts.js - collecting and uploading job output
//
// Patterns are matched with the glob support built into node, so there is
// nothing to install. Matches are confined to the workspace: a job can write
// a symlink pointing anywhere it likes, and following one would upload a
// file the job was never given.

import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { SCRIPT_DIR } from './script.js';

const MAX_FILES = 2000;

export async function collectArtifacts(workspace, patterns, { logger = console } = {}) {
  const root = await fs.realpath(workspace);
  const seen = new Map();

  for (const pattern of patterns) {
    let matches;
    try {
      matches = await Array.fromAsync(fs.glob(pattern, { cwd: root }));
    } catch (e) {
      logger.warn?.(`artifact pattern ${pattern} failed: ${e.message}`);
      continue;
    }

    for (const relative of matches) {
      if (seen.size >= MAX_FILES) {
        logger.warn?.(`artifact limit of ${MAX_FILES} files reached, ignoring the rest`);
        return [...seen.values()];
      }

      const normalized = relative.split(path.sep).join('/');
      // The generated script lives in the workspace and is not output.
      if (normalized === SCRIPT_DIR || normalized.startsWith(`${SCRIPT_DIR}/`)) continue;
      if (seen.has(normalized)) continue;

      const absolute = path.join(root, relative);
      let resolved;
      let stat;
      try {
        resolved = await fs.realpath(absolute);
        stat = await fs.stat(resolved);
      } catch {
        // Vanished between globbing and stat, or a broken symlink.
        continue;
      }

      if (!stat.isFile()) continue;
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        logger.warn?.(`refusing artifact ${normalized}: resolves outside the workspace`);
        continue;
      }

      seen.set(normalized, { path: normalized, absolute: resolved, size: stat.size });
    }
  }

  return [...seen.values()];
}

export function shouldCollect(when, success) {
  if (when === 'always') return true;
  if (when === 'on_failure') return !success;
  return success;
}

export async function uploadArtifacts(client, url, files, { logger = console } = {}) {
  const uploaded = [];
  for (const file of files) {
    try {
      const body = Readable.toWeb(createReadStream(file.absolute));
      const result = await client.uploadArtifact(url, file.path, body, file.size);
      uploaded.push(result);
    } catch (e) {
      // An artifact that cannot be stored is worth reporting, but the job
      // itself already succeeded or failed on its own merits.
      logger.warn?.(`could not upload ${file.path}: ${e.message}`);
    }
  }
  return uploaded;
}
