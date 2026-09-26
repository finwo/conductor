// web/src/screen/task.tsx - one task, its log, outputs and artifacts

import m from 'mithril';
import { get, page, ApiError } from '../util/api';
import { poll } from '../util/poll';
import { ansi } from '../util/ansi';
import { settled, duration, bytes, stamp } from '../util/format';
import { Badge, Empty, Failed, Gone, Loading, When } from '../component/layout';

type Log = { offset: number; size: number; data: string; expired: boolean };

const FOLLOW_SLACK = 24;

export const Task: m.Component = {
  oninit(vnode: any) {
    const id = m.route.param('task');
    vnode.state.task = null;
    vnode.state.log = '';
    vnode.state.at = 0;
    vnode.state.expired = false;
    vnode.state.outputs = [];
    vnode.state.artifacts = [];
    vnode.state.error = null;
    vnode.state.gone = false;
    vnode.state.follow = true;

    vnode.state.load = async () => {
      try {
        const detail = await get<any>(`/tasks/${id}`);
        vnode.state.task = detail.task;

        const chunk = await get<Log>(`/tasks/${id}/log`, { offset: vnode.state.at });
        vnode.state.expired = chunk.expired;
        if (chunk.data) {
          vnode.state.log += chunk.data;
          vnode.state.at = chunk.offset + new TextEncoder().encode(chunk.data).length;
        }

        if (settled(detail.task.state)) {
          vnode.state.outputs = (await page<any>(`/tasks/${id}/outputs`, { query: { limit: 200 } })).rows;
          vnode.state.artifacts = (await page<any>(`/tasks/${id}/artifacts`, { query: { limit: 200 } })).rows;
        }
        vnode.state.error = null;
      } catch (e) {
        if ((e as ApiError).status === 404) vnode.state.gone = true;
        else vnode.state.error = e;
        return false;
      }
      return !settled(vnode.state.task.state);
    };

    vnode.state.poller = poll(vnode.state.load, 3000);
    vnode.state.poller.start();
  },

  onremove: (vnode: any) => vnode.state.poller.stop(),

  // Whether the reader was at the bottom has to be decided before the new
  // bytes land, or the answer is always no.
  onbeforeupdate(vnode: any) {
    const pane = vnode.state.pane as HTMLElement | undefined;
    if (pane) {
      vnode.state.follow = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - FOLLOW_SLACK;
    }
    return true;
  },

  onupdate(vnode: any) {
    const pane = vnode.state.pane as HTMLElement | undefined;
    if (pane && vnode.state.follow) pane.scrollTop = pane.scrollHeight;
  },

  view(vnode: any) {
    const { task, error, gone } = vnode.state;
    if (gone) return <Gone what="task" />;
    if (error) return <Failed error={error} />;
    if (!task) return <Loading />;

    return [
      <h1>
        <m.route.Link href={`/jobs/${task.job_id}`}>{`#${task.job_number}`}</m.route.Link>
        {` ${task.name}`}
        <Badge state={task.state} />
      </h1>,

      <dl class="facts">
        <dt>image</dt><dd class="mono">{task.image}</dd>
        {task.arch ? [<dt>arch</dt>, <dd>{task.arch}</dd>] : null}
        <dt>worker</dt><dd>{task.worker_name ?? ''}</dd>
        <dt>attempt</dt><dd>{`${task.attempt} of ${task.max_attempts}`}</dd>
        {task.exit_code !== null ? [<dt>exit</dt>, <dd class="mono">{task.exit_code}</dd>] : null}
        <dt>took</dt><dd>{duration(task.started_at, task.finished_at)}</dd>
        <dt>started</dt><dd><When at={task.started_at} /></dd>
      </dl>,

      task.error ? <div class="error"><p>{task.error}</p></div> : null,

      <h2>log</h2>,
      vnode.state.expired
        ? <p class="muted">This log has been removed by the retention policy.</p>
        : (
          <pre class="log" oncreate={(v: any) => { vnode.state.pane = v.dom; v.dom.scrollTop = v.dom.scrollHeight; }}>
            {vnode.state.log ? ansi(vnode.state.log) : <span class="muted">no output yet</span>}
          </pre>
        ),

      <h2>outputs</h2>,
      vnode.state.outputs.length === 0
        ? <Empty what="outputs" />
        : (
          <table>
            <tbody>
              {vnode.state.outputs.map((o: any) => (
                <tr key={o.name}>
                  <td class="mono">{o.name}</td>
                  <td class="mono">{o.masked ? <span class="muted">masked</span> : o.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ),

      <h2>artifacts</h2>,
      vnode.state.artifacts.length === 0
        ? <Empty what="artifacts" />
        : (
          <table>
            <tbody>
              {vnode.state.artifacts.map((a: any) => (
                <tr key={a.id}>
                  <td><a href={a.url}>{a.path}</a></td>
                  <td>{bytes(a.size)}</td>
                  <td title={stamp(a.expires_at)}>{a.expires_at ? 'expires' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ),
    ];
  },
};
