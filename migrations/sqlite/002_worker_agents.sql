-- 002_worker_agents.sql - capabilities per machine behind a worker token
--
-- Several hosts may share one token. Only feature names are stored.

CREATE TABLE worker_agents (
  id             TEXT    NOT NULL PRIMARY KEY,
  token_id       TEXT    NOT NULL REFERENCES worker_tokens(id) ON DELETE CASCADE,
  name           TEXT    NOT NULL,
  arches         TEXT    NOT NULL,
  features       TEXT    NOT NULL,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  last_ip        TEXT
);

CREATE UNIQUE INDEX idx_worker_agents_identity ON worker_agents (token_id, name);
CREATE INDEX idx_worker_agents_sweep ON worker_agents (last_seen_at);
CREATE INDEX idx_tasks_worker ON tasks (worker_token_id, claimed_at);
