// src/lib/auth/index.js - request authentication
//
// OIDC is used when auth.oidc.issuer is configured, built-in accounts
// otherwise. Local logins remain available alongside OIDC only when
// auth.allow_local_login is explicitly enabled, so that turning on OIDC does
// not silently leave a second way in.
//
// A credential arrives either as a bearer token or as the session cookie
// set at login, so the dashboard and scripts can use the same endpoints.

import { verifyToken, parseCookies, SESSION_COOKIE } from './token.js';
import { createOidc } from './oidc.js';

export { issueToken, verifyToken, sessionCookie, clearedCookie, SESSION_COOKIE } from './token.js';
export { hashPassword, verifyPassword, generatePassword, validatePassword } from './password.js';

export function createAuth({ cfg, users, logger = console }) {
  const oidc = cfg.auth.mode === 'oidc' ? createOidc(cfg) : null;
  const localLogin = cfg.auth.mode !== 'oidc' || cfg.auth.allow_local_login === true;

  function credentialFrom(req) {
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice(7).trim();
    }
    const cookies = parseCookies(req.headers.cookie);
    return cookies[SESSION_COOKIE] ?? null;
  }

  return {
    mode: cfg.auth.mode,
    localLogin,

    // Resolves a request to a user, or null. Never throws: an unparseable
    // credential is simply not authenticated.
    async identify(req) {
      const credential = credentialFrom(req);
      if (!credential) return null;

      if (oidc) {
        try {
          return await oidc.verify(credential);
        } catch (e) {
          logger.debug?.(`oidc verification failed: ${e.message}`);
          // Fall through only when local logins are also permitted.
          if (!localLogin) return null;
        }
      }

      if (!localLogin) return null;

      const claims = verifyToken(cfg.auth.session_secret, credential);
      if (!claims) return null;

      // Re-read the account, so disabling a user takes effect immediately
      // rather than when their token happens to expire.
      const user = await users.get(claims.sub);
      if (!user || user.disabled === 1) return null;

      return { id: user.id, username: user.username, role: user.role, source: 'local' };
    },
  };
}

// Fastify preHandler factories. Kept here so every route guards the same way.
export function requireUser(auth) {
  return async function guard(req, reply) {
    const user = await auth.identify(req);
    if (!user) {
      reply.code(401).send({ error: 'authentication required' });
      return;
    }
    req.user = user;
  };
}

export function requireAdmin(auth) {
  return async function guard(req, reply) {
    const user = await auth.identify(req);
    if (!user) {
      reply.code(401).send({ error: 'authentication required' });
      return;
    }
    if (user.role !== 'admin') {
      reply.code(403).send({ error: 'administrator role required' });
      return;
    }
    req.user = user;
  };
}
