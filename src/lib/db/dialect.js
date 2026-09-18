// src/lib/db/dialect.js - dialect naming and detection
//
// Kept separate from index.js so that configuration loading can resolve a
// dialect without pulling in any driver module.

export const DIALECTS = ['sqlite', 'mysql', 'postgres'];

// Maps a database.url scheme onto a dialect name. An unset url means sqlite.
// Returns null for a scheme that is not supported.
export function dialectFromUrl(url) {
  if (!url) return 'sqlite';
  const scheme = String(url).split(':')[0].toLowerCase();
  if (scheme === 'mysql') return 'mysql';
  if (scheme === 'postgres' || scheme === 'postgresql') return 'postgres';
  if (scheme === 'sqlite' || scheme === 'file') return 'sqlite';
  return null;
}
