// src/lib/db/params.js - bind value normalization shared by every driver
//
// Callers write portable application code and let this file absorb the
// differences between drivers. node:sqlite rejects booleans, undefined and
// Date objects outright; mysql2 and pg accept them but would each apply their
// own timestamp handling. Timestamps are epoch milliseconds everywhere, so
// Date values are flattened here rather than handed to any driver.

export function normalizeValue(v, key) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) {
      throw new Error(`bind parameter ${key ? `{${key}} ` : ''}is an invalid Date`);
    }
    return v.getTime();
  }
  if (typeof v === 'bigint') {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error(`bind parameter ${key ? `{${key}} ` : ''}exceeds the safe integer range: ${v}`);
    }
    return Number(v);
  }
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return v;

  // Objects and arrays are almost always a forgotten JSON.stringify, or a
  // dotted key that should have addressed a leaf. Both are worth catching.
  throw new Error(
    `bind parameter ${key ? `{${key}} ` : ''}has unsupported type ${
      Array.isArray(v) ? 'array' : typeof v
    }; serialize it first, or address a nested value with a dotted key`
  );
}
