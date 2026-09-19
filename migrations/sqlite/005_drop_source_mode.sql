-- 005_drop_source_mode.sql - one way to get the source, not two
--
-- A project could choose between having the worker download a tarball of
-- the commit from the conductor, or clone the repository itself. Clone
-- mode is gone.
--
-- It existed to save bandwidth on large repositories, and cost a great
-- deal for it: the worker needed git, needed credentials for the
-- repository, and could reach any ref rather than only the commit it was
-- given work for. The tarball has none of those properties, and is now
-- streamed straight into the job container, so the worker needs no
-- working directory of its own either.
--
-- The column is dropped rather than left in place, since a setting that
-- is still offered and no longer does anything is worse than one that is
-- gone.

ALTER TABLE projects DROP COLUMN source_mode;
