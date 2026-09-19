// test/helpers/minio.js - a real object store for the tests
//
// Runs MinIO, which speaks real S3. The signing code here is written
// against node:crypto rather than taken from a library, so verifying it
// against a real server is the only way to know it works: a stub would
// accept whatever signature we happened to produce, including a wrong one.
//
// Set CONDUCTOR_TEST_S3_ENDPOINT to point the same tests at something else,
// such as Garage or AWS, instead of starting a container.

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import net from 'node:net';
import { signRequest, sha256Hex } from '../../src/lib/storage/sigv4.js';
import { reapStale } from './containers.js';

const execFileAsync = promisify(execFile);

// Pinned, so a MinIO release cannot change what the suite is testing
// against without the change being visible here.
export const IMAGE = 'quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z';
// How long to wait for the container to answer. Generous, because it
// competes with image builds for the machine.
const READY_TIMEOUT = 120 * 1000;

const NAME_PREFIX = 'conductor-minio-test-';

const ACCESS_KEY = 'conductortest';
const SECRET_KEY = 'conductortestsecret';

// Checked synchronously: the runner needs to know whether to skip while it
// is collecting tests, and an unsettled top-level await at that point
// aborts the whole file.
export function dockerAvailableSync() {
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

// True when the suite can exercise S3 at all: either an endpoint was given,
// or docker is here to start one.
export function s3Available() {
  return Boolean(process.env.CONDUCTOR_TEST_S3_ENDPOINT) || dockerAvailableSync();
}

async function freePort() {
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

// Buckets are created with a signed request rather than the MinIO client,
// which keeps the helper free of another dependency and exercises the
// signer on the way in.
export async function createBucket(endpoint, bucket, credentials) {
  const url = new URL(`${endpoint.replace(/\/+$/, '')}/${bucket}`);
  const headers = signRequest({
    method: 'PUT',
    url,
    payloadHash: sha256Hex(''),
    region: credentials.region,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
  });

  const res = await fetch(url, { method: 'PUT', headers });
  // 409 means it already exists, which is fine.
  if (!res.ok && res.status !== 409) {
    throw new Error(`could not create bucket ${bucket}: ${res.status} ${await res.text()}`);
  }
}

export async function startMinio() {
  const external = process.env.CONDUCTOR_TEST_S3_ENDPOINT;

  // An endpoint supplied by the operator wins, and is left alone.
  if (external) {
    const credentials = {
      region: process.env.CONDUCTOR_TEST_S3_REGION || 'us-east-1',
      accessKeyId: process.env.CONDUCTOR_TEST_S3_KEY,
      secretAccessKey: process.env.CONDUCTOR_TEST_S3_SECRET,
    };
    return {
      endpoint: external.replace(/\/+$/, ''),
      credentials,
      managed: false,
      async bucket(name = `citest${Date.now().toString(36)}`) {
        await createBucket(this.endpoint, name, credentials);
        return name;
      },
      async stop() {},
    };
  }

  await reapStale(NAME_PREFIX);

  const port = await freePort();
  const name = `${NAME_PREFIX}${crypto.randomBytes(4).toString('hex')}`;
  const endpoint = `http://127.0.0.1:${port}`;
  const credentials = { region: 'us-east-1', accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY };

  await execFileAsync('docker', [
    'run', '--detach', '--rm',
    '--name', name,
    '--publish', `${port}:9000`,
    '--env', `MINIO_ROOT_USER=${ACCESS_KEY}`,
    '--env', `MINIO_ROOT_PASSWORD=${SECRET_KEY}`,
    IMAGE, 'server', '/data',
  ], { timeout: 180000 });

  // Deadline rather than a count of attempts. A refused connection comes
  // back instantly, so sixty attempts spaced by half a second gave up
  // after thirty seconds regardless of the interval, and a machine busy
  // pulling or building images needs longer than that. Failing there
  // looked like a broken test rather than a slow start.
  let ready = false;
  const deadline = Date.now() + READY_TIMEOUT;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${endpoint}/minio/health/live`, { signal: AbortSignal.timeout(2000) });
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
    // Whatever the container said on its way down, so a failure here is
    // diagnosable from the test output rather than needing a rerun that
    // may well not reproduce it.
    const diagnosis = await execFileAsync('docker', ['logs', '--tail', '20', name], { timeout: 10000 })
      .then(({ stdout, stderr }) => `${stdout}${stderr}`.trim())
      .catch((e) => `could not read container logs: ${e.message}`);
    await execFileAsync('docker', ['rm', '-f', name]).catch(() => {});
    throw new Error(
      `MinIO did not become ready at ${endpoint} within ${READY_TIMEOUT / 1000}s\n${diagnosis}`,
    );
  }

  return {
    endpoint,
    credentials,
    name,
    managed: true,

    // A fresh bucket per test keeps them independent.
    async bucket(bucketName = `citest${crypto.randomBytes(6).toString('hex')}`) {
      await createBucket(endpoint, bucketName, credentials);
      return bucketName;
    },

    // Configuration block for createStorage and for the conductor.
    storageConfig(bucketName) {
      return {
        endpoint,
        region: credentials.region,
        bucket: bucketName,
        access_key_id: credentials.accessKeyId,
        secret_access_key: credentials.secretAccessKey,
        force_path_style: true,
      };
    },

    async stop() {
      await execFileAsync('docker', ['rm', '-f', name], { timeout: 60000 }).catch(() => {});
    },
  };
}
