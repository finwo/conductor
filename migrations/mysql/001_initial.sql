-- 001_initial.sql - base schema for conductor (mysql and tidb)
--
-- Conventions, kept identical to the sqlite and postgres dialects:
--   timestamps are BIGINT epoch milliseconds
--   booleans are TINYINT 0 or 1
--   json documents are TEXT
--   secrets are TEXT produced by src/lib/secretbox.js
--
-- Vocabulary. A trigger creates a job. Compiling the repository's pipeline
-- turns that job into one or more tasks, and a task is the standalone unit
-- a worker actually runs: one container, one script, one result. Workers
-- deal only in tasks and never learn which project or job a task came from.
--
-- Column widths are chosen so that every indexed column stays within the
-- InnoDB 3072 byte key limit under utf8mb4. Tables are declared in
-- dependency order, since a referenced table must exist already.

CREATE TABLE users (
  id             VARCHAR(64)  NOT NULL PRIMARY KEY,
  username       VARCHAR(191) NOT NULL UNIQUE,
  password_hash  TEXT         NOT NULL,
  -- Two roles: 'admin' and 'user'. A user is not read only; they may own
  -- projects and workers. Administration is the thing being gated, not
  -- participation.
  role           VARCHAR(32)  NOT NULL DEFAULT 'user',
  disabled       TINYINT      NOT NULL DEFAULT 0,
  created_at     BIGINT       NOT NULL,
  last_login_at  BIGINT,
  -- With OIDC the provider owns identity, but the conductor still needs a
  -- local row per person: projects and worker tokens reference users(id),
  -- so a user who exists only inside a token cannot own anything. The
  -- account is created on first sight of a valid token, keyed by issuer
  -- and subject rather than by the display name, which a provider is free
  -- to change.
  external_id    VARCHAR(255),
  UNIQUE KEY idx_users_external (external_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE projects (
  id              VARCHAR(64)  NOT NULL PRIMARY KEY,
  name            VARCHAR(255) NOT NULL,
  repo_url        TEXT         NOT NULL,
  default_branch  VARCHAR(255) NOT NULL DEFAULT 'main',
  -- The preferred pipeline file. When it is one of the conventional names
  -- the other extension is accepted as a fallback, so a repository may
  -- spell it .conductor.yml or .conductor.yaml without being configured.
  config_path     VARCHAR(255) NOT NULL DEFAULT '.conductor.yml',
  -- Shared secret for trigger HMAC verification, encrypted at rest.
  trigger_secret  TEXT,
  enabled         TINYINT      NOT NULL DEFAULT 1,
  job_counter     BIGINT       NOT NULL DEFAULT 0,
  created_at      BIGINT       NOT NULL,
  updated_at      BIGINT       NOT NULL,
  -- A user may register their own projects and their own workers. A worker
  -- that has an owner is only ever offered tasks belonging to that owner's
  -- projects, so lending someone build capacity exposes nothing else. A
  -- worker with no owner is shared and can run any project's tasks.
  --
  -- Deleting a user deletes what they owned, cascading on to their jobs,
  -- tasks and artifacts. Leaving the rows behind unowned would be worse
  -- than losing them, since an unowned worker token is shared capacity: a
  -- deleted account would quietly widen a worker's reach, not remove it.
  owner_id        VARCHAR(64),
  visibility      VARCHAR(16)  NOT NULL DEFAULT 'private',
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
  artifact_keep_jobs  INT,
  artifact_keep_days  INT,
  log_keep_days       INT,
  -- Where a task's tree is unpacked inside its container. Three answers,
  -- most specific first: the workdir key in the repository's pipeline,
  -- this column, and failing both the server default of /work. The
  -- repository wins because the path belongs with the code: an image that
  -- expects to build in /usr/src/app knows that, and whoever registered
  -- the project should not have to.
  workdir         VARCHAR(1024),
  KEY idx_projects_owner (owner_id),
  CONSTRAINT fk_projects_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE worker_tokens (
  id            VARCHAR(64)  NOT NULL PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  token_hash    CHAR(64)     NOT NULL UNIQUE,
  enabled       TINYINT      NOT NULL DEFAULT 1,
  created_at    BIGINT       NOT NULL,
  last_seen_at  BIGINT,
  last_ip       VARCHAR(64),
  owner_id      VARCHAR(64),
  KEY idx_worker_tokens_owner (owner_id),
  CONSTRAINT fk_worker_tokens_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE jobs (
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
  -- Resolved pipeline as scheduled, retained so a job stays explainable
  -- after the repository moves on.
  pipeline     MEDIUMTEXT,
  error        TEXT,
  created_at   BIGINT       NOT NULL,
  started_at   BIGINT,
  finished_at  BIGINT,
  -- A job is private unless it says otherwise. The value comes from the
  -- project, and the pipeline at the built commit may override it, so a
  -- repository decides whether its own results are public.
  visibility   VARCHAR(16)  NOT NULL DEFAULT 'private',
  CONSTRAINT fk_jobs_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE KEY idx_jobs_project_number (project_id, number),
  KEY idx_jobs_created (created_at),
  KEY idx_jobs_state (state),
  KEY idx_jobs_visibility (visibility)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE tasks (
  -- Opaque and time ordered. A task id deliberately carries no structure:
  -- a worker holding one learns nothing about the job or project it
  -- belongs to, and the id stays usable in a URL, a container name and a
  -- storage key without escaping.
  id               VARCHAR(64)  NOT NULL PRIMARY KEY,
  job_id           VARCHAR(64)  NOT NULL,
  -- Expanded name, for example 'package:pkg=musl'.
  name             VARCHAR(191) NOT NULL,
  -- Template name before matrix and arch expansion.
  base_name        VARCHAR(191) NOT NULL,
  arch             VARCHAR(32),
  image            TEXT         NOT NULL,
  -- json array of worker feature names this task needs.
  requires         TEXT         NOT NULL,
  -- json document: script, env, services, artifacts, matrix values, the
  -- resolved needs and depth, and the workdir settled when the job was
  -- created so a retry cannot land somewhere else.
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
  -- Distinguishes a log that was swept from one that never existed, so the
  -- interface can say which without guessing from an empty log_key.
  log_expired_at   BIGINT,
  worker_token_id  VARCHAR(64),
  worker_name      VARCHAR(255),
  claimed_at       BIGINT,
  heartbeat_at     BIGINT,
  created_at       BIGINT       NOT NULL,
  started_at       BIGINT,
  finished_at      BIGINT,
  CONSTRAINT fk_tasks_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  UNIQUE KEY idx_tasks_job_name (job_id, name),
  KEY idx_tasks_job (job_id),
  KEY idx_tasks_state (state),
  -- Supports the reaper scan for claimed tasks that stopped reporting.
  KEY idx_tasks_heartbeat (state, heartbeat_at),
  -- The sweep walks finished tasks oldest first, per project.
  KEY idx_tasks_log_sweep (log_expired_at, finished_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE task_deps (
  task_id        VARCHAR(64) NOT NULL,
  depends_on_id  VARCHAR(64) NOT NULL,
  PRIMARY KEY (task_id, depends_on_id),
  KEY idx_task_deps_reverse (depends_on_id),
  CONSTRAINT fk_task_deps_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  CONSTRAINT fk_task_deps_target FOREIGN KEY (depends_on_id) REFERENCES tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE artifacts (
  id           VARCHAR(64)   NOT NULL PRIMARY KEY,
  task_id      VARCHAR(64)   NOT NULL,
  -- Denormalized so the retention sweep and the download path can filter
  -- by job without joining through tasks.
  job_id       VARCHAR(64)   NOT NULL,
  path         VARCHAR(1024) NOT NULL,
  storage_key  VARCHAR(1024) NOT NULL,
  size         BIGINT        NOT NULL,
  sha256       CHAR(64)      NOT NULL,
  created_at   BIGINT        NOT NULL,
  expires_at   BIGINT,
  CONSTRAINT fk_artifacts_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  KEY idx_artifacts_task (task_id),
  KEY idx_artifacts_job (job_id),
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
