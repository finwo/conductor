-- 002_ownership.sql - project ownership and run visibility (postgres)
--
-- See migrations/sqlite/002_ownership.sql for the reasoning.

ALTER TABLE projects
  ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';

ALTER TABLE worker_tokens
  ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE runs
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';

CREATE INDEX idx_projects_owner ON projects (owner_id);
CREATE INDEX idx_worker_tokens_owner ON worker_tokens (owner_id);
CREATE INDEX idx_runs_visibility ON runs (visibility);
