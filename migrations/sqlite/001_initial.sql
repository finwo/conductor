-- 001_initial.sql - base schema for conductor (sqlite)
--
-- Conventions, kept identical to the mysql and postgres dialects:
--   timestamps are INTEGER epoch milliseconds
--   booleans are INTEGER 0 or 1
--   json documents are TEXT
--   secrets are TEXT produced by src/lib/secretbox.js
--
-- Vocabulary. A trigger creates a job. Compiling the repository's pipeline
-- turns that job into one or more tasks, and a task is the standalone unit
-- a worker actually runs: one container, one script, one result. Workers
-- deal only in tasks and never learn which project or job a task came from.
--
-- Tables are declared in dependency order, since mysql and postgres both
-- require a referenced table to exist already.

CREATE TABLE users (
  id             TEXT    NOT NULL PRIMARY KEY,
  username       TEXT    NOT NULL UNIQUE,
  password_hash  TEXT    NOT NULL,
  -- Two roles: 'admin' and 'user'. A user is not read only; they may own
  -- projects and workers. Administration is the thing being gated, not
  -- participation.
  role           TEXT    NOT NULL DEFAULT 'user',
  disabled       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER,
  -- With OIDC the provider owns identity, but the conductor still needs a
  -- local row per person: projects and worker tokens reference users(id),
  -- so a user who exists only inside a token cannot own anything. The
  -- account is created on first sight of a valid token, keyed by issuer
  -- and subject rather than by the display name, which a provider is free
  -- to change.
  external_id    TEXT
);

CREATE UNIQUE INDEX idx_users_external ON users (external_id);

CREATE TABLE projects (
  id              TEXT    NOT NULL PRIMARY KEY,
  name            TEXT    NOT NULL,
  repo_url        TEXT    NOT NULL,
  default_branch  TEXT    NOT NULL DEFAULT 'main',
  -- The preferred pipeline file. When it is one of the conventional names
  -- the other extension is accepted as a fallback, so a repository may
  -- spell it .conductor.yml or .conductor.yaml without being configured.
  config_path     TEXT    NOT NULL DEFAULT '.conductor.yml',
  -- Shared secret for trigger HMAC verification, encrypted at rest.
  trigger_secret  TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  job_counter     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  -- A user may register their own projects and their own workers. A worker
  -- that has an owner is only ever offered tasks belonging to that owner's
  -- projects, so lending someone build capacity exposes nothing else. A
  -- worker with no owner is shared and can run any project's tasks.
  --
  -- Deleting a user deletes what they owned, cascading on to their jobs,
  -- tasks and artifacts. Leaving the rows behind unowned would be worse
  -- than losing them, since an unowned worker token is shared capacity: a
  -- deleted account would quietly widen a worker's reach, not remove it.
  owner_id        TEXT    REFERENCES users(id) ON DELETE CASCADE,
  visibility      TEXT    NOT NULL DEFAULT 'private',
  -- Retention. NULL is "no opinion", and the server default applies. Zero
  -- means keep forever, which has to be distinguishable from unset or a
  -- project could not opt out of a server default that deletes things.
  --
  -- Artifacts have two rules and an artifact survives if either wants it:
  -- the last artifact_keep_jobs jobs are kept however old they are, and
  -- anything younger than artifact_keep_days is kept however many jobs
  -- have followed it. The artifacts of the most recent successful job are
  -- kept regardless, so a project that has gone quiet still has something
  -- to download. A task that set artifacts.expire in the pipeline overrides
  -- all of it with an exact deadline, in either direction, since a bulky
  -- intermediate is worth dropping early even from a green build.
  --
  -- Logs are simpler: they go by age alone.
  artifact_keep_jobs  INTEGER,
  artifact_keep_days  INTEGER,
  log_keep_days       INTEGER,
  -- Where a task's tree is unpacked inside its container. Three answers,
  -- most specific first: the workdir key in the repository's pipeline,
  -- this column, and failing both the server default of /work. The
  -- repository wins because the path belongs with the code: an image that
  -- expects to build in /usr/src/app knows that, and whoever registered
  -- the project should not have to.
  workdir         TEXT
);

CREATE INDEX idx_projects_owner ON projects (owner_id);

CREATE TABLE worker_tokens (
  id            TEXT    NOT NULL PRIMARY KEY,
  name          TEXT    NOT NULL,
  token_hash    TEXT    NOT NULL UNIQUE,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  last_ip       TEXT,
  owner_id      TEXT    REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_worker_tokens_owner ON worker_tokens (owner_id);

CREATE TABLE jobs (
  id           TEXT    NOT NULL PRIMARY KEY,
  project_id   TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number       INTEGER NOT NULL,
  ref          TEXT,
  base_sha     TEXT,
  head_sha     TEXT    NOT NULL,
  -- Named trigger_type rather than trigger, which is reserved in MySQL.
  trigger_type TEXT    NOT NULL DEFAULT 'push',
  actor        TEXT,
  title        TEXT,
  state        TEXT    NOT NULL DEFAULT 'pending',
  -- Resolved pipeline as scheduled, retained so a job stays explainable
  -- after the repository moves on.
  pipeline     TEXT,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER,
  -- A job is private unless it says otherwise. The value comes from the
  -- project, and the pipeline at the built commit may override it, so a
  -- repository decides whether its own results are public.
  visibility   TEXT    NOT NULL DEFAULT 'private'
);

CREATE UNIQUE INDEX idx_jobs_project_number ON jobs (project_id, number);
CREATE INDEX idx_jobs_created ON jobs (created_at);
CREATE INDEX idx_jobs_state ON jobs (state);
CREATE INDEX idx_jobs_visibility ON jobs (visibility);

CREATE TABLE tasks (
  -- Opaque and time ordered. A task id deliberately carries no structure:
  -- a worker holding one learns nothing about the job or project it
  -- belongs to, and the id stays usable in a URL, a container name and a
  -- storage key without escaping.
  id               TEXT    NOT NULL PRIMARY KEY,
  job_id           TEXT    NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  -- Expanded name, for example 'package:pkg=musl'.
  name             TEXT    NOT NULL,
  -- Template name before matrix and arch expansion.
  base_name        TEXT    NOT NULL,
  arch             TEXT,
  image            TEXT    NOT NULL,
  -- json array of worker feature names this task needs.
  requires         TEXT    NOT NULL,
  -- json document: script, env, services, artifacts, matrix values, the
  -- resolved needs and depth, and the workdir settled when the job was
  -- created so a retry cannot land somewhere else.
  spec             TEXT    NOT NULL,
  state            TEXT    NOT NULL DEFAULT 'queued',
  allow_failure    INTEGER NOT NULL DEFAULT 0,
  attempt          INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 1,
  timeout          INTEGER NOT NULL,
  exit_code        INTEGER,
  error            TEXT,
  log_key          TEXT,
  log_size         INTEGER NOT NULL DEFAULT 0,
  -- Distinguishes a log that was swept from one that never existed, so the
  -- interface can say which without guessing from an empty log_key.
  log_expired_at   INTEGER,
  worker_token_id  TEXT,
  worker_name      TEXT,
  claimed_at       INTEGER,
  heartbeat_at     INTEGER,
  created_at       INTEGER NOT NULL,
  started_at       INTEGER,
  finished_at      INTEGER
);

CREATE UNIQUE INDEX idx_tasks_job_name ON tasks (job_id, name);
CREATE INDEX idx_tasks_job ON tasks (job_id);
CREATE INDEX idx_tasks_state ON tasks (state);
-- Supports the reaper scan for claimed tasks that stopped reporting.
CREATE INDEX idx_tasks_heartbeat ON tasks (state, heartbeat_at);
-- The sweep walks finished tasks oldest first, per project.
CREATE INDEX idx_tasks_log_sweep ON tasks (log_expired_at, finished_at);

CREATE TABLE task_deps (
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id)
);

CREATE INDEX idx_task_deps_reverse ON task_deps (depends_on_id);

CREATE TABLE artifacts (
  id           TEXT    NOT NULL PRIMARY KEY,
  task_id      TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- Denormalized so the retention sweep and the download path can filter
  -- by job without joining through tasks.
  job_id       TEXT    NOT NULL,
  path         TEXT    NOT NULL,
  storage_key  TEXT    NOT NULL,
  size         INTEGER NOT NULL,
  sha256       TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER
);

CREATE INDEX idx_artifacts_task ON artifacts (task_id);
CREATE INDEX idx_artifacts_job ON artifacts (job_id);
CREATE INDEX idx_artifacts_expires ON artifacts (expires_at);

CREATE TABLE project_variables (
  project_id  TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  value       TEXT    NOT NULL,
  masked      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, name)
);
