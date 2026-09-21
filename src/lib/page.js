// src/lib/page.js - windows over the tables that grow without bound
//
// A window is one page of rows plus the total behind them. The total is
// counted under the same conditions as the rows, from the same FROM and
// WHERE, so a visibility rule cannot promise a page that turns out empty.
//
// LIMIT and OFFSET are bound rather than pasted in. All three dialects
// accept that, and retention already relies on it.

export const PER_PAGE = 25;

// A page number out of a query string. Anything unusable reads as the
// first page: a mistyped url should still answer with a table.
export function pageOf(query, perPage = PER_PAGE) {
  const raw = query?.page;
  const n = Number.parseInt(typeof raw === 'string' ? raw : '', 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  // Far enough out that the offset stays a sane integer.
  return Math.min(n, Math.ceil(Number.MAX_SAFE_INTEGER / perPage));
}

export function offsetOf(page, perPage = PER_PAGE) {
  return (page - 1) * perPage;
}

// Describes a page of rows for whoever renders it.
export function windowOf({ rows, total, page, perPage = PER_PAGE }) {
  const from = offsetOf(page, perPage);
  return {
    rows,
    total,
    page,
    perPage,
    pages: Math.max(1, Math.ceil(total / perPage)),
    // 1 based and inclusive, for "11 to 20 of 57".
    first: rows.length === 0 ? 0 : from + 1,
    last: from + rows.length,
  };
}

// Runs the rows and their count as one window. Sharing from and where
// between the two is the whole point; they cannot drift apart.
export async function paginate(db, {
  select, from, where = '1 = 1', order, params = {}, page, perPage = PER_PAGE,
}) {
  const rows = await db.all(
    `SELECT ${select} FROM ${from} WHERE ${where} ORDER BY ${order}
      LIMIT {pageSize} OFFSET {pageFrom}`,
    { ...params, pageSize: perPage, pageFrom: offsetOf(page, perPage) }
  );

  const counted = await db.get(
    `SELECT COUNT(*) AS total FROM ${from} WHERE ${where}`,
    params
  );

  return windowOf({ rows, total: Number(counted?.total ?? 0), page, perPage });
}

// For a list already in memory, where the source is not a single query.
export function windowOfAll(all, page, perPage = PER_PAGE) {
  const from = offsetOf(page, perPage);
  return windowOf({ rows: all.slice(from, from + perPage), total: all.length, page, perPage });
}

// --- offset windows, for the API ---
//
// The interface pages by number because a person reads "page 3 of 7". A
// program asks from an offset and follows the url it is handed.

export const API_LIMIT = 50;
export const API_MAX_LIMIT = 200;

// Anything unusable reads as the default, and the cap applies silently: a
// client asking for everything gets a page, not an error to learn about.
export function limitOf(query, fallback = API_LIMIT, max = API_MAX_LIMIT) {
  const n = Number.parseInt(typeof query?.limit === 'string' ? query.limit : '', 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export function offsetOfQuery(query, max = API_MAX_LIMIT) {
  const n = Number.parseInt(typeof query?.offset === 'string' ? query.offset : '', 10);
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
