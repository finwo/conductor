// src/lib/storage/s3.js - S3 compatible object storage
//
// Engaged as soon as storage.s3.bucket is configured. Tested against Garage
// and MinIO, which both need path style addressing; set force_path_style to
// false for AWS S3 proper.
//
// Requests go out over fetch with SigV4 headers.
//
// Large uploads go through multipart, one part at a time. Handing a stream
// to fetch does not stream it: undici collects the whole body before
// sending, which was measured at just over a gigabyte of live heap for a
// one gigabyte artifact. Build output is routinely that size, so a single
// upload could exhaust the conductor. Multipart also lifts the five
// gigabyte ceiling on a single PUT, and lets an upload proceed when the
// total length is not known in advance.
//
// Small bodies still go as one request, since three round trips to save
// buffering a few megabytes is a poor trade.

import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { signRequest, presignUrl, sha256Hex, uriEncode } from './sigv4.js';
import { StorageNotFound, assertKey } from './key.js';

// Replays what has already been read, then continues with the rest.
async function* concatSources(head, rest) {
  yield head;
  yield* rest;
}

// S3 requires every part except the last to be at least 5 MiB, and allows
// at most 10000 parts. The default part size is comfortably above the
// minimum, and is scaled up when the total is large enough that 10000
// parts would not cover it.
const MIN_PART_SIZE = 5 * 1024 * 1024;
const DEFAULT_PART_SIZE = 16 * 1024 * 1024;
const MAX_PARTS = 10000;

// Below this a stream is collected and sent as one request.
const SINGLE_PUT_MAX = 32 * 1024 * 1024;

export function partSizeFor(size) {
  if (!Number.isFinite(size) || size <= 0) return DEFAULT_PART_SIZE;
  const needed = Math.ceil(size / (MAX_PARTS - 1));
  const rounded = Math.ceil(needed / (1024 * 1024)) * 1024 * 1024;
  return Math.max(DEFAULT_PART_SIZE, MIN_PART_SIZE, rounded);
}

// Regroups an arbitrarily chunked stream into buffers of a fixed size, so
// memory stays bounded by the part size no matter how the source behaves.
export async function* inParts(source, partSize) {
  let held = [];
  let heldLength = 0;

  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    held.push(buffer);
    heldLength += buffer.length;

    while (heldLength >= partSize) {
      const joined = Buffer.concat(held, heldLength);
      yield joined.subarray(0, partSize);
      const rest = joined.subarray(partSize);
      held = rest.length > 0 ? [rest] : [];
      heldLength = rest.length;
    }
  }

  if (heldLength > 0) yield Buffer.concat(held, heldLength);
}

// Values inside S3 XML are hex digests and quotes, but escaping keeps a
// surprising key or ETag from breaking the document.
function xmlEscape(value) {
  return String(value).replace(/[<>&'"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ));
}

function firstTag(xml, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? match[1] : null;
}

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

  async function send(method, key, { headers = {}, body, payloadHash, query } = {}) {
    const url = objectUrl(key);
    // Query parameters are part of the signature, so they must be set
    // before signing and not touched afterwards.
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);

    const signed = signRequest({
      method,
      url,
      headers,
      payloadHash: payloadHash ?? sha256Hex(''),
      ...creds,
    });

    const init = { method, headers: signed };
    if (body !== undefined) init.body = body;
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

  // One request, for a body already in memory.
  async function putBuffer(key, buffer, contentType) {
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    const headers = { 'content-length': String(buffer.length) };
    if (contentType) headers['content-type'] = contentType;

    const res = await send('PUT', key, { headers, body: buffer, payloadHash: digest });
    if (!res.ok) throw await errorFrom(res, 'put', key);
    await res.arrayBuffer();

    return { key, size: buffer.length, sha256: digest };
  }

  async function createMultipart(key, contentType) {
    const headers = {};
    if (contentType) headers['content-type'] = contentType;

    const res = await send('POST', key, { headers, query: { uploads: '' }, body: undefined });
    if (!res.ok) throw await errorFrom(res, 'create multipart upload', key);

    const uploadId = firstTag(await res.text(), 'UploadId');
    if (!uploadId) throw new Error(`s3 did not return an upload id for ${key}`);
    return uploadId;
  }

  async function uploadPart(key, uploadId, partNumber, buffer) {
    const res = await send('PUT', key, {
      headers: { 'content-length': String(buffer.length) },
      query: { partNumber: String(partNumber), uploadId },
      body: buffer,
      payloadHash: crypto.createHash('sha256').update(buffer).digest('hex'),
    });
    if (!res.ok) throw await errorFrom(res, `upload part ${partNumber}`, key);
    await res.arrayBuffer();

    const etag = res.headers.get('etag');
    if (!etag) throw new Error(`s3 did not return an ETag for part ${partNumber} of ${key}`);
    return etag;
  }

  async function completeMultipart(key, uploadId, parts) {
    const body = Buffer.from(
      '<CompleteMultipartUpload>' +
      parts.map((p) => `<Part><PartNumber>${p.number}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`).join('') +
      '</CompleteMultipartUpload>',
      'utf8'
    );

    const res = await send('POST', key, {
      headers: { 'content-length': String(body.length), 'content-type': 'application/xml' },
      query: { uploadId },
      body,
      payloadHash: crypto.createHash('sha256').update(body).digest('hex'),
    });
    if (!res.ok) throw await errorFrom(res, 'complete multipart upload', key);

    // S3 can report failure inside a 200 response, because the connection
    // is held open while the parts are assembled.
    const text = await res.text();
    if (/<Error>/.test(text)) {
      const code = firstTag(text, 'Code') ?? 'unknown';
      throw new Error(`s3 complete multipart upload failed for ${key}: ${code}`);
    }
  }

  async function abortMultipart(key, uploadId) {
    // Parts left behind are billable and invisible, so this matters even
    // though nothing depends on its result.
    const res = await send('DELETE', key, { query: { uploadId } });
    await res.arrayBuffer().catch(() => {});
  }

  async function putMultipart(key, source, { contentType, size }) {
    const uploadId = await createMultipart(key, contentType);
    const partSize = partSizeFor(size);
    const hash = crypto.createHash('sha256');
    const parts = [];
    let total = 0;

    // Parts go up one at a time. Overlapping them was measured at about
    // eight percent faster while doubling peak memory, which is not a
    // trade worth the extra failure handling.
    try {
      for await (const part of inParts(source, partSize)) {
        hash.update(part);
        total += part.length;
        if (parts.length >= MAX_PARTS) {
          throw new Error(`s3 upload of ${key} exceeded ${MAX_PARTS} parts`);
        }
        const etag = await uploadPart(key, uploadId, parts.length + 1, part);
        parts.push({ number: parts.length + 1, etag });
      }

      // A multipart upload must have at least one part.
      if (parts.length === 0) {
        parts.push({ number: 1, etag: await uploadPart(key, uploadId, 1, Buffer.alloc(0)) });
      }

      if (size !== undefined && size !== total) {
        throw new Error(`s3 put size mismatch for ${key}: declared ${size}, read ${total}`);
      }

      await completeMultipart(key, uploadId, parts);
    } catch (e) {
      await abortMultipart(key, uploadId).catch(() => {});
      throw e;
    }

    return { key, size: total, sha256: hash.digest('hex') };
  }

  return {
    driver: 's3',

    async put(key, body, opts = {}) {
      assertKey(key);

      if (Buffer.isBuffer(body) || typeof body === 'string') {
        return putBuffer(key, Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'), opts.contentType);
      }

      const source = body instanceof Readable ? body : Readable.from(body);

      // Small and of known length: collect it and send one request rather
      // than paying for three.
      if (opts.size !== undefined && opts.size <= SINGLE_PUT_MAX) {
        const chunks = [];
        let length = 0;
        for await (const chunk of source) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          chunks.push(buffer);
          length += buffer.length;
          if (length > SINGLE_PUT_MAX) break;
        }

        if (length <= SINGLE_PUT_MAX) {
          const buffer = Buffer.concat(chunks, length);
          if (opts.size !== buffer.length) {
            throw new Error(`s3 put size mismatch for ${key}: declared ${opts.size}, read ${buffer.length}`);
          }
          return putBuffer(key, buffer, opts.contentType);
        }

        // It was larger than it claimed; carry on as multipart without
        // losing what has already been read.
        const head = Buffer.concat(chunks, length);
        return putMultipart(key, concatSources(head, source), {
          contentType: opts.contentType,
          size: opts.size,
        });
      }

      return putMultipart(key, source, { contentType: opts.contentType, size: opts.size });
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

    // Lets a download redirect straight at the object store
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
