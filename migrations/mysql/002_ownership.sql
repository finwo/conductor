-- 002_ownership.sql - project ownership and run visibility (mysql and tidb)
--
-- See migrations/sqlite/002_ownership.sql for the reasoning.

ALTER TABLE projects
  ADD COLUMN owner_id VARCHAR(64) NULL,
  ADD COLUMN visibility VARCHAR(16) NOT NULL DEFAULT 'private',
  ADD KEY idx_projects_owner (owner_id),
  ADD CONSTRAINT fk_projects_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE worker_tokens
  ADD COLUMN owner_id VARCHAR(64) NULL,
  ADD KEY idx_worker_tokens_owner (owner_id),
  ADD CONSTRAINT fk_worker_tokens_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE runs
  ADD COLUMN visibility VARCHAR(16) NOT NULL DEFAULT 'private',
  ADD KEY idx_runs_visibility (visibility);
