// src/lib/auth/token.js - access tokens and authorization codes
//
// Compact HS256 tokens in the JWT shape, signed with node:crypto rather than
// a library. The jose dependency exists for the external provider, where the
// verification rules genuinely are complicated.
//
// Both kinds are signed with the same secret and are otherwise the same
// shape, so _tu separates them and is checked on every path. Without it an
// authorization code would pass wherever an access token is expected.

import crypto from 'node:crypto';

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

function sign(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function signToken(secret, { use, iss, aud, sub, ttl, now = Date.now(), ...rest }) {
  const issued = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({
    ...rest,
    iss,
    aud,
    sub,
    _tu: use,
    iat: issued,
    exp: issued + ttl,
  })).toString('base64url');

  const body = `${HEADER}.${payload}`;
  return `${body}.${sign(secret, body)}`;
}

// Returns the claims, or null. Never throws, so a malformed token from a
// browser is an ordinary 401 rather than a 500.
export function verifyToken(secret, token, { use, iss, aud, now = Date.now() }) {
  if (typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  const expected = sign(secret, `${header}.${payload}`);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof claims !== 'object' || claims === null) return null;
  if (claims._tu !== use) return null;
  if (claims.iss !== iss || claims.aud !== aud) return null;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;

  return claims;
}
