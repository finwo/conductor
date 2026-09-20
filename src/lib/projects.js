// src/lib/projects.js - project records
//
// A project pairs a repository with the settings needed to turn a push into
// a run, and with an owner.
//
// Ownership is what makes it safe for people to bring their own hardware. A
// user registers their own projects and their own workers; their workers are
// only ever offered their own projects. A project with no owner belongs to
// the installation and is administered centrally.
//
// The trigger secret is the only sensitive field, and it has to be
// recoverable rather than hashed because HMAC verification needs the
// original value, so it is sealed with the secret box.

import { newProjectId, slugify } from './ids.js';
import { parseWorkdir } from './pipeline/parse.js';
import { Problems } from './pipeline/schema.js';

export const VISIBILITIES = ['public', 'private'];

// Validated with the same rule the pipeline uses, so a project and a
// repository cannot disagree about what a usable working directory is.
export function assertWorkdir(value) {
  const problems = new Problems();
  const parsed = parseWorkdir(problems, 'workdir', value);
  if (problems.length > 0) {
    throw new Error(`workdir ${problems.items[0].message}`);
  }
  return parsed;
}

const COLUMNS = `
  id, name, repo_url, default_branch, config_path, workdir,
  trigger_secret, enabled, job_counter, owner_id, visibility,
  artifact_keep_jobs, artifact_keep_days, log_keep_days,
  created_at, updated_at
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

    // What a given user is allowed to see. Administrators see everything;
    // everyone else sees what they own plus anything public.
    async listVisible(user) {
      if (user && user.role === 'admin') return this.list();
      if (user) {
        return db.all(
          `SELECT ${COLUMNS} FROM projects
            WHERE owner_id = {owner} OR visibility = 'public'
            ORDER BY name`,
          { owner: user.id }
        );
      }
      return db.all(`SELECT ${COLUMNS} FROM projects WHERE visibility = 'public' ORDER BY name`);
    },

    async listOwnedBy(ownerId) {
      return db.all(`SELECT ${COLUMNS} FROM projects WHERE owner_id = {owner} ORDER BY name`, { owner: ownerId });
    },

    async create(input) {
      const id = input.id ? slugify(input.id) : (slugify(input.name) || newProjectId());
      const now = Date.now();

      if (input.visibility && !VISIBILITIES.includes(input.visibility)) {
        throw new Error(`visibility must be one of ${VISIBILITIES.join(', ')}`);
      }
      if (!input.repo_url) throw new Error('repo_url is required');

      if (await this.get(id)) throw new Error(`project ${id} already exists`);

      await db.run(
        `INSERT INTO projects
           (id, name, repo_url, default_branch, config_path, workdir,
            trigger_secret, enabled, job_counter, owner_id, visibility,
            created_at, updated_at)
         VALUES
           ({id}, {name}, {repo_url}, {branch}, {config_path}, {workdir},
            {secret}, {enabled}, 0, {owner}, {visibility},
            {now}, {now})`,
        {
          id,
          name: input.name || id,
          repo_url: input.repo_url,
          branch: input.default_branch || 'main',
          config_path: input.config_path || '.conductor.yml',
          workdir: input.workdir ? assertWorkdir(input.workdir) : null,
          secret: input.trigger_secret ? secrets.seal(input.trigger_secret, aad(id)) : null,
          enabled: input.enabled === undefined ? 1 : (input.enabled ? 1 : 0),
          owner: input.owner_id ?? null,
          visibility: input.visibility || 'private',
          now,
        }
      );

      return this.get(id);
    },

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

    async setVisibility(id, visibility) {
      if (!VISIBILITIES.includes(visibility)) {
        throw new Error(`visibility must be one of ${VISIBILITIES.join(', ')}`);
      }
      await db.run(
        'UPDATE projects SET visibility = {visibility}, updated_at = {now} WHERE id = {id}',
        { id, visibility, now: Date.now() }
      );
    },

    // Retention overrides. Null hands the decision back to the server
    // default; zero means keep forever, and has to stay distinguishable
    // from null or a project could not opt out of a default that deletes.
    async setRetention(id, values) {
      const columns = ['artifact_keep_jobs', 'artifact_keep_days', 'log_keep_days'];
      const updates = [];
      const params = { id, now: Date.now() };

      for (const column of columns) {
        if (!Object.hasOwn(values, column)) continue;
        const value = values[column];

        if (value !== null && (!Number.isInteger(value) || value < 0)) {
          throw new Error(`${column} must be a whole number of zero or more, or null to follow the server default`);
        }

        updates.push(`${column} = {${column}}`);
        params[column] = value;
      }

      if (updates.length === 0) return;

      await db.run(
        `UPDATE projects SET ${updates.join(', ')}, updated_at = {now} WHERE id = {id}`,
        params
      );
    },

    // Null hands the decision back to the repository, and failing that
    // to the server default.
    async setWorkdir(id, workdir) {
      await db.run(
        'UPDATE projects SET workdir = {workdir}, updated_at = {now} WHERE id = {id}',
        { id, workdir: workdir ? assertWorkdir(workdir) : null, now: Date.now() }
      );
    },

    async setOwner(id, ownerId) {
      await db.run(
        'UPDATE projects SET owner_id = {owner}, updated_at = {now} WHERE id = {id}',
        { id, owner: ownerId ?? null, now: Date.now() }
      );
    },

    async remove(id) {
      await db.run('DELETE FROM projects WHERE id = {id}', { id });
    },

    // Allocates the next job number. Must run inside the same transaction
    // as the job insert, or two concurrent pushes can collide on the
    // unique (project_id, number) index.
    async nextJobNumber(tx, projectId) {
      await tx.run('UPDATE projects SET job_counter = job_counter + 1 WHERE id = {id}', { id: projectId });
      const row = await tx.get('SELECT job_counter FROM projects WHERE id = {id}', { id: projectId });
      return row.job_counter;
    },
  };
}

// An unowned project is administered centrally; an owned one is the
// owner's, and administrators may act on either.
export function canManageProject(user, project) {
  if (!user || !project) return false;
  if (user.role === 'admin') return true;
  return project.owner_id !== null && project.owner_id === user.id;
}

export function canViewProject(user, project) {
  if (!project) return false;
  if (project.visibility === 'public') return true;
  return canManageProject(user, project);
}
