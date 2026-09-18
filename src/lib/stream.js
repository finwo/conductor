// src/lib/stream.js - stream helpers
//
// Note for anyone tempted to hash with a 'data' listener on a PassThrough:
// attaching one switches the stream into flowing mode immediately, so the
// bytes are gone before the real consumer attaches and the upload silently
// stores nothing. A Transform stays paused until something reads it, and
// keeps backpressure intact.

import crypto from 'node:crypto';
import { Transform } from 'node:stream';

export function hashingTransform(algorithm = 'sha256') {
  const hash = crypto.createHash(algorithm);
  let bytes = 0;

  const transform = new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });

  transform.digest = () => hash.digest('hex');
  transform.bytes = () => bytes;
  return transform;
}
