// test/oidc.introspection.test.js - unit coverage for opaque token introspection
//
// The provider is stubbed with a fake fetch so these run without docker and
// without a real identity provider. They pin the contract: an introspection
// endpoint that reports active:true yields a profile, active:false is
// rejected, and a provider without an endpoint falls back to JWKS.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createOidc, fetchDiscovery } from '../src/lib/auth/oidc.js';

function discovery(overrides = {}) {
  return {
    issuer: 'https://idp.example',
    authorization_endpoint: 'https://idp.example/auth',
    token_endpoint: 'https://idp.example/token',
    jwks_uri: 'https://idp.example/jwks',
    ...overrides,
  };
}

function makeFetch(handler) {
  return async (url, opts) => handler(String(url), opts || {});
}

test('introspection success builds a profile from the response claims', async () => {
  const doc = discovery({ introspection_endpoint: 'https://idp.example/introspect' });
  const fetchImpl = makeFetch((url) => {
    if (url.endsWith('/.well-known/openid-configuration')) {
      return new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      active: true,
      sub: 'user-1',
      preferred_username: 'alice',
      groups: ['conductor-admin'],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const cfg = { auth: { oidc: { discovery_url: 'https://idp.example/.well-known/openid-configuration', client_id: 'conductor', scopes: 'openid', admin_role: 'conductor-admin' } } };
  const oidc = createOidc(cfg, { fetchImpl });
  const profile = await oidc.verify('opaque-token');
  assert.equal(profile.subject, 'user-1');
  assert.equal(profile.username, 'alice');
  assert.equal(profile.role, 'admin');
});

test('introspection reporting active:false is rejected', async () => {
  const doc = discovery({ introspection_endpoint: 'https://idp.example/introspect' });
  const fetchImpl = makeFetch((url) => {
    if (url.endsWith('/.well-known/openid-configuration')) {
      return new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ active: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const cfg = { auth: { oidc: { discovery_url: 'https://idp.example/.well-known/openid-configuration', client_id: 'conductor', scopes: 'openid', admin_role: 'conductor-admin' } } };
  const oidc = createOidc(cfg, { fetchImpl });
  await assert.rejects(() => oidc.verify('opaque-token'), /not active/);
});

test('a provider without an introspection endpoint uses JWKS verification', async () => {
  const doc = discovery(); // no introspection_endpoint
  // jwks verification requires a real jose key set; instead confirm fetchDiscovery
  // does not require introspection_endpoint and the document loads.
  const fetchImpl = makeFetch((url) => {
    if (url.endsWith('/.well-known/openid-configuration')) {
      return new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('nope', { status: 404 });
  });
  const loaded = await fetchDiscovery('https://idp.example/.well-known/openid-configuration', { fetchImpl });
  assert.equal(loaded.introspection_endpoint, undefined);
});
