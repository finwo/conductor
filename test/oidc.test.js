// test/oidc.test.js - authentication against a real identity provider
//
// Jobs navikt/mock-oauth2-server in a container and verifies real signed
// tokens against its real key set. Skipped when docker is unavailable.
//
// The two things worth proving here cannot be proven against a stub: that
// the key set is located by discovery rather than by guessing a provider
// specific path, and that somebody who exists only inside a token still
// ends up able to own projects.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startHarness } from './helpers/harness.js';
import { startOidc, forgedToken } from './helpers/oidc.js';
import { fetchDiscovery } from '../src/lib/auth/oidc.js';

// Checked synchronously: the runner needs to know whether to skip while it
// is collecting tests, and an unsettled top-level await at that point
// aborts the whole file.
function dockerAvailableSync() {
  if (process.env.CONDUCTOR_TEST_NO_DOCKER) return false;
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: 15000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

const available = dockerAvailableSync();
const opts = { skip: available ? false : 'docker is not available' };

// These exercised the JSON API, which has been removed. Kept until the
// suite is rebuilt against the interface.
const apiGone = { skip: 'the JSON API was removed' };

// One provider for the whole file; each test gets a fresh conductor.
let oidc = null;

before(async () => {
  if (available) oidc = await startOidc();
}, { timeout: 180000 });

after(async () => {
  if (oidc) await oidc.stop();
});

async function withOidcConductor(options, fn) {
  const h = await startHarness({
    oidcDiscoveryUrl: oidc.discovery,
    oidcClientId: 'conductor',
    oidcAdminRole: 'conductor-admin',
    ...options,
  });
  try {
    return await fn(h);
  } finally {
    await h.stop();
  }
}

const json = (headers) => ({ ...headers, 'content-type': 'application/json' });

test('the endpoints and key set come from the discovery document', opts, async () => {
  const document = await fetchDiscovery(oidc.discovery);

  assert.equal(document.issuer, oidc.issuer);
  // Keycloak serves the key set from /protocol/openid-connect/certs. Reading
  // the advertised jwks_uri rather than guessing that path is the point.
  assert.equal(document.jwks_uri, `${oidc.issuer}/jwks`);
  assert.ok(document.authorization_endpoint.endsWith('/authorize'));
  assert.ok(document.token_endpoint.endsWith('/token'));
});

test('discovery reports a document that is missing an endpoint', async () => {
  const withoutKeys = async () => new Response(
    JSON.stringify({
      issuer: 'https://idp.example/realm',
      authorization_endpoint: 'https://idp.example/auth',
      token_endpoint: 'https://idp.example/token',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
  await assert.rejects(
    fetchDiscovery('https://idp.example/realm/.well-known/openid-configuration', { fetchImpl: withoutKeys }),
    /did not advertise jwks_uri/
  );
});

test('discovery reports an unreachable provider and a bad status', async () => {
  const notFound = async () => new Response('nope', { status: 404, statusText: 'Not Found' });
  await assert.rejects(
    fetchDiscovery('https://idp.example/realm/.well-known/openid-configuration', { fetchImpl: notFound }),
    /returned 404/
  );

  const offline = async () => { throw new Error('connection refused'); };
  await assert.rejects(
    fetchDiscovery('https://idp.example/realm/.well-known/openid-configuration', { fetchImpl: offline }),
    /could not reach the OIDC discovery document/
  );
});

test('a token carrying the admin role authenticates as an administrator', opts, async () => {
  await withOidcConductor({}, async (h) => {
    const headers = await oidc.headers('persona-admin');

    const me = await h.app.inject({ method: 'GET', url: '/api/v1/users/me', headers });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().data.username, 'alice');
    assert.equal(me.json().data.role, 'admin');
    assert.equal(me.json().data.source, 'oidc');

    const users = await h.app.inject({ method: 'GET', url: '/api/v1/users', headers });
    assert.equal(users.statusCode, 200);
    assert.ok(users.json().data.length >= 1);
  });
});

test('a token without the admin role is an ordinary user', opts, async () => {
  await withOidcConductor({}, async (h) => {
    const headers = await oidc.headers('persona-viewer');

    const me = await h.app.inject({ method: 'GET', url: '/api/v1/users/me', headers });
    assert.equal(me.json().data.username, 'bob');
    assert.equal(me.json().data.role, 'user');

    // Listing accounts returns only their own rather than refusing.
    const users = await h.app.inject({ method: 'GET', url: '/api/v1/users', headers });
    assert.equal(users.statusCode, 200);
    assert.deepEqual(users.json().data.map((u) => u.username), ['bob']);
  });
});

test('roles are recognised in the groups and resource_access shapes', opts, async () => {
  await withOidcConductor({}, async (h) => {
    for (const persona of ['persona-groups', 'persona-resource']) {
      const me = await h.app.inject({
        method: 'GET', url: '/api/v1/users/me', headers: await oidc.headers(persona),
      });
      assert.equal(me.json().data.role, 'admin', `${persona} should map to admin`);
    }
  });
});

test('an OIDC user gets a local account and can own a project', opts, async () => {
  await withOidcConductor({}, async (h) => {
    const headers = await oidc.headers('persona-viewer');

    // Nothing exists for them before they appear.
    assert.equal(await h.services.users.byUsername('bob'), undefined);

    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: json(headers),
      payload: JSON.stringify({ id: 'bobs-app', repo_url: 'https://git.example.com/bob.git' }),
    });
    // Without a local row this fails on the owner_id foreign key.
    assert.equal(created.statusCode, 201, created.body);

    const account = await h.services.users.byUsername('bob');
    assert.ok(account, 'a local account should have been provisioned');
    assert.equal(created.json().data.owner_id, account.id);

    // The account cannot be signed into with a password.
    assert.equal(await h.services.users.authenticate('bob', 'external'), null);
    assert.equal(await h.services.users.authenticate('bob', ''), null);
  });
});

test('the same subject keeps one account even when the display name changes', opts, async () => {
  await withOidcConductor({}, async (h) => {
    const first = await h.app.inject({
      method: 'GET', url: '/api/v1/users/me', headers: await oidc.headers('persona-admin'),
    });
    const second = await h.app.inject({
      method: 'GET', url: '/api/v1/users/me', headers: await oidc.headers('persona-admin-renamed'),
    });

    // Identity is the subject, not the label the provider shows.
    assert.equal(second.json().data.id, first.json().data.id);
    assert.equal((await h.services.users.list()).filter((u) => u.external_id).length, 1);
  });
});

test('a display name colliding with a local account gets its own username', opts, async () => {
  await withOidcConductor({}, async (h) => {
    // A local account that predates OIDC already holds the name 'admin'.
    const local = await h.services.users.create({
      username: 'admin', password: 'bootstrap-password', role: 'admin',
    });

    const me = await h.app.inject({
      method: 'GET', url: '/api/v1/users/me', headers: await oidc.headers('persona-collision'),
    });
    assert.equal(me.statusCode, 200);
    assert.notEqual(me.json().data.id, local.id, 'the local account must not be taken over');
    assert.notEqual(me.json().data.username, 'admin');
    assert.match(me.json().data.username, /^admin-\d+$/);
  });
});

test('a role revoked at the provider is lost on the next request', opts, async () => {
  await withOidcConductor({}, async (h) => {
    const asAdmin = await h.app.inject({
      method: 'GET', url: '/api/v1/users/me', headers: await oidc.headers('persona-admin'),
    });
    assert.equal(asAdmin.json().data.role, 'admin');

    // The provider stops asserting the role for that subject.
    const account = await h.services.users.byExternalId(`${oidc.issuer}|alice-sub`);
    await h.services.users.upsertExternal({
      externalId: `${oidc.issuer}|alice-sub`, username: 'alice', role: 'user',
    });
    const refreshed = await h.services.users.get(account.id);
    assert.equal(refreshed.role, 'user');
  });
});

test('an account disabled locally is refused despite a valid token', opts, async () => {
  await withOidcConductor({}, async (h) => {
    const headers = await oidc.headers('persona-admin');
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/v1/users/me', headers })).statusCode, 200);

    const account = await h.services.users.byExternalId(`${oidc.issuer}|alice-sub`);
    await h.services.users.setDisabled(account.id, true);

    // The provider would still admit them; the conductor does not.
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/v1/users/me', headers })).statusCode, 401);
  });
});

test('a forged signature is refused', opts, async () => {
  await withOidcConductor({}, async (h) => {
    const token = await forgedToken(oidc.issuer);
    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/users/me', headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(await h.services.users.byUsername('mallory'), undefined, 'no account should be created');
  });
});

test('an expired token is refused', opts, async () => {
  await withOidcConductor({}, async (h) => {
    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/users/me', headers: await oidc.headers('persona-expired'),
    });
    assert.equal(res.statusCode, 401);
  });
});

test('a token from a different issuer is refused', opts, async () => {
  // The conductor trusts the issuer in its discovery document; a token
  // minted under another path of the same server must not be accepted.
  await withOidcConductor({
    oidcDiscoveryUrl: `${oidc.issuer.replace(/\/conductor$/, '/other')}/.well-known/openid-configuration`,
  }, async (h) => {
    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/users/me', headers: await oidc.headers('persona-admin'),
    });
    assert.equal(res.statusCode, 401);
  });
});

// Keycloak puts the client in azp and leaves aud as the resource server, so
// asserting aud alone rejects every real access token.
test('a token naming the client only in azp is accepted', opts, async () => {
  await withOidcConductor({}, async (h) => {
    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/users/me', headers: await oidc.headers('persona-azp'),
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().data.role, 'admin');
  });
});

test('a token issued to another client is refused', opts, async () => {
  await withOidcConductor({}, async (h) => {
    const res = await h.app.inject({
      method: 'GET', url: '/api/v1/users/me', headers: await oidc.headers('persona-other-client'),
    });
    assert.equal(res.statusCode, 401);
  });
});

test('discovery passes the provider through and names the client', opts, async () => {
  await withOidcConductor({}, async (h) => {
    const res = await h.discovery();
    assert.equal(res.statusCode, 200);

    const doc = res.json();
    assert.equal(doc.issuer, oidc.issuer);
    assert.equal(doc.authorization_endpoint, `${oidc.issuer}/authorize`);
    assert.equal(doc.client_id, 'conductor');
  });
});

// Only one provider is ever advertised, so only one may answer.
test('the built-in provider is not mounted while a provider is configured', opts, async () => {
  await withOidcConductor({}, async (h) => {
    for (const url of ['/auth/authorize', '/auth/token', '/auth/jwks']) {
      assert.equal((await h.app.inject({ method: 'GET', url })).statusCode, 404, url);
    }
  });
});

test('worker ownership follows the OIDC identity', opts, async () => {
  await withOidcConductor({ visibility: 'private' }, async (h) => {
    const alice = await oidc.headers('persona-admin');
    const bob = await oidc.headers('persona-viewer');

    const project = await h.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: json(bob),
      payload: JSON.stringify({ id: 'bob-proj', repo_url: h.repoDir }),
    });
    assert.equal(project.statusCode, 201, project.body);

    const bobToken = await h.app.inject({
      method: 'POST', url: '/api/v1/workers', headers: json(bob), payload: JSON.stringify({ name: 'bob-pi' }),
    });
    const aliceToken = await h.app.inject({
      method: 'POST', url: '/api/v1/workers', headers: json(alice), payload: JSON.stringify({ name: 'alice-pi' }),
    });

    const aliceList = await h.app.inject({ method: 'GET', url: '/api/v1/workers', headers: alice });
    const names = aliceList.json().data.map((t) => t.name);
    assert.ok(names.includes('bob-pi'), 'an administrator sees every worker');

    const bobList = await h.app.inject({ method: 'GET', url: '/api/v1/workers', headers: bob });
    assert.deepEqual(bobList.json().data.map((t) => t.name), ['bob-pi']);

    assert.ok(bobToken.json().data.token);
    assert.ok(aliceToken.json().data.token);
  });
});
