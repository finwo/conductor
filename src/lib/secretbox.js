// src/lib/secretbox.js - encryption at rest for stored secrets
//
// Used for project trigger secrets and project variables. When
// secrets.encryption_key is configured, values are sealed with AES-256-GCM.
// When it is not, values are stored base64 encoded and clearly marked as
// plaintext, so that an operator can tell at a glance which rows are
// protected and a later key rollout can find what needs upgrading.
//
// Stored format is a dotted, self describing string:
//   v1.<iv>.<tag>.<ciphertext>   sealed, all parts base64
//   plain.<value>                 not encrypted, value base64
//
// The optional aad argument binds a ciphertext to its location, so a row
// copied into a different project or variable name fails to open.

import crypto from 'node:crypto';

const IV_BYTES = 12;

export function createSecretBox(key) {
  const enabled = Boolean(key);
  if (enabled && (!Buffer.isBuffer(key) || key.length !== 32)) {
    throw new Error('secret box key must be a 32 byte Buffer');
  }

  return {
    enabled,

    seal(plaintext, aad) {
      if (typeof plaintext !== 'string') throw new Error('secret value must be a string');
      if (!enabled) return `plain.${Buffer.from(plaintext, 'utf8').toString('base64')}`;

      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
    },

    open(stored, aad) {
      if (typeof stored !== 'string' || stored.length === 0) {
        throw new Error('stored secret is empty');
      }

      if (stored.startsWith('plain.')) {
        return Buffer.from(stored.slice(6), 'base64').toString('utf8');
      }

      if (!stored.startsWith('v1.')) {
        throw new Error('stored secret has an unrecognised format');
      }
      if (!enabled) {
        throw new Error(
          'stored secret is encrypted but secrets.encryption_key is not configured; ' +
          'set it to the key this value was sealed with'
        );
      }

      const parts = stored.split('.');
      if (parts.length !== 4) throw new Error('stored secret is malformed');
      const [, ivB64, tagB64, ctB64] = parts;

      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
      try {
        return Buffer.concat([
          decipher.update(Buffer.from(ctB64, 'base64')),
          decipher.final(),
        ]).toString('utf8');
      } catch (e) {
        throw new Error(
          'stored secret failed to decrypt; the encryption key may have changed, ' +
          'or the value was moved between rows',
          { cause: e }
        );
      }
    },

    // True when a value is stored without encryption, so an admin endpoint
    // can report what a key rollout would need to re-seal.
    isPlaintext(stored) {
      return typeof stored === 'string' && stored.startsWith('plain.');
    },
  };
}
