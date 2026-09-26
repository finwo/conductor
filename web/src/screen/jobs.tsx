// web/src/screen/jobs.tsx - jobs, everywhere or within one project

import m from 'mithril';
import { page, Page } from '../util/api';
import { poll } from '../util/poll';
import { settled, duration, shortSha } from '../util/format';
import { Badge, Empty, Failed, Loading, Pager, When } from '../component/layout';

const LIMIT = 25;

type Job = {
  id: string; project_id: string; number: number; ref: string; head_sha: string;
  trigger_type: string; actor: string | null; title: string | null; state: string;
  created_at: number; started_at: number | null; finished_at: number | null;
};

export const Jobs: m.Component = {
  oninit(vnode: any) {
    const project = m.route.param('project');
    vnode.state.offset = 0;
    vnode.state.rows = null as Page<Job> | null;
    vnode.state.error = null as unknown;

    vnode.state.load = async () => {
      try {
        const path = project ? `/projects/${encodeURIComponent(project)}/jobs` : '/jobs';
        vnode.state.rows = await page<Job>(path, { query: { offset: vnode.state.offset, limit: LIMIT } });
        vnode.state.error = null;
      } catch (e) {
        vnode.state.error = e;
        return false;
      }
      return vnode.state.rows.rows.some((j: Job) => !settled(j.state));
    };

    vnode.state.poller = poll(vnode.state.load, 4000);
    vnode.state.poller.start();
  },

  onremove: (vnode: any) => vnode.state.poller.stop(),

  view(vnode: any) {
    const { rows, error } = vnode.state;
    if (error) return <Failed error={error} />;
    if (!rows) return <Loading />;

    const move = (offset: number) => {
      vnode.state.offset = offset;
      vnode.state.poller.stop();
      vnode.state.poller.start();
    };

    return [
      <h1>jobs</h1>,
      rows.rows.length === 0 ? <Empty what="jobs" /> : (
        <table>
          <thead>
            <tr>
              <th>job</th><th>project</th><th>ref</th><th>commit</th>
              <th>state</th><th>took</th><th>created</th>
            </tr>
          </thead>
          <tbody>
            {rows.rows.map((job) => (
              <tr key={job.id}>
                <td><m.route.Link href={`/jobs/${job.id}`}>{`#${job.number}`}</m.route.Link></td>
                <td><m.route.Link href={`/projects/${job.project_id}`}>{job.project_id}</m.route.Link></td>
                <td class="ref">{job.ref?.replace(/^refs\/heads\//, '') ?? ''}</td>
                <td class="mono">{shortSha(job.head_sha)}</td>
                <td><Badge state={job.state} /></td>
                <td>{duration(job.started_at, job.finished_at)}</td>
                <td><When at={job.created_at} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ),
      <Pager offset={rows.offset} total={rows.total} limit={LIMIT} onmove={move} />,
    ];
  },
};
