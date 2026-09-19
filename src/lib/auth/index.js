// src/lib/auth/index.js - request authentication
//
// OIDC is used when auth.oidc.discovery_url is configured, built-in accounts
// otherwise. The two do not mix: with OIDC the provider owns identity and
// local accounts cannot sign in at all.

import { verifyToken, parseCookies, SESSION_COOKIE } from './token.js';
import { createOidc } from './oidc.js';

export { issueToken, verifyToken, sessionCookie, clearedCookie, SESSION_COOKIE } from './token.js';
export { hashPassword, verifyPassword, generatePassword, validatePassword } from './password.js';

export function createAuth({ cfg, users, logger = console }) {
  const oidc = cfg.auth.mode === 'oidc' ? createOidc(cfg) : null;
  const localLogin = cfg.auth.mode !== 'oidc';

  // The session cookie is the only credential the conductor itself accepts.
  // Workers and triggers authenticate on their own routes.
  function credentialFrom(req) {
    const cookies = parseCookies(req.headers.cookie);
    return cookies[SESSION_COOKIE] ?? null;
  }

  return {
    mode: cfg.auth.mode,
    localLogin,
    // The provider client, or null for built-in accounts. The interface
    // uses it to start the browser login and to end the provider session.
    oidc,

    // Resolves a request to a user, or null. Never throws: an unparseable
    // credential is simply not authenticated.
    async identify(req) {
      const credential = credentialFrom(req);
      if (!credential) return null;

      if (oidc) {
        try {
          const profile = await oidc.verify(credential);

          // The provider vouched for them, but they still need a local row
          // to own anything, since projects and worker tokens reference
          // users(id). Created on first sight, refreshed after that.
          const account = await users.upsertExternal({
            externalId: `${profile.issuer}|${profile.subject}`,
            username: profile.username,
            role: profile.role,
          });

          // An administrator can still lock out an account the provider
          // would happily keep admitting.
          if (account.disabled === 1) return null;

          return { id: account.id, username: account.username, role: account.role, source: 'oidc' };
        } catch (e) {
          logger.debug?.(`oidc verification failed: ${e.message}`);
          return null;
        }
      }

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
