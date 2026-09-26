// web/src/screen/projects.tsx - the project list, and creating one

import m from 'mithril';
import { page, post, Page } from '../util/api';
import { Empty, Failed, Loading, Pager, When, session } from '../component/layout';

const LIMIT = 25;

type Project = {
  id: string; name: string; repo_url: string; default_branch: string;
  visibility: string; enabled: number; job_counter: number; created_at: number;
};

export const Projects: m.Component = {
  oninit(vnode: any) {
    vnode.state.offset = 0;
    vnode.state.rows = null as Page<Project> | null;
    vnode.state.error = null;
    vnode.state.creating = false;
    vnode.state.created = null;
    vnode.state.form = { id: '', name: '', repo_url: '', default_branch: 'main' };

    vnode.state.load = async () => {
      try {
        vnode.state.rows = await page<Project>('/projects', {
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
    const { rows, error, created } = vnode.state;
    if (error && !rows) return <Failed error={error} />;
    if (!rows) return <Loading />;

    const create = async (e: Event) => {
      e.preventDefault();
      try {
        vnode.state.created = await post<any>('/projects', vnode.state.form);
        vnode.state.creating = false;
        vnode.state.form = { id: '', name: '', repo_url: '', default_branch: 'main' };
        await vnode.state.load();
      } catch (err) {
        vnode.state.error = err;
      }
    };

    const field = (key: string, label: string, required = false) => (
      <label>
        <span>{label}</span>
        <input
          value={vnode.state.form[key]}
          required={required}
          oninput={(e: any) => { vnode.state.form[key] = e.target.value; }}
        />
      </label>
    );

    return [
      <h1>projects</h1>,
      error ? <Failed error={error} /> : null,

      // Shown once, because it is never readable again.
      created?.trigger_secret
        ? (
          <div class="reveal">
            <strong>Trigger secret for {created.id}</strong>
            <p class="muted">Copy it now. It cannot be shown again.</p>
            <code class="mono">{created.trigger_secret}</code>
            <button onclick={() => { vnode.state.created = null; }}>done</button>
          </div>
        )
        : null,

      !session.user ? null : vnode.state.creating
        ? (
          <form class="panel" onsubmit={create}>
            {field('id', 'id')}
            {field('name', 'name')}
            {field('repo_url', 'repository url', true)}
            {field('default_branch', 'default branch')}
            <div class="actions">
              <button type="submit">create</button>
              <button type="button" onclick={() => { vnode.state.creating = false; }}>cancel</button>
            </div>
          </form>
        )
        : <div class="actions"><button onclick={() => { vnode.state.creating = true; }}>new project</button></div>,

      rows.rows.length === 0 ? <Empty what="projects" /> : (
        <table>
          <thead>
            <tr><th>project</th><th>repository</th><th>branch</th><th>visibility</th><th>jobs</th><th>created</th></tr>
          </thead>
          <tbody>
            {rows.rows.map((p) => (
              <tr key={p.id} class={p.enabled ? '' : 'disabled'}>
                <td><m.route.Link href={`/projects/${p.id}`}>{p.name}</m.route.Link></td>
                <td class="mono ellipsis">{p.repo_url}</td>
                <td class="ref">{p.default_branch}</td>
                <td>{p.visibility}</td>
                <td>{p.job_counter}</td>
                <td><When at={p.created_at} /></td>
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
