// src/lib/variables.js - per project variables
//
// Values are sealed with the secret box, bound to their project and name so
// a row copied elsewhere will not open. They are injected into a job's
// environment when it is claimed, and never written into the jobs table, so
// the only place a secret rests is this one.
//
// Masked variables are also redacted from job logs. The worker does that
// before anything leaves the host; the conductor repeats it on ingest as a
// backstop against a worker that does not.

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function createVariables({ db, secrets, ttl = 30000 }) {
  // Decrypting on every log append would be wasteful, so the masked values
  // for a project are cached briefly.
  const maskCache = new Map();

  function aad(projectId, name) {
    return `project:${projectId}/variable:${name}`;
  }

  function open(row) {
    return secrets.open(row.value, aad(row.project_id, row.name));
  }

  return {
    async list(projectId) {
      const rows = await db.all(
        `SELECT project_id, name, value, masked, created_at
           FROM project_variables WHERE project_id = {project} ORDER BY name`,
        { project: projectId }
      );
      // Values are never listed, only whether they are masked.
      return rows.map((row) => ({
        name: row.name,
        masked: row.masked === 1,
        created_at: row.created_at,
        plaintext_at_rest: secrets.isPlaintext(row.value),
      }));
    },

    // Unlike resolve, a value that cannot be opened throws rather than
    // reading as absent, or a rotated key would look like a missing variable.
    async reveal(projectId, name) {
      const row = await db.get(
        `SELECT project_id, name, value, masked FROM project_variables
          WHERE project_id = {project} AND name = {name}`,
        { project: projectId, name }
      );
      if (!row) return null;
      return { name: row.name, masked: row.masked === 1, value: open(row) };
    },

    async set(projectId, name, value, { masked = true } = {}) {
      if (!NAME_PATTERN.test(String(name))) {
        throw new Error(`variable name ${JSON.stringify(name)} is not a valid environment variable name`);
      }
      if (typeof value !== 'string') throw new Error('variable value must be a string');
      if (value.length > 8192) throw new Error('variable value must be at most 8192 characters');

      const sealed = secrets.seal(value, aad(projectId, name));

      // No portable upsert, so the read and the write happen together.
      await db.transaction(async (tx) => {
        const existing = await tx.get(
          'SELECT name FROM project_variables WHERE project_id = {project} AND name = {name}',
          { project: projectId, name }
        );
        if (existing) {
          await tx.run(
            `UPDATE project_variables SET value = {value}, masked = {masked}
              WHERE project_id = {project} AND name = {name}`,
            { project: projectId, name, value: sealed, masked: masked ? 1 : 0 }
          );
        } else {
          await tx.run(
            `INSERT INTO project_variables (project_id, name, value, masked, created_at)
             VALUES ({project}, {name}, {value}, {masked}, {now})`,
            { project: projectId, name, value: sealed, masked: masked ? 1 : 0, now: Date.now() }
          );
        }
      });

      maskCache.delete(projectId);
      return { name, masked };
    },

    async remove(projectId, name) {
      const res = await db.run(
        'DELETE FROM project_variables WHERE project_id = {project} AND name = {name}',
        { project: projectId, name }
      );
      maskCache.delete(projectId);
      return res.changes > 0;
    },

    // Decrypted, for injection into a job environment.
    async resolve(projectId) {
      const rows = await db.all(
        'SELECT project_id, name, value, masked FROM project_variables WHERE project_id = {project}',
        { project: projectId }
      );

      const env = {};
      const masked = [];
      for (const row of rows) {
        let value;
        try {
          value = open(row);
        } catch {
          // A value that cannot be opened is skipped rather than failing
          // the job, since the rest of the pipeline may not need it.
          continue;
        }
        env[row.name] = value;
        if (row.masked === 1) masked.push(value);
      }
      return { env, masked };
    },

    // Just the values that must not appear in a log.
    async maskedValues(projectId) {
      const cached = maskCache.get(projectId);
      if (cached && cached.expires > Date.now()) return cached.values;

      const { masked } = await this.resolve(projectId);
      maskCache.set(projectId, { values: masked, expires: Date.now() + ttl });
      return masked;
    },

    invalidate(projectId) {
      if (projectId) maskCache.delete(projectId);
      else maskCache.clear();
    },
  };
}

// Replaces known secrets in a buffer. Used by the conductor on ingest as a
// backstop; it works within a chunk only, since the worker is responsible
// for handling values split across chunk boundaries.
export function maskBuffer(buffer, values) {
  if (!values || values.length === 0) return buffer;

  let text = buffer.toString('utf8');
  let changed = false;
  // Longest first, so an overlapping shorter value cannot partially reveal
  // a longer one.
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    if (value.length < 4 || !text.includes(value)) continue;
    text = text.split(value).join('[masked]');
    changed = true;
  }

  return changed ? Buffer.from(text, 'utf8') : buffer;
}
