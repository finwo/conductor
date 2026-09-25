-- 005_refresh_tokens.sql - revocable refresh tokens, built-in provider only

CREATE TABLE refresh_tokens (
  id            TEXT   NOT NULL PRIMARY KEY,
  user_id       TEXT   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT   NOT NULL UNIQUE,
  issued_at     BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL,
  last_used_at  BIGINT,
  revoked_at    BIGINT,
  user_agent    TEXT,
  ip            TEXT
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens (expires_at);
