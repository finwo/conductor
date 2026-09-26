// src/lib/page.js - windows over the tables that grow without bound
//
// A window is one page of rows plus the total behind them. The total is
// counted under the same conditions as the rows, from the same FROM and
// WHERE, so a visibility rule cannot promise a page that turns out empty.
//
// LIMIT and OFFSET are bound rather than pasted in. All three dialects
// accept that, and retention already relies on it.

export const API_LIMIT = 50;
export const API_MAX_LIMIT = 200;

// A query string gives strings, a json body gives numbers, and both are
// accepted so the two ways of asking cannot disagree.
function asInt(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : NaN;
  return Number.parseInt(typeof value === 'string' ? value : '', 10);
}

// Anything unusable reads as the default, and the cap applies silently: a
// client asking for everything gets a page, not an error to learn about.
export function limitOf(query, fallback = API_LIMIT, max = API_MAX_LIMIT) {
  const n = asInt(query?.limit);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export function offsetOfQuery(query, max = API_MAX_LIMIT) {
  const n = asInt(query?.offset);
  if (!Number.isFinite(n) || n < 0) return 0;
  // Far enough out that offset + limit stays a safe integer.
  return Math.min(n, Number.MAX_SAFE_INTEGER - max);
}

// next is absent on the last page, so following pages needs no special case.
export function pageBlock({ url, offset, limit, total }) {
  const block = {};

  const after = offset + limit;
  if (after < total) {
    const next = new URL(url);
    next.searchParams.set('offset', String(after));
    next.searchParams.set('limit', String(limit));
    block.next = next.toString();
  }

  block.offset = offset;
  block.total = total;
  return block;
}

// The offset twin of paginate, sharing from and where for the same reason.
export async function paginateOffset(db, {
  select, from, where = '1 = 1', order, params = {}, offset, limit,
}) {
  const rows = await db.all(
    `SELECT ${select} FROM ${from} WHERE ${where} ORDER BY ${order}
      LIMIT {pageSize} OFFSET {pageFrom}`,
    { ...params, pageSize: limit, pageFrom: offset }
  );

  const counted = await db.get(
    `SELECT COUNT(*) AS total FROM ${from} WHERE ${where}`,
    params
  );

  return { rows, total: Number(counted?.total ?? 0), offset, limit };
}
