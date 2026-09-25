// src/lib/auth/refresh.js - refresh tokens the built-in provider issued

import { hashToken } from '../ids.js';
import { paginateOffset } from '../page.js';

// user_agent and ip are shown to tell sessions apart. Never validated.
const COLUMNS = 'id, user_id, issued_at, expires_at, last_used_at, revoked_at, user_agent, ip';

export function createRefreshTokens({ db }) {
  return {
    async issue({ id, userId, token, expiresAt, userAgent = null, ip = null, now = Date.now() }) {
      await db.run(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, issued_at, expires_at, user_agent, ip)
         VALUES ({id}, {user}, {hash}, {now}, {expires}, {agent}, {ip})`,
        { id, user: userId, hash: hashToken(token), now, expires: expiresAt, agent: userAgent, ip }
      );
      return { id, user_id: userId, issued_at: now, expires_at: expiresAt, user_agent: userAgent, ip };
    },

    async claim(token, { now = Date.now() } = {}) {
      if (typeof token !== 'string' || token.length === 0) return null;
      const row = await db.get(
        `SELECT ${COLUMNS} FROM refresh_tokens WHERE token_hash = {hash}`,
        { hash: hashToken(token) }
      );
      if (!row || row.revoked_at !== null || row.expires_at <= now) return null;
      return row;
    },

    // Records the use. Leaving expiresAt out keeps the original deadline,
    // which is what a non-sliding session wants.
    async touch({ id, expiresAt = null, userAgent = null, ip = null, now = Date.now() }) {
      const moved = expiresAt === null ? '' : ', expires_at = {expires}';
      const res = await db.run(
        `UPDATE refresh_tokens SET last_used_at = {now}, user_agent = {agent}, ip = {ip}${moved}
          WHERE id = {id} AND revoked_at IS NULL`,
        { id, now, agent: userAgent, ip, expires: expiresAt }
      );
      return res.changes > 0;
    },

    async revoke(id, { now = Date.now() } = {}) {
      const res = await db.run(
        'UPDATE refresh_tokens SET revoked_at = {now} WHERE id = {id} AND revoked_at IS NULL',
        { id, now }
      );
      return res.changes > 0;
    },

    async revokeAllFor(userId, { now = Date.now() } = {}) {
      const res = await db.run(
        'UPDATE refresh_tokens SET revoked_at = {now} WHERE user_id = {user} AND revoked_at IS NULL',
        { user: userId, now }
      );
      return res.changes;
    },

    async get(id) {
      return db.get(`SELECT ${COLUMNS} FROM refresh_tokens WHERE id = {id}`, { id });
    },

    // Live sessions only.
    async page({ userId = null, offset, limit, now = Date.now() }) {
      const scoped = userId ? 'user_id = {user} AND ' : '';
      return paginateOffset(db, {
        select: COLUMNS,
        from: 'refresh_tokens',
        where: `${scoped}revoked_at IS NULL AND expires_at > {now}`,
        order: 'issued_at DESC',
        params: userId ? { user: userId, now } : { now },
        offset,
        limit,
      });
    },

    async sweep(cutoff) {
      const res = await db.run('DELETE FROM refresh_tokens WHERE expires_at < {cutoff}', { cutoff });
      return res.changes;
    },
  };
}
