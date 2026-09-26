// web/src/screen/workers.tsx - registered workers, and one worker's machines

import m from 'mithril';
import { get, page, patch, post, del, ApiError } from '../util/api';
import { Badge, Empty, Failed, Gone, Loading, Pager, When } from '../component/layout';
import { duration } from '../util/format';

const LIMIT = 25;

export const Workers: m.Component = {
  oninit(vnode: any) {
    vnode.state.offset = 0;
    vnode.state.rows = null;
    vnode.state.error = null;
    vnode.state.token = null;
    vnode.state.name = '';

    vnode.state.load = async () => {
      try {
        vnode.state.rows = await page<any>('/workers', {
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

    const create = async (e: Event) => {
      e.preventDefault();
      try {
        vnode.state.token = await post<any>('/workers', { name: vnode.state.name });
        vnode.state.name = '';
        await vnode.state.load();
      } catch (err) {
        vnode.state.error = err;
      }
    };

    return [
      <h1>workers</h1>,
      error ? <Failed error={error} /> : null,

      vnode.state.token
        ? (
          <div class="reveal">
            <strong>{`Token for ${vnode.state.token.name}`}</strong>
            <p class="muted">Copy it now. It cannot be shown again.</p>
            <code class="mono">{vnode.state.token.token}</code>
            <button onclick={() => { vnode.state.token = null; }}>done</button>
          </div>
        )
        : null,

      <form class="panel" onsubmit={create}>
        <label>
          <span>name</span>
          <input required value={vnode.state.name} oninput={(e: any) => { vnode.state.name = e.target.value; }} />
        </label>
        <button type="submit">register a worker</button>
      </form>,

      rows.rows.length === 0 ? <Empty what="workers" /> : (
        <table>
          <thead><tr><th>worker</th><th>enabled</th><th>last seen</th><th>address</th></tr></thead>
          <tbody>
            {rows.rows.map((w: any) => (
              <tr key={w.id}>
                <td><m.route.Link href={`/workers/${w.id}`}>{w.name}</m.route.Link></td>
                <td>{w.enabled ? 'yes' : 'no'}</td>
                <td><When at={w.last_seen_at} /></td>
                <td class="mono">{w.last_ip ?? ''}</td>
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

export const Worker: m.Component = {
  oninit(vnode: any) {
    const id = m.route.param('worker');
    vnode.state.id = id;
    vnode.state.worker = null;
    vnode.state.agents = [];
    vnode.state.tasks = [];
    vnode.state.error = null;
    vnode.state.gone = false;

    vnode.state.load = async () => {
      try {
        vnode.state.worker = await get<any>(`/workers/${id}`);
        vnode.state.agents = await get<any[]>(`/workers/${id}/agents`);
        vnode.state.tasks = (await page<any>(`/workers/${id}/tasks`, { query: { limit: 25 } })).rows;
        vnode.state.error = null;
      } catch (e) {
        if ((e as ApiError).status === 404) vnode.state.gone = true;
        else vnode.state.error = e;
      }
      m.redraw();
    };
    vnode.state.load();
  },

  view(vnode: any) {
    const { worker, error, gone, id } = vnode.state;
    if (gone) return <Gone what="worker" />;
    if (error && !worker) return <Failed error={error} />;
    if (!worker) return <Loading />;

    return [
      <h1>{worker.name}</h1>,
      error ? <Failed error={error} /> : null,

      <div class="actions">
        <label class="check">
          <input
            type="checkbox"
            checked={worker.enabled === 1}
            onchange={async (e: any) => {
              vnode.state.worker = await patch<any>(`/workers/${id}`, { enabled: e.target.checked });
            }}
          />
          <span>enabled</span>
        </label>
        <button
          onclick={async () => {
            await del(`/workers/${id}`);
            m.route.set('/workers');
          }}
        >
          remove
        </button>
      </div>,

      <h2>machines</h2>,
      vnode.state.agents.length === 0 ? <Empty what="machines" /> : (
        <table>
          <thead><tr><th>machine</th><th>architectures</th><th>features</th><th>last seen</th></tr></thead>
          <tbody>
            {vnode.state.agents.map((a: any) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td class="mono">{(a.arches ?? []).join(', ')}</td>
                <td class="mono">{(a.features ?? []).join(', ')}</td>
                <td><When at={a.last_seen_at} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ),

      <h2>recent tasks</h2>,
      vnode.state.tasks.length === 0 ? <Empty what="tasks" /> : (
        <table>
          <tbody>
            {vnode.state.tasks.map((t: any) => (
              <tr key={t.id}>
                <td><m.route.Link href={`/tasks/${t.id}`}>{t.name}</m.route.Link></td>
                <td><Badge state={t.state} /></td>
                <td>{duration(t.started_at, t.finished_at)}</td>
                <td><When at={t.created_at} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ),
    ];
  },
};
