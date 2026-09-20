// src/lib/auth/oidc.js - OIDC discovery, browser login and token verification
//
// Engaged when auth.oidc.discovery_url is configured. The provider's OpenID
// configuration document owns every detail of the provider: its issuer, the
// authorization and token endpoints, the key set and the end session
// endpoint. A Keycloak realm serves them under /protocol/openid-connect/...,
// but that is a Keycloak detail and nothing else follows it; guessing it
// works with one provider and silently fails with every other.
//
// The browser signs in through the authorization code flow and the session
// cookie is the id_token the provider issued. Every request re-verifies it
// against the discovered issuer and key set, so nothing is re-signed here.
//
// Role mapping deliberately looks in several places. Keycloak puts realm
// roles under realm_access.roles, other providers use a flat roles claim or
// groups, and there is no standard.

const ADMIN = 'admin';
const USER_ROLE = 'user';
const DISCOVERY_TIMEOUT = 10000;
const TOKEN_TIMEOUT = 10000;

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

    // Verifies the provider's token: signature, issuer and, for the
    // id_token the browser presents, the client it was issued to.
    async verify(token) {
      const document = await load();
      const { payload } = await jwtVerify(token, jwks, {
        issuer: document.issuer,
        audience: clientId,
      });
      return profileFrom(payload, document.issuer);
    },

    // Where to send the browser to sign in.
    async authorizationUrl({ redirectUri, state }) {
      const document = await load();
      const url = new URL(document.authorization_endpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', scopes);
      url.searchParams.set('state', state);
      return url.toString();
    },

    // Redeems the authorization code at the discovered token endpoint. A
    // confidential client authenticates with HTTP Basic.
    async exchangeCode({ code, redirectUri }) {
      const document = await load();
      const headers = { 'content-type': 'application/x-www-form-urlencoded' };
      if (clientSecret) {
        headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      }

      let res;
      try {
        res = await fetch(document.token_endpoint, {
          method: 'POST',
          headers,
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
          }),
          signal: AbortSignal.timeout(TOKEN_TIMEOUT),
        });
      } catch (e) {
        throw new Error(
          `could not reach the OIDC token endpoint at ${document.token_endpoint}: ${e.message}`,
          { cause: e }
        );
      }

      const text = await res.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        // Reported below, together with the status.
      }

      if (!res.ok) {
        const detail = payload?.error_description ?? payload?.error ?? text;
        throw new Error(
          `OIDC token exchange failed: ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`
        );
      }
      if (payload === null || typeof payload !== 'object') {
        throw new Error('OIDC token endpoint did not return JSON');
      }
      return payload;
    },

    // Where to send the browser to end the provider session, or null when
    // the provider does not advertise one.
    async endSessionUrl({ postLogoutRedirectUri } = {}) {
      const document = await load();
      if (typeof document.end_session_endpoint !== 'string' || document.end_session_endpoint.length === 0) {
        return null;
      }
      const url = new URL(document.end_session_endpoint);
      url.searchParams.set('client_id', clientId);
      if (postLogoutRedirectUri) url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
      return url.toString();
    },
  };
}
