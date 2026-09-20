// test/helpers/database.js - real postgres and mysql for the tests
//
// The suite otherwise jobs entirely on sqlite, which means the postgres
// and mysql migrations and the dialect specific query compilation were
// only ever read, never executed. A migration that does not apply, or a
// query that binds its parameters in a way one driver dislikes, would
// reach whoever jobs that database rather than the test suite.
//
// Set CONDUCTOR_TEST_POSTGRES_URL or CONDUCTOR_TEST_MYSQL_URL to use a
// server you already have instead of starting a container.

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import net from 'node:net';

import { openDatabase, dialectFromUrl } from '../../src/lib/db/index.js';
import { reapStale } from './containers.js';

const execFileAsync = promisify(execFile);

// Pinned, so an upstream release cannot change what is being tested
// against without the change being visible here.
export const IMAGES = {
  postgres: 'postgres:16-alpine',
  mysql: 'mysql:8.4',
};

const READY_TIMEOUT = 180 * 1000;
const NAME_PREFIX = 'conductor-db-test-';
const PASSWORD = 'conductortestpassword';

// Checked synchronously: the runner needs to know whether to skip while
// it is collecting tests, and an unsettled top-level await at that point
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

// Whether a given dialect can be exercised: a url was supplied, or docker
// is here to start one. The drivers are optional dependencies, so a
// checkout that skipped them cannot job these either.
export function dialectAvailable(dialect) {
  if (envUrl(dialect)) return true;
  if (!dockerAvailableSync()) return false;
  try {
    // require rather than import, to stay synchronous for the same reason.
    import.meta.resolve(dialect === 'postgres' ? 'pg' : 'mysql2');
    return true;
  } catch {
    return false;
  }
}

function envUrl(dialect) {
  return dialect === 'postgres'
    ? process.env.CONDUCTOR_TEST_POSTGRES_URL
    : process.env.CONDUCTOR_TEST_MYSQL_URL;
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

// Whether the server is actually usable yet.
//
// Not pg_isready or mysqladmin ping over docker exec, which is the
// obvious choice and the wrong one: both images job a temporary server
// during initialisation to create the database, and those clients answer
// for it over the local socket. The probe then passes, the temporary
// server shuts down, and the first real query dies with ECONNRESET.
//
// Both images keep that temporary server off the network, so connecting
// over the published port and running a statement is the thing that
// cannot be satisfied early.
async function probe(url) {
  let db;
  try {
    db = await openDatabase({ database: { url, dialect: dialectFromUrl(url) } });
    await db.get('SELECT 1 AS ok', {});
    return true;
  } catch {
    return false;
  } finally {
    await db?.close().catch(() => {});
  }
}

// Starts one, returning its url and a stop function. Each caller gets its
// own database so tests cannot see each other's rows.
export async function startDatabase(dialect) {
  const supplied = envUrl(dialect);
  if (supplied) {
    return { url: supplied, async stop() {} };
  }

  await reapStale(NAME_PREFIX);

  const name = `${NAME_PREFIX}${dialect}-${crypto.randomBytes(4).toString('hex')}`;
  const port = await freePort();
  const inner = dialect === 'postgres' ? 5432 : 3306;

  const env = dialect === 'postgres'
    ? [
      '--env', 'POSTGRES_USER=conductor',
      '--env', `POSTGRES_PASSWORD=${PASSWORD}`,
      '--env', 'POSTGRES_DB=conductor',
    ]
    : [
      '--env', `MYSQL_ROOT_PASSWORD=${PASSWORD}`,
      '--env', 'MYSQL_DATABASE=conductor',
    ];

  await execFileAsync('docker', [
    'run', '--detach', '--rm',
    '--name', name,
    '--publish', `127.0.0.1:${port}:${inner}`,
    // Nothing here outlives the test, so durability is only a cost.
    '--tmpfs', dialect === 'postgres' ? '/var/lib/postgresql/data' : '/var/lib/mysql',
    ...env,
    IMAGES[dialect],
  ], { timeout: 300000 });

  const stop = async () => {
    await execFileAsync('docker', ['rm', '-f', name], { timeout: 60000 }).catch(() => {});
  };

  const url = dialect === 'postgres'
    ? `postgres://conductor:${PASSWORD}@127.0.0.1:${port}/conductor`
    : `mysql://root:${PASSWORD}@127.0.0.1:${port}/conductor`;

  const deadline = Date.now() + READY_TIMEOUT;
  let ready = false;
  while (Date.now() < deadline) {
    if (await probe(url)) {
      ready = true;
      break;
    }
    await new Promise((r) => { setTimeout(r, 500); });
  }

  if (!ready) {
    const diagnosis = await execFileAsync('docker', ['logs', '--tail', '20', name], { timeout: 10000 })
      .then(({ stdout, stderr }) => `${stdout}${stderr}`.trim())
      .catch((e) => `could not read container logs: ${e.message}`);
    await stop();
    throw new Error(`${dialect} did not become ready within ${READY_TIMEOUT / 1000}s\n${diagnosis}`);
  }

  return { url, stop };
}
