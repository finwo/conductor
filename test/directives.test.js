import test from 'node:test';
import assert from 'node:assert/strict';

import { createDirectives, createScanner } from '../src/worker/directives.js';

function scan(chunks, options = {}) {
  const problems = [];
  const masked = [];
  const directives = createDirectives({
    onProblem: (m) => problems.push(m),
    onMask: (v) => masked.push(v),
    ...options,
  });
  const scanner = createScanner(directives);
  const out = [];
  for (const chunk of chunks) out.push(scanner.push(Buffer.from(chunk)));
  out.push(scanner.end());
  return { log: Buffer.concat(out).toString('utf8'), directives, problems, masked };
}

test('set-output is taken off the log and defaults to masked', () => {
  const { log, directives, masked } = scan(['hello\n::set-output token=abcdef\nbye\n']);
  assert.equal(log, 'hello\nbye\n');
  assert.deepEqual(directives.outputs, [{ name: 'token', value: 'abcdef', masked: true }]);
  assert.deepEqual(masked, ['abcdef']);
});

test('public outputs are not masked', () => {
  const { directives, masked } = scan(['::set-output tag=v1.2.3::public\n']);
  assert.deepEqual(directives.outputs, [{ name: 'tag', value: 'v1.2.3', masked: false }]);
  assert.deepEqual(masked, []);
});

test('masked may be stated explicitly', () => {
  const { directives } = scan(['::set-output tag=v1::masked\n']);
  assert.equal(directives.outputs[0].masked, true);
});

test('a directive split across chunks is still recognised', () => {
  const { log, directives } = scan(['out\n::set-out', 'put to', 'ken=abcdef\nmore\n']);
  assert.equal(log, 'out\nmore\n');
  assert.deepEqual(directives.outputs, [{ name: 'token', value: 'abcdef', masked: true }]);
});

test('a directive split one byte at a time is still recognised', () => {
  const { log, directives } = scan([...'::set-output a=bcdef\ntail\n']);
  assert.equal(log, 'tail\n');
  assert.equal(directives.outputs[0].value, 'bcdef');
});

test('ordinary output is not held back waiting for a newline', () => {
  const problems = [];
  const directives = createDirectives({ onProblem: (m) => problems.push(m) });
  const scanner = createScanner(directives);
  assert.equal(scanner.push(Buffer.from('progress...')).toString(), 'progress...');
  assert.equal(scanner.push(Buffer.from(' done\n')).toString(), ' done\n');
});

test('a trailing line with no newline still parses', () => {
  const { log, directives } = scan(['::set-state failed']);
  assert.equal(log, '');
  assert.equal(directives.state, 'failed');
});

test('CRLF line endings are tolerated', () => {
  const { log, directives } = scan(['a\r\n::set-state skipped\r\nb\r\n']);
  assert.equal(log, 'a\r\nb\r\n');
  assert.equal(directives.state, 'skipped');
});

test('last one wins for state and for a repeated output', () => {
  const { directives } = scan([
    '::set-state failed\n::set-output a=first\n::set-state success\n::set-output a=second\n',
  ]);
  assert.equal(directives.state, 'success');
  assert.deepEqual(directives.outputs, [{ name: 'a', value: 'second', masked: true }]);
});

test('a line that is not a directive is left alone', () => {
  const { log, problems } = scan(['::not-a-command whatever\n:: spaced\nplain\n']);
  assert.equal(log, '::not-a-command whatever\n:: spaced\nplain\n');
  assert.deepEqual(problems, []);
});

test('a malformed set-output is reported and still stripped', () => {
  const { log, problems, directives } = scan(['::set-output token=abcdef::typo\n']);
  assert.equal(log, '', 'the value must not reach the log');
  assert.equal(directives.outputs.length, 0);
  assert.match(problems[0], /unknown visibility/);
});

test('an output name may carry dots and dashes', () => {
  const { directives, problems } = scan([
    '::set-output myname-x86_64=/pkg/a.tar::public\n::set-output pizza.calzone=tasty::public\n',
  ]);
  assert.deepEqual(problems, []);
  assert.deepEqual(directives.outputs, [
    { name: 'myname-x86_64', value: '/pkg/a.tar', masked: false },
    { name: 'pizza.calzone', value: 'tasty', masked: false },
  ]);
});

test('a bad output name is reported and stripped', () => {
  for (const name of ['9lives', 'pizza..calzone', 'pizza.', '.pizza', 'a b']) {
    const { log, problems } = scan([`::set-output ${name}=x\n`]);
    assert.equal(log, '', `${name} must not reach the log`);
    assert.match(problems[0], /is not a valid name/, `${name} should be rejected`);
  }
});

test('set-output without name=value is reported', () => {
  const { problems } = scan(['::set-output nope\n']);
  assert.match(problems[0], /wants name=value/);
});

test('an unknown state is reported and stripped', () => {
  const { log, problems, directives } = scan(['::set-state banana\n']);
  assert.equal(log, '');
  assert.equal(directives.state, null);
  assert.match(problems[0], /unknown state/);
});

test('a value may contain an equals sign', () => {
  const { directives } = scan(['::set-output data=a=b=c\n']);
  assert.equal(directives.outputs[0].value, 'a=b=c');
});

test('a directive must start at column 0', () => {
  const { log, directives } = scan(['  ::set-output a=b\n']);
  assert.equal(log, '  ::set-output a=b\n');
  assert.equal(directives.outputs.length, 0);
});

test('trailing whitespace after a directive is tolerated', () => {
  const { directives } = scan(['::set-state success   \n']);
  assert.equal(directives.state, 'success');
});

test('binary output passes through untouched', () => {
  const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x0a, 0x01, 0x02]);
  const directives = createDirectives();
  const scanner = createScanner(directives);
  const out = Buffer.concat([scanner.push(bytes), scanner.end()]);
  assert.deepEqual(out, bytes);
});

test('outputs are capped and the excess is dropped without leaking', () => {
  const lines = [];
  for (let i = 0; i < 70; i += 1) lines.push(`::set-output n${i}=value${i}\n`);
  const { log, directives, problems } = scan([lines.join('')]);
  assert.equal(log, '');
  assert.equal(directives.outputs.length, 64);
  assert.match(problems[0], /more than 64 outputs/);
});

test('stdout and stderr scanners do not corrupt each other', () => {
  const directives = createDirectives();
  const out = createScanner(directives);
  const err = createScanner(directives);
  // Interleaved halves of two different directives.
  out.push(Buffer.from('::set-out'));
  err.push(Buffer.from('::set-sta'));
  out.push(Buffer.from('put a=bcdef\n'));
  err.push(Buffer.from('te success\n'));
  assert.equal(directives.state, 'success');
  assert.deepEqual(directives.outputs, [{ name: 'a', value: 'bcdef', masked: true }]);
});
