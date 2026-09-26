// src/lib/auth/index.js - request authentication
//
// One provider at a time: the external one when auth.oidc.discovery_url is
// configured, the built-in one otherwise. Access tokens arrive as bearer
// credentials and nothing is stored between requests.

import { signToken, verifyToken } from './token.js';
import { createOidc } from './oidc.js';

export { signToken, verifyToken } from './token.js';
export { hashPassword, verifyPassword, generatePassword, validatePassword } from './password.js';

// The built-in provider has no registration step, so the app is named here.
export const LOCAL_CLIENT_ID = 'conductor';

export function createAuth({ cfg, users, logger = console }) {
  const oidc = cfg.auth.mode === 'oidc' ? createOidc(cfg) : null;
  const localLogin = !oidc;
  const issuer = cfg.server.public_url.replace(/\/+$/, '');
  const clientId = oidc ? cfg.auth.oidc.client_id : LOCAL_CLIENT_ID;

  // A worker token is 64 hex characters and never parses as a JWT, so the
  // two meanings of this header cannot be confused.
  function bearerFrom(req) {
    const header = req.headers.authorization || '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  }

  async function verifyAccessToken(token) {
    if (oidc) {
      const profile = await oidc.verify(token);

      // The provider vouched for them, but they still need a local row to
      // own anything, since projects and worker tokens reference users(id).
      const account = await users.upsertExternal({
        externalId: `${profile.issuer}|${profile.subject}`,
        username: profile.username,
        role: profile.role,
      });
      if (account.disabled === 1) return null;
      return { id: account.id, username: account.username, role: account.role, source: 'oidc' };
    }

    const claims = verifyToken(cfg.auth.session_secret, token, {
      use: 'access',
      iss: issuer,
      aud: clientId,
    });
    if (!claims) return null;

    // Re-read the account, so disabling a user takes effect immediately
    // rather than when their token happens to expire.
    const user = await users.get(claims.sub);
    if (!user || user.disabled === 1) return null;

    return { id: user.id, username: user.username, role: user.role, source: 'local' };
  }

  return {
    mode: cfg.auth.mode,
    localLogin,
    oidc,
    issuer,
    clientId,

    accessToken(user, { now = Date.now() } = {}) {
      return signToken(cfg.auth.session_secret, {
        use: 'access',
        iss: issuer,
        aud: clientId,
        sub: user.id,
        name: user.username,
        role: user.role,
        ttl: cfg.auth.access_ttl,
        now,
      });
    },

    verifyAccessToken,

    // Resolves a request to a user, or null. Never throws: an unparseable
    // credential is simply not authenticated.
    async identify(req) {
      const token = bearerFrom(req);
      if (!token) return null;
      try {
        return await verifyAccessToken(token);
      } catch (e) {
        logger.debug?.(`access token rejected: ${e.message}`);
        return null;
      }
    },
  };
}
