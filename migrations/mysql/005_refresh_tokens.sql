-- 005_refresh_tokens.sql - revocable refresh tokens, built-in provider only

CREATE TABLE refresh_tokens (
  id            VARCHAR(64)  NOT NULL PRIMARY KEY,
  user_id       VARCHAR(64)  NOT NULL,
  token_hash    CHAR(64)     NOT NULL UNIQUE,
  issued_at     BIGINT       NOT NULL,
  expires_at    BIGINT       NOT NULL,
  last_used_at  BIGINT,
  revoked_at    BIGINT,
  user_agent    VARCHAR(255),
  ip            VARCHAR(64),
  KEY idx_refresh_tokens_user (user_id),
  KEY idx_refresh_tokens_expires (expires_at),
  CONSTRAINT fk_refresh_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
