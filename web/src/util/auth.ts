// web/src/util/auth.ts - the authorization code flow, against either provider
//
// The conductor answers discovery for both its own login page and a
// configured provider, so there is one code path here rather than two.

const STORE = 'conductor.refresh';
const PENDING = 'conductor.pending';
const IDENTITY = 'conductor.identity';

export type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
  revocation_endpoint?: string;
  client_id: string;
  scopes?: string;
};

let discovery: Discovery | null = null;
let accessToken: string | null = null;
let expiresAt = 0;

function encode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function random(): string {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return encode(new Uint8Array(digest));
}

// The fragment is the router's, so the code comes back on the query instead.
function redirectUri(): string {
  return location.origin + location.pathname;
}

export function refreshToken(): string | null {
  return localStorage.getItem(STORE);
}

export function signedIn(): boolean {
  return refreshToken() !== null;
}

export async function load(): Promise<Discovery> {
  if (discovery) return discovery;
  const res = await fetch('.well-known/openid-configuration');
  if (!res.ok) throw new Error(`discovery failed: ${res.status}`);
  discovery = await res.json();
  return discovery as Discovery;
}

export async function signIn(): Promise<void> {
  const doc = await load();
  const verifier = random();
  const state = random();
  sessionStorage.setItem(PENDING, JSON.stringify({ verifier, state, at: location.hash }));

  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', doc.client_id);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('scope', doc.scopes || 'openid');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await challengeFor(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  location.assign(url.toString());
}

// Returns where the browser was headed before it was sent to sign in.
export async function completeSignIn(): Promise<string | null> {
  const query = new URLSearchParams(location.search);
  const code = query.get('code');
  const error = query.get('error');
  if (!code && !error) return null;

  const raw = sessionStorage.getItem(PENDING);
  sessionStorage.removeItem(PENDING);
  history.replaceState(null, '', redirectUri() + location.hash);

  if (error) throw new Error(query.get('error_description') || error);
  if (!raw) throw new Error('this sign in did not start here');

  const pending = JSON.parse(raw);
  if (pending.state !== query.get('state')) throw new Error('this sign in did not start here');

  const doc = await load();
  await exchange(doc, {
    grant_type: 'authorization_code',
    code: code as string,
    redirect_uri: redirectUri(),
    code_verifier: pending.verifier,
    client_id: doc.client_id,
  });
  return pending.at || null;
}

async function exchange(doc: Discovery, body: Record<string, string>): Promise<void> {
  const res = await fetch(doc.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const payload = await res.json();
      detail = payload.error_description || payload.error || detail;
    } catch { /* the status is all there is */ }
    throw new Error(detail);
  }

  const grant = await res.json();
  accessToken = grant.access_token;
  expiresAt = Date.now() + (grant.expires_in ?? 300) * 1000;
  if (grant.refresh_token) localStorage.setItem(STORE, grant.refresh_token);
  if (grant.id_token) localStorage.setItem(IDENTITY, grant.id_token);
}

let refreshing: Promise<void> | null = null;

// Concurrent requests finding an expired token must refresh once between
// them, not once each.
export async function refresh(): Promise<void> {
  if (refreshing) return refreshing;
  const token = refreshToken();
  if (!token) throw new Error('not signed in');

  const doc = await load();
  refreshing = exchange(doc, {
    grant_type: 'refresh_token',
    refresh_token: token,
    client_id: doc.client_id,
  }).finally(() => { refreshing = null; });

  return refreshing;
}

// Renewed a little early, so a request is not sent with a token that dies
// on the way.
export async function bearer(): Promise<string | null> {
  if (!refreshToken()) return null;
  if (!accessToken || Date.now() > expiresAt - 10_000) await refresh();
  return accessToken;
}

export function forget(): void {
  accessToken = null;
  expiresAt = 0;
  localStorage.removeItem(STORE);
  localStorage.removeItem(IDENTITY);
}

export async function signOut(): Promise<void> {
  const token = refreshToken();
  const identity = localStorage.getItem(IDENTITY);
  const doc = discovery;

  if (doc?.revocation_endpoint && token) {
    await fetch(doc.revocation_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, client_id: doc.client_id }).toString(),
    }).catch(() => { /* the local session goes either way */ });
  }

  forget();

  if (doc?.end_session_endpoint) {
    const url = new URL(doc.end_session_endpoint);
    url.searchParams.set('post_logout_redirect_uri', redirectUri());
    url.searchParams.set('client_id', doc.client_id);
    if (identity) url.searchParams.set('id_token_hint', identity);
    location.assign(url.toString());
    return;
  }
  location.assign(redirectUri());
}
