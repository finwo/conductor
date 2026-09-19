-- 002_ownership.sql - project ownership and run visibility (sqlite)
--
-- Two changes that go together:
--
--   Ownership. A user may register their own projects and their own
--   workers. A worker that has an owner will only ever be offered jobs
--   belonging to that owner's projects, so lending someone build capacity
--   does not expose anything else. A worker with no owner is shared and
--   can run any project, which is how an administrator provides general
--   capacity.
--
--   Visibility. A run is private unless it says otherwise. The value comes
--   from the project, and the pipeline at the built commit may override it,
--   so a repository decides whether its own results are public.
--
-- Deleting a user deletes what they owned, cascading on to their runs,
-- jobs and artifacts. Leaving the rows behind unowned would be worse than
-- losing them: an unowned project is administered centrally, and an
-- unowned worker token is shared capacity that accepts every project's
-- jobs, so a deleted account would quietly widen a worker's reach rather
-- than removing it.

ALTER TABLE projects ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE projects ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';

ALTER TABLE worker_tokens ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE runs ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';

CREATE INDEX idx_projects_owner ON projects (owner_id);
CREATE INDEX idx_worker_tokens_owner ON worker_tokens (owner_id);
CREATE INDEX idx_runs_visibility ON runs (visibility);
