// web/src/util/api.ts - the conductor's API, unwrapped

import { bearer, forget, refresh, signedIn } from './auth';

export type Page<T> = { rows: T[]; offset: number; total: number; next?: string };

export class ApiError extends Error {
  name: string;
  status: number;
  details?: unknown;

  constructor(status: number, body: { name?: string; message?: string; details?: unknown }) {
    super(body.message || `request failed: ${status}`);
    this.name = body.name || 'Error';
    this.status = status;
    this.details = body.details;
  }
}

type Options = {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
};

function urlFor(path: string, query?: Options['query']): string {
  const url = new URL(`api/v1${path}`, location.origin + location.pathname);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.pathname + url.search;
}

async function send(url: string, options: Options, token: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  return fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function authorized(url: string, options: Options): Promise<Response> {
  const res = await send(url, options, await bearer());
  if (res.status !== 401 || !signedIn()) return res;

  try {
    await refresh();
  } catch {
    forget();
  }
  return send(url, options, await bearer());
}

export async function request<T>(path: string, options: Options = {}): Promise<T> {
  const url = path.startsWith('http') ? path : urlFor(path, options.query);
  const res = await authorized(url, options);

  if (res.status === 204) return undefined as T;

  let body: { ok?: boolean; data?: T; error?: { name?: string; message?: string; details?: unknown } };
  try {
    body = await res.json();
  } catch {
    throw new ApiError(res.status, { message: `the conductor did not answer in JSON (${res.status})` });
  }

  if (!res.ok || body.ok === false) throw new ApiError(res.status, body.error ?? {});
  return body.data as T;
}

// The envelope's pagination, flattened onto the rows it describes.
export async function page<T>(path: string, options: Options = {}): Promise<Page<T>> {
  const url = path.startsWith('http') ? path : urlFor(path, options.query);
  const res = await authorized(url, options);

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new ApiError(res.status, body.error ?? {});

  const block = body.pagination ?? { offset: 0, total: (body.data ?? []).length };
  return { rows: body.data ?? [], offset: block.offset, total: block.total, next: block.next };
}

export const get = <T>(path: string, query?: Options['query']) => request<T>(path, { query });
export const post = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body });
export const patch = <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body });
export const put = <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body });
export const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });
