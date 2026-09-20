// src/lib/log.js - task log spool
//
// Logs are written to local disk while a task runs, then copied to object
// storage when it finishes. The spool is always local even when S3 is
// configured, because a running task produces many small appends and a live
// tail wants cheap random reads; neither suits an object store.
//
// Appends carry the offset the worker believes it is writing at, which makes
// a retry after a dropped connection safe: an overlapping chunk is trimmed
// and a gap is refused so the worker can resend from the right place.

import fs from 'node:fs/promises';
import path from 'node:path';

export class LogOffsetError extends Error {
  constructor(message, expected) {
    super(message);
    this.name = 'LogOffsetError';
    this.expected = expected;
  }
}

const TRUNCATION_NOTICE = '\n[conductor] log truncated: size limit reached\n';

export function createLogStore(cfg) {
  const root = cfg.log.spool_path;
  const maxSize = cfg.log.max_size;

  // One writer per job, so a retried append cannot interleave with the
  // original.
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

  // A directory per job keeps listings sane, and lets a whole job's spool
  // be removed in one go. Both ids are encoded anyway, which costs nothing
  // now that neither carries a separator.
  function spoolPath(jobId, taskId) {
    return path.join(root, encodeURIComponent(jobId), `${encodeURIComponent(taskId)}.log`);
  }

  async function currentSize(file) {
    try {
      return (await fs.stat(file)).size;
    } catch (e) {
      if (e.code === 'ENOENT') return 0;
      throw e;
    }
  }

  return {
    spoolPath,

    async size(jobId, taskId) {
      return currentSize(spoolPath(jobId, taskId));
    },

    // Returns the new total size. When offset is omitted the chunk is simply
    // appended, which is what a worker that never retries will do.
    async append(jobId, taskId, chunk, offset) {
      const file = spoolPath(jobId, taskId);
      const key = `${jobId}/${taskId}`;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');

      return withLock(key, async () => {
        const size = await currentSize(file);

        let payload = data;
        if (offset !== undefined && offset !== null) {
          if (offset > size) {
            throw new LogOffsetError(
              `log append starts past the end of the log: got offset ${offset}, have ${size}`,
              size
            );
          }
          if (offset < size) {
            // The worker is resending something already stored. Keep only
            // the part beyond what we have.
            const overlap = size - offset;
            if (overlap >= payload.length) return { size, written: 0 };
            payload = payload.subarray(overlap);
          }
        }

        if (size >= maxSize) return { size, written: 0, truncated: true };

        let truncated = false;
        if (size + payload.length > maxSize) {
          payload = Buffer.concat([
            payload.subarray(0, Math.max(0, maxSize - size)),
            Buffer.from(TRUNCATION_NOTICE, 'utf8'),
          ]);
          truncated = true;
        }

        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.appendFile(file, payload);
        return { size: size + payload.length, written: payload.length, truncated };
      });
    },

    // Reads a window for the live tail. Returns the total size too, so the
    // caller knows whether more is already available.
    async read(jobId, taskId, { offset = 0, limit = 256 * 1024 } = {}) {
      const file = spoolPath(jobId, taskId);
      const size = await currentSize(file);
      if (size === 0 || offset >= size) {
        return { data: Buffer.alloc(0), offset: Math.min(offset, size), size };
      }

      const start = Math.max(0, offset);
      const length = Math.min(limit, size - start);
      const handle = await fs.open(file, 'r');
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        return { data: buffer.subarray(0, bytesRead), offset: start, size };
      } finally {
        await handle.close();
      }
    },

    // Copies the finished log into object storage and drops the spool copy.
    // Storage is the durable home; the spool only exists to serve a tail.
    async finalize(jobId, taskId, storage, storageKey) {
      const file = spoolPath(jobId, taskId);
      const size = await currentSize(file);
      if (size === 0) return { key: null, size: 0 };

      const handle = await fs.open(file, 'r');
      try {
        await storage.put(storageKey, handle.createReadStream(), {
          size,
          contentType: 'text/plain; charset=utf-8',
        });
      } finally {
        await handle.close();
      }

      await fs.rm(file, { force: true });
      return { key: storageKey, size };
    },

    async remove(jobId, taskId) {
      await fs.rm(spoolPath(jobId, taskId), { force: true });
    },

    async removeJob(jobId) {
      await fs.rm(path.join(root, encodeURIComponent(jobId)), { recursive: true, force: true });
    },
  };
}
