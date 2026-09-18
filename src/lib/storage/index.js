// src/lib/storage/index.js - object storage backend selection
//
// S3 is used when storage.s3.bucket is configured, otherwise objects go to
// the local filesystem. Both backends expose the same surface:
//
//   put(key, body, opts)  -> { key, size, sha256 }
//   get(key, { range })   -> { key, size, stream }, throws StorageNotFound
//   head(key)             -> { key, size, modified } or null
//   delete(key)           -> resolves even when the key is absent
//   presign(key, opts)    -> absolute URL, or null when unsupported
//
// Callers must handle a null from presign by streaming get() themselves,
// since the local backend has no URL to hand out.

import { createLocalStorage } from './local.js';
import { createS3Storage } from './s3.js';

export { StorageNotFound, assertKey, sanitizeRelativePath } from './key.js';

export function createStorage(cfg) {
  return cfg.storage.driver === 's3' ? createS3Storage(cfg) : createLocalStorage(cfg);
}

// Key layout, kept in one place so the read-api and the conductor agree.
export const keys = {
  artifact: (runId, jobId, relPath) => `artifacts/${runId}/${jobId}/${relPath}`,
  log: (runId, jobId) => `logs/${runId}/${jobId}.log`,
};
