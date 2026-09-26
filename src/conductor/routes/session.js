// src/conductor/routes/session.js - who am I, and where am I signed in

import { ok } from './envelope.js';
import { identifies, requireUser } from './guard.js';
import { NotFound } from '../../lib/errors.js';
import { limitOf, offsetOfQuery, pageBlock } from '../../lib/page.js';

export default async function sessionRoutes(fastify, { cfg, auth, refreshTokens }) {
  const base = cfg.server.public_url.replace(/\/+$/, '');
  identifies(fastify, auth);

  fastify.get('/sessions', async (req, reply) => {
    const user = requireUser(req);
    const window = await refreshTokens.page({
      userId: user.role === 'admin' ? null : user.id,
      offset: offsetOfQuery(req.query),
      limit: limitOf(req.query),
    });

    return ok(reply, window.rows, pageBlock({ ...window, url: base + req.url }));
  });

  fastify.delete('/sessions/:id', async (req, reply) => {
    const user = requireUser(req);
    const row = await refreshTokens.get(req.params.id);
    if (!row || (user.role !== 'admin' && row.user_id !== user.id)) throw new NotFound();

    await refreshTokens.revoke(row.id);
    return ok(reply, { id: row.id, revoked: true });
  });
}
