// web/src/component/layout.tsx - chrome, badges, paging and failure

import m from 'mithril';
import * as auth from '../util/auth';
import { ApiError } from '../util/api';
import { ago, stamp } from '../util/format';

export { session } from '../util/auth';

// Mirrors canManageProject on the server.
export function manages(project: { owner_id?: string | null } | null): boolean {
  const user = auth.session.user;
  if (!user || !project) return false;
  if (user.role === 'admin') return true;
  return project.owner_id != null && project.owner_id === user.id;
}

const Link = (href: string, label: string) => {
  const at = m.route.get() ?? '';
  return <m.route.Link href={href} class={at.startsWith(href) ? 'active' : ''}>{label}</m.route.Link>;
};

export const Chrome: m.Component = {
  view(vnode) {
    return [
      <header>
        <nav>
          <span class="brand">conductor</span>
          {Link('/jobs', 'jobs')}
          {Link('/projects', 'projects')}
          {auth.session.user ? Link('/workers', 'workers') : null}
          {auth.session.user?.role === 'admin' ? Link('/users', 'users') : null}
          {auth.session.user ? Link('/sessions', 'sessions') : null}
        </nav>
        <div class="who">
          {auth.session.user
            ? [
              <span>{auth.session.user.username}</span>,
              <button class="link" onclick={() => auth.signOut()}>sign out</button>,
            ]
            : <button class="link" onclick={() => auth.signIn()}>sign in</button>}
        </div>
      </header>,
      <main>{vnode.children}</main>,
    ];
  },
};

export const Badge: m.Component<{ state: string }> = {
  view: ({ attrs }) => <span class={`badge s-${attrs.state}`}>{attrs.state}</span>,
};

export const Loading: m.Component = {
  view: () => <p class="muted">loading</p>,
};

export const Failed: m.Component<{ error: unknown }> = {
  view({ attrs }) {
    const e = attrs.error as ApiError;
    const unauthenticated = e?.name === 'NotAuthenticated';
    return (
      <div class="error">
        <strong>{unauthenticated ? 'Not signed in' : (e?.name ?? 'Error')}</strong>
        <p>{e?.message ?? String(attrs.error)}</p>
        {unauthenticated ? <button onclick={() => auth.signIn()}>sign in</button> : null}
      </div>
    );
  },
};

// A polled entity that vanishes has to say so, rather than the region it
// was in quietly disappearing.
export const Gone: m.Component<{ what: string }> = {
  view: ({ attrs }) => (
    <div class="error">
      <strong>Gone</strong>
      <p>{`That ${attrs.what} no longer exists, or is no longer yours to see.`}</p>
    </div>
  ),
};

export const When: m.Component<{ at: number | null }> = {
  view: ({ attrs }) => <span class="when" title={stamp(attrs.at)}>{ago(attrs.at)}</span>,
};

type PagerAttrs = { offset: number; total: number; limit: number; onmove: (offset: number) => void };

export const Pager: m.Component<PagerAttrs> = {
  view({ attrs }) {
    const { offset, total, limit } = attrs;
    if (total <= limit) return null;

    const last = Math.min(offset + limit, total);
    return (
      <div class="pager">
        <button disabled={offset === 0} onclick={() => attrs.onmove(Math.max(0, offset - limit))}>previous</button>
        <span>{`${total === 0 ? 0 : offset + 1} to ${last} of ${total}`}</span>
        <button disabled={last >= total} onclick={() => attrs.onmove(offset + limit)}>next</button>
      </div>
    );
  },
};

export const Empty: m.Component<{ what: string }> = {
  view: ({ attrs }) => <p class="muted">{`No ${attrs.what} to show.`}</p>,
};
