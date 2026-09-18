// src/worker/client.js - talking to the conductor
//
// Built on fetch, so there is nothing to install. Every call carries the
// worker token. Network errors are surfaced rather than retried here; the
// agent decides what a failure means, since a failed poll and a failed log
// append want very different handling.

export class ConductorError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = 'ConductorError';
    this.status = status;
    this.body = body;
  }
}

export function createClient(cfg) {
  const base = cfg.conductor_url;
  const auth = { authorization: `Bearer ${cfg.token}` };

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
    return new ConductorError(`${action} failed: ${res.status} ${res.statusText} ${detail}`.trim(), {
      status: res.status,
      body,
    });
  }

  return {
    // Returns a job, or null when there is nothing to do.
    async poll({ arches, features, name }) {
      const query = new URLSearchParams();
      if (arches.length > 0) query.set('arches', arches.join(','));
      if (features.length > 0) query.set('features', features.join(','));
      if (name) query.set('name', name);

      const res = await fetch(`${base}/api/workers/poll?${query}`, { headers: auth });
      if (res.status === 204) return null;
      if (!res.ok) throw await readError(res, 'poll');
      return (await res.json()).job;
    },

    // The tree at the job's commit. Returned as a web stream so it can be
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
        return { conflict: true, expected: body.expected_offset ?? 0 };
      }
      if (!res.ok) throw await readError(res, 'log append');
      return await res.json();
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
      return await res.json();
    },

    // Reports that the job is alive, and learns whether it should stop.
    async heartbeat(url) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: '{}',
      });
      if (res.status === 404) return { cancelled: true, gone: true };
      if (!res.ok) throw await readError(res, 'heartbeat');
      return await res.json();
    },

    async done(url, { success, exitCode, error }) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ success, exit_code: exitCode ?? null, error: error ?? null }),
      });
      if (!res.ok) throw await readError(res, 'done');
      return await res.json();
    },
  };
}
