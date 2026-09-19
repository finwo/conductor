-- 003_external_accounts.sql - accounts provisioned by an identity provider
--
-- See migrations/sqlite/003_external_accounts.sql for the reasoning.

ALTER TABLE users ADD COLUMN external_id TEXT;

CREATE UNIQUE INDEX idx_users_external ON users (external_id);
