// src/lib/workers.js - worker registration tokens
//
// A worker authenticates with a bearer token. Only the SHA-256 of the token
// is stored, so the database never holds a usable credential; the plaintext
// is shown once at creation and cannot be recovered afterwards.

import { newToken, hashToken, newWorkerTokenId } from './ids.js';

export function createWorkerTokens({ db }) {
  return {
    async create(name) {
      if (!name || typeof name !== 'string') throw new Error('worker token needs a name');
      const token = newToken();
      const id = newWorkerTokenId();
      await db.run(
        `INSERT INTO worker_tokens (id, name, token_hash, enabled, created_at)
         VALUES ({id}, {name}, {hash}, 1, {now})`,
        { id, name, hash: hashToken(token), now: Date.now() }
      );
      // The only time the plaintext exists outside the worker.
      return { id, name, token };
    },

    // Returns the token record, or null. Lookup is by hash, so a timing
    // difference cannot reveal anything beyond whether a hash exists.
    async verify(presented, { ip = null } = {}) {
      if (typeof presented !== 'string' || presented.length === 0) return null;
      const hash = hashToken(presented);
      const row = await db.get(
        'SELECT id, name, enabled FROM worker_tokens WHERE token_hash = {hash}',
        { hash }
      );
      if (!row || row.enabled !== 1) return null;

      await db.run(
        'UPDATE worker_tokens SET last_seen_at = {now}, last_ip = {ip} WHERE id = {id}',
        { id: row.id, now: Date.now(), ip }
      );
      return { id: row.id, name: row.name };
    },

    async list() {
      return db.all(
        `SELECT id, name, enabled, created_at, last_seen_at, last_ip
           FROM worker_tokens ORDER BY created_at DESC`
      );
    },

    async setEnabled(id, enabled) {
      const res = await db.run(
        'UPDATE worker_tokens SET enabled = {enabled} WHERE id = {id}',
        { id, enabled: enabled ? 1 : 0 }
      );
      return res.changes > 0;
    },

    async remove(id) {
      const res = await db.run('DELETE FROM worker_tokens WHERE id = {id}', { id });
      return res.changes > 0;
    },
  };
}
