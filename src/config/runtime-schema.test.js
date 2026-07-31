'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  RUNTIME_ENV_SCHEMA,
  runtimeDefault,
  readRuntimeEnv,
  renderEnvDefaultsBlock,
  renderReadmeDefaultsBlock,
  renderConfigurationDocument
} = require('./runtime-schema');

const repoRoot = path.resolve(__dirname, '../..');

assert.strictEqual(runtimeDefault('TRAECN_GATEWAY_HOST'), '127.0.0.1');
assert.strictEqual(runtimeDefault('TRAECN_GATEWAY_PORT'), '8788');
assert.strictEqual(runtimeDefault('TRAECN_REMOTE_DEBUGGING_PORT'), '9222');
assert.strictEqual(runtimeDefault('TRAECN_QUICKSTART_PROFILE_MODE'), 'existing');
assert.strictEqual(runtimeDefault('TRAECN_AUTO_START_TRAE'), '0');
assert.strictEqual(runtimeDefault('TRAECN_RESPONSE_TIMEOUT_MS'), '1800000');
assert.strictEqual(runtimeDefault('TRAECN_QUEUE_MAX_WAIT_MS'), '');

assert.strictEqual(
  readRuntimeEnv('TRAECN_GATEWAY_HOST', { TRAECN_GATEWAY_HOST: '10.0.0.1', HOST: '10.0.0.2' }),
  '10.0.0.1'
);
assert.strictEqual(readRuntimeEnv('TRAECN_GATEWAY_HOST', { HOST: '10.0.0.2' }), '10.0.0.2');
assert.strictEqual(readRuntimeEnv('TRAECN_AUTO_START_TRAE', { TRAECN_AUTOSTART: '1' }), '1');

for (const [name, spec] of Object.entries(RUNTIME_ENV_SCHEMA)) {
  assert.ok(Object.prototype.hasOwnProperty.call(spec, 'default'), `${name} needs a default`);
  assert.ok(spec.description, `${name} needs a description`);
}

const envExample = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
assert.ok(envExample.includes(renderEnvDefaultsBlock()), '.env.example generated defaults are stale');

const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
assert.ok(readme.includes(renderReadmeDefaultsBlock()), 'README generated defaults are stale');

assert.strictEqual(
  fs.readFileSync(path.join(repoRoot, 'docs/configuration.md'), 'utf8'),
  renderConfigurationDocument(),
  'generated configuration reference is stale'
);

console.log('[runtime-schema.test.js] PASS');
