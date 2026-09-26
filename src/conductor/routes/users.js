// src/conductor/routes/users.js - accounts

import { ok } from './envelope.js';
import { identifies, requireUser, requireAdmin } from './guard.js';
import { BadRequest, Conflict, NotFound, NotPermitted } from '../../lib/errors.js';
import { validatePassword } from '../../lib/auth/password.js';
import { ROLES } from '../../lib/users.js';
import { limitOf, offsetOfQuery, pageBlock } from '../../lib/page.js';

const present = (user) => ({ ...user, source: user.external_id ? 'oidc' : 'local' });

export default async function userRoutes(fastify, { cfg, auth, users, refreshTokens }) {
  const base = cfg.server.public_url.replace(/\/+$/, '');
  identifies(fastify, auth);

  // "me" is an ordinary id that happens to resolve to the caller.
  function idIn(req, caller) {
    return req.params.id === 'me' ? caller.id : req.params.id;
  }

  async function reachable(req) {
    const caller = requireUser(req);
    const id = idIn(req, caller);
    if (caller.role !== 'admin' && id !== caller.id) throw new NotFound();

    const user = await users.get(id);
    if (!user) throw new NotFound();
    return { caller, user };
  }

  fastify.get('/users', async (req, reply) => {
    const caller = requireUser(req);
    if (caller.role !== 'admin') {
      return ok(reply, [present(await users.get(caller.id))], { offset: 0, total: 1 });
    }

    const window = await users.pageWithHoldings({
      offset: offsetOfQuery(req.query),
      limit: limitOf(req.query),
    });
    return ok(reply, window.rows.map(present), pageBlock({ ...window, url: base + req.url }));
  });

  fastify.post('/users', async (req, reply) => {
    requireAdmin(req);
    if (!auth.localLogin) throw new NotPermitted('accounts come from the identity provider');

    const { username, password, role } = req.body ?? {};
    const bad = validatePassword(String(password ?? ''));
    if (bad) throw new BadRequest(bad);
    if (role !== undefined && !ROLES.includes(role)) {
      throw new BadRequest(`role must be one of ${ROLES.join(', ')}`);
    }

    try {
      return reply.code(201).send({ ok: true, data: await users.create({ username, password, role }) });
    } catch (e) {
      throw /already (exists|taken)|UNIQUE/i.test(e.message) ? new Conflict(e.message) : new BadRequest(e.message);
    }
  });

  fastify.get('/users/:id', async (req, reply) => ok(reply, present((await reachable(req)).user)));

  fastify.patch('/users/:id', async (req, reply) => {
    const { caller, user } = await reachable(req);
    const body = req.body ?? {};

    // Not on themselves, so the last way in cannot be locked by accident.
    for (const key of ['role', 'disabled']) {
      if (!Object.hasOwn(body, key)) continue;
      requireAdmin(req);
      if (user.id === caller.id) throw new NotPermitted(`you cannot change your own ${key}`);
    }

    if (Object.hasOwn(body, 'role')) {
      if (!ROLES.includes(body.role)) throw new BadRequest(`role must be one of ${ROLES.join(', ')}`);
      await users.setRole(user.id, body.role);
    }

    if (Object.hasOwn(body, 'disabled')) {
      await users.setDisabled(user.id, Boolean(body.disabled));
      // A disabled account keeps working until its sessions are gone.
      if (body.disabled) await refreshTokens.revokeAllFor(user.id);
    }

    if (Object.hasOwn(body, 'password')) {
      const bad = validatePassword(String(body.password ?? ''));
      if (bad) throw new BadRequest(bad);
      await users.setPassword(user.id, body.password);
      await refreshTokens.revokeAllFor(user.id);
    }

    return ok(reply, present(await users.get(user.id)));
  });

  fastify.delete('/users/:id', async (req, reply) => {
    const caller = requireAdmin(req);
    const id = idIn(req, caller);
    if (id === caller.id) throw new NotPermitted('you cannot remove your own account');

    const user = await users.get(id);
    if (!user) throw new NotFound();

    await refreshTokens.revokeAllFor(user.id);
    await users.remove(user.id);
    return ok(reply, { id: user.id, removed: true });
  });
}
