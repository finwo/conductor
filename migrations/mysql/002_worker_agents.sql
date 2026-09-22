-- 002_worker_agents.sql - capabilities per machine behind a worker token
--
-- Several hosts may share one token. Only feature names are stored.

CREATE TABLE worker_agents (
  id             VARCHAR(64)  NOT NULL PRIMARY KEY,
  token_id       VARCHAR(64)  NOT NULL,
  name           VARCHAR(255) NOT NULL,
  arches         TEXT         NOT NULL,
  features       TEXT         NOT NULL,
  first_seen_at  BIGINT       NOT NULL,
  last_seen_at   BIGINT       NOT NULL,
  last_ip        VARCHAR(64),
  UNIQUE KEY idx_worker_agents_identity (token_id, name),
  KEY idx_worker_agents_sweep (last_seen_at),
  CONSTRAINT fk_worker_agents_token FOREIGN KEY (token_id) REFERENCES worker_tokens(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_tasks_worker ON tasks (worker_token_id, claimed_at);
