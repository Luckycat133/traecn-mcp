'use strict';

const assert = require('assert');
const path = require('path');
const { createRunner } = require('../../shared/test-runner');
const { replayFixture } = require('./normalize-dom');

const runner = createRunner('trae-adapters/traecn-1.107/normalize-dom.test.js');
const { test, summary } = runner;

test('sanitized 1.107 fixture replays list, select, submit, queue, approval, response and review states', () => {
  const replay = replayFixture(path.join(__dirname, 'fixtures', 'workflow.json'));
  assert.strictEqual(replay.source.traeVersion, '1.107.1');
  assert.strictEqual(replay.source.platform, 'darwin');
  assert.deepStrictEqual(replay.states.map(state => state.operation), [
    'list',
    'select',
    'submit',
    'queue',
    'approval',
    'response',
    'review'
  ]);
  assert.ok(replay.states.every(state => state.ok), JSON.stringify(replay.states, null, 2));
});

summary();
if (runner.failed > 0) process.exitCode = 1;
