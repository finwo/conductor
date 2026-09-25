-- 003_task_dep_kind.sql - two kinds of dependency edge
--
-- 'needs' is the original meaning: the dependency must have succeeded.
-- 'after' waits only for the dependency to have finished, whatever it
-- finished as, and is not followed when a failure skips dependents.
--
-- Every existing edge is a 'needs', which the default records.

ALTER TABLE task_deps ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'needs';
