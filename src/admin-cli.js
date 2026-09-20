// src/admin-cli.js - local administration
//
// Usage:
//   node src/admin-cli.js project:add <id> <repo-url> [--name n] [--branch b]
//                                                     [--config p] [--source archive|clone]
//                                                     [--secret s]
//   node src/admin-cli.js project:list
//   node src/admin-cli.js project:secret <id> [secret]
//   node src/admin-cli.js project:remove <id>
//   node src/admin-cli.js token:add <name>
//   node src/admin-cli.js token:list
//   node src/admin-cli.js token:remove <id>
//   node src/admin-cli.js var:set <project> <NAME> <value> [--visible]
//   node src/admin-cli.js var:list <project>
//   node src/admin-cli.js var:remove <project> <NAME>
//   node src/admin-cli.js user:add <username> <password> [--role admin|user]
//   node src/admin-cli.js user:list
//   node src/admin-cli.js user:passwd <username> <password>
//   node src/admin-cli.js user:remove <username>
//   node src/admin-cli.js job:trigger <project> <sha> [--ref r] [--base b]
//   node src/admin-cli.js job:cancel <job-id>
//
// This runs against the database directly, so it works before the first
// account exists and when the server is down.

import crypto from 'node:crypto';
import { loadConfig } from './lib/config.js';
import { createServices } from './conductor/app.js';

const [command, ...rest] = process.argv.slice(2);

// Splits --flag value pairs out of the positional arguments.
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const name = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true;
      } else {
        flags[name] = next;
        i += 1;
      }
    } else {
      positional.push(argv[i]);
    }
  }
  return { flags, positional };
}

const { flags, positional } = parseArgs(rest);

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    [
      'usage:',
      '  project:add <id> <repo-url> [--name n] [--branch b] [--config p] [--source archive|clone] [--secret s]',
      '  project:list',
      '  project:secret <id> [secret]',
      '  project:remove <id>',
      '  token:add <name>',
      '  token:list',
      '  token:remove <id>',
      '  var:set <project> <NAME> <value> [--visible]',
      '  var:list <project>',
      '  var:remove <project> <NAME>',
      '  user:add <username> <password> [--role admin|user]',
      '  user:list',
      '  user:passwd <username> <password>',
      '  user:remove <username>',
      '  job:trigger <project> <sha> [--ref r] [--base b]',
      '  job:cancel <job-id>',
    ].join('\n')
  );
  process.exit(message ? 1 : 0);
}

if (!command || command === 'help' || command === '--help') usage();

const cfg = loadConfig();
// No bootstrap account is created here: the CLI already has full access,
// and creating one as a side effect of running a command would be a
// surprise.
const services = await createServices(cfg, { migrationLogger: () => {}, bootstrap: false });
const { projects, workerTokens, variables, users, scheduler, db } = services;

function table(rows, columns) {
  if (rows.length === 0) {
    console.log('(none)');
    return;
  }
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  console.log(columns.map((c, i) => c.padEnd(widths[i])).join('  '));
  for (const row of rows) {
    console.log(columns.map((c, i) => String(row[c] ?? '').padEnd(widths[i])).join('  '));
  }
}

const when = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '');

try {
  switch (command) {
    case 'project:add': {
      const [id, repoUrl] = positional;
      if (!id || !repoUrl) usage('project:add needs an id and a repository url');

      // Generated when not supplied, since an unsigned trigger endpoint is
      // rarely what anyone actually wants.
      const secret = flags.secret === true || flags.secret === undefined
        ? crypto.randomBytes(24).toString('hex')
        : String(flags.secret);

      const project = await projects.create({
        id,
        name: flags.name ? String(flags.name) : id,
        repo_url: repoUrl,
        default_branch: flags.branch ? String(flags.branch) : 'main',
        config_path: flags.config ? String(flags.config) : '.conductor.yml',
        trigger_secret: secret,
      });

      console.log(`created project ${project.id}`);
      console.log(`  repository:  ${project.repo_url}`);
      console.log(`  pipeline:    ${project.config_path}`);
      console.log(`  trigger url: ${cfg.server.public_url.replace(/\/+$/, '')}/api/v1/projects/${project.id}/trigger`);
      console.log(`  secret:      ${secret}`);
      break;
    }

    case 'project:list': {
      const rows = (await projects.list()).map((p) => ({
        id: p.id,
        repo_url: p.repo_url,
        branch: p.default_branch,
        config: p.config_path,
        enabled: p.enabled ? 'yes' : 'no',
        jobs: p.job_counter,
      }));
      table(rows, ['id', 'repo_url', 'branch', 'config', 'source', 'enabled', 'jobs']);
      break;
    }

    case 'project:secret': {
      const [id, value] = positional;
      if (!id) usage('project:secret needs a project id');
      if (!(await projects.get(id))) usage(`unknown project ${id}`);
      const secret = value ?? crypto.randomBytes(24).toString('hex');
      await projects.setTriggerSecret(id, secret);
      console.log(`trigger secret for ${id}: ${secret}`);
      break;
    }

    case 'project:remove': {
      const [id] = positional;
      if (!id) usage('project:remove needs a project id');
      await projects.remove(id);
      console.log(`removed project ${id}`);
      break;
    }

    case 'token:add': {
      const [name] = positional;
      if (!name) usage('token:add needs a name');
      const created = await workerTokens.create(name);
      console.log(`created worker token ${created.id} for ${created.name}`);
      console.log(`  token: ${created.token}`);
      console.log('  This is shown once. Store it in the worker configuration now.');
      break;
    }

    case 'token:list': {
      const rows = (await workerTokens.list()).map((t) => ({
        id: t.id,
        name: t.name,
        enabled: t.enabled ? 'yes' : 'no',
        created: when(t.created_at),
        last_seen: when(t.last_seen_at),
        last_ip: t.last_ip ?? '',
      }));
      table(rows, ['id', 'name', 'enabled', 'created', 'last_seen', 'last_ip']);
      break;
    }

    case 'token:remove': {
      const [id] = positional;
      if (!id) usage('token:remove needs a token id');
      console.log(await workerTokens.remove(id) ? `removed token ${id}` : `no such token ${id}`);
      break;
    }

    case 'var:set': {
      const [projectId, name, ...valueParts] = positional;
      const value = valueParts.join(' ');
      if (!projectId || !name || valueParts.length === 0) usage('var:set needs a project, a name and a value');
      if (!(await projects.get(projectId))) usage(`unknown project ${projectId}`);
      if (!cfg.secrets.encryption_key) {
        console.warn('warning: secrets.encryption_key is not set, so this is stored in the clear');
      }
      await variables.set(projectId, name, value, { masked: flags.visible !== true });
      console.log(`set ${name} for ${projectId}${flags.visible === true ? '' : ' (masked in logs)'}`);
      break;
    }

    case 'var:list': {
      const [projectId] = positional;
      if (!projectId) usage('var:list needs a project');
      const rows = (await variables.list(projectId)).map((v) => ({
        name: v.name,
        masked: v.masked ? 'yes' : 'no',
        at_rest: v.plaintext_at_rest ? 'PLAINTEXT' : 'encrypted',
        created: when(v.created_at),
      }));
      table(rows, ['name', 'masked', 'at_rest', 'created']);
      break;
    }

    case 'var:remove': {
      const [projectId, name] = positional;
      if (!projectId || !name) usage('var:remove needs a project and a name');
      console.log(await variables.remove(projectId, name) ? `removed ${name}` : `no such variable ${name}`);
      break;
    }

    case 'user:add': {
      const [username, password] = positional;
      if (!username || !password) usage('user:add needs a username and a password');
      const user = await users.create({
        username,
        password,
        role: flags.role ? String(flags.role) : 'user',
      });
      console.log(`created user ${user.username} with role ${user.role}`);
      break;
    }

    case 'user:list': {
      const rows = (await users.list()).map((u) => ({
        username: u.username,
        role: u.role,
        enabled: u.disabled ? 'no' : 'yes',
        created: when(u.created_at),
        last_login: when(u.last_login_at),
      }));
      table(rows, ['username', 'role', 'enabled', 'created', 'last_login']);
      break;
    }

    case 'user:passwd': {
      const [username, password] = positional;
      if (!username || !password) usage('user:passwd needs a username and a password');
      const existing = await users.byUsername(username);
      if (!existing) usage(`unknown user ${username}`);
      await users.setPassword(existing.id, password);
      console.log(`password updated for ${username}`);
      break;
    }

    case 'user:remove': {
      const [username] = positional;
      if (!username) usage('user:remove needs a username');
      const existing = await users.byUsername(username);
      if (!existing) usage(`unknown user ${username}`);
      await users.remove(existing.id);
      console.log(`removed user ${username}`);
      break;
    }

    case 'job:trigger': {
      const [projectId, sha] = positional;
      if (!projectId || !sha) usage('job:trigger needs a project and a commit');
      const project = await projects.get(projectId);
      if (!project) usage(`unknown project ${projectId}`);

      const result = await scheduler.createJob(project, {
        headSha: sha,
        ref: flags.ref ? String(flags.ref) : null,
        baseSha: flags.base ? String(flags.base) : null,
        trigger: 'manual',
        actor: 'admin-cli',
      });
      console.log(`created job ${result.jobId} with ${result.taskCount} task(s)`);
      break;
    }

    case 'job:cancel': {
      const [jobId] = positional;
      if (!jobId) usage('job:cancel needs a job id');
      const result = await scheduler.cancelJob(jobId);
      console.log(result.ok ? `cancelled ${jobId}` : `could not cancel: ${result.reason}`);
      break;
    }

    default:
      usage(`unknown command ${command}`);
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
