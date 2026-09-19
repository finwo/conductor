-- 005_drop_source_mode.sql - one way to get the source, not two
--
-- See migrations/sqlite/005_drop_source_mode.sql for the reasoning.

ALTER TABLE projects DROP COLUMN source_mode;
