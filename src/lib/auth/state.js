// src/lib/auth/state.js - the OIDC login state
//
// A short signed value that travels to the provider as the state parameter
// and comes back on the callback. It carries when the login started and,
// when there is somewhere to return to, that path. It is verified on the
// way back, so nothing has to be stored between the two requests.
//
//   body = base64url(JSON.stringify({ iat, url }))
//   sign = base64url(hmacSha256(secret, body))
//   state = body + "." + sign

import crypto from 'node:crypto';

const MAX_AGE = 300;

function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

export function createState(secret, url, { now = Date.now() } = {}) {
  const claims = { iat: Math.floor(now / 1000) };
  if (url) claims.url = url;
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

// Returns { iat, url }, or null when the value is malformed, forged or
// older than five minutes. A missing url means the root.
export function verifyState(secret, state, { now = Date.now() } = {}) {
  if (typeof state !== 'string') return null;

  const [body, given, ...rest] = state.split('.');
  if (!body || !given || rest.length > 0) return null;

  const expected = sign(secret, body);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const seconds = Math.floor(now / 1000);
  if (!Number.isInteger(claims?.iat) || claims.iat > seconds || claims.iat < seconds - MAX_AGE) return null;

  const url = claims.url === undefined
    ? '/'
    : typeof claims.url === 'string' && claims.url.startsWith('/') && !claims.url.startsWith('//')
      ? claims.url
      : null;
  if (url === null) return null;

  return { iat: claims.iat, url };
}
