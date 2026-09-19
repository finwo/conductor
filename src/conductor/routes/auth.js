// src/conductor/routes/auth.js - logging in and out
//
// Only meaningful for built-in accounts. When OIDC is in use the provider
// issues the token and these endpoints report that, rather than pretending
// to accept a password.

import { issueToken, sessionCookie, clearedCookie } from '../../lib/auth/index.js';

export default async function authRoutes(fastify, { cfg, auth, users }) {
  const secure = cfg.server.public_url.startsWith('https://');

  fastify.get('/mode', async (req, reply) => reply.send({
    mode: auth.mode,
    local_login: auth.localLogin,
    issuer: cfg.auth.oidc.issuer ?? null,
  }));

  fastify.post('/login', async (req, reply) => {
    if (!auth.localLogin) {
      return reply.code(400).send({
        error: 'this conductor authenticates through OIDC; obtain a token from the provider',
        issuer: cfg.auth.oidc.issuer,
      });
    }

    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return reply.code(400).send({ error: 'username and password are required' });
    }

    const user = await users.authenticate(username, password);
    // Deliberately the same answer for an unknown user and a wrong password.
    if (!user) return reply.code(401).send({ error: 'invalid username or password' });

    const ttl = cfg.auth.session_ttl;
    const token = issueToken(cfg.auth.session_secret, {
      sub: user.id,
      name: user.username,
      role: user.role,
    }, { ttl });

    reply.header('set-cookie', sessionCookie(token, { ttl, secure }));
    return reply.send({
      token,
      expires_in: ttl,
      user: { id: user.id, username: user.username, role: user.role },
    });
  });

  fastify.post('/logout', async (req, reply) => {
    // Tokens are stateless, so this clears the cookie and nothing more. A
    // token already in hand stays valid until it expires.
    reply.header('set-cookie', clearedCookie());
    return reply.send({ ok: true });
  });

  fastify.get('/me', async (req, reply) => {
    const user = await auth.identify(req);
    if (!user) return reply.code(401).send({ error: 'not authenticated' });
    return reply.send({ user });
  });
}
