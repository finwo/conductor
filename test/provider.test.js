// test/provider.test.js - the built-in login provider

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startHarness } from './helpers/harness.js';

const PUBLIC_URL = 'http://conductor.test';
const REDIRECT = `${PUBLIC_URL}/callback`;

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

function authorizeQuery(overrides = {}) {
  return new URLSearchParams({
    client_id: 'conductor',
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: pkce().challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    ...overrides,
  });
}

async function withConductor(fn) {
  const c = await startHarness({ bootstrap: true, publicUrl: PUBLIC_URL });
  try {
    return await fn(c);
  } finally {
    await c.stop();
  }
}

async function authorize(c, query, credentials = { username: 'admin', password: 'bootstrap-password' }) {
  return c.app.inject({
    method: 'POST',
    url: `/auth/authorize?${query}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(credentials).toString(),
  });
}

test('discovery advertises the built-in endpoints and the client id', async () => {
  await withConductor(async (c) => {
    const res = await c.discovery();
    assert.equal(res.statusCode, 200);

    const doc = res.json();
    assert.equal(doc.issuer, PUBLIC_URL);
    assert.equal(doc.authorization_endpoint, `${PUBLIC_URL}/auth/authorize`);
    assert.equal(doc.token_endpoint, `${PUBLIC_URL}/auth/token`);
    assert.equal(doc.end_session_endpoint, `${PUBLIC_URL}/auth/logout`);
    assert.deepEqual(doc.code_challenge_methods_supported, ['S256']);
    assert.equal(doc.client_id, 'conductor');
  });
});

test('the login page is served for a valid authorization request', async () => {
  await withConductor(async (c) => {
    const res = await c.app.inject({ method: 'GET', url: `/auth/authorize?${authorizeQuery()}` });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /name="password"/);
    // The query string carries the parameters, so the form needs no action.
    assert.ok(!res.body.includes('action='));
  });
});

test('the whole code flow yields a working access token', async () => {
  await withConductor(async (c) => {
    const grant = await c.login();
    assert.equal(grant.token_type, 'Bearer');
    assert.equal(grant.expires_in, 900);
    assert.ok(grant.access_token);
    assert.ok(grant.refresh_token);

    const me = await c.app.inject({ method: 'GET', url: '/api/v1/users/me', headers: grant.headers });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().data.username, 'admin');
  });
});

test('a code is single use', async () => {
  await withConductor(async (c) => {
    const { verifier, challenge } = pkce();
    const res = await authorize(c, authorizeQuery({ code_challenge: challenge }));
    const code = new URL(res.headers.location).searchParams.get('code');

    const body = {
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier,
    };
    assert.equal((await c.token(body)).statusCode, 200);

    const replay = await c.token(body);
    assert.equal(replay.statusCode, 400);
    assert.equal(replay.json().error, 'invalid_grant');
  });
});

test('a code will not redeem without the matching verifier', async () => {
  await withConductor(async (c) => {
    const { challenge } = pkce();
    const res = await authorize(c, authorizeQuery({ code_challenge: challenge }));
    const code = new URL(res.headers.location).searchParams.get('code');

    const wrong = await c.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: crypto.randomBytes(32).toString('base64url'),
    });
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.json().error, 'invalid_grant');
  });
});

test('a code will not redeem against a different redirect uri', async () => {
  await withConductor(async (c) => {
    const { verifier, challenge } = pkce();
    const res = await authorize(c, authorizeQuery({ code_challenge: challenge }));
    const code = new URL(res.headers.location).searchParams.get('code');

    const moved = await c.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${PUBLIC_URL}/elsewhere`,
      code_verifier: verifier,
    });
    assert.equal(moved.statusCode, 400);
  });
});

// Redirecting to an unregistered uri would make this an open redirect.
test('an unregistered redirect uri is refused without redirecting', async () => {
  await withConductor(async (c) => {
    const query = authorizeQuery({ redirect_uri: 'https://evil.example/steal', code_challenge: pkce().challenge });

    const shown = await c.app.inject({ method: 'GET', url: `/auth/authorize?${query}` });
    assert.equal(shown.statusCode, 400);
    assert.equal(shown.headers.location, undefined);

    const posted = await authorize(c, query);
    assert.equal(posted.statusCode, 400);
    assert.equal(posted.headers.location, undefined);
  });
});

test('a bad request with a good redirect uri comes back as an oauth error', async () => {
  await withConductor(async (c) => {
    for (const [override, error] of [
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ client_id: 'someone-else' }, 'unauthorized_client'],
    ]) {
      const query = authorizeQuery({ code_challenge: pkce().challenge, ...override });
      const res = await c.app.inject({ method: 'GET', url: `/auth/authorize?${query}` });

      assert.equal(res.statusCode, 303);
      const url = new URL(res.headers.location);
      assert.equal(url.origin + url.pathname, REDIRECT);
      assert.equal(url.searchParams.get('error'), error);
      assert.equal(url.searchParams.get('state'), 'xyz');
    }
  });
});

test('a request with no code challenge at all is refused', async () => {
  await withConductor(async (c) => {
    const query = authorizeQuery();
    query.delete('code_challenge');
    const res = await c.app.inject({ method: 'GET', url: `/auth/authorize?${query}` });

    assert.equal(res.statusCode, 303);
    assert.equal(new URL(res.headers.location).searchParams.get('error'), 'invalid_request');
  });
});

test('wrong credentials redisplay the form rather than issuing a code', async () => {
  await withConductor(async (c) => {
    const res = await authorize(c, authorizeQuery({ code_challenge: pkce().challenge }), {
      username: 'admin', password: 'not-the-password',
    });

    assert.equal(res.statusCode, 401);
    assert.equal(res.headers.location, undefined);
    assert.match(res.body, /did not match/);
  });
});

test('the state is handed back so the app can resume', async () => {
  await withConductor(async (c) => {
    const res = await authorize(c, authorizeQuery({ code_challenge: pkce().challenge, state: 'resume-me' }));
    assert.equal(new URL(res.headers.location).searchParams.get('state'), 'resume-me');
  });
});

test('refreshing returns a new access token and keeps the refresh token', async () => {
  await withConductor(async (c) => {
    const grant = await c.login();

    const res = await c.token({ grant_type: 'refresh_token', refresh_token: grant.refresh_token });
    assert.equal(res.statusCode, 200);

    const next = res.json();
    assert.equal(next.refresh_token, grant.refresh_token);
    assert.ok(next.access_token);

    const me = await c.app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${next.access_token}` },
    });
    assert.equal(me.statusCode, 200);
  });
});

test('an unknown grant type or refresh token is refused', async () => {
  await withConductor(async (c) => {
    const bad = await c.token({ grant_type: 'password', username: 'admin', password: 'bootstrap-password' });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, 'unsupported_grant_type');

    const unknown = await c.token({ grant_type: 'refresh_token', refresh_token: 'a'.repeat(64) });
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.json().error, 'invalid_grant');
  });
});

test('revoking ends the session and reports nothing about unknown tokens', async () => {
  await withConductor(async (c) => {
    const grant = await c.login();

    const unknown = await c.app.inject({
      method: 'POST',
      url: '/auth/revoke',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ token: 'b'.repeat(64) }).toString(),
    });
    assert.equal(unknown.statusCode, 200);

    const revoked = await c.app.inject({
      method: 'POST',
      url: '/auth/revoke',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ token: grant.refresh_token }).toString(),
    });
    assert.equal(revoked.statusCode, 200);

    const after = await c.token({ grant_type: 'refresh_token', refresh_token: grant.refresh_token });
    assert.equal(after.statusCode, 400);
  });
});

test('logout redirects only to a registered uri', async () => {
  await withConductor(async (c) => {
    const ok = await c.app.inject({
      method: 'GET',
      url: `/auth/logout?post_logout_redirect_uri=${encodeURIComponent(PUBLIC_URL)}`,
    });
    assert.equal(ok.statusCode, 303);
    assert.equal(ok.headers.location, PUBLIC_URL);

    const bad = await c.app.inject({
      method: 'GET',
      url: '/auth/logout?post_logout_redirect_uri=https%3A%2F%2Fevil.example',
    });
    assert.equal(bad.statusCode, 400);
  });
});

test('the key set is advertised and empty', async () => {
  await withConductor(async (c) => {
    const res = await c.app.inject({ method: 'GET', url: '/auth/jwks' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { keys: [] });
  });
});

test('a disabled account cannot refresh an existing session', async () => {
  await withConductor(async (c) => {
    const grant = await c.login();
    const admin = await c.services.users.byUsername('admin');
    await c.services.users.setDisabled(admin.id, true);

    const res = await c.token({ grant_type: 'refresh_token', refresh_token: grant.refresh_token });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'invalid_grant');
  });
});
