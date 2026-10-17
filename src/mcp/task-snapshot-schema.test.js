'use strict';

const assert = require('assert');
const { fromJsonSchema } = require('@modelcontextprotocol/client');
const { handleTaskStatus } = require('../http/handlers/task-actions');
const { TOOL_OUTPUT_SCHEMAS, ERROR_RESULT_SCHEMA } = require('./output-schemas');
const { asMcpContent } = require('./tools');
const { createRunner } = require('../shared/test-runner');

const r = createRunner('task-snapshot-schema.test.js');
const { asyncTest, pendingAsyncTests, summary } = r;

async function pendingSnapshot(status, error = null) {
  const task = {
    taskId: `offline-${status}`, status, createdAt: 1790958700000,
    result: { text: 'Captured task output retained for storage retry.', stable: true },
    error, statePersistencePending: { previousStatus: 'executing', status }
  };
  let body;
  await handleTaskStatus({ url: `/api/task/${task.taskId}` }, {}, {
    taskQueue: new Map([[task.taskId, task]]),
    _json(_req, _res, value) { body = value; }
  }, task.taskId);
  return asMcpContent(body);
}

asyncTest('actual retained-result task snapshots validate before state persistence is confirmed', async () => {
  const validator = fromJsonSchema(TOOL_OUTPUT_SCHEMAS.traecn_get_task)['~standard'];
  for (const status of ['done', 'error', 'awaiting_review', 'approval_required']) {
    const wire = await pendingSnapshot(status);
    assert.strictEqual(wire.isError, false);
    assert.strictEqual(wire.structuredContent.status, 'executing');
    assert.strictEqual(wire.structuredContent.statePersistencePending, true);
    assert.strictEqual(wire.structuredContent.error, null);
    assert.deepStrictEqual(JSON.parse(wire.content[0].text), wire.structuredContent);
    const validation = await validator.validate(wire.structuredContent);
    assert.strictEqual(validation.issues, undefined, `${status}: ${JSON.stringify(validation.issues)}`);
  }
});

asyncTest('a pending execution failure preserves and validates its original error text', async () => {
  const wire = await pendingSnapshot('error', 'Original execution failure');
  assert.strictEqual(wire.structuredContent.error, 'Original execution failure');
  const validation = await fromJsonSchema(TOOL_OUTPUT_SCHEMAS.traecn_get_task)['~standard'].validate(wire.structuredContent);
  assert.strictEqual(validation.issues, undefined);
});

asyncTest('task nullable errors do not relax other tool errors or accept malformed task errors', async () => {
  const taskValidator = fromJsonSchema(TOOL_OUTPUT_SCHEMAS.traecn_get_task)['~standard'];
  for (const error of [false, 1, {}, []]) {
    assert.ok((await taskValidator.validate({ error })).issues?.length);
  }
  for (const schema of [ERROR_RESULT_SCHEMA, TOOL_OUTPUT_SCHEMAS.traecn_create_conversation]) {
    const validation = await fromJsonSchema(schema)['~standard'].validate({ error: null });
    assert.ok(validation.issues?.length, 'non-task errors must keep their string contract');
  }
});

(async () => {
  await pendingAsyncTests();
  summary();
  if (r.failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
