// src/conductor/auth/index.js - the built-in login provider
//
// A plain authorization code flow with PKCE, so the app drives the built-in
// provider and an external one through exactly the same code path.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { signToken, verifyToken } from '../../lib/auth/token.js';
import { newToken, randomId } from '../../lib/ids.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE_TTL = 60;

// The row id is derived from the code, so redeeming a code twice collides on
// the primary key instead of needing a table of spent codes.
function sessionIdFor(jti) {
  return crypto.createHash('sha256').update(`code:${jti}`).digest('hex').slice(0, 32);
}

function challengeFor(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export default async function authRoutes(fastify, { cfg, auth, users, refreshTokens }) {
  const issuer = auth.issuer;

  fastify.get('/.well-known/openid-configuration', async (req, reply) => {
    // The document carries no client id of its own, but the app has to learn
    // one somewhere and this saves it a second request.
    if (auth.oidc) {
      const document = await auth.oidc.metadata();
      return reply.send({ ...document, client_id: auth.clientId, scopes: auth.oidc.scopes });
    }

    return reply.send({
      issuer,
      authorization_endpoint: `${issuer}/auth/authorize`,
      token_endpoint: `${issuer}/auth/token`,
      revocation_endpoint: `${issuer}/auth/revoke`,
      end_session_endpoint: `${issuer}/auth/logout`,
      jwks_uri: `${issuer}/auth/jwks`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['openid'],
      client_id: auth.clientId,
      scopes: 'openid',
    });
  });

  if (!auth.localLogin) return;

  const page = await fs.readFile(path.join(HERE, 'login.html'), 'utf8');
  const style = await fs.readFile(path.join(HERE, 'login.css'), 'utf8');
  const failedPage = page.replace('id="error" hidden', 'id="error"');

  fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    const out = {};
    for (const [key, value] of new URLSearchParams(body)) out[key] = value;
    done(null, out);
  });

  const registered = cfg.auth.local.redirect_uris;
  const anywhere = registered.includes('*');

  function allowed(uri) {
    if (typeof uri !== 'string' || uri.length === 0) return false;
    if (anywhere) return /^https?:/.test(uri);
    return registered.some((entry) => sameOrigin(uri, entry));
  }

  function refuse(reply, what, given) {
    return reply.code(400).type('text/plain; charset=utf-8').send(
      `${what} ${JSON.stringify(given ?? null)} is not registered for this conductor.\n`
      + `Registered: ${registered.join(', ')}\n`
      + 'Set auth.local.redirect_uris, or CONDUCTOR_LOCAL_REDIRECT_URIS, to a comma separated\n'
      + 'list of origins. Use * to allow any, which is for local testing only.\n'
    );
  }

  function oauthError(reply, status, error, description) {
    return reply.code(status).send({ error, error_description: description });
  }

  // Returns the validated request, or answers and returns null. A bad
  // redirect_uri is never redirected to, or this would be an open redirect.
  function authorizationRequest(req, reply) {
    const { client_id: clientId, redirect_uri: redirectUri, response_type: responseType } = req.query;
    const { code_challenge: challenge, code_challenge_method: method, state } = req.query;

    if (!allowed(redirectUri)) {
      refuse(reply, 'redirect_uri', redirectUri);
      return null;
    }

    const back = (error, description) => {
      const url = new URL(redirectUri);
      url.searchParams.set('error', error);
      url.searchParams.set('error_description', description);
      if (typeof state === 'string') url.searchParams.set('state', state);
      reply.redirect(url.toString(), 303);
      return null;
    };

    if (clientId !== auth.clientId) return back('unauthorized_client', 'unknown client_id');
    if (responseType !== 'code') return back('unsupported_response_type', 'only code is supported');
    if (method !== 'S256') return back('invalid_request', 'code_challenge_method must be S256');
    if (typeof challenge !== 'string' || challenge.length < 43) {
      return back('invalid_request', 'a code_challenge is required');
    }

    return { redirectUri, challenge, state };
  }

  fastify.get('/auth/login.css', async (req, reply) => reply.type('text/css; charset=utf-8').send(style));

  fastify.get('/auth/authorize', async (req, reply) => {
    if (!authorizationRequest(req, reply)) return reply;
    return reply.type('text/html; charset=utf-8').send(page);
  });

  fastify.post('/auth/authorize', async (req, reply) => {
    const request = authorizationRequest(req, reply);
    if (!request) return reply;

    const { username, password } = req.body ?? {};
    const user = await users.authenticate(String(username ?? ''), String(password ?? ''));
    if (!user) {
      return reply.code(401).type('text/html; charset=utf-8').send(failedPage);
    }

    const code = signToken(cfg.auth.session_secret, {
      use: 'code',
      iss: issuer,
      aud: auth.clientId,
      sub: user.id,
      ru: request.redirectUri,
      cc: request.challenge,
      jti: randomId(16),
      ttl: CODE_TTL,
    });

    const url = new URL(request.redirectUri);
    url.searchParams.set('code', code);
    if (typeof request.state === 'string') url.searchParams.set('state', request.state);
    return reply.redirect(url.toString(), 303);
  });

  fastify.post('/auth/token', async (req, reply) => {
    const body = req.body ?? {};
    if (body.client_id !== undefined && body.client_id !== auth.clientId) {
      return oauthError(reply, 401, 'invalid_client', 'unknown client_id');
    }

    if (body.grant_type === 'authorization_code') return exchangeCode(req, reply, body);
    if (body.grant_type === 'refresh_token') return refresh(req, reply, body);
    return oauthError(reply, 400, 'unsupported_grant_type', 'expected authorization_code or refresh_token');
  });

  async function exchangeCode(req, reply, body) {
    const claims = verifyToken(cfg.auth.session_secret, body.code, {
      use: 'code',
      iss: issuer,
      aud: auth.clientId,
    });
    if (!claims) return oauthError(reply, 400, 'invalid_grant', 'the code is unknown or expired');
    if (claims.ru !== body.redirect_uri) {
      return oauthError(reply, 400, 'invalid_grant', 'redirect_uri does not match the one the code was issued for');
    }

    const verifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
    const given = Buffer.from(challengeFor(verifier));
    const want = Buffer.from(String(claims.cc));
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      return oauthError(reply, 400, 'invalid_grant', 'the code_verifier does not match the challenge');
    }

    const user = await users.get(claims.sub);
    if (!user || user.disabled === 1) return oauthError(reply, 400, 'invalid_grant', 'the account is unavailable');

    const now = Date.now();
    const token = newToken();
    try {
      await refreshTokens.issue({
        id: sessionIdFor(claims.jti),
        userId: user.id,
        token,
        expiresAt: now + cfg.auth.refresh_ttl * 1000,
        userAgent: req.headers['user-agent'] ?? null,
        ip: req.ip,
        now,
      });
    } catch {
      return oauthError(reply, 400, 'invalid_grant', 'the code has already been redeemed');
    }

    return reply.send(grant(user, token, now));
  }

  async function refresh(req, reply, body) {
    const now = Date.now();
    const row = await refreshTokens.claim(body.refresh_token, { now });
    if (!row) return oauthError(reply, 400, 'invalid_grant', 'the refresh token is unknown or expired');

    const user = await users.get(row.user_id);
    if (!user || user.disabled === 1) return oauthError(reply, 400, 'invalid_grant', 'the account is unavailable');

    const alive = await refreshTokens.touch({
      id: row.id,
      expiresAt: cfg.auth.refresh_sliding ? now + cfg.auth.refresh_ttl * 1000 : null,
      userAgent: req.headers['user-agent'] ?? null,
      ip: req.ip,
      now,
    });
    if (!alive) return oauthError(reply, 400, 'invalid_grant', 'the session was revoked');

    return reply.send(grant(user, body.refresh_token, now));
  }

  function grant(user, refreshToken, now) {
    return {
      access_token: auth.accessToken(user, { now }),
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: cfg.auth.access_ttl,
    };
  }

  // RFC 7009: revoking an unknown token is a success, so nothing can be
  // learned by presenting one.
  fastify.post('/auth/revoke', async (req, reply) => {
    const row = await refreshTokens.claim(req.body?.token);
    if (row) await refreshTokens.revoke(row.id);
    return reply.code(200).send();
  });

  fastify.get('/auth/logout', async (req, reply) => {
    const target = req.query.post_logout_redirect_uri;
    if (typeof target === 'string' && target.length > 0) {
      if (!allowed(target)) return refuse(reply, 'post_logout_redirect_uri', target);
      return reply.redirect(target, 303);
    }
    return reply.redirect(issuer, 303);
  });

  // The built-in tokens are HS256 and nothing outside this conductor verifies
  // them, so the set is empty. It is advertised for shape.
  fastify.get('/auth/jwks', async (req, reply) => reply.send({ keys: [] }));
}
