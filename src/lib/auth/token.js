// src/lib/auth/token.js - session tokens
//
// Compact HS256 tokens in the JWT shape, so they can be inspected with any
// ordinary tool, signed with node:crypto rather than a library. The jose
// dependency exists for OIDC, where the token is issued elsewhere and the
// verification rules genuinely are complicated. Signing our own does not
// need it.
//
// A token carries only the subject, name and role. Anything more would go
// stale, since it is not re-read from the database on every request.

import crypto from 'node:crypto';

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

function sign(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function issueToken(secret, { sub, name, role }, { ttl = 43200, now = Date.now() } = {}) {
  const issued = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub,
    name,
    role,
    iat: issued,
    exp: issued + ttl,
  })).toString('base64url');

  const body = `${HEADER}.${payload}`;
  return `${body}.${sign(secret, body)}`;
}

// Returns the claims, or null. Never throws, so a malformed token from a
// browser is an ordinary 401 rather than a 500.
export function verifyToken(secret, token, { now = Date.now() } = {}) {
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
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;

  return claims;
}

export const SESSION_COOKIE = 'conductor_session';

// Minimal cookie parsing, to avoid a dependency for one header.
export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      out[key] = part.slice(index + 1).trim();
    }
  }
  return out;
}

export function sessionCookie(token, { ttl = 43200, secure = false } = {}) {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${ttl}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function clearedCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
