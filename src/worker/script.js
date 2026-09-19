// src/worker/script.js - turning a job's commands into a shell script
//
// The script is copied into the container and run by path rather than
// piped to the shell's stdin, so that a command which itself reads stdin
// cannot swallow the rest of the script.
//
// It lives outside the tree, so that a repository cannot shadow it and
// nothing the job does to its own working directory can lose it.

// Single quoting is the only form that is safe for arbitrary text in POSIX
// sh: everything inside is literal, and an embedded quote is closed,
// escaped and reopened.
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// Each command is echoed before it runs, so a reader can tell which one
// produced what. set -e stops at the first failure, and the exit code of
// that command becomes the exit code of the script.
export function buildScript(commands) {
  const lines = ['#!/bin/sh', 'set -e', ''];
  for (const command of commands) {
    lines.push(`printf '%s\\n' ${shellQuote(`$ ${command}`)}`);
    lines.push(command);
    lines.push('');
  }
  return lines.join('\n');
}

export const SCRIPT_NAME = 'entrypoint.sh';
export const SCRIPT_PATH = `/tmp/${SCRIPT_NAME}`;
