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
//   node src/admin-cli.js run:trigger <project> <sha> [--ref r] [--base b]
//   node src/admin-cli.js run:cancel <run-id>
//
// The HTTP admin API arrives with the auth work. Until then this is the
// supported way to register projects and mint worker tokens.

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
      '  run:trigger <project> <sha> [--ref r] [--base b]',
      '  run:cancel <run-id>',
    ].join('\n')
  );
  process.exit(message ? 1 : 0);
}

if (!command || command === 'help' || command === '--help') usage();

const cfg = loadConfig();
const services = await createServices(cfg, { migrationLogger: () => {} });
const { projects, workerTokens, scheduler, db } = services;

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
        source_mode: flags.source ? String(flags.source) : 'archive',
        trigger_secret: secret,
      });

      console.log(`created project ${project.id}`);
      console.log(`  repository:  ${project.repo_url}`);
      console.log(`  pipeline:    ${project.config_path}`);
      console.log(`  source mode: ${project.source_mode}`);
      console.log(`  trigger url: ${cfg.server.public_url.replace(/\/+$/, '')}/api/trigger/${project.id}`);
      console.log(`  secret:      ${secret}`);
      break;
    }

    case 'project:list': {
      const rows = (await projects.list()).map((p) => ({
        id: p.id,
        repo_url: p.repo_url,
        branch: p.default_branch,
        config: p.config_path,
        source: p.source_mode,
        enabled: p.enabled ? 'yes' : 'no',
        runs: p.run_counter,
      }));
      table(rows, ['id', 'repo_url', 'branch', 'config', 'source', 'enabled', 'runs']);
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

    case 'run:trigger': {
      const [projectId, sha] = positional;
      if (!projectId || !sha) usage('run:trigger needs a project and a commit');
      const project = await projects.get(projectId);
      if (!project) usage(`unknown project ${projectId}`);

      const result = await scheduler.createRun(project, {
        headSha: sha,
        ref: flags.ref ? String(flags.ref) : null,
        baseSha: flags.base ? String(flags.base) : null,
        trigger: 'manual',
        actor: 'admin-cli',
      });
      console.log(`created run ${result.runId} with ${result.jobCount} job(s)`);
      break;
    }

    case 'run:cancel': {
      const [runId] = positional;
      if (!runId) usage('run:cancel needs a run id');
      const result = await scheduler.cancelRun(runId);
      console.log(result.ok ? `cancelled ${runId}` : `could not cancel: ${result.reason}`);
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
