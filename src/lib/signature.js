// src/lib/signature.js - checking a request against a project's trigger secret
//
// Shared because the same secret authenticates both starting a job and
// reading one back, and a comparison this easy to get subtly wrong should
// exist once rather than once per caller.
//
// Two shapes are accepted, matching what the forges actually send:
// GitHub and Gitea sign the body, GitLab presents the secret itself.
//
// The HMAC is computed over the exact bytes received, which is why callers
// keep the raw body around rather than re-serializing the parsed one. A GET
// carries no body, so its signature is an HMAC over zero bytes.

import crypto from 'node:crypto';

export function verifySignature(req, secret) {
  const raw = req.rawBody ?? Buffer.alloc(0);

  // GitHub and Gitea: sha256=<hex> over the body.
  const hubSignature = req.headers['x-hub-signature-256'];
  if (typeof hubSignature === 'string' && hubSignature.length > 0) {
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
    return timingSafeEqual(expected, hubSignature);
  }

  // GitLab: the secret itself, compared rather than signed.
  const gitlabToken = req.headers['x-gitlab-token'];
  if (typeof gitlabToken === 'string' && gitlabToken.length > 0) {
    return timingSafeEqual(secret, gitlabToken);
  }

  return false;
}

export function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
