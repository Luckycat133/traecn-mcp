'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const result = spawnSync(process.execPath, [path.join(__dirname, 'doctor.js')], {
  cwd: path.resolve(__dirname, '..'),
  encoding: 'utf8',
  env: {
    ...process.env,
    TRAECN_GATEWAY_HOST: '0.0.0.0',
    TRAECN_GATEWAY_PORT: '8788',
    TRAECN_GATEWAY_TOKEN: '',
    TRAECN_CDP_HOST: '127.0.0.1',
    TRAECN_REMOTE_DEBUGGING_PORT: '1',
    TRAECN_ENABLE_MOCK_BRIDGE: '1'
  }
});

assert.strictEqual(result.status, 1, result.stderr || result.stdout);
assert.match(result.stdout, /FAIL Gateway authentication .*non-loopback/i);
console.log('[doctor.test.js] PASS');
