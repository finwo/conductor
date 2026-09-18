// src/lib/storage/key.js - object key validation shared by both backends
//
// Keys are slash separated and always relative. Validation is centralised
// because a key frequently originates from a job artifact path, which is
// attacker controlled for any worker or repository that is not fully trusted.

export class StorageNotFound extends Error {
  constructor(key) {
    super(`object not found: ${key}`);
    this.name = 'StorageNotFound';
    this.code = 'ENOENT';
    this.key = key;
  }
}

export function assertKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('storage key must be a non-empty string');
  }
  if (key.length > 1024) {
    throw new Error(`storage key exceeds 1024 characters: ${key.slice(0, 64)}...`);
  }
  if (key.startsWith('/')) {
    throw new Error(`storage key must be relative: ${key}`);
  }
  if (key.includes('\\')) {
    throw new Error(`storage key must use forward slashes: ${key}`);
  }
  // A NUL byte truncates the path in some syscalls.
  if (key.includes('\0')) {
    throw new Error('storage key contains a NUL byte');
  }
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`storage key contains an invalid path segment: ${key}`);
    }
  }
  return key;
}

// Normalizes a path reported by a worker into a safe key suffix. Returns null
// when nothing usable remains, so the caller can reject the upload.
export function sanitizeRelativePath(input) {
  if (typeof input !== 'string') return null;
  const parts = input
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p !== '' && p !== '.' && p !== '..' && !p.includes('\0'));
  if (parts.length === 0) return null;
  const joined = parts.join('/');
  return joined.length > 512 ? null : joined;
}
