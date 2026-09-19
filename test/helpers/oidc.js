// test/helpers/oidc.js - a real identity provider for the tests
//
// Runs navikt/mock-oauth2-server, which speaks real OIDC discovery and
// signs real tokens with a real key set. Faking the provider would test the
// fake: the interesting failures here are discovery paths, signature
// verification and claim shapes, and none of those survive a stub.
//
// Personas are declared up front as token callbacks and requested by scope,
// so a test can ask for a specific set of claims without a browser.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';

const execFileAsync = promisify(execFile);

export const IMAGE = 'ghcr.io/navikt/mock-oauth2-server:2.1.10';
const ISSUER_ID = 'conductor';

// Each persona is selected with scope=<name> at the token endpoint.
const PERSONAS = {
  'persona-admin': {
    sub: 'alice-sub',
    preferred_username: 'alice',
    realm_access: { roles: ['conductor-admin'] },
    aud: ['conductor'],
  },
  'persona-viewer': {
    sub: 'bob-sub',
    preferred_username: 'bob',
    realm_access: { roles: ['developer'] },
    aud: ['conductor'],
  },
  // The same person as persona-admin, to prove identity is keyed on the
  // subject rather than on a display name the provider may change.
  'persona-admin-renamed': {
    sub: 'alice-sub',
    preferred_username: 'alice-moved',
    realm_access: { roles: ['conductor-admin'] },
    aud: ['conductor'],
  },
  // Roles arriving in the other shapes providers use.
  'persona-groups': {
    sub: 'carol-sub',
    preferred_username: 'carol',
    groups: ['conductor-admin'],
    aud: ['conductor'],
  },
  'persona-resource': {
    sub: 'dave-sub',
    preferred_username: 'dave',
    resource_access: { conductor: { roles: ['conductor-admin'] } },
    aud: ['conductor'],
  },
  // A display name that collides with an existing local account.
  'persona-collision': {
    sub: 'eve-sub',
    preferred_username: 'admin',
    realm_access: { roles: ['developer'] },
    aud: ['conductor'],
  },
  // Audience the conductor is not expecting.
  'persona-wrong-audience': {
    sub: 'frank-sub',
    preferred_username: 'frank',
    realm_access: { roles: ['conductor-admin'] },
    aud: ['some-other-service'],
  },
  // Already expired when issued.
  'persona-expired': {
    sub: 'grace-sub',
    preferred_username: 'grace',
    realm_access: { roles: ['conductor-admin'] },
    aud: ['conductor'],
    exp: 1000000000,
  },
};

export async function dockerAvailable() {
  if (process.env.CONDUCTOR_TEST_NO_DOCKER) return false;
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// How long to wait for the container to answer. Generous, because it
// competes with image builds for the machine.
const READY_TIMEOUT = 120 * 1000;

const NAME_PREFIX = 'conductor-oidc-test-';

// A test run that crashes hard, or is killed, never reaches its cleanup
// hook and leaves the container behind. Since exactly one provider is
// needed at a time, anything already carrying the prefix is stale and can
// go. Cheaper than asking people to clean up after a failed run.
async function reapStale() {
  try {
    const { stdout } = await execFileAsync('docker', [
      'ps', '-aq', '--filter', `name=${NAME_PREFIX}`,
    ], { timeout: 30000 });
    const ids = stdout.trim().split('\n').filter(Boolean);
    if (ids.length > 0) await execFileAsync('docker', ['rm', '-f', ...ids], { timeout: 60000 });
  } catch {
    // Best effort; a failure here must not fail the tests.
  }
}

export async function startOidc() {
  await reapStale();

  const port = await freePort();
  const name = `${NAME_PREFIX}${crypto.randomBytes(4).toString('hex')}`;
  const issuer = `http://127.0.0.1:${port}/${ISSUER_ID}`;

  const config = {
    interactiveLogin: false,
    tokenCallbacks: [{
      issuerId: ISSUER_ID,
      requestMappings: Object.entries(PERSONAS).map(([scope, claims]) => ({
        requestParam: 'scope',
        match: scope,
        claims,
      })),
    }],
  };

  await execFileAsync('docker', [
    'run', '--detach', '--rm',
    '--name', name,
    '--publish', `${port}:8080`,
    '--env', `JSON_CONFIG=${JSON.stringify(config)}`,
    IMAGE,
  ], { timeout: 120000 });

  const discovery = `${issuer}/.well-known/openid-configuration`;
  // Deadline rather than a count of attempts. A refused connection comes
  // back instantly, so sixty attempts spaced by half a second gave up
  // after thirty seconds regardless of the interval, and a machine busy
  // pulling or building images needs longer than that. Failing there
  // looked like a broken test rather than a slow start.
  let ready = false;
  const deadline = Date.now() + READY_TIMEOUT;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(discovery, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // Still starting.
    }
    await new Promise((r) => { setTimeout(r, 500); });
  }

  if (!ready) {
    await execFileAsync('docker', ['rm', '-f', name]).catch(() => {});
    throw new Error(`the OIDC provider did not become ready at ${discovery} within ${READY_TIMEOUT / 1000}s`);
  }

  return {
    issuer,
    port,
    name,
    discovery,

    // Obtains a signed token for one of the personas above.
    async token(persona) {
      if (!Object.hasOwn(PERSONAS, persona)) throw new Error(`unknown persona ${persona}`);
      const res = await fetch(`${issuer}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: 'conductor',
          client_secret: 'secret',
          scope: persona,
        }),
      });
      if (!res.ok) throw new Error(`token request failed: ${res.status} ${await res.text()}`);
      return (await res.json()).access_token;
    },

    // Bearer headers for a persona.
    async headers(persona) {
      return { authorization: `Bearer ${await this.token(persona)}` };
    },

    async stop() {
      await execFileAsync('docker', ['rm', '-f', name], { timeout: 60000 }).catch(() => {});
    },
  };
}

// A token signed by a key the provider does not publish, for checking that
// a forged signature is refused.
export async function forgedToken(issuer, claims = {}) {
  const jose = await import('jose');
  const { privateKey } = await jose.generateKeyPair('RS256');
  return new jose.SignJWT({
    preferred_username: 'mallory',
    realm_access: { roles: ['conductor-admin'] },
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'forged' })
    .setSubject('mallory-sub')
    .setIssuer(issuer)
    .setAudience('conductor')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}
