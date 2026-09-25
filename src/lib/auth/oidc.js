// src/lib/auth/oidc.js - discovery and access token verification
//
// The app runs the code flow against the provider itself. All that happens
// here is verifying the tokens it comes back with.

const ADMIN = 'admin';
const USER_ROLE = 'user';
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

// Fetches and validates the provider's configuration document. The document
// is the single source of truth for the issuer and every endpoint.
export async function fetchDiscovery(url, { fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT) });
  } catch (e) {
    throw new Error(`could not reach the OIDC discovery document at ${url}: ${e.message}`, { cause: e });
  }
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: ${url} returned ${res.status} ${res.statusText}`);
  }

  let document;
  try {
    document = await res.json();
  } catch {
    throw new Error(`OIDC discovery at ${url} did not return JSON`);
  }

  for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (typeof document?.[field] !== 'string' || document[field].length === 0) {
      throw new Error(`OIDC discovery at ${url} did not advertise ${field}`);
    }
  }

  return document;
}

export function createOidc(cfg) {
  const {
    discovery_url: discoveryUrl,
    client_id: clientId,
    scopes,
    admin_role: adminRole,
  } = cfg.auth.oidc;

  let metadata = null;
  let jwks = null;
  let jwtVerify = null;
  let loading = null;

  async function load() {
    if (metadata) return metadata;
    // Concurrent requests during startup should discover once, not once
    // each, and a failure must not be cached.
    if (!loading) {
      loading = (async () => {
        let jose;
        try {
          jose = await import('jose');
        } catch (e) {
          throw new Error('auth.oidc.discovery_url is set but the jose package is not installed', { cause: e });
        }
        const document = await fetchDiscovery(discoveryUrl);
        jwtVerify = jose.jwtVerify;
        jwks = jose.createRemoteJWKSet(new URL(document.jwks_uri));
        metadata = document;
        return metadata;
      })().finally(() => { loading = null; });
    }
    return loading;
  }

  function profileFrom(claims, issuer) {
    const roles = collectRoles(claims);
    return {
      issuer,
      subject: claims.sub,
      username: claims.preferred_username ?? claims.email ?? claims.sub,
      role: roles.includes(adminRole) ? ADMIN : USER_ROLE,
      roles,
    };
  }

  return {
    mode: 'oidc',

    // The configuration document, fetched once.
    async metadata() {
      return load();
    },

    clientId,
    scopes,

    // An access token names the client in azp; aud is the resource server,
    // which for Keycloak is "account" rather than us.
    async verify(token) {
      const document = await load();
      const { payload } = await jwtVerify(token, jwks, { issuer: document.issuer });

      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (payload.azp !== clientId && !aud.includes(clientId)) {
        throw new Error(`token was issued to ${payload.azp ?? aud.join(', ')}, not ${clientId}`);
      }

      return profileFrom(payload, document.issuer);
    },
  };
}
