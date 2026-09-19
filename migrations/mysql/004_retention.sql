-- 004_retention.sql - how long artifacts and logs are kept
--
-- See migrations/sqlite/004_retention.sql for the reasoning.

ALTER TABLE projects
  ADD COLUMN artifact_keep_runs INT NULL,
  ADD COLUMN artifact_keep_days INT NULL,
  ADD COLUMN log_keep_days INT NULL;

ALTER TABLE jobs
  ADD COLUMN log_expired_at BIGINT NULL,
  ADD KEY idx_jobs_log_sweep (log_expired_at, finished_at);
