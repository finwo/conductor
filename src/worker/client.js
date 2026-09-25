// src/worker/client.js - talking to the conductor
//
// Built on fetch, so there is nothing to install. Every call carries the
// worker token. Network errors are surfaced rather than retried here; the
// agent decides what a failure means, since a failed claim and a failed log
// append want very different handling.

export class ConductorError extends Error {
  constructor(message, { status = 0, body = null, cause = null } = {}) {
    super(message);
    this.name = 'ConductorError';
    this.status = status;
    this.body = body;
    // The conductor's own name for what went wrong, where it sent one.
    this.cause = cause;
  }
}

export function createClient(cfg) {
  const base = cfg.conductor_url;
  const auth = { authorization: `Bearer ${cfg.token}` };

  // The envelope is unwrapped here and nowhere else, so the rest of the
  // worker keeps dealing in plain task, log and outcome objects.
  async function data(res) {
    const body = await res.json();
    return body?.data;
  }

  async function readError(res, action) {
    let body = null;
    let detail = '';
    try {
      const text = await res.text();
      detail = text.slice(0, 512);
      body = JSON.parse(text);
    } catch {
      // A non JSON body is still worth reporting as text.
    }
    const error = body?.error;
    return new ConductorError(`${action} failed: ${res.status} ${res.statusText} ${detail}`.trim(), {
      status: res.status,
      body,
      cause: error?.name ?? null,
    });
  }

  return {
    // Returns a task, or null when there is nothing to do. This is the only
    // URL the worker knows; everything else it needs arrives with the task.
    async claim({ arches, features, name }) {
      const res = await fetch(`${base}/api/v1/tasks/claim`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ arches, features, name }),
      });
      if (res.status === 204) return null;
      if (!res.ok) throw await readError(res, 'claim');
      return (await data(res)).task;
    },

    // The tree at the task's commit. Returned as a web stream so it can be
    // piped straight into tar without buffering.
    async source(url) {
      const res = await fetch(url, { headers: auth });
      if (!res.ok) throw await readError(res, 'source download');
      return res.body;
    },

    // Returns the new log size. A 409 means the conductor and the worker
    // disagree about the offset, and carries the offset to resume from.
    async appendLog(url, chunk, offset) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/octet-stream', 'x-log-offset': String(offset) },
        body: chunk,
      });

      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        return { conflict: true, expected: body.error?.details?.expected_offset ?? 0 };
      }
      if (!res.ok) throw await readError(res, 'log append');
      return await data(res);
    },

    async uploadArtifact(url, relPath, body, size) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          ...auth,
          'content-type': 'application/octet-stream',
          'content-length': String(size),
          'x-artifact-path': relPath,
        },
        body,
        duplex: 'half',
      });
      if (!res.ok) throw await readError(res, `artifact upload (${relPath})`);
      return await data(res);
    },

    // Reports that the task is alive, and learns whether it should stop.
    async heartbeat(url) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: '{}',
      });
      if (res.status === 404) return { cancelled: true, gone: true };
      if (!res.ok) throw await readError(res, 'heartbeat');
      return await data(res);
    },

    async done(url, { success, state = null, exitCode, error, outputs = [] }) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          success,
          state,
          exit_code: exitCode ?? null,
          error: error ?? null,
          outputs,
        }),
      });
      if (!res.ok) throw await readError(res, 'done');
      return await data(res);
    },
  };
}
