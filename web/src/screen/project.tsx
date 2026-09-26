// web/src/screen/project.tsx - one project: settings, variables, jobs

import m from 'mithril';
import { get, page, patch, post, put, del, ApiError } from '../util/api';
import { Badge, Empty, Failed, Gone, Loading, When, manages } from '../component/layout';
import { duration, shortSha } from '../util/format';

// Empty means follow the server default, zero means keep forever. They are
// different answers and the form has to keep them apart.
function retentionValue(raw: string): number | null {
  const trimmed = raw.trim();
  return trimmed === '' ? null : Number(trimmed);
}

export const Project: m.Component = {
  oninit(vnode: any) {
    const id = m.route.param('project');
    vnode.state.id = id;
    vnode.state.project = null;
    vnode.state.variables = [];
    vnode.state.jobs = [];
    vnode.state.error = null;
    vnode.state.gone = false;
    vnode.state.secret = null;
    vnode.state.newVar = { name: '', value: '', masked: true };

    vnode.state.load = async () => {
      try {
        vnode.state.project = await get<any>(`/projects/${id}`);
        vnode.state.jobs = (await page<any>(`/projects/${id}/jobs`, { query: { limit: 10 } })).rows;
        vnode.state.variables = manages(vnode.state.project)
          ? await get<any[]>(`/projects/${id}/variables`)
          : null;
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
    const { project, error, gone, id } = vnode.state;
    if (gone) return <Gone what="project" />;
    if (error && !project) return <Failed error={error} />;
    if (!project) return <Loading />;

    const save = async (body: unknown) => {
      try {
        vnode.state.project = await patch<any>(`/projects/${id}`, body);
        vnode.state.error = null;
      } catch (e) {
        vnode.state.error = e;
      }
    };

    const rotate = async () => {
      try {
        vnode.state.secret = (await post<any>(`/projects/${id}/trigger-secret`)).trigger_secret;
      } catch (e) {
        vnode.state.error = e;
      }
    };

    const setVariable = async (e: Event) => {
      e.preventDefault();
      const { name, value, masked } = vnode.state.newVar;
      try {
        await put(`/projects/${id}/variables/${encodeURIComponent(name)}`, { value, masked });
        vnode.state.newVar = { name: '', value: '', masked: true };
        await vnode.state.load();
      } catch (err) {
        vnode.state.error = err;
      }
    };

    const retention = (key: string, label: string) => (
      <label>
        <span>{label}</span>
        <input
          type="number"
          min="0"
          placeholder="server default"
          value={project[key] === null ? '' : project[key]}
          onchange={(e: any) => save({ [key]: retentionValue(e.target.value) })}
        />
      </label>
    );

    const mine = manages(project);

    return [
      <h1>{project.name}</h1>,
      error ? <Failed error={error} /> : null,

      <section class="panel">
        <h2>settings</h2>
        <dl class="facts">
          <dt>repository</dt><dd class="mono">{project.repo_url}</dd>
          <dt>branch</dt><dd class="ref">{project.default_branch}</dd>
          <dt>config</dt><dd class="mono">{project.config_path}</dd>
        </dl>
        {mine ? (
          <label>
            <span>visibility</span>
            <select value={project.visibility} onchange={(e: any) => save({ visibility: e.target.value })}>
              <option value="private">private</option>
              <option value="public">public</option>
            </select>
          </label>
        ) : null}
        {mine ? (
          <label class="check">
            <input
              type="checkbox"
              checked={project.enabled === 1}
              onchange={(e: any) => save({ enabled: e.target.checked })}
            />
            <span>enabled</span>
          </label>
        ) : null}
      </section>,

      mine ? (
        <section class="panel">
          <h2>retention</h2>
          <p class="muted">Empty follows the server default. Zero keeps forever.</p>
          {retention('artifact_keep_jobs', 'artifact jobs')}
          {retention('artifact_keep_days', 'artifact days')}
          {retention('log_keep_days', 'log days')}
        </section>
      ) : null,

      mine ? (
        <section class="panel">
          <h2>trigger secret</h2>
          {vnode.state.secret
            ? (
              <div class="reveal">
                <p class="muted">Copy it now. It cannot be shown again.</p>
                <code class="mono">{vnode.state.secret}</code>
                <button onclick={() => { vnode.state.secret = null; }}>done</button>
              </div>
            )
            : <p class="muted">{project.has_trigger_secret ? 'A secret is set.' : 'No secret set.'}</p>}
          <button onclick={rotate}>generate a new secret</button>
        </section>
      ) : null,

      vnode.state.variables === null ? null : (
        <section class="panel">
          <h2>variables</h2>
          {vnode.state.variables.length === 0 ? <Empty what="variables" /> : (
            <table>
              <tbody>
                {vnode.state.variables.map((v: any) => (
                  <tr key={v.name}>
                    <td class="mono">{v.name}</td>
                    <td>{v.masked ? 'masked' : 'visible'}</td>
                    <td>
                      <button
                        class="link"
                        onclick={async () => {
                          await del(`/projects/${id}/variables/${encodeURIComponent(v.name)}`);
                          await vnode.state.load();
                        }}
                      >
                        remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <form onsubmit={setVariable}>
            <label>
              <span>name</span>
              <input
                required
                value={vnode.state.newVar.name}
                oninput={(e: any) => { vnode.state.newVar.name = e.target.value; }}
              />
            </label>
            <label>
              <span>value</span>
              <input
                required
                value={vnode.state.newVar.value}
                oninput={(e: any) => { vnode.state.newVar.value = e.target.value; }}
              />
            </label>
            <label class="check">
              <input
                type="checkbox"
                checked={vnode.state.newVar.masked}
                onchange={(e: any) => { vnode.state.newVar.masked = e.target.checked; }}
              />
              <span>mask in logs</span>
            </label>
            <button type="submit">set</button>
          </form>
        </section>
      ),

      <h2>recent jobs</h2>,
      vnode.state.jobs.length === 0 ? <Empty what="jobs" /> : (
        <table>
          <tbody>
            {vnode.state.jobs.map((job: any) => (
              <tr key={job.id}>
                <td><m.route.Link href={`/jobs/${job.id}`}>{`#${job.number}`}</m.route.Link></td>
                <td class="mono">{shortSha(job.head_sha)}</td>
                <td><Badge state={job.state} /></td>
                <td>{duration(job.started_at, job.finished_at)}</td>
                <td><When at={job.created_at} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ),
    ];
  },
};
