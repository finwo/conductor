-- 001_initial.sql - base schema for conductor (postgres)
--
-- Conventions, kept identical to the sqlite and mysql dialects:
--   timestamps are BIGINT epoch milliseconds
--   booleans are SMALLINT 0 or 1, deliberately not the native BOOLEAN type,
--     so that a row read back looks the same on every dialect
--   json documents are TEXT, not JSONB, since nothing queries inside them
--   secrets are TEXT produced by src/lib/secretbox.js

CREATE TABLE projects (
  id              TEXT     NOT NULL PRIMARY KEY,
  name            TEXT     NOT NULL,
  repo_url        TEXT     NOT NULL,
  default_branch  TEXT     NOT NULL DEFAULT 'main',
  config_path     TEXT     NOT NULL DEFAULT '.conductor.yml',
  -- How workers obtain the source: 'archive' has them download a tarball
  -- from the conductor, 'clone' has them git clone repo_url themselves.
  source_mode     TEXT     NOT NULL DEFAULT 'archive',
  -- Shared secret for trigger HMAC verification, encrypted at rest.
  trigger_secret  TEXT,
  enabled         SMALLINT NOT NULL DEFAULT 1,
  run_counter     BIGINT   NOT NULL DEFAULT 0,
  created_at      BIGINT   NOT NULL,
  updated_at      BIGINT   NOT NULL
);

CREATE TABLE users (
  id             TEXT     NOT NULL PRIMARY KEY,
  username       TEXT     NOT NULL UNIQUE,
  password_hash  TEXT     NOT NULL,
  role           TEXT     NOT NULL DEFAULT 'viewer',
  disabled       SMALLINT NOT NULL DEFAULT 0,
  created_at     BIGINT   NOT NULL,
  last_login_at  BIGINT
);

CREATE TABLE worker_tokens (
  id            TEXT     NOT NULL PRIMARY KEY,
  name          TEXT     NOT NULL,
  token_hash    CHAR(64) NOT NULL UNIQUE,
  enabled       SMALLINT NOT NULL DEFAULT 1,
  created_at    BIGINT   NOT NULL,
  last_seen_at  BIGINT,
  last_ip       TEXT
);

CREATE TABLE runs (
  id           TEXT   NOT NULL PRIMARY KEY,
  project_id   TEXT   NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number       BIGINT NOT NULL,
  ref          TEXT,
  base_sha     TEXT,
  head_sha     TEXT   NOT NULL,
  -- Named trigger_type rather than trigger, which is reserved in MySQL.
  trigger_type TEXT   NOT NULL DEFAULT 'push',
  actor        TEXT,
  title        TEXT,
  state        TEXT   NOT NULL DEFAULT 'pending',
  -- Resolved pipeline as scheduled, retained so a run stays explainable
  -- after the repository moves on.
  pipeline     TEXT,
  error        TEXT,
  created_at   BIGINT NOT NULL,
  started_at   BIGINT,
  finished_at  BIGINT
);

CREATE UNIQUE INDEX idx_runs_project_number ON runs (project_id, number);
CREATE INDEX idx_runs_created ON runs (created_at);
CREATE INDEX idx_runs_state ON runs (state);

CREATE TABLE jobs (
  id               TEXT     NOT NULL PRIMARY KEY,
  run_id           TEXT     NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  -- Expanded name, for example 'package:pkg=musl'.
  name             TEXT     NOT NULL,
  -- Template name before matrix and arch expansion.
  base_name        TEXT     NOT NULL,
  arch             TEXT,
  image            TEXT     NOT NULL,
  -- json array of worker feature names this job needs.
  requires         TEXT     NOT NULL,
  -- json document: script, env, services, artifacts, cache, matrix values.
  spec             TEXT     NOT NULL,
  state            TEXT     NOT NULL DEFAULT 'queued',
  allow_failure    SMALLINT NOT NULL DEFAULT 0,
  attempt          INTEGER  NOT NULL DEFAULT 0,
  max_attempts     INTEGER  NOT NULL DEFAULT 1,
  timeout          INTEGER  NOT NULL,
  exit_code        INTEGER,
  error            TEXT,
  log_key          TEXT,
  log_size         BIGINT   NOT NULL DEFAULT 0,
  worker_token_id  TEXT,
  worker_name      TEXT,
  claimed_at       BIGINT,
  heartbeat_at     BIGINT,
  created_at       BIGINT   NOT NULL,
  started_at       BIGINT,
  finished_at      BIGINT
);

CREATE UNIQUE INDEX idx_jobs_run_name ON jobs (run_id, name);
CREATE INDEX idx_jobs_run ON jobs (run_id);
CREATE INDEX idx_jobs_state ON jobs (state);
-- Supports the reaper scan for claimed jobs that stopped reporting.
CREATE INDEX idx_jobs_heartbeat ON jobs (state, heartbeat_at);

CREATE TABLE job_deps (
  job_id         TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  depends_on_id  TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, depends_on_id)
);

CREATE INDEX idx_job_deps_reverse ON job_deps (depends_on_id);

CREATE TABLE artifacts (
  id           TEXT     NOT NULL PRIMARY KEY,
  job_id       TEXT     NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_id       TEXT     NOT NULL,
  path         TEXT     NOT NULL,
  storage_key  TEXT     NOT NULL,
  size         BIGINT   NOT NULL,
  sha256       CHAR(64) NOT NULL,
  created_at   BIGINT   NOT NULL,
  expires_at   BIGINT
);

CREATE INDEX idx_artifacts_job ON artifacts (job_id);
CREATE INDEX idx_artifacts_run ON artifacts (run_id);
CREATE INDEX idx_artifacts_expires ON artifacts (expires_at);

CREATE TABLE project_variables (
  project_id  TEXT     NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT     NOT NULL,
  value       TEXT     NOT NULL,
  masked      SMALLINT NOT NULL DEFAULT 1,
  created_at  BIGINT   NOT NULL,
  PRIMARY KEY (project_id, name)
);
