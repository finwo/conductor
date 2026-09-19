-- 006_project_workdir.sql - where a job's tree is put in its container
--
-- The tree used to be bind mounted from the worker at a path the worker
-- chose. It is now unpacked inside the container instead, which means the
-- path is a property of the build rather than of the machine running it,
-- and is worth being able to choose.
--
-- Three answers, most specific first: the workdir key in the repository's
-- pipeline, this column, and failing both the server default of /work.
-- Null means the project has no opinion.
--
-- A repository may override its project because the path belongs with the
-- code: an image that expects to build in /usr/src/app knows that, and
-- whoever registered the project should not have to.

ALTER TABLE projects ADD COLUMN workdir TEXT;
