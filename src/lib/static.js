// src/lib/static.js - the built application bundle
//
// The directory is read once at startup and the routes are built from what
// was actually found, so nothing can be requested that is not on disk and
// path traversal is impossible by construction rather than by escaping.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WEB_DIR = path.resolve(HERE, '../../web/dist');

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// Nothing in the bundle is inline, which is what makes this possible, and it
// is what keeps a refresh token in local storage from being readable by an
// injected script.
export function contentSecurityPolicy(connect = []) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${connect.length > 0 ? ` ${connect.join(' ')}` : ''}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

async function collect(dir, base = '') {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // A tree with no build simply serves nothing.
    return out;
  }

  for (const entry of entries) {
    const route = `${base}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await collect(path.join(dir, entry.name), route));
    else if (entry.isFile()) out.push({ route, file: path.join(dir, entry.name) });
  }
  return out;
}

export default async function staticRoutes(fastify, { dir = WEB_DIR, csp = contentSecurityPolicy() } = {}) {
  const cache = new Map();

  for (const { route, file } of await collect(dir)) {
    const body = await fs.readFile(file);
    cache.set(route, {
      body,
      type: TYPES[path.extname(file)] ?? 'application/octet-stream',
      etag: `"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 32)}"`,
    });
  }

  const index = cache.get('/index.html');

  function serve(reply, entry, req) {
    if (req.headers['if-none-match'] === entry.etag) return reply.code(304).send();
    reply.header('content-type', entry.type);
    reply.header('etag', entry.etag);
    reply.header('cache-control', 'no-cache');
    if (entry === index) reply.header('content-security-policy', csp);
    return reply.send(entry.body);
  }

  for (const [route, entry] of cache) {
    fastify.get(route, async (req, reply) => serve(reply, entry, req));
    if (route === '/index.html') fastify.get('/', async (req, reply) => serve(reply, entry, req));
  }

  if (!index) return;

  // The application routes client side, so a deep link is a page request
  // rather than a missing file. The API answers its own 404s inside its own
  // prefix, so those are unaffected.
  fastify.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || !(req.headers.accept ?? '').includes('text/html')) {
      return reply.code(404).send({ ok: false, error: { name: 'NotFound', message: 'not found' } });
    }
    return serve(reply, index, req);
  });
}
