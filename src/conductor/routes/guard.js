// src/conductor/routes/guard.js - who is asking, and what they may see

import { NotAuthenticated, NotPermitted } from '../../lib/errors.js';

// Anonymous is not an error: public projects read without signing in.
export function identifies(fastify, auth) {
  fastify.addHook('preHandler', async (req) => {
    req.user = auth ? await auth.identify(req) : null;
  });
}

export function requireUser(req) {
  if (!req.user) throw new NotAuthenticated();
  return req.user;
}

export function requireAdmin(req) {
  const user = requireUser(req);
  if (user.role !== 'admin') throw new NotPermitted();
  return user;
}

// In SQL rather than in javascript, so a count and its rows cannot disagree.
export function visible(user, { project = 'p', job = null } = {}) {
  const column = job ? `${job}.visibility` : `${project}.visibility`;
  if (user?.role === 'admin') return { sql: '1 = 1', params: {} };
  if (user) {
    return {
      sql: `(${column} = 'public' OR ${project}.owner_id = {viewerId})`,
      params: { viewerId: user.id },
    };
  }
  return { sql: `${column} = 'public'`, params: {} };
}
