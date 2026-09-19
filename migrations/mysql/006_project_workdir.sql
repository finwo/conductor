-- 006_project_workdir.sql - where a job's tree is put in its container
--
-- See migrations/sqlite/006_project_workdir.sql for the reasoning.

ALTER TABLE projects ADD COLUMN workdir VARCHAR(1024) NULL;
