// src/lib/workers.js - worker registration tokens
//
// A worker authenticates with a bearer token. Only the SHA-256 of the token
// is stored, so the database never holds a usable credential; the plaintext
// is shown once at creation and cannot be recovered afterwards.
//
// A token may belong to a user, in which case it is only ever offered jobs
// from that user's projects. A token with no owner is shared and can run
// anything, which is how an administrator provides general capacity. That
// distinction is enforced in the scheduler, not here.
//
// A token is not a machine: several hosts may share one, so what each
// advertises is kept per reported name in worker_agents.

import { newToken, hashToken, newWorkerTokenId, newWorkerAgentId } from './ids.js';
import { paginateOffset } from './page.js';

function parseList(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function createWorkerTokens({ db }) {
  return {
    async create(name, { ownerId = null } = {}) {
      if (!name || typeof name !== 'string') throw new Error('worker token needs a name');
      const token = newToken();
      const id = newWorkerTokenId();
      await db.run(
        `INSERT INTO worker_tokens (id, name, token_hash, enabled, owner_id, created_at)
         VALUES ({id}, {name}, {hash}, 1, {owner}, {now})`,
        { id, name, hash: hashToken(token), owner: ownerId, now: Date.now() }
      );
      // The only time the plaintext exists outside the worker.
      return { id, name, token, owner_id: ownerId };
    },

    async get(id) {
      return db.get(
        'SELECT id, name, enabled, owner_id, created_at, last_seen_at, last_ip FROM worker_tokens WHERE id = {id}',
        { id }
      );
    },

    // Returns the token record, or null. Lookup is by hash, so a timing
    // difference cannot reveal anything beyond whether a hash exists.
    async verify(presented, { ip = null } = {}) {
      if (typeof presented !== 'string' || presented.length === 0) return null;
      const hash = hashToken(presented);
      const row = await db.get(
        'SELECT id, name, enabled, owner_id FROM worker_tokens WHERE token_hash = {hash}',
        { hash }
      );
      if (!row || row.enabled !== 1) return null;

      await db.run(
        'UPDATE worker_tokens SET last_seen_at = {now}, last_ip = {ip} WHERE id = {id}',
        { id: row.id, now: Date.now(), ip }
      );
      return { id: row.id, name: row.name, owner_id: row.owner_id };
    },

    // Upsert syntax is not portable, so read and write share a transaction.
    async recordAgent({ tokenId, name, arches = [], features = [], ip = null }) {
      const label = typeof name === 'string' ? name.trim().slice(0, 255) : '';
      if (!tokenId || !label) return;

      const now = Date.now();
      const values = { arches: JSON.stringify(arches), features: JSON.stringify(features) };

      await db.transaction(async (tx) => {
        const row = await tx.get(
          'SELECT id FROM worker_agents WHERE token_id = {token} AND name = {name}',
          { token: tokenId, name: label }
        );
        if (row) {
          await tx.run(
            `UPDATE worker_agents
                SET arches = {arches}, features = {features}, last_seen_at = {now}, last_ip = {ip}
              WHERE id = {id}`,
            { id: row.id, ...values, now, ip }
          );
          return;
        }
        await tx.run(
          `INSERT INTO worker_agents
             (id, token_id, name, arches, features, first_seen_at, last_seen_at, last_ip)
           VALUES ({id}, {token}, {name}, {arches}, {features}, {now}, {now}, {ip})`,
          { id: newWorkerAgentId(), token: tokenId, name: label, ...values, now, ip }
        );
      });
    },

    async agentsFor(tokenId) {
      const rows = await db.all(
        `SELECT id, name, arches, features, first_seen_at, last_seen_at, last_ip
           FROM worker_agents WHERE token_id = {token} ORDER BY last_seen_at DESC`,
        { token: tokenId }
      );
      return rows.map((row) => ({
        ...row,
        arches: parseList(row.arches),
        features: parseList(row.features),
      }));
    },

    async list() {
      return db.all(
        `SELECT id, name, enabled, owner_id, created_at, last_seen_at, last_ip
           FROM worker_tokens ORDER BY created_at DESC`
      );
    },

    async listVisible(user) {
      if (user && user.role === 'admin') return this.list();
      if (!user) return [];
      return db.all(
        `SELECT id, name, enabled, owner_id, created_at, last_seen_at, last_ip
           FROM worker_tokens WHERE owner_id = {owner} ORDER BY created_at DESC`,
        { owner: user.id }
      );
    },

    // One page of listVisible. An anonymous caller sees nothing, so the
    // window is empty rather than a query nobody needs.
    async pageVisible(user, { offset, limit }) {
      if (!user) return { rows: [], total: 0, offset, limit };
      const admin = user.role === 'admin';
      return paginateOffset(db, {
        select: 'id, name, enabled, owner_id, created_at, last_seen_at, last_ip',
        from: 'worker_tokens',
        where: admin ? '1 = 1' : 'owner_id = {owner}',
        order: 'created_at DESC',
        params: admin ? {} : { owner: user.id },
        offset,
        limit,
      });
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

export function canManageWorker(user, token) {
  if (!user || !token) return false;
  if (user.role === 'admin') return true;
  return token.owner_id !== null && token.owner_id === user.id;
}
