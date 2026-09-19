// src/lib/static.js - the interface's static assets
//
// Pages are rendered by the server, so the only static files are the
// stylesheet and the vendored htmx build. An allowlist is used rather than
// a general static file server: nothing can be requested that is not named
// here, which makes path traversal impossible by construction rather than
// by careful escaping.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ASSET_DIR = path.resolve(HERE, '../../assets');

const FILES = {
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/vendor/htmx.min.js': { file: 'vendor/htmx.min.js', type: 'text/javascript; charset=utf-8' },
  '/vendor/htmx-LICENSE.txt': { file: 'vendor/htmx-LICENSE.txt', type: 'text/plain; charset=utf-8' },
};

export default async function staticRoutes(fastify, { dir = ASSET_DIR } = {}) {
  // Read once at startup. These are small and never change at runtime.
  const cache = new Map();

  for (const [route, entry] of Object.entries(FILES)) {
    let body;
    try {
      body = await fs.readFile(path.join(dir, entry.file));
    } catch {
      // A deployment that does not ship the assets simply has no styling.
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
