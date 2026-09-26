// web/src/screen/job.tsx - one job, and the stage graph of its tasks

import m from 'mithril';
import { get, post, ApiError } from '../util/api';
import { poll } from '../util/poll';
import { settled, duration, shortSha, stamp } from '../util/format';
import { Badge, Failed, Gone, Loading, When, session } from '../component/layout';

type Task = {
  id: string; name: string; base_name: string; state: string; arch: string | null;
  attempt: number; exit_code: number | null; error: string | null; worker_name: string | null;
  created_at: number; started_at: number | null; finished_at: number | null;
};

type Dep = { task_id: string; depends_on_id: string; kind: string };

// The longest path to each task, so tasks that can run together line up.
// Memoised per task rather than sharing one visited set, which would let a
// diamond settle at whichever depth it was reached by first.
function stages(tasks: Task[], deps: Dep[]): Task[][] {
  const incoming = new Map<string, string[]>();
  for (const task of tasks) incoming.set(task.id, []);
  for (const dep of deps) incoming.get(dep.task_id)?.push(dep.depends_on_id);

  const depth = new Map<string, number>();
  const measure = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id) as number;
    if (seen.has(id)) return 0;
    seen.add(id);

    let best = 0;
    for (const parent of incoming.get(id) ?? []) {
      if (!incoming.has(parent)) continue;
      best = Math.max(best, measure(parent, seen) + 1);
    }
    seen.delete(id);
    depth.set(id, best);
    return best;
  };

  const out: Task[][] = [];
  for (const task of tasks) {
    const at = measure(task.id, new Set());
    (out[at] ??= []).push(task);
  }
  return out.filter(Boolean);
}

export const Job: m.Component = {
  oninit(vnode: any) {
    const id = m.route.param('job');
    vnode.state.job = null;
    vnode.state.stages = [];
    vnode.state.error = null;
    vnode.state.gone = false;
    vnode.state.busy = false;

    vnode.state.load = async () => {
      try {
        vnode.state.job = await get<any>(`/jobs/${id}`);
        const graph = await get<{ tasks: Task[]; deps: Dep[] }>(`/jobs/${id}/tasks`, { limit: 200 });
        vnode.state.stages = stages(graph.tasks, graph.deps);
        vnode.state.error = null;
      } catch (e) {
        if ((e as ApiError).status === 404) vnode.state.gone = true;
        else vnode.state.error = e;
        return false;
      }
      return !settled(vnode.state.job.state);
    };

    vnode.state.poller = poll(vnode.state.load, 4000);
    vnode.state.poller.start();
  },

  onremove: (vnode: any) => vnode.state.poller.stop(),

  view(vnode: any) {
    const { job, error, gone } = vnode.state;
    if (gone) return <Gone what="job" />;
    if (error) return <Failed error={error} />;
    if (!job) return <Loading />;

    const act = async (what: string) => {
      vnode.state.busy = true;
      try {
        const res = await post<any>(`/jobs/${job.id}/${what}`);
        if (res?.job_id) m.route.set(`/jobs/${res.job_id}`);
        else await vnode.state.load();
      } catch (e) {
        vnode.state.error = e;
      } finally {
        vnode.state.busy = false;
      }
    };

    return [
      <h1>
        <m.route.Link href={`/projects/${job.project_id}`}>{job.project_id}</m.route.Link>
        {` #${job.number}`}
        <Badge state={job.state} />
      </h1>,

      <dl class="facts">
        <dt>ref</dt><dd class="ref">{job.ref?.replace(/^refs\/heads\//, '')}</dd>
        <dt>commit</dt><dd class="mono">{shortSha(job.head_sha)}</dd>
        <dt>trigger</dt><dd>{job.trigger_type}{job.actor ? ` by ${job.actor}` : ''}</dd>
        <dt>started</dt><dd>{stamp(job.started_at)}</dd>
        <dt>took</dt><dd>{duration(job.started_at, job.finished_at)}</dd>
        <dt>created</dt><dd><When at={job.created_at} /></dd>
      </dl>,

      job.error ? <div class="error"><p>{job.error}</p></div> : null,

      session.user ? (
        <div class="actions">
          {job.state === 'running'
            ? <button disabled={vnode.state.busy} onclick={() => act('cancel')}>cancel</button>
            : null}
          <button disabled={vnode.state.busy} onclick={() => act('retry')}>retry</button>
        </div>
      ) : null,

      vnode.state.stages.map((stage: Task[], at: number) => (
        <section class="stage">
          <h2>{`stage ${at + 1}`}</h2>
          <div class="tasks">
            {stage.map((task) => (
              <m.route.Link href={`/tasks/${task.id}`} class={`task s-${task.state}`} key={task.id}>
                <span class="name">{task.name}</span>
                <Badge state={task.state} />
                <span class="muted">{duration(task.started_at, task.finished_at)}</span>
              </m.route.Link>
            ))}
          </div>
        </section>
      )),
    ];
  },
};
