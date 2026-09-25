// test/config.test.js - configuration loading, precedence and validation

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, stateDirs, parseKey } from '../src/lib/config.js';

// loadConfig reads process.env, so every case jobs with a clean slate.
async function withEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CONDUCTOR_')) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('CONDUCTOR_')) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'conductor-cfg-'));
}

test('defaults select sqlite, local storage and local auth', async () => {
  await withEnv({}, () => {
    const cfg = loadConfig();
    assert.equal(cfg.database.dialect, 'sqlite');
    assert.equal(cfg.storage.driver, 'local');
    assert.equal(cfg.auth.mode, 'local');
    assert.equal(cfg.server.port, 8080);
  });
});

test('configuring an s3 bucket switches the storage driver', async () => {
  await withEnv({
    CONDUCTOR_S3_ENDPOINT: 'http://127.0.0.1:3900',
    CONDUCTOR_S3_BUCKET: 'ci',
    CONDUCTOR_S3_ACCESS_KEY_ID: 'k',
    CONDUCTOR_S3_SECRET_ACCESS_KEY: 's',
  }, () => {
    assert.equal(loadConfig().storage.driver, 's3');
  });
});

test('a partial s3 configuration is rejected rather than half applied', async () => {
  await withEnv({ CONDUCTOR_S3_BUCKET: 'ci' }, () => {
    assert.throws(() => loadConfig(), /partially configured/);
  });
});

test('configuring an oidc discovery url switches the auth mode', async () => {
  await withEnv({
    CONDUCTOR_OIDC_DISCOVERY_URL: 'https://idp.example.com/realms/ci/.well-known/openid-configuration',
    CONDUCTOR_OIDC_CLIENT_ID: 'conductor',
  }, () => {
    assert.equal(loadConfig().auth.mode, 'oidc');
  });
});

test('an oidc discovery url without a client id is rejected', async () => {
  await withEnv({
    CONDUCTOR_OIDC_DISCOVERY_URL: 'https://idp.example.com/realms/ci/.well-known/openid-configuration',
  }, () => {
    assert.throws(() => loadConfig(), /client_id is required/);
  });
});

test('the built-in provider is on by default and answers at public_url', async () => {
  await withEnv({ CONDUCTOR_PUBLIC_URL: 'https://ci.example.com/' }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.auth.local.enabled, true);
    assert.deepEqual(cfg.auth.local.redirect_uris, ['https://ci.example.com']);
  });
});

test('configuring a provider turns the built-in one off', async () => {
  await withEnv({
    CONDUCTOR_OIDC_DISCOVERY_URL: 'https://idp.example.com/realms/ci/.well-known/openid-configuration',
    CONDUCTOR_OIDC_CLIENT_ID: 'conductor',
  }, () => {
    assert.equal(loadConfig().auth.local.enabled, false);
  });
});

// Only one provider can be advertised, so asking for the built-in one wins.
test('enabling the built-in provider overrides a configured one', async () => {
  await withEnv({
    CONDUCTOR_OIDC_DISCOVERY_URL: 'https://idp.example.com/realms/ci/.well-known/openid-configuration',
    CONDUCTOR_OIDC_CLIENT_ID: 'conductor',
    CONDUCTOR_LOCAL_AUTH: 'true',
  }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.auth.mode, 'local');
    assert.equal(cfg.auth.local.enabled, true);
  });
});

test('disabling the built-in provider with no other one is rejected', async () => {
  await withEnv({ CONDUCTOR_LOCAL_AUTH: 'false' }, () => {
    assert.throws(() => loadConfig(), /nobody could sign in/);
  });
});

test('redirect uris are split on commas and lose trailing slashes', async () => {
  await withEnv({
    CONDUCTOR_LOCAL_REDIRECT_URIS: 'https://app.example.com/ , https://alt.example.com',
  }, () => {
    assert.deepEqual(loadConfig().auth.local.redirect_uris, [
      'https://app.example.com',
      'https://alt.example.com',
    ]);
  });
});

test('token lifetimes are read from the environment as integers', async () => {
  await withEnv({
    CONDUCTOR_ACCESS_TTL: '300',
    CONDUCTOR_REFRESH_TTL: '86400',
    CONDUCTOR_REFRESH_SLIDING: 'off',
  }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.auth.access_ttl, 300);
    assert.equal(cfg.auth.refresh_ttl, 86400);
    assert.equal(cfg.auth.refresh_sliding, false);
  });
});

test('a database url selects its dialect', async () => {
  await withEnv({ CONDUCTOR_DATABASE_URL: 'postgres://u:p@h:5432/ci' }, () => {
    assert.equal(loadConfig().database.dialect, 'postgres');
  });
  await withEnv({ CONDUCTOR_DATABASE_URL: 'mysql://u:p@h:3306/ci' }, () => {
    assert.equal(loadConfig().database.dialect, 'mysql');
  });
});

test('an unsupported database scheme is reported clearly', async () => {
  await withEnv({ CONDUCTOR_DATABASE_URL: 'mongodb://h/ci' }, () => {
    assert.throws(() => loadConfig(), /unsupported scheme/);
  });
});

test('a sqlite url collapses into database.path', async () => {
  await withEnv({ CONDUCTOR_DATABASE_URL: 'sqlite:///var/lib/conductor/c.db' }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.database.dialect, 'sqlite');
    assert.equal(cfg.database.url, null);
    assert.equal(cfg.database.path, '/var/lib/conductor/c.db');
  });
});

test('environment variables override the config file', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'conductor.yaml');
  await fs.writeFile(file, 'server:\n  port: 9999\n  public_url: https://ci.example.com\n');

  await withEnv({ CONDUCTOR_CONFIG: file, CONDUCTOR_PORT: '7777' }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.server.port, 7777);
    assert.equal(cfg.server.public_url, 'https://ci.example.com');
  });
  await fs.rm(dir, { recursive: true, force: true });
});

test('relative paths resolve against the config file directory', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'conductor.yaml');
  await fs.writeFile(file, 'database:\n  path: ./state/c.db\n');

  await withEnv({ CONDUCTOR_CONFIG: file }, () => {
    assert.equal(loadConfig().database.path, path.join(dir, 'state/c.db'));
  });
  await fs.rm(dir, { recursive: true, force: true });
});

test('a missing explicit config file is an error, a missing default is not', async () => {
  await withEnv({ CONDUCTOR_CONFIG: '/nonexistent/conductor.yaml' }, () => {
    assert.throws(() => loadConfig(), /config file not found/);
  });
  await withEnv({}, () => {
    assert.doesNotThrow(() => loadConfig());
  });
});

test('a heartbeat timeout below the reap interval is rejected', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'conductor.yaml');
  await fs.writeFile(file, 'scheduler:\n  heartbeat_timeout: 10\n  reap_interval: 30\n');

  await withEnv({ CONDUCTOR_CONFIG: file }, () => {
    assert.throws(() => loadConfig(), /must be greater than/);
  });
  await fs.rm(dir, { recursive: true, force: true });
});

test('a non-integer port is rejected with the variable named', async () => {
  await withEnv({ CONDUCTOR_PORT: 'http' }, () => {
    assert.throws(() => loadConfig(), /CONDUCTOR_PORT/);
  });
});

test('parseKey accepts hex and base64, and rejects the wrong length', () => {
  assert.equal(parseKey('a'.repeat(64), 'k').length, 32);
  assert.equal(parseKey(Buffer.alloc(32).toString('base64'), 'k').length, 32);
  assert.throws(() => parseKey('abcd', 'secrets.encryption_key'), /must decode to 32 bytes/);
});

test('stateDirs omits the storage directory when s3 is in use', async () => {
  await withEnv({}, () => {
    assert.ok(stateDirs(loadConfig()).some((d) => d.endsWith('storage')));
  });
  await withEnv({
    CONDUCTOR_S3_ENDPOINT: 'http://127.0.0.1:3900',
    CONDUCTOR_S3_BUCKET: 'ci',
    CONDUCTOR_S3_ACCESS_KEY_ID: 'k',
    CONDUCTOR_S3_SECRET_ACCESS_KEY: 's',
  }, () => {
    assert.ok(!stateDirs(loadConfig()).some((d) => d.endsWith('storage')));
  });
});

test('the loaded config is frozen', async () => {
  await withEnv({}, () => {
    const cfg = loadConfig();
    assert.throws(() => { cfg.server.port = 1; }, TypeError);
  });
});
