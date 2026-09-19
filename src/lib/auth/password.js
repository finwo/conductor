// src/lib/auth/password.js - password hashing
//
// scrypt from node:crypto, so there is no native module to build and no
// dependency to audit. Parameters are stored alongside the hash, which lets
// them be raised later without invalidating existing passwords.
//
// Format: scrypt$N$r$p$salt$hash, salt and hash base64.

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// 16384 * 8 * 128 bytes is 16 MB of memory per hash, which is the usual
// interactive-login setting and comfortably inside node's default maxmem.
export const DEFAULT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

const MIN_LENGTH = 8;
const MAX_LENGTH = 1024;

export function validatePassword(password) {
  if (typeof password !== 'string') return 'password must be a string';
  if (password.length < MIN_LENGTH) return `password must be at least ${MIN_LENGTH} characters`;
  if (password.length > MAX_LENGTH) return `password must be at most ${MAX_LENGTH} characters`;
  return null;
}

export async function hashPassword(password, params = DEFAULT_PARAMS) {
  const problem = validatePassword(password);
  if (problem) throw new Error(problem);

  const { N, r, p, keylen } = params;
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, keylen, { N, r, p, maxmem: 256 * N * r });
  return ['scrypt', N, r, p, salt.toString('base64'), derived.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = parseInt(parts[1], 10);
  const r = parseInt(parts[2], 10);
  const p = parseInt(parts[3], 10);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived;
  try {
    derived = await scrypt(password, salt, expected.length, { N, r, p, maxmem: 256 * N * r });
  } catch {
    return false;
  }

  return crypto.timingSafeEqual(derived, expected);
}

// Used when generating a bootstrap password, which is shown once and then
// only ever stored as a hash.
export function generatePassword(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url');
}
