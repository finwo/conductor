// src/conductor/retention.js - deleting build output that is past its time
//
// Everything a run produces is kept forever unless something removes it,
// and logs are the worst of it: written for every job, read for almost
// none, and never stopping. This sweeps both.
//
// Artifacts follow two rules per project, and an artifact survives if
// either wants it. The last artifact_keep_runs runs keep their artifacts
// however old they are, and anything younger than artifact_keep_days is
// kept however many runs have followed. The most recent successful run is
// kept regardless, so a project that has gone quiet still has something
// to download.
//
// A job that set artifacts.expire in its pipeline overrides all of that
// with an exact deadline, in either direction. That is deliberate: the
// point of the key is to drop a bulky intermediate early, and a
// node_modules tree is not worth keeping just because its run was green.
//
// Logs go by age alone.
//
// Deleting is done object first and row second. An orphaned object wastes
// space until the next sweep notices nothing references it; an orphaned
// row points at something that is gone, which is a broken download. The
// cheaper failure is the one to choose.

const DAY = 24 * 60 * 60 * 1000;

// A project's own setting, the server default when it has none. Zero is a
// real answer meaning keep forever, so only null and undefined fall
// through to the default.
function setting(projectValue, fallback) {
  return projectValue === null || projectValue === undefined ? fallback : projectValue;
}

export function createRetention({ cfg, db, storage, logs, logger = {} }) {
  const defaults = cfg.retention;

  async function deleteObject(key, what) {
    if (!key) return true;
    try {
      await storage.delete(key);
      return true;
    } catch (e) {
      // Leave the row alone so the next sweep tries again rather than
      // losing track of the object entirely.
      logger.warn?.(`retention: could not delete ${what} ${key}: ${e.message}`);
      return false;
    }
  }

  // Artifacts whose pipeline gave them an explicit deadline. Nothing
  // protects these, which is the point of setting one.
  async function sweepExpiredArtifacts(now, batch) {
    const rows = await db.all(
      `SELECT id, storage_key FROM artifacts
        WHERE expires_at IS NOT NULL AND expires_at <= {now}
        ORDER BY expires_at
        LIMIT {batch}`,
      { now, batch }
    );

    let deleted = 0;
    let bytes = 0;
    for (const row of rows) {
      if (!(await deleteObject(row.storage_key, 'artifact'))) continue;
      const size = await db.get('SELECT size FROM artifacts WHERE id = {id}', { id: row.id });
      await db.run('DELETE FROM artifacts WHERE id = {id}', { id: row.id });
      deleted += 1;
      bytes += size?.size ?? 0;
    }
    return { deleted, bytes };
  }

  async function sweepProjectArtifacts(project, now, batch) {
    const keepRuns = setting(project.artifact_keep_runs, defaults.artifact_keep_runs);
    const keepDays = setting(project.artifact_keep_days, defaults.artifact_keep_days);

    // Both rules off means keep everything, and with the rules combined by
    // whichever keeps longer there is nothing left to delete.
    if (keepRuns === 0 && keepDays === 0) return { deleted: 0, bytes: 0 };

    const protectedRuns = new Set();

    if (keepRuns > 0) {
      const recent = await db.all(
        `SELECT id FROM runs WHERE project_id = {project}
          ORDER BY number DESC
          LIMIT {limit}`,
        { project: project.id, limit: keepRuns }
      );
      for (const run of recent) protectedRuns.add(run.id);
    }

    // The last green run, however old. Looked up separately rather than
    // folded into the query above, since it may be far outside the recent
    // window on a project that has been failing for a while.
    const lastGood = await db.get(
      `SELECT id FROM runs WHERE project_id = {project} AND state = 'success'
        ORDER BY number DESC
        LIMIT 1`,
      { project: project.id }
    );
    if (lastGood) protectedRuns.add(lastGood.id);

    // With no age rule, anything outside the run window goes; otherwise
    // only what is also older than the cutoff.
    const cutoff = keepDays > 0 ? now - keepDays * DAY : now;

    const candidates = await db.all(
      `SELECT a.id, a.storage_key, a.size, a.run_id
         FROM artifacts a
         JOIN runs r ON r.id = a.run_id
        WHERE r.project_id = {project}
          AND a.expires_at IS NULL
          AND r.created_at < {cutoff}
          AND r.finished_at IS NOT NULL
        ORDER BY r.created_at
        LIMIT {batch}`,
      { project: project.id, cutoff, batch }
    );

    let deleted = 0;
    let bytes = 0;
    for (const row of candidates) {
      if (protectedRuns.has(row.run_id)) continue;
      if (!(await deleteObject(row.storage_key, 'artifact'))) continue;
      await db.run('DELETE FROM artifacts WHERE id = {id}', { id: row.id });
      deleted += 1;
      bytes += row.size ?? 0;
    }
    return { deleted, bytes };
  }

  async function sweepProjectLogs(project, now, batch) {
    const keepDays = setting(project.log_keep_days, defaults.log_keep_days);
    if (keepDays === 0) return { deleted: 0, bytes: 0 };

    const cutoff = now - keepDays * DAY;

    const rows = await db.all(
      `SELECT j.id, j.run_id, j.log_key, j.log_size
         FROM jobs j
         JOIN runs r ON r.id = j.run_id
        WHERE r.project_id = {project}
          AND j.log_expired_at IS NULL
          AND j.finished_at IS NOT NULL
          AND j.finished_at < {cutoff}
        ORDER BY j.finished_at
        LIMIT {batch}`,
      { project: project.id, cutoff, batch }
    );

    let deleted = 0;
    let bytes = 0;
    for (const row of rows) {
      if (!(await deleteObject(row.log_key, 'log'))) continue;

      // A job that never finished archiving still has a spool file, and a
      // job with nothing to say has neither. Both are fine to ask about.
      await logs.remove(row.run_id, row.id).catch((e) => {
        logger.warn?.(`retention: could not remove spooled log for ${row.id}: ${e.message}`);
      });

      await db.run(
        'UPDATE jobs SET log_key = NULL, log_expired_at = {now} WHERE id = {id}',
        { id: row.id, now }
      );
      deleted += 1;
      bytes += row.log_size ?? 0;
    }
    return { deleted, bytes };
  }

  return {
    // One pass over everything. Returns what it did, which the tests read
    // and the log line summarises.
    async sweep({ now = Date.now(), batch = defaults.batch } = {}) {
      const total = {
        artifacts: 0, artifactBytes: 0, logs: 0, logBytes: 0,
      };

      const expired = await sweepExpiredArtifacts(now, batch);
      total.artifacts += expired.deleted;
      total.artifactBytes += expired.bytes;

      const projects = await db.all(
        `SELECT id, artifact_keep_runs, artifact_keep_days, log_keep_days
           FROM projects`,
        {}
      );

      for (const project of projects) {
        const a = await sweepProjectArtifacts(project, now, batch);
        total.artifacts += a.deleted;
        total.artifactBytes += a.bytes;

        const l = await sweepProjectLogs(project, now, batch);
        total.logs += l.deleted;
        total.logBytes += l.bytes;
      }

      if (total.artifacts > 0 || total.logs > 0) {
        logger.info?.(
          `retention: removed ${total.artifacts} artifact(s) and ${total.logs} log(s), ` +
          `freeing ${Math.round((total.artifactBytes + total.logBytes) / 1024)} KiB`
        );
      }

      return total;
    },
  };
}
