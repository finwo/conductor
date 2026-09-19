// src/lib/static.js - serving the dashboard
//
// The dashboard is three files, so an allowlist is used rather than a
// general static file server. Nothing can be requested that is not named
// here, which makes path traversal impossible by construction instead of by
// careful escaping.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DASHBOARD_DIR = path.resolve(HERE, '../../dashboard');

const FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

export default async function staticRoutes(fastify, { dir = DASHBOARD_DIR } = {}) {
  // Read once at startup. These are small and never change at runtime.
  const cache = new Map();

  for (const [route, entry] of Object.entries(FILES)) {
    let body;
    try {
      body = await fs.readFile(path.join(dir, entry.file));
    } catch {
      // A deployment that does not ship the dashboard simply has no UI.
      continue;
    }
    const etag = `"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
    cache.set(route, { body, type: entry.type, etag });
  }

  for (const [route, entry] of cache) {
    fastify.get(route, async (req, reply) => {
      if (req.headers['if-none-match'] === entry.etag) return reply.code(304).send();
      reply.header('content-type', entry.type);
      reply.header('etag', entry.etag);
      reply.header('cache-control', 'no-cache');
      return reply.send(entry.body);
    });
  }
}
