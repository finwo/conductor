// src/worker/directives.js - magic lines a script writes to talk back
//
//   ::set-output NAME=VALUE[::masked|public]
//   ::set-state success|failed|skipped
//
// Output arrives as arbitrary chunks and stdout interleaves with stderr, so
// scanning is per stream. A partial line is held back only while it could
// still become a directive, otherwise ordinary output would stall waiting
// for a newline that may never come.

export const STATES = ['success', 'failed', 'skipped'];
export const VISIBILITIES = ['masked', 'public'];

const COMMANDS = ['set-output', 'set-state'];
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/;
const MAX_VALUE = 8192;
const MAX_OUTPUTS = 64;

// null when the line is not a directive. A recognised command always yields
// a directive or an error, so a malformed set-output is still stripped
// rather than printing the value it failed to parse.
function parse(line) {
  if (!line.startsWith('::')) return null;

  const body = line.slice(2);
  const space = body.indexOf(' ');
  const command = space === -1 ? body : body.slice(0, space);
  if (!COMMANDS.includes(command)) return null;
  const rest = space === -1 ? '' : body.slice(space + 1);

  // Only the last :: separates, so a value may contain one.
  const cut = rest.lastIndexOf('::');
  const args = cut === -1 ? rest : rest.slice(0, cut);
  const data = cut === -1 ? null : rest.slice(cut + 2);

  if (command === 'set-state') {
    if (data !== null) return { error: 'set-state takes no :: value' };
    if (!STATES.includes(args)) {
      return { error: `unknown state ${JSON.stringify(args)}; expected ${STATES.join(', ')}` };
    }
    return { state: args };
  }

  const eq = args.indexOf('=');
  if (eq === -1) return { error: 'set-output wants name=value' };
  const name = args.slice(0, eq);
  const value = args.slice(eq + 1);
  if (!NAME_PATTERN.test(name)) {
    return { error: `output name ${JSON.stringify(name)} is not a valid name` };
  }
  if (value.length > MAX_VALUE) {
    return { error: `output ${name} is longer than ${MAX_VALUE} characters` };
  }
  if (data !== null && !VISIBILITIES.includes(data)) {
    return { error: `unknown visibility ${JSON.stringify(data)}; expected ${VISIBILITIES.join(', ')}` };
  }
  return { output: { name, value, masked: data !== 'public' } };
}

// Last one wins, for a repeated output name and for the state alike.
export function createDirectives({ onMask = null, onProblem = null } = {}) {
  const outputs = new Map();
  let state = null;

  return {
    get state() { return state; },
    get outputs() { return [...outputs.values()]; },

    accept(parsed) {
      if (parsed.error) return onProblem?.(parsed.error);
      if (parsed.state) { state = parsed.state; return; }

      const { name, value, masked } = parsed.output;
      if (!outputs.has(name) && outputs.size >= MAX_OUTPUTS) {
        return onProblem?.(`more than ${MAX_OUTPUTS} outputs; ${name} was dropped`);
      }
      outputs.set(name, { name, value, masked });
      if (masked) onMask?.(value, name);
    },
  };
}

export function createScanner(directives) {
  let pending = Buffer.alloc(0);
  let passing = false;

  // A directive has to begin at column 0, so only a prefix of '::' waits.
  function mayBeDirective(buf) {
    if (buf.length >= 2) return buf[0] === 0x3a && buf[1] === 0x3a;
    if (buf.length === 1) return buf[0] === 0x3a;
    return true;
  }

  function keep(line) {
    const parsed = parse(line.toString('utf8').replace(/[\r\s]+$/, ''));
    if (parsed === null) return true;
    directives.accept(parsed);
    return false;
  }

  function consume(chunk, final) {
    const out = [];
    let buf = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    pending = Buffer.alloc(0);

    while (buf.length > 0) {
      const nl = buf.indexOf(0x0a);

      if (passing) {
        if (nl === -1) { out.push(buf); break; }
        out.push(buf.subarray(0, nl + 1));
        buf = buf.subarray(nl + 1);
        passing = false;
        continue;
      }

      if (nl === -1) {
        if (final) {
          if (keep(buf)) out.push(buf);
        } else if (mayBeDirective(buf)) {
          pending = buf;
        } else {
          out.push(buf);
          passing = true;
        }
        break;
      }

      if (keep(buf.subarray(0, nl))) out.push(buf.subarray(0, nl + 1));
      buf = buf.subarray(nl + 1);
    }

    return out.length === 0 ? Buffer.alloc(0) : Buffer.concat(out);
  }

  return {
    push(chunk) { return consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), false); },
    end() {
      if (pending.length === 0) return Buffer.alloc(0);
      const rest = pending;
      pending = Buffer.alloc(0);
      return consume(rest, true);
    },
  };
}
