// src/conductor/ui/layout.js - the page shell and shared fragments
//
// Pages are rendered whole on a normal request and as fragments when htmx
// asks for one, so everything works without javascript and gets live
// updates with it.

import { html, raw, esc } from './html.js';

export function layout({ title, user, body, active = '', localLogin = true }) {
  const nav = [
    { href: '/', label: 'jobs', key: 'jobs' },
    user ? { href: '/projects', label: 'projects', key: 'projects' } : null,
    user ? { href: '/workers', label: 'workers', key: 'workers' } : null,
    // Accounts cannot sign in while the provider owns identity, so the page
    // is kept off the nav but remains reachable by anyone who needs it.
    user && user.role === 'admin' && localLogin ? { href: '/users', label: 'users', key: 'users' } : null,
  ].filter(Boolean);

  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title ? `${title} - conductor` : 'conductor'}</title>
<link rel="stylesheet" href="/style.css">
<script src="/vendor/htmx.min.js" defer></script>
</head>
<body>
<header>
  <h1><a href="/">conductor</a></h1>
  <nav>
    ${nav.map((item) => html`<a class="${item.key === active ? 'on' : ''}" href="${item.href}">${item.label}</a>`)}
  </nav>
  <div class="session">
    ${user
    ? html`<span class="muted">${user.username}</span>
           <span class="role">${user.role}</span>
           <form method="post" action="/logout" hx-post="/logout" hx-swap="none">
             <button type="submit">sign out</button>
           </form>`
    : html`<a class="button" href="/login">sign in</a>`}
  </div>
</header>

<main>
${body}
</main>

<script>
// Keep a log pane pinned to the bottom unless the reader has scrolled up.
document.body.addEventListener('htmx:beforeSwap', (e) => {
  const pane = e.detail.target.closest ? e.detail.target.closest('.logpane') : null;
  if (pane) pane.dataset.follow = String(pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 24);
});
document.body.addEventListener('htmx:afterSwap', (e) => {
  const pane = e.detail.target.closest ? e.detail.target.closest('.logpane') : null;
  if (pane && pane.dataset.follow !== 'false') pane.scrollTop = pane.scrollHeight;
});
// A redirect asked for by the server after a form post.
document.body.addEventListener('htmx:afterRequest', (e) => {
  const to = e.detail.xhr && e.detail.xhr.getResponseHeader('HX-Redirect');
  if (to) window.location = to;
});
</script>
</body>
</html>`;
}

export function badge(state) {
  return html`<span class="badge ${esc(state)}">${state}</span>`;
}

export function notice(message, kind = 'error') {
  if (!message) return raw('');
  return html`<p class="${kind === 'error' ? 'error' : 'ok'}">${message}</p>`;
}

// A value shown once and never again, such as a token or a secret.
export function oneTimeSecret(label, value, help) {
  return html`<div class="panel secret">
    <h3>${label}</h3>
    <p class="muted">${help}</p>
    <input type="text" readonly value="${value}" onclick="this.select()" class="wide mono">
  </div>`;
}

export function shortSha(sha) {
  return sha ? String(sha).slice(0, 8) : '';
}

export function ago(ms) {
  if (!ms) return '';
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

export function duration(from, to) {
  if (!from) return '';
  const seconds = Math.round(((to ?? Date.now()) - from) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export const ACTIVE_RUN_STATES = ['pending', 'running'];
export const ACTIVE_JOB_STATES = ['queued', 'running'];
