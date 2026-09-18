-- 001_initial.sql - base schema for conductor (mysql and tidb)
--
-- Conventions, kept identical to the sqlite dialect:
--   timestamps are BIGINT epoch milliseconds
--   booleans are TINYINT 0 or 1
--   json documents are TEXT
--   secrets are TEXT produced by src/lib/secretbox.js
--
-- Column widths are chosen so that every indexed column stays within the
-- InnoDB 3072 byte key limit under utf8mb4.

CREATE TABLE projects (
  id              VARCHAR(64)  NOT NULL PRIMARY KEY,
  name            VARCHAR(255) NOT NULL,
  repo_url        TEXT         NOT NULL,
  default_branch  VARCHAR(255) NOT NULL DEFAULT 'main',
  config_path     VARCHAR(255) NOT NULL DEFAULT '.conductor.yml',
  -- How workers obtain the source: 'archive' has them download a tarball
  -- from the conductor, 'clone' has them git clone repo_url themselves.
  source_mode     VARCHAR(16)  NOT NULL DEFAULT 'archive',
  -- Shared secret for trigger HMAC verification, encrypted at rest.
  trigger_secret  TEXT,
  enabled         TINYINT      NOT NULL DEFAULT 1,
  run_counter     BIGINT       NOT NULL DEFAULT 0,
  created_at      BIGINT       NOT NULL,
  updated_at      BIGINT       NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE users (
  id             VARCHAR(64)  NOT NULL PRIMARY KEY,
  username       VARCHAR(191) NOT NULL UNIQUE,
  password_hash  TEXT         NOT NULL,
  role           VARCHAR(32)  NOT NULL DEFAULT 'viewer',
  disabled       TINYINT      NOT NULL DEFAULT 0,
  created_at     BIGINT       NOT NULL,
  last_login_at  BIGINT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE worker_tokens (
  id            VARCHAR(64)  NOT NULL PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  token_hash    CHAR(64)     NOT NULL UNIQUE,
  enabled       TINYINT      NOT NULL DEFAULT 1,
  created_at    BIGINT       NOT NULL,
  last_seen_at  BIGINT,
  last_ip       VARCHAR(64)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE runs (
  id           VARCHAR(64)  NOT NULL PRIMARY KEY,
  project_id   VARCHAR(64)  NOT NULL,
  number       BIGINT       NOT NULL,
  ref          VARCHAR(255),
  base_sha     VARCHAR(64),
  head_sha     VARCHAR(64)  NOT NULL,
  -- Named trigger_type rather than trigger, which is reserved in MySQL.
  trigger_type VARCHAR(32)  NOT NULL DEFAULT 'push',
  actor        VARCHAR(255),
  title        TEXT,
  state        VARCHAR(16)  NOT NULL DEFAULT 'pending',
  -- Resolved pipeline as scheduled, retained so a run stays explainable
  -- after the repository moves on.
  pipeline     MEDIUMTEXT,
  error        TEXT,
  created_at   BIGINT       NOT NULL,
  started_at   BIGINT,
  finished_at  BIGINT,
  CONSTRAINT fk_runs_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE KEY idx_runs_project_number (project_id, number),
  KEY idx_runs_created (created_at),
  KEY idx_runs_state (state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE jobs (
  id               VARCHAR(96)  NOT NULL PRIMARY KEY,
  run_id           VARCHAR(64)  NOT NULL,
  -- Expanded name, for example 'package:pkg=musl'.
  name             VARCHAR(191) NOT NULL,
  -- Template name before matrix and arch expansion.
  base_name        VARCHAR(191) NOT NULL,
  arch             VARCHAR(32),
  image            TEXT         NOT NULL,
  -- json array of worker feature names this job needs.
  requires         TEXT         NOT NULL,
  -- json document: script, env, services, artifacts, cache, matrix values.
  spec             MEDIUMTEXT   NOT NULL,
  state            VARCHAR(16)  NOT NULL DEFAULT 'queued',
  allow_failure    TINYINT      NOT NULL DEFAULT 0,
  attempt          INT          NOT NULL DEFAULT 0,
  max_attempts     INT          NOT NULL DEFAULT 1,
  timeout          INT          NOT NULL,
  exit_code        INT,
  error            TEXT,
  log_key          VARCHAR(255),
  log_size         BIGINT       NOT NULL DEFAULT 0,
  worker_token_id  VARCHAR(64),
  worker_name      VARCHAR(255),
  claimed_at       BIGINT,
  heartbeat_at     BIGINT,
  created_at       BIGINT       NOT NULL,
  started_at       BIGINT,
  finished_at      BIGINT,
  CONSTRAINT fk_jobs_run FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  UNIQUE KEY idx_jobs_run_name (run_id, name),
  KEY idx_jobs_run (run_id),
  KEY idx_jobs_state (state),
  -- Supports the reaper scan for claimed jobs that stopped reporting.
  KEY idx_jobs_heartbeat (state, heartbeat_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE job_deps (
  job_id         VARCHAR(96) NOT NULL,
  depends_on_id  VARCHAR(96) NOT NULL,
  PRIMARY KEY (job_id, depends_on_id),
  KEY idx_job_deps_reverse (depends_on_id),
  CONSTRAINT fk_job_deps_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  CONSTRAINT fk_job_deps_target FOREIGN KEY (depends_on_id) REFERENCES jobs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE artifacts (
  id           VARCHAR(64)   NOT NULL PRIMARY KEY,
  job_id       VARCHAR(96)   NOT NULL,
  run_id       VARCHAR(64)   NOT NULL,
  path         VARCHAR(1024) NOT NULL,
  storage_key  VARCHAR(1024) NOT NULL,
  size         BIGINT        NOT NULL,
  sha256       CHAR(64)      NOT NULL,
  created_at   BIGINT        NOT NULL,
  expires_at   BIGINT,
  CONSTRAINT fk_artifacts_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  KEY idx_artifacts_job (job_id),
  KEY idx_artifacts_run (run_id),
  KEY idx_artifacts_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE project_variables (
  project_id  VARCHAR(64)  NOT NULL,
  name        VARCHAR(191) NOT NULL,
  value       TEXT         NOT NULL,
  masked      TINYINT      NOT NULL DEFAULT 1,
  created_at  BIGINT       NOT NULL,
  PRIMARY KEY (project_id, name),
  CONSTRAINT fk_project_variables_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
