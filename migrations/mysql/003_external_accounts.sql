-- 003_external_accounts.sql - accounts provisioned by an identity provider
--
-- See migrations/sqlite/003_external_accounts.sql for the reasoning.

ALTER TABLE users
  ADD COLUMN external_id VARCHAR(255) NULL,
  ADD UNIQUE KEY idx_users_external (external_id);
