// src/lib/storage/sigv4.js - AWS Signature Version 4 signing
//
// Only what an S3 compatible object store needs: PUT, GET, HEAD, DELETE and
// presigned URLs. Written against node:crypto rather than pulling in the AWS
// SDK, which would add roughly a hundred transitive packages for four verbs.
//
// Verified against the published AWS test vectors, see test/sigv4.test.js.

import crypto from 'node:crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// RFC 3986 encoding. encodeURIComponent leaves ! ' ( ) * alone, which AWS
// expects to be percent encoded.
export function uriEncode(str, encodeSlash = true) {
  let out = '';
  for (const ch of String(str)) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else if (ch === '/') {
      out += encodeSlash ? '%2F' : '/';
    } else {
      for (const byte of Buffer.from(ch, 'utf8')) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}

// 20150830T123600Z and 20150830
export function amzDate(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amz: iso, stamp: iso.slice(0, 8) };
}

function canonicalQuery(searchParams) {
  const pairs = [];
  for (const [k, v] of searchParams) pairs.push([uriEncode(k), uriEncode(v)]);
  // Sort by encoded key, then encoded value.
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

// The canonical URI is the request path exactly as it goes on the wire.
// Callers must therefore hand in a URL whose path is already RFC 3986
// encoded, which is what uriEncode(key, false) produces. Encoding here
// instead would double encode, turning a %20 into %25 20 and yielding
// SignatureDoesNotMatch for any key containing a space or a plus.
//
// Note this is correct for S3 specifically. Other AWS services expect the
// path to be normalized and encoded a second time.
function canonicalPath(pathname) {
  return pathname === '' ? '/' : pathname;
}

function signingKey(secretAccessKey, stamp, region, service) {
  const kDate = hmac(`AWS4${secretAccessKey}`, stamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function buildCanonical({ method, url, headers, payloadHash }) {
  const lowered = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const canonicalHeaders = lowered.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = lowered.map(([k]) => k).join(';');

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  return { canonicalRequest, signedHeaders };
}

// Signs a request and returns the headers to send, including Authorization.
export function signRequest(opts) {
  const {
    method,
    url,
    headers = {},
    payloadHash = EMPTY_SHA256,
    region,
    service = 's3',
    accessKeyId,
    secretAccessKey,
    date = new Date(),
  } = opts;

  const target = url instanceof URL ? url : new URL(url);
  const { amz, stamp } = amzDate(date);

  const signedHeaderSet = {
    ...headers,
    host: target.host,
    'x-amz-date': amz,
  };
  if (service === 's3') signedHeaderSet['x-amz-content-sha256'] = payloadHash;

  const { canonicalRequest, signedHeaders } = buildCanonical({
    method,
    url: target,
    headers: signedHeaderSet,
    payloadHash,
  });

  const scope = `${stamp}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, amz, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKey(secretAccessKey, stamp, region, service))
    .update(stringToSign, 'utf8')
    .digest('hex');

  return {
    ...signedHeaderSet,
    authorization:
      `${ALGORITHM} Credential=${accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// Produces a presigned URL, where the signature travels in the query string
// and no Authorization header is needed.
export function presignUrl(opts) {
  const {
    method = 'GET',
    url,
    headers = {},
    expires = 3600,
    region,
    service = 's3',
    accessKeyId,
    secretAccessKey,
    date = new Date(),
  } = opts;

  const target = new URL(url instanceof URL ? url.toString() : url);
  const { amz, stamp } = amzDate(date);
  const scope = `${stamp}/${region}/${service}/aws4_request`;

  // Only host is signed, so the URL works from any client.
  const signedHeaderSet = { ...headers, host: target.host };
  const signedHeaders = Object.keys(signedHeaderSet)
    .map((k) => k.toLowerCase())
    .sort()
    .join(';');

  target.searchParams.set('X-Amz-Algorithm', ALGORITHM);
  target.searchParams.set('X-Amz-Credential', `${accessKeyId}/${scope}`);
  target.searchParams.set('X-Amz-Date', amz);
  target.searchParams.set('X-Amz-Expires', String(expires));
  target.searchParams.set('X-Amz-SignedHeaders', signedHeaders);

  const { canonicalRequest } = buildCanonical({
    method,
    url: target,
    headers: signedHeaderSet,
    payloadHash: UNSIGNED_PAYLOAD,
  });

  const stringToSign = [ALGORITHM, amz, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKey(secretAccessKey, stamp, region, service))
    .update(stringToSign, 'utf8')
    .digest('hex');

  target.searchParams.set('X-Amz-Signature', signature);
  return target.toString();
}
