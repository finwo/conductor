-- 004_retention.sql - how long artifacts and logs are kept
--
-- See migrations/sqlite/004_retention.sql for the reasoning.

ALTER TABLE projects ADD COLUMN artifact_keep_runs INTEGER;
ALTER TABLE projects ADD COLUMN artifact_keep_days INTEGER;
ALTER TABLE projects ADD COLUMN log_keep_days INTEGER;

ALTER TABLE jobs ADD COLUMN log_expired_at BIGINT;

CREATE INDEX idx_jobs_log_sweep ON jobs (log_expired_at, finished_at);
