// src/lib/auth/oidc.js - OIDC bearer verification
//
// Engaged when auth.oidc.issuer is configured. Tokens are issued by the
// provider, so jose does the work here: fetching and caching the JWKS,
// checking the signature, issuer, audience and expiry.
//
// The key set is located by discovery rather than by assuming a path.
// Keycloak serves it from /protocol/openid-connect/certs, but that is a
// Keycloak detail and nothing else follows it; guessing it works with one
// provider and silently fails with every other. auth.oidc.jwks_uri is
// available for a provider that publishes no discovery document.
//
// Role mapping deliberately looks in several places. Keycloak puts realm
// roles under realm_access.roles, other providers use a flat roles claim or
// groups, and there is no standard.

const ADMIN = 'admin';
const VIEWER = 'viewer';
const DISCOVERY_TIMEOUT = 10000;

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

// Reads the provider's metadata to find the key set.
export async function discoverJwksUri(issuer, { fetchImpl = fetch } = {}) {
  const base = issuer.replace(/\/+$/, '');
  const url = `${base}/.well-known/openid-configuration`;

  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT) });
  } catch (e) {
    throw new Error(`could not reach the OIDC discovery document at ${url}: ${e.message}`, { cause: e });
  }
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: ${url} returned ${res.status} ${res.statusText}`);
  }

  const document = await res.json();

  // A document claiming a different issuer than the one configured means
  // the provider is misconfigured, or the URL is not what it claims to be.
  if (document.issuer !== base && document.issuer !== `${base}/`) {
    throw new Error(
      `OIDC discovery mismatch: ${url} declares issuer ${JSON.stringify(document.issuer)}, ` +
      `but auth.oidc.issuer is ${JSON.stringify(issuer)}`
    );
  }
  if (typeof document.jwks_uri !== 'string' || document.jwks_uri.length === 0) {
    throw new Error(`OIDC discovery at ${url} did not advertise a jwks_uri`);
  }

  return document.jwks_uri;
}

export function createOidc(cfg) {
  const { issuer, audience, admin_role: adminRole, jwks_uri: configuredJwks } = cfg.auth.oidc;

  let jwks = null;
  let jwtVerify = null;
  let loading = null;

  async function load() {
    if (jwks) return;
    // Concurrent requests during startup should discover once, not once
    // each, and a failure must not be cached.
    if (!loading) {
      loading = (async () => {
        let jose;
        try {
          jose = await import('jose');
        } catch (e) {
          throw new Error('auth.oidc.issuer is set but the jose package is not installed', { cause: e });
        }
        const uri = configuredJwks || await discoverJwksUri(issuer);
        jwtVerify = jose.jwtVerify;
        jwks = jose.createRemoteJWKSet(new URL(uri));
        return uri;
      })().finally(() => { loading = null; });
    }
    return loading;
  }

  return {
    mode: 'oidc',
    issuer,

    // Exposed so a health check can report what was discovered.
    async jwksUri() {
      await load();
      return configuredJwks || discoverJwksUri(issuer);
    },

    async verify(token) {
      await load();
      const options = { issuer };
      if (audience) options.audience = audience;

      const { payload } = await jwtVerify(token, jwks, options);
      const roles = collectRoles(payload);

      return {
        subject: payload.sub,
        username: payload.preferred_username ?? payload.email ?? payload.sub,
        role: roles.includes(adminRole) ? ADMIN : VIEWER,
        source: 'oidc',
        roles,
      };
    },
  };
}
