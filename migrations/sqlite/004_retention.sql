-- 004_retention.sql - how long artifacts and logs are kept
--
-- Without this everything a run produces is kept forever, and a conductor
-- that has been busy for a year is mostly old build output nobody will
-- read again.
--
-- Each setting is NULL when the project has no opinion, in which case the
-- server default applies. Zero means keep forever, which has to be
-- distinguishable from "unset" or a project could not opt out of a server
-- default that deletes things.
--
-- Artifacts have two rules and an artifact survives if either wants it:
-- the last artifact_keep_runs runs are kept however old they are, and
-- anything younger than artifact_keep_days is kept however many runs have
-- followed it. The artifacts of the most recent successful run are kept
-- regardless, so a project that has gone quiet still has something to
-- download. A job that set artifacts.expire in the pipeline overrides all
-- of that with an exact deadline, in either direction, since a bulky
-- intermediate is worth dropping early even from a green build.
--
-- Logs are simpler: they go by age alone.

ALTER TABLE projects ADD COLUMN artifact_keep_runs INTEGER;
ALTER TABLE projects ADD COLUMN artifact_keep_days INTEGER;
ALTER TABLE projects ADD COLUMN log_keep_days INTEGER;

-- Distinguishes a log that was swept from one that never existed, so the
-- interface can say which without guessing from an empty log_key.
ALTER TABLE jobs ADD COLUMN log_expired_at INTEGER;

-- The sweep walks finished jobs oldest first, per project.
CREATE INDEX idx_jobs_log_sweep ON jobs (log_expired_at, finished_at);
