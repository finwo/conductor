// web/src/screen/users.tsx - accounts and live sessions

import m from 'mithril';
import { page, patch, post, del } from '../util/api';
import { session, Empty, Failed, Loading, Pager, When } from '../component/layout';

const LIMIT = 25;

export const Users: m.Component = {
  oninit(vnode: any) {
    vnode.state.offset = 0;
    vnode.state.rows = null;
    vnode.state.error = null;
    vnode.state.form = { username: '', password: '', role: 'user' };

    vnode.state.load = async () => {
      try {
        vnode.state.rows = await page<any>('/users', {
          query: { offset: vnode.state.offset, limit: LIMIT },
        });
        vnode.state.error = null;
      } catch (e) {
        vnode.state.error = e;
      }
      m.redraw();
    };
    vnode.state.load();
  },

  view(vnode: any) {
    const { rows, error } = vnode.state;
    if (error && !rows) return <Failed error={error} />;
    if (!rows) return <Loading />;

    const admin = session.user?.role === 'admin';

    const create = async (e: Event) => {
      e.preventDefault();
      try {
        await post('/users', vnode.state.form);
        vnode.state.form = { username: '', password: '', role: 'user' };
        await vnode.state.load();
      } catch (err) {
        vnode.state.error = err;
      }
    };

    const change = async (id: string, body: unknown) => {
      try {
        await patch(`/users/${id}`, body);
        await vnode.state.load();
      } catch (err) {
        vnode.state.error = err;
      }
    };

    return [
      <h1>users</h1>,
      error ? <Failed error={error} /> : null,

      admin
        ? (
          <form class="panel" onsubmit={create}>
            <label>
              <span>username</span>
              <input
                required
                value={vnode.state.form.username}
                oninput={(e: any) => { vnode.state.form.username = e.target.value; }}
              />
            </label>
            <label>
              <span>password</span>
              <input
                required
                type="password"
                value={vnode.state.form.password}
                oninput={(e: any) => { vnode.state.form.password = e.target.value; }}
              />
            </label>
            <label>
              <span>role</span>
              <select
                value={vnode.state.form.role}
                onchange={(e: any) => { vnode.state.form.role = e.target.value; }}
              >
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <button type="submit">create</button>
          </form>
        )
        : null,

      <table>
        <thead><tr><th>username</th><th>role</th><th>source</th><th>holdings</th><th>last seen</th><th /></tr></thead>
        <tbody>
          {rows.rows.map((u: any) => (
            <tr key={u.id} class={u.disabled ? 'disabled' : ''}>
              <td>{u.username}</td>
              <td>
                {admin && u.id !== session.user?.id
                  ? (
                    <select value={u.role} onchange={(e: any) => change(u.id, { role: e.target.value })}>
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                    </select>
                  )
                  : u.role}
              </td>
              <td>{u.source}</td>
              <td class="muted">{`${u.project_count ?? 0} projects, ${u.worker_count ?? 0} workers`}</td>
              <td><When at={u.last_login_at} /></td>
              <td>
                {admin && u.id !== session.user?.id
                  ? (
                    <div class="rowactions">
                      <button class="quiet" onclick={() => change(u.id, { disabled: !u.disabled })}>
                        {u.disabled ? 'enable' : 'disable'}
                      </button>
                      <button
                        class="quiet"
                        onclick={async () => { await del(`/users/${u.id}`); await vnode.state.load(); }}
                      >
                        remove
                      </button>
                    </div>
                  )
                  : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>,

      <Pager
        offset={rows.offset}
        total={rows.total}
        limit={LIMIT}
        onmove={(offset: number) => { vnode.state.offset = offset; vnode.state.load(); }}
      />,
    ];
  },
};

export const Sessions: m.Component = {
  oninit(vnode: any) {
    vnode.state.offset = 0;
    vnode.state.rows = null;
    vnode.state.error = null;

    vnode.state.load = async () => {
      try {
        vnode.state.rows = await page<any>('/sessions', {
          query: { offset: vnode.state.offset, limit: LIMIT },
        });
        vnode.state.error = null;
      } catch (e) {
        vnode.state.error = e;
      }
      m.redraw();
    };
    vnode.state.load();
  },

  view(vnode: any) {
    const { rows, error } = vnode.state;
    if (error && !rows) return <Failed error={error} />;
    if (!rows) return <Loading />;

    return [
      <h1>sessions</h1>,
      <p class="muted">Revoking a session signs that browser out the next time it asks for a token.</p>,
      error ? <Failed error={error} /> : null,

      rows.rows.length === 0 ? <Empty what="sessions" /> : (
        <table>
          <thead><tr><th>browser</th><th>address</th><th>signed in</th><th>last used</th><th>expires</th><th /></tr></thead>
          <tbody>
            {rows.rows.map((s: any) => (
              <tr key={s.id}>
                <td class="ellipsis">{s.user_agent ?? 'unknown'}</td>
                <td class="mono">{s.ip ?? ''}</td>
                <td><When at={s.issued_at} /></td>
                <td><When at={s.last_used_at} /></td>
                <td><When at={s.expires_at} /></td>
                <td>
                  <button
                    class="quiet"
                    onclick={async () => { await del(`/sessions/${s.id}`); await vnode.state.load(); }}
                  >
                    revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ),

      <Pager
        offset={rows.offset}
        total={rows.total}
        limit={LIMIT}
        onmove={(offset: number) => { vnode.state.offset = offset; vnode.state.load(); }}
      />,
    ];
  },
};
