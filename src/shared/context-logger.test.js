'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const ctx = require('./request-context');
const { withContext } = require('./context-logger');

// Capture logger output by spying on process.stdout.write / process.stderr.write.
// The logger writes directly to those streams, not to console.log/error.
let captured = [];
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function capture(stream, restore) {
  return (chunk, ...rest) => {
    captured.push(String(chunk));
    return restore(chunk, ...rest);
  };
}
process.stdout.write = capture(process.stdout, originalStdoutWrite);
process.stderr.write = capture(process.stderr, originalStderrWrite);

function reset() {
  captured = [];
}

test('withContext() injects requestId from active context into info()', () => {
  reset();
  return ctx.run({ requestId: 'req-xyz' }, () => {
    const log = withContext();
    log.info('hello');
    assert.equal(captured.length, 1);
    const entry = JSON.parse(captured[0]);
    assert.equal(entry.level, 'info');
    assert.equal(entry.message, 'hello');
    assert.equal(entry.requestId, 'req-xyz');
  });
});

test('withContext() forwards metadata and merges actor info', () => {
  reset();
  return ctx.run({ requestId: 'req-abc', authKeyId: 'k-1', userId: 'u-1' }, () => {
    const log = withContext();
    log.info('delegate', { taskId: 't-1' });
    assert.equal(captured.length, 1);
    const entry = JSON.parse(captured[0]);
    assert.equal(entry.metadata.taskId, 't-1');
    assert.equal(entry.metadata.authKeyId, 'k-1');
    assert.equal(entry.metadata.userId, 'u-1');
  });
});

test('withContext() falls back to bare logger outside run()', () => {
  reset();
  const log = withContext();
  log.info('orphan');
  assert.equal(captured.length, 1);
  const entry = JSON.parse(captured[0]);
  assert.equal(entry.message, 'orphan');
  assert.equal(entry.requestId, undefined);
});

test('withContext() error() preserves Error objects', () => {
  reset();
  return ctx.run({ requestId: 'req-err' }, () => {
    const log = withContext();
    const err = new Error('boom');
    log.error('failed', { error: err, metadata: { taskId: 't-2' } });
    assert.equal(captured.length, 1);
    const entry = JSON.parse(captured[0]);
    assert.equal(entry.requestId, 'req-err');
    assert.equal(entry.error.message, 'boom');
    assert.equal(entry.metadata.taskId, 't-2');
  });
});

test('withContext() does not log below threshold (debug disabled by default)', () => {
  reset();
  return ctx.run({ requestId: 'req-debug' }, () => {
    const log = withContext();
    log.debug('trace');
    assert.equal(captured.length, 0);
  });
});

// Restore streams for downstream tests.
process.on('exit', () => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
});