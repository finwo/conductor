// src/lib/storage/s3.js - S3 compatible object storage
//
// Engaged as soon as storage.s3.bucket is configured. Tested against Garage
// and MinIO, which both need path style addressing; set force_path_style to
// false for AWS S3 proper.
//
// Requests go out over fetch with SigV4 headers. Uploads of a known Buffer
// are signed over their content hash; streamed uploads use UNSIGNED-PAYLOAD,
// which every S3 implementation accepts and which avoids buffering an entire
// artifact in memory just to hash it.

import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { signRequest, presignUrl, sha256Hex, uriEncode, UNSIGNED_PAYLOAD } from './sigv4.js';
import { StorageNotFound, assertKey } from './key.js';

export function createS3Storage(cfg) {
  const s3 = cfg.storage.s3;
  const endpoint = new URL(s3.endpoint);
  const creds = {
    region: s3.region,
    accessKeyId: s3.access_key_id,
    secretAccessKey: s3.secret_access_key,
  };

  // Any path prefix on the endpoint is preserved, so an S3 gateway mounted
  // under a subpath keeps working.
  const prefix = endpoint.pathname.replace(/\/+$/, '');

  function objectUrl(key) {
    assertKey(key);
    const url = new URL(endpoint.toString());
    // The signer treats the path as final, so encode it here and exactly
    // once. Slashes stay literal to keep the key hierarchy intact.
    const encoded = uriEncode(key, false);
    if (s3.force_path_style) {
      url.pathname = `${prefix}/${s3.bucket}/${encoded}`;
    } else {
      url.host = `${s3.bucket}.${endpoint.host}`;
      url.pathname = `${prefix}/${encoded}`;
    }
    return url;
  }

  async function send(method, key, { headers = {}, body, payloadHash } = {}) {
    const url = objectUrl(key);
    const signed = signRequest({
      method,
      url,
      headers,
      payloadHash: payloadHash ?? sha256Hex(''),
      ...creds,
    });

    const init = { method, headers: signed };
    if (body !== undefined) {
      init.body = body;
      // Required by undici when streaming a request body.
      if (body instanceof ReadableStream) init.duplex = 'half';
    }
    return fetch(url, init);
  }

  async function errorFrom(res, action, key) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 512);
    } catch {
      // The status alone is still useful.
    }
    return new Error(`s3 ${action} failed for ${key}: ${res.status} ${res.statusText}\n${detail}`);
  }

  return {
    driver: 's3',

    async put(key, body, opts = {}) {
      const headers = {};
      if (opts.contentType) headers['content-type'] = opts.contentType;

      let payload;
      let payloadHash;
      let size = opts.size;
      let sha256 = opts.sha256;

      if (Buffer.isBuffer(body) || typeof body === 'string') {
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
        payload = buf;
        sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        payloadHash = sha256;
        size = buf.length;
        headers['content-length'] = String(size);
      } else {
        if (size === undefined) {
          throw new Error(
            `s3 put of a stream needs an explicit size for ${key}; ` +
            'buffer the object first if the length is unknown'
          );
        }
        payloadHash = UNSIGNED_PAYLOAD;
        headers['content-length'] = String(size);
        payload = body instanceof Readable ? Readable.toWeb(body) : body;
      }

      const res = await send('PUT', key, { headers, body: payload, payloadHash });
      if (!res.ok) throw await errorFrom(res, 'put', key);
      await res.arrayBuffer();

      return { key, size, sha256: sha256 ?? null };
    },

    async get(key, opts = {}) {
      const headers = {};
      if (opts.range) {
        const { start = 0, end } = opts.range;
        headers.range = `bytes=${start}-${end === undefined ? '' : end}`;
      }

      const res = await send('GET', key, { headers });
      if (res.status === 404) throw new StorageNotFound(key);
      if (!res.ok) throw await errorFrom(res, 'get', key);

      const len = res.headers.get('content-length');
      return {
        key,
        size: len === null ? null : Number(len),
        stream: Readable.fromWeb(res.body),
      };
    },

    async head(key) {
      const res = await send('HEAD', key);
      if (res.status === 404) return null;
      if (!res.ok) throw await errorFrom(res, 'head', key);
      const len = res.headers.get('content-length');
      const modified = res.headers.get('last-modified');
      return {
        key,
        size: len === null ? null : Number(len),
        modified: modified ? Date.parse(modified) : null,
      };
    },

    async delete(key) {
      const res = await send('DELETE', key);
      // A missing object is already in the desired state.
      if (!res.ok && res.status !== 404) throw await errorFrom(res, 'delete', key);
      await res.arrayBuffer();
    },

    // Lets the read-api redirect a client straight at the object store
    // instead of proxying the bytes.
    async presign(key, opts = {}) {
      return presignUrl({
        method: opts.method || 'GET',
        url: objectUrl(key),
        expires: opts.expires ?? 3600,
        ...creds,
      });
    },
  };
}
