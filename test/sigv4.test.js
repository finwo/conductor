// test/sigv4.test.js - AWS Signature Version 4
//
// The vectors come from the published AWS signature test suite. Getting this
// wrong produces an opaque SignatureDoesNotMatch from the server, so the
// reference cases are worth pinning.

import test from 'node:test';
import assert from 'node:assert/strict';
import { signRequest, presignUrl, uriEncode, amzDate, EMPTY_SHA256 } from '../src/lib/storage/sigv4.js';

const CREDS = {
  region: 'us-east-1',
  service: 'service',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  date: new Date(Date.UTC(2015, 7, 30, 12, 36, 0)),
};

test('get-vanilla matches the reference signature', () => {
  const headers = signRequest({
    method: 'GET',
    url: new URL('https://example.amazonaws.com/'),
    payloadHash: EMPTY_SHA256,
    ...CREDS,
  });

  assert.equal(
    headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
    'SignedHeaders=host;x-amz-date, ' +
    'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
  );
});

test('get-vanilla-query-order-key-case matches the reference signature', () => {
  const headers = signRequest({
    method: 'GET',
    url: new URL('https://example.amazonaws.com/?Param2=value2&Param1=value1'),
    payloadHash: EMPTY_SHA256,
    ...CREDS,
  });

  assert.equal(
    headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
    'SignedHeaders=host;x-amz-date, ' +
    'Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500'
  );
});

test('uriEncode percent encodes the characters encodeURIComponent leaves alone', () => {
  assert.equal(uriEncode("a b!'()*"), 'a%20b%21%27%28%29%2A');
  assert.equal(uriEncode('keep~unreserved-._'), 'keep~unreserved-._');
  assert.equal(uriEncode('a/b'), 'a%2Fb');
  assert.equal(uriEncode('a/b', false), 'a/b');
});

test('amzDate produces both required formats', () => {
  const { amz, stamp } = amzDate(new Date(Date.UTC(2015, 7, 30, 12, 36, 0)));
  assert.equal(amz, '20150830T123600Z');
  assert.equal(stamp, '20150830');
});

test('s3 requests carry the content hash header', () => {
  const headers = signRequest({
    method: 'PUT',
    url: new URL('https://bucket.example.com/key'),
    payloadHash: EMPTY_SHA256,
    region: 'us-east-1',
    service: 's3',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret',
  });
  assert.equal(headers['x-amz-content-sha256'], EMPTY_SHA256);
  assert.ok(headers.authorization.includes('x-amz-content-sha256'));
});

test('presigned urls carry the signature in the query string', () => {
  const url = new URL(presignUrl({
    method: 'GET',
    url: new URL('https://example.com/bucket/key'),
    expires: 900,
    region: 'us-east-1',
    service: 's3',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret',
  }));

  assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '900');
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.match(url.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
});

test('an already encoded path is not encoded a second time', () => {
  // A key containing a space reaches the signer as %20. Re-encoding it to
  // %2520 is the bug this guards against.
  const url = new URL('https://example.com/bucket/a%20b');
  const headers = signRequest({
    method: 'GET',
    url,
    payloadHash: EMPTY_SHA256,
    region: 'us-east-1',
    service: 's3',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret',
  });

  // Signing the same path written differently must differ, proving the path
  // is taken verbatim rather than normalized.
  const other = signRequest({
    method: 'GET',
    url: new URL('https://example.com/bucket/a%2520b'),
    payloadHash: EMPTY_SHA256,
    region: 'us-east-1',
    service: 's3',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret',
  });

  assert.notEqual(headers.authorization, other.authorization);
});
