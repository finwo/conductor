// src/lib/projects.js - project records
//
// A project pairs a repository with the settings needed to turn a push into
// a run. The trigger secret is the only sensitive field, and it has to be
// recoverable rather than hashed because HMAC verification needs the
// original value, so it is sealed with the secret box.

import { newProjectId, slugify } from './ids.js';

export const SOURCE_MODES = ['archive', 'clone'];

const COLUMNS = `
  id, name, repo_url, default_branch, config_path, source_mode,
  trigger_secret, enabled, run_counter, created_at, updated_at
`;

export function createProjects({ db, secrets }) {
  function aad(projectId) {
    return `project:${projectId}/trigger_secret`;
  }

  return {
    async get(id) {
      return db.get(`SELECT ${COLUMNS} FROM projects WHERE id = {id}`, { id });
    },

    async list() {
      return db.all(`SELECT ${COLUMNS} FROM projects ORDER BY name`);
    },

    async create(input) {
      const id = input.id ? slugify(input.id) : (slugify(input.name) || newProjectId());
      const now = Date.now();

      if (input.source_mode && !SOURCE_MODES.includes(input.source_mode)) {
        throw new Error(`source_mode must be one of ${SOURCE_MODES.join(', ')}`);
      }
      if (!input.repo_url) throw new Error('repo_url is required');

      const existing = await this.get(id);
      if (existing) throw new Error(`project ${id} already exists`);

      await db.run(
        `INSERT INTO projects
           (id, name, repo_url, default_branch, config_path, source_mode,
            trigger_secret, enabled, run_counter, created_at, updated_at)
         VALUES
           ({id}, {name}, {repo_url}, {branch}, {config_path}, {source_mode},
            {secret}, {enabled}, 0, {now}, {now})`,
        {
          id,
          name: input.name || id,
          repo_url: input.repo_url,
          branch: input.default_branch || 'main',
          config_path: input.config_path || '.conductor.yml',
          source_mode: input.source_mode || 'archive',
          secret: input.trigger_secret ? secrets.seal(input.trigger_secret, aad(id)) : null,
          enabled: input.enabled === undefined ? 1 : (input.enabled ? 1 : 0),
          now,
        }
      );

      return this.get(id);
    },

    // Returns the plaintext trigger secret, or null when the project does
    // not require signed triggers.
    triggerSecret(project) {
      if (!project.trigger_secret) return null;
      return secrets.open(project.trigger_secret, aad(project.id));
    },

    async setTriggerSecret(id, value) {
      await db.run(
        'UPDATE projects SET trigger_secret = {secret}, updated_at = {now} WHERE id = {id}',
        { id, secret: value === null ? null : secrets.seal(value, aad(id)), now: Date.now() }
      );
    },

    async setEnabled(id, enabled) {
      await db.run(
        'UPDATE projects SET enabled = {enabled}, updated_at = {now} WHERE id = {id}',
        { id, enabled: enabled ? 1 : 0, now: Date.now() }
      );
    },

    async remove(id) {
      await db.run('DELETE FROM projects WHERE id = {id}', { id });
    },

    // Allocates the next run number. Must run inside the same transaction
    // as the run insert, or two concurrent pushes can collide on the
    // unique (project_id, number) index.
    async nextRunNumber(tx, projectId) {
      await tx.run('UPDATE projects SET run_counter = run_counter + 1 WHERE id = {id}', { id: projectId });
      const row = await tx.get('SELECT run_counter FROM projects WHERE id = {id}', { id: projectId });
      return row.run_counter;
    },
  };
}
