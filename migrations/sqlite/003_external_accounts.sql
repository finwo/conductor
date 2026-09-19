-- 003_external_accounts.sql - accounts provisioned by an identity provider
--
-- With OIDC the provider owns identity, but the conductor still needs a
-- local row for each person: projects and worker tokens reference users(id),
-- so a user who exists only inside a token cannot own anything.
--
-- An account is therefore created the first time someone presents a valid
-- token, keyed by issuer and subject rather than by the display name, which
-- a provider is free to change. The local row carries the role most
-- recently seen in a token, so revoking a role at the provider takes effect
-- on the next request rather than requiring a change here as well.

ALTER TABLE users ADD COLUMN external_id TEXT;

CREATE UNIQUE INDEX idx_users_external ON users (external_id);
