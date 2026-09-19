// src/lib/auth/oidc.js - OIDC bearer verification
//
// Engaged when auth.oidc.issuer is configured. Tokens are issued by the
// provider, so jose does the work here: fetching and caching the JWKS,
// checking the signature, issuer, audience and expiry.
//
// Role mapping deliberately looks in several places. Keycloak puts realm
// roles under realm_access.roles, other providers use a flat roles claim or
// groups, and there is no standard.

const ADMIN = 'admin';
const VIEWER = 'viewer';

export function collectRoles(claims) {
  const roles = new Set();
  const add = (value) => {
    if (typeof value === 'string') roles.add(value);
    else if (Array.isArray(value)) for (const item of value) if (typeof item === 'string') roles.add(item);
  };

  add(claims.roles);
  add(claims.groups);
  add(claims.realm_access?.roles);
  for (const resource of Object.values(claims.resource_access ?? {})) add(resource?.roles);

  return [...roles];
}

export function createOidc(cfg) {
  const { issuer, audience, admin_role: adminRole } = cfg.auth.oidc;
  let jwks = null;
  let jwtVerify = null;

  async function load() {
    if (jwks) return;
    let jose;
    try {
      jose = await import('jose');
    } catch (e) {
      throw new Error('auth.oidc.issuer is set but the jose package is not installed', { cause: e });
    }
    jwtVerify = jose.jwtVerify;
    // jose caches the key set and refetches on rotation.
    jwks = jose.createRemoteJWKSet(new URL(`${issuer.replace(/\/+$/, '')}/protocol/openid-connect/certs`));
  }

  return {
    mode: 'oidc',
    issuer,

    // Allows a deployment to point at a provider whose JWKS is not at the
    // Keycloak path.
    setJwksUri(uri) {
      jwks = null;
      this.jwksUri = uri;
    },

    async verify(token) {
      await load();
      const options = { issuer };
      if (audience) options.audience = audience;

      const { payload } = await jwtVerify(token, jwks, options);
      const roles = collectRoles(payload);

      return {
        id: payload.sub,
        username: payload.preferred_username ?? payload.email ?? payload.sub,
        role: roles.includes(adminRole) ? ADMIN : VIEWER,
        source: 'oidc',
        roles,
      };
    },
  };
}
