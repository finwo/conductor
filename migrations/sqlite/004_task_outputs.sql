-- 004_task_outputs.sql - values a task produced while it ran
--
-- Written by ::set-output, read by ${{ tasks.<name>.outputs.<key> }} when a
-- later task is dispatched. Sealed like project variables whether masked or
-- not; masked only decides whether the value may be shown again.

CREATE TABLE task_outputs (
  task_id     TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  value       TEXT    NOT NULL,
  masked      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (task_id, name)
);
