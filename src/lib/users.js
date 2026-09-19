// src/lib/users.js - built-in user accounts
//
// Used when no OIDC issuer is configured. Passwords are stored as scrypt
// hashes and never recoverable; a forgotten password is reset, not read.

import { newUserId } from './ids.js';
import { hashPassword, verifyPassword, generatePassword, validatePassword } from './auth/password.js';

export const ROLES = ['admin', 'viewer'];

const PUBLIC_COLUMNS = 'id, username, role, disabled, created_at, last_login_at';

export function createUsers({ db, logger = console }) {
  return {
    async get(id) {
      return db.get(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = {id}`, { id });
    },

    async byUsername(username) {
      return db.get(
        `SELECT id, username, password_hash, role, disabled FROM users WHERE username = {username}`,
        { username }
      );
    },

    async list() {
      return db.all(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY username`);
    },

    // With what each account owns, since removing one takes those with it.
    async listWithHoldings() {
      return db.all(
        `SELECT u.id, u.username, u.role, u.disabled, u.created_at, u.last_login_at,
                (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id) AS project_count,
                (SELECT COUNT(*) FROM worker_tokens w WHERE w.owner_id = u.id) AS worker_count
           FROM users u ORDER BY u.username`
      );
    },

    async count() {
      return (await db.get('SELECT COUNT(*) AS c FROM users')).c;
    },

    async create({ username, password, role = 'viewer' }) {
      if (typeof username !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{1,63}$/.test(username)) {
        throw new Error('username must be 2 to 64 characters of letters, digits, underscore, dot, at or hyphen');
      }
      if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);

      const problem = validatePassword(password);
      if (problem) throw new Error(problem);

      if (await this.byUsername(username)) throw new Error(`user ${username} already exists`);

      const id = newUserId();
      await db.run(
        `INSERT INTO users (id, username, password_hash, role, disabled, created_at)
         VALUES ({id}, {username}, {hash}, {role}, 0, {now})`,
        { id, username, hash: await hashPassword(password), role, now: Date.now() }
      );
      return this.get(id);
    },

    // Returns the user on success, or null. Deliberately gives the caller
    // no way to tell an unknown user from a wrong password.
    async authenticate(username, password) {
      const row = await this.byUsername(username);
      if (!row || row.disabled === 1) {
        // Spend the time anyway, so a missing user is not measurably faster.
        await verifyPassword(password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
        return null;
      }
      if (!(await verifyPassword(password, row.password_hash))) return null;

      await db.run('UPDATE users SET last_login_at = {now} WHERE id = {id}', { id: row.id, now: Date.now() });
      return { id: row.id, username: row.username, role: row.role, source: 'local' };
    },

    async setPassword(id, password) {
      const problem = validatePassword(password);
      if (problem) throw new Error(problem);
      const res = await db.run(
        'UPDATE users SET password_hash = {hash} WHERE id = {id}',
        { id, hash: await hashPassword(password) }
      );
      return res.changes > 0;
    },

    async setRole(id, role) {
      if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
      const res = await db.run('UPDATE users SET role = {role} WHERE id = {id}', { id, role });
      return res.changes > 0;
    },

    async setDisabled(id, disabled) {
      const res = await db.run(
        'UPDATE users SET disabled = {disabled} WHERE id = {id}',
        { id, disabled: disabled ? 1 : 0 }
      );
      return res.changes > 0;
    },

    async remove(id) {
      const res = await db.run('DELETE FROM users WHERE id = {id}', { id });
      return res.changes > 0;
    },

    // Creates the first administrator, once, while the table is empty. With
    // no password configured one is generated and printed, because an
    // install that silently has no way in is worse than a noisy log line.
    async bootstrap(cfg) {
      if (await this.count() > 0) return null;

      const username = cfg.auth.bootstrap_admin.username || 'admin';
      const configured = cfg.auth.bootstrap_admin.password;
      const password = configured || generatePassword();

      const user = await this.create({ username, password, role: 'admin' });

      if (configured) {
        logger.info?.(`created the initial administrator ${username} from configuration`);
      } else {
        logger.warn?.(
          `created the initial administrator ${username} with a generated password: ${password}\n` +
          'This is shown once. Change it, or set auth.bootstrap_admin.password.'
        );
      }
      return { ...user, password: configured ? null : password };
    },
  };
}
