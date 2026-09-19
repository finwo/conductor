// test/oidc.test.js - authentication against a real identity provider
//
// Runs navikt/mock-oauth2-server in a container and verifies real signed
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
import { discoverJwksUri } from '../src/lib/auth/oidc.js';

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
    oidcIssuer: oidc.issuer,
    oidcAudience: 'conductor',
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

test('the key set is found through discovery, not a guessed path', opts, async () => {
  const uri = await discoverJwksUri(oidc.issuer);

  // Keycloak serves it from /protocol/openid-connect/certs. Assuming that
  // path is exactly the bug this guards against.
  assert.equal(uri, `${oidc.issuer}/jwks`);
  assert.ok(!uri.includes('protocol/openid-connect'));

  const keys = await (await fetch(uri)).json();
  assert.ok(Array.isArray(keys.keys) && keys.keys.length > 0);
});

// The guard against a bad discovery document is checked by injection
// rather than against the live provider, which serves a self consistent
// document for every path and so can never disagree with itself.
test('discovery rejects a document that declares a different issuer', async () => {
  const fetchImpl = async () => new Response(
    JSON.stringify({ issuer: 'https://evil.example/realm', jwks_uri: 'https://evil.example/keys' }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );

  await assert.rejects(
    discoverJwksUri('https://idp.example/realm', { fetchImpl }),
    /discovery mismatch/
  );
});

test('discovery tolerates a trailing slash on the advertised issuer', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://idp.example/realm/.well-known/openid-configuration');
    return new Response(
      JSON.stringify({ issuer: 'https://idp.example/realm/', jwks_uri: 'https://idp.example/realm/keys' }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  assert.equal(await discoverJwksUri('https://idp.example/realm/', { fetchImpl }), 'https://idp.example/realm/keys');
});

test('discovery reports a missing key set and an unreachable provider', async () => {
  const withoutKeys = async () => new Response(
    JSON.stringify({ issuer: 'https://idp.example/realm' }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
  await assert.rejects(
    discoverJwksUri('https://idp.example/realm', { fetchImpl: withoutKeys }),
    /did not advertise a jwks_uri/
  );

  const notFound = async () => new Response('nope', { status: 404, statusText: 'Not Found' });
  await assert.rejects(
    discoverJwksUri('https://idp.example/realm', { fetchImpl: notFound }),
    /returned 404/
  );

  const offline = async () => { throw new Error('connection refused'); };
  await assert.rejects(
    discoverJwksUri('https://idp.example/realm', { fetchImpl: offline }),
    /could not reach the OIDC discovery document/
  );
});

test('a token carrying the admin role authenticates as an administrator', opts, async () => {
  await withOidcConductor({}, async (h) => {
    const headers = await oidc.headers('persona-admin');

    const me = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.username, 'alice');
    assert.equal(me.json().user.role, 'admin');
    assert.equal(me.json().user.source, 'oidc');

    // And can reach the administrator only surface.
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/admin/users', headers })).statusCode, 200);
  });
});

test('a token without the admin role is a viewer', opts, async () => {
  await withOidcConductor({}, async (h) => {
    const headers = await oidc.headers('persona-viewer');

    const me = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers });
    assert.equal(me.json().user.username, 'bob');
    assert.equal(me.json().user.role, 'viewer');

    assert.equal((await h.app.inject({ method: 'GET', url: '/api/admin/users', headers })).statusCode, 403);
  });
});

test('roles are recognised in the groups and resource_access shapes', opts, async () => {
  await withOidcConductor({}, async (h) => {
    for (const persona of ['persona-groups', 'persona-resource']) {
      const me = await h.app.inject({
        method: 'GET', url: '/api/auth/me', headers: await oidc.headers(persona),
      });
      assert.equal(me.json().user.role, 'admin', `${persona} should map to admin`);
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
      url: '/api/projects',
      headers: json(headers),
      payload: JSON.stringify({ id: 'bobs-app', repo_url: 'https://git.example.com/bob.git' }),
    });
    // Without a local row this fails on the owner_id foreign key.
    assert.equal(created.statusCode, 201, created.body);

    const account = await h.services.users.byUsername('bob');
    assert.ok(account, 'a local account should have been provisioned');
    assert.equal(created.json().project.owner_id, account.id);

    // The account cannot be signed into with a password.
    assert.equal(await h.services.users.authenticate('bob', 'external'), null);
    assert.equal(await h.services.users.authenticate('bob', ''), null);
  });
});

test('the same subject keeps one account even when the display name changes', opts, async () => {
  await withOidcConductor({}, async (h) => {
    const first = await h.app.inject({
      method: 'GET', url: '/api/auth/me', headers: await oidc.headers('persona-admin'),
    });
    const second = await h.app.inject({
      method: 'GET', url: '/api/auth/me', headers: await oidc.headers('persona-admin-renamed'),
    });

    // Identity is the subject, not the label the provider shows.
    assert.equal(second.json().user.id, first.json().user.id);
    assert.equal((await h.services.users.list()).filter((u) => u.external_id).length, 1);
  });
});

test('a display name colliding with a local account gets its own username', opts, async () => {
  await withOidcConductor({ bootstrap: true, allowLocalLogin: true }, async (h) => {
    // The bootstrap administrator already holds the name 'admin'.
    const local = await h.services.users.byUsername('admin');
    assert.ok(local);

    const me = await h.app.inject({
      method: 'GET', url: '/api/auth/me', headers: await oidc.headers('persona-collision'),
    });
    assert.equal(me.statusCode, 200);
    assert.notEqual(me.json().user.id, local.id, 'the local account must not be taken over');
    assert.notEqual(me.json().user.username, 'admin');
    assert.match(me.json().user.username, /^admin-\d+$/);
  });
});

test('a role revoked at the provider is lost on the next request', opts, async () => {
  await withOidcConductor({}, async (h) => {
    const asAdmin = await h.app.inject({
      method: 'GET', url: '/api/auth/me', headers: await oidc.headers('persona-admin'),
    });
    assert.equal(asAdmin.json().user.role, 'admin');

    // The provider stops asserting the role for that subject.
    const account = await h.services.users.byExternalId(`${oidc.issuer}|alice-sub`);
    await h.services.users.upsertExternal({
      externalId: `${oidc.issuer}|alice-sub`, username: 'alice', role: 'viewer',
    });
    const refreshed = await h.services.users.get(account.id);
    assert.equal(refreshed.role, 'viewer');
  });
});

test('an account disabled locally is refused despite a valid token', opts, async () => {
  await withOidcConductor({}, async (h) => {
    const headers = await oidc.headers('persona-admin');
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/auth/me', headers })).statusCode, 200);

    const account = await h.services.users.byExternalId(`${oidc.issuer}|alice-sub`);
    await h.services.users.setDisabled(account.id, true);

    // The provider would still admit them; the conductor does not.
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/auth/me', headers })).statusCode, 401);
  });
});

test('a forged signature is refused', opts, async () => {
  await withOidcConductor({}, async (h) => {
    const token = await forgedToken(oidc.issuer);
    const res = await h.app.inject({
      method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(await h.services.users.byUsername('mallory'), undefined, 'no account should be created');
  });
});

test('an expired token is refused', opts, async () => {
  await withOidcConductor({}, async (h) => {
    const res = await h.app.inject({
      method: 'GET', url: '/api/auth/me', headers: await oidc.headers('persona-expired'),
    });
    assert.equal(res.statusCode, 401);
  });
});

test('a token for another audience is refused when an audience is configured', opts, async () => {
  await withOidcConductor({}, async (h) => {
    const res = await h.app.inject({
      method: 'GET', url: '/api/auth/me', headers: await oidc.headers('persona-wrong-audience'),
    });
    assert.equal(res.statusCode, 401);
  });
});

test('the same token is accepted when no audience is configured', opts, async () => {
  await withOidcConductor({ oidcAudience: null }, async (h) => {
    const res = await h.app.inject({
      method: 'GET', url: '/api/auth/me', headers: await oidc.headers('persona-wrong-audience'),
    });
    assert.equal(res.statusCode, 200);
  });
});

test('a token from a different issuer is refused', opts, async () => {
  // The conductor trusts one issuer; a token minted under another path of
  // the same server must not be accepted.
  await withOidcConductor({ oidcIssuer: oidc.issuer.replace(/\/conductor$/, '/other') }, async (h) => {
    const res = await h.app.inject({
      method: 'GET', url: '/api/auth/me', headers: await oidc.headers('persona-admin'),
    });
    assert.equal(res.statusCode, 401);
  });
});

test('an explicit jwks_uri bypasses discovery', opts, async () => {
  await withOidcConductor({ oidcJwksUri: `${oidc.issuer}/jwks` }, async (h) => {
    const res = await h.app.inject({
      method: 'GET', url: '/api/auth/me', headers: await oidc.headers('persona-admin'),
    });
    assert.equal(res.statusCode, 200);
  });
});

test('local passwords are refused while OIDC is in charge', opts, async () => {
  await withOidcConductor({ bootstrap: true }, async (h) => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'admin', password: 'bootstrap-password' }),
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /OIDC/);
  });
});

test('an OIDC administrator can drive the interface', opts, async () => {
  await withOidcConductor({}, async (h) => {
    const headers = await oidc.headers('persona-admin');

    const page = await h.app.inject({ method: 'GET', url: '/', headers });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /href="\/users"/, 'an admin should see the users link');

    const users = await h.app.inject({ method: 'GET', url: '/users', headers });
    assert.equal(users.statusCode, 200);
    assert.match(users.body, /alice/);
  });
});

test('worker ownership follows the OIDC identity', opts, async () => {
  await withOidcConductor({ visibility: 'private' }, async (h) => {
    const alice = await oidc.headers('persona-admin');
    const bob = await oidc.headers('persona-viewer');

    // Bob owns a project and registers a worker for it.
    const project = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: json(bob),
      payload: JSON.stringify({ id: 'bob-proj', repo_url: h.repoDir }),
    });
    assert.equal(project.statusCode, 201);

    const bobToken = await h.app.inject({
      method: 'POST', url: '/api/worker-tokens', headers: json(bob), payload: JSON.stringify({ name: 'bob-pi' }),
    });
    const aliceToken = await h.app.inject({
      method: 'POST', url: '/api/worker-tokens', headers: json(alice), payload: JSON.stringify({ name: 'alice-pi' }),
    });

    // Alice cannot see bob's worker, even as an administrator listing her
    // own, and bob cannot see the project he does not own.
    const aliceList = await h.app.inject({ method: 'GET', url: '/api/worker-tokens', headers: alice });
    const names = aliceList.json().worker_tokens.map((t) => t.name);
    assert.ok(names.includes('bob-pi'), 'an administrator sees every worker');

    const bobList = await h.app.inject({ method: 'GET', url: '/api/worker-tokens', headers: bob });
    assert.deepEqual(bobList.json().worker_tokens.map((t) => t.name), ['bob-pi']);

    assert.ok(bobToken.json().token);
    assert.ok(aliceToken.json().token);
  });
});
