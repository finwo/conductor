// src/lib/auth/oidc.js - discovery and access token verification
//
// The app runs the code flow against the provider itself. All that happens
// here is verifying the tokens it comes back with.

const ADMIN = 'admin';
const USER_ROLE = 'user';
const DISCOVERY_TIMEOUT = 10000;

function isCompactJws(token) {
  return typeof token === 'string' && token.split('.').length === 3;
}

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

export function createOidc(cfg, options = {}) {
  const fetchImpl = options.fetchImpl ?? cfg?.fetchImpl ?? fetch;
  const {
    discovery_url: discoveryUrl,
    client_id: clientId,
    client_secret: clientSecret,
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
        const document = await fetchDiscovery(discoveryUrl, { fetchImpl });
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

  function checkAudience(claims) {
    const azp = claims.azp ?? claims.client_id;
    const audRaw = claims.aud;
    const aud = audRaw == null ? [] : Array.isArray(audRaw) ? audRaw : [audRaw];
    if (azp === undefined && aud.length === 0) return;
    if (azp !== clientId && !aud.includes(clientId)) {
      throw new Error(`token was issued to ${azp ?? aud.join(', ')}, not ${clientId}`);
    }
  }

  async function verifyJwt(token, document) {
    const { payload } = await jwtVerify(token, jwks, { issuer: document.issuer });
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.azp !== clientId && !aud.includes(clientId)) {
      throw new Error(`token was issued to ${payload.azp ?? aud.join(', ')}, not ${clientId}`);
    }
    return profileFrom(payload, document.issuer);
  }

  async function introspect(token, endpoint, issuer) {
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    const body = new URLSearchParams();
    body.set('token', token);
    body.set('client_id', clientId);
    if (clientSecret) body.set('client_secret', clientSecret);
    if (clientSecret) {
      headers.authorization = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    }

    let res;
    try {
      res = await fetchImpl(endpoint, { method: 'POST', headers, body });
    } catch (e) {
      throw new Error(`could not reach the OIDC introspection endpoint at ${endpoint}: ${e.message}`, { cause: e });
    }

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }

    if (!res.ok) {
      if (!clientSecret && /invalid_client/i.test(text)) {
        return null;
      }
      throw new Error(`OIDC introspection failed: ${endpoint} returned ${res.status} ${res.statusText}`);
    }

    if (!data || data.active !== true) {
      if (data && data.active === false) throw new Error('token is not active');
      throw new Error('OIDC introspection did not confirm the token is active');
    }

    return data;
  }

  async function fetchUserinfo(token, endpoint) {
    let res;
    try {
      res = await fetchImpl(endpoint, {
        headers: { authorization: `Bearer ${token}` },
      });
    } catch (e) {
      throw new Error(`could not reach the OIDC userinfo endpoint at ${endpoint}: ${e.message}`, { cause: e });
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error('token is not active');
      throw new Error(`OIDC userinfo failed: ${endpoint} returned ${res.status} ${res.statusText}`);
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`OIDC userinfo at ${endpoint} did not return JSON`);
    }

    if (!data || typeof data.sub !== 'string' || data.sub.length === 0) {
      throw new Error('OIDC userinfo did not include a subject');
    }

    return data;
  }

  return {
    mode: 'oidc',

    // The configuration document, fetched once.
    async metadata() {
      return load();
    },

    clientId,
    scopes,

    async verify(token) {
      const document = await load();
      const introspectionEndpoint = typeof document.introspection_endpoint === 'string' && document.introspection_endpoint.length > 0
        ? document.introspection_endpoint
        : null;
      const userinfoEndpoint = typeof document.userinfo_endpoint === 'string' && document.userinfo_endpoint.length > 0
        ? document.userinfo_endpoint
        : null;

      let introspectionData = null;
      let introspectionFailed = false;

      if (introspectionEndpoint) {
        try {
          introspectionData = await introspect(token, introspectionEndpoint);
        } catch (e) {
          if (e.message === 'token is not active' || /did not confirm/i.test(e.message)) throw e;
          introspectionFailed = true;
        }
      }

      let userinfoData = null;
      if (userinfoEndpoint) {
        try {
          userinfoData = await fetchUserinfo(token, userinfoEndpoint);
        } catch (e) {
          if (introspectionData) throw e;
          if (introspectionEndpoint && !introspectionFailed && introspectionData === null && isCompactJws(token) && jwtVerify && jwks) {
            return verifyJwt(token, document);
          }
          throw e;
        }
      }

      const merged = { ...(introspectionData || {}), ...(userinfoData || {}) };

      if (merged.sub) {
        checkAudience(merged);
        return profileFrom(merged, document.issuer);
      }

      if (isCompactJws(token) && jwtVerify && jwks) {
        return verifyJwt(token, document);
      }

      if (introspectionData === null && userinfoData === null && !introspectionFailed) {
        throw new Error('OIDC provider did not verify the token');
      }
      throw new Error('OIDC response did not include a subject');
    },
  };
}
