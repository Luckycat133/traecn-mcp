'use strict';

const assert = require('assert');
const { chooseReviewGateAction } = require('./response-collection');

assert.strictEqual(
  chooseReviewGateAction({ taskText: 'Implemented the change. All focused tests passed.' }),
  'keep_all'
);
assert.strictEqual(
  chooseReviewGateAction({ taskText: 'FATAL: repository may be corrupted; changes could not be applied safely.' }),
  'revert_all'
);
assert.strictEqual(
  chooseReviewGateAction({ taskText: 'Permission denied while writing files. No safe completion is possible.' }),
  'revert_all'
);

console.log('[review-policy.test.js] PASS');
