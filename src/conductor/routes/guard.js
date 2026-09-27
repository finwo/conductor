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
