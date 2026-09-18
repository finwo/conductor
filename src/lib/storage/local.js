// src/lib/storage/local.js - filesystem object storage
//
// The default backend, used whenever no S3 bucket is configured. Objects are
// plain files under storage.path, so artifacts remain inspectable with
// ordinary tools and a single node install needs nothing else running.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { StorageNotFound, assertKey } from './key.js';

export function createLocalStorage(cfg) {
  const root = cfg.storage.path;

  function resolve(key) {
    assertKey(key);
    const full = path.resolve(root, key);
    // Defence in depth: assertKey already rejects traversal, but a symlinked
    // storage root should not become an escape either.
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error(`storage key escapes the storage root: ${key}`);
    }
    return full;
  }

  return {
    driver: 'local',

    async put(key, body, opts = {}) {
      const full = resolve(key);
      await fsp.mkdir(path.dirname(full), { recursive: true });

      // Write to a sibling temp file and rename, so a reader never observes a
      // partially written object.
      const tmp = `${full}.${crypto.randomBytes(6).toString('hex')}.part`;
      const hash = crypto.createHash('sha256');
      let size = 0;

      try {
        if (Buffer.isBuffer(body) || typeof body === 'string') {
          const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
          hash.update(buf);
          size = buf.length;
          await fsp.writeFile(tmp, buf);
        } else {
          const source = body instanceof Readable ? body : Readable.from(body);
          const out = fs.createWriteStream(tmp);
          source.on('data', (chunk) => {
            hash.update(chunk);
            size += chunk.length;
          });
          await pipeline(source, out);
        }
        await fsp.rename(tmp, full);
      } catch (e) {
        await fsp.rm(tmp, { force: true });
        throw e;
      }

      if (opts.size !== undefined && opts.size !== size) {
        await fsp.rm(full, { force: true });
        throw new Error(`storage put size mismatch for ${key}: declared ${opts.size}, wrote ${size}`);
      }

      return { key, size, sha256: hash.digest('hex') };
    },

    async get(key, opts = {}) {
      const full = resolve(key);
      let stat;
      try {
        stat = await fsp.stat(full);
      } catch (e) {
        if (e.code === 'ENOENT') throw new StorageNotFound(key);
        throw e;
      }

      const range = opts.range;
      const start = range?.start ?? 0;
      const end = range?.end ?? undefined;

      return {
        key,
        size: stat.size,
        stream: fs.createReadStream(full, end === undefined ? { start } : { start, end }),
      };
    },

    async head(key) {
      try {
        const stat = await fsp.stat(resolve(key));
        return { key, size: stat.size, modified: stat.mtimeMs };
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },

    async delete(key) {
      await fsp.rm(resolve(key), { force: true });
    },

    // Local files cannot be handed out directly; callers stream them instead.
    async presign() {
      return null;
    },
  };
}
