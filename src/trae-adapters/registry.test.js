'use strict';

const assert = require('assert');
const { createRunner } = require('../shared/test-runner');
const {
  adapterHandshake,
  listTraeAdapters,
  mergeAdapterConfig,
  selectTraeAdapter
} = require('./registry');

const runner = createRunner('trae-adapters/registry.test.js');
const { test, summary } = runner;

test('registry selects the verified macOS TraeCN 1.107 adapter', () => {
  const adapter = selectTraeAdapter({
    product: 'Trae CN',
    traeVersion: '1.107.1',
    platform: 'darwin',
    mode: 'solo',
    structures: { composer: true }
  });
  const handshake = adapterHandshake(adapter);

  assert.strictEqual(adapter.id, 'traecn-1.107');
  assert.strictEqual(handshake.traeVersion, '1.107.1');
  assert.strictEqual(handshake.platform, 'darwin');
  assert.strictEqual(handshake.mode, 'solo');
  assert.strictEqual(handshake.compatibility, 'verified');
  assert.deepStrictEqual(handshake.capabilities, {
    conversationIdentity: true,
    reviewGate: true,
    settingsUI: true,
    structuredTaskState: false,
    fixtureReplay: true
  });
});

test('registry reports unknown versions as degraded without verified capability claims', () => {
  const adapter = selectTraeAdapter({
    product: 'Trae CN',
    traeVersion: '1.999.0',
    platform: 'darwin',
    mode: 'ide',
    structures: { composer: true, reviewGate: true }
  });
  const handshake = adapterHandshake(adapter);

  assert.strictEqual(adapter.id, 'traecn-unknown');
  assert.strictEqual(handshake.compatibility, 'degraded');
  assert.strictEqual(handshake.verified, false);
  assert.deepStrictEqual(handshake.capabilities, {
    conversationIdentity: false,
    reviewGate: false,
    settingsUI: false,
    structuredTaskState: false,
    fixtureReplay: false
  });
  assert.match(handshake.warnings[0], /not verified/i);
});

test('version adapter selectors are prepended without removing runtime overrides', () => {
  const adapter = selectTraeAdapter({
    traeVersion: '1.107.1',
    platform: 'darwin',
    mode: 'solo'
  });
  const merged = mergeAdapterConfig({
    composerSelectors: ['[data-custom-composer]'],
    sendButtonSelectors: ['[data-custom-send]'],
    timeoutMs: 1234
  }, adapter);

  assert.strictEqual(merged.composerSelectors[0], '.chat-input-v2-input-box-editable');
  assert.ok(merged.composerSelectors.includes('[data-custom-composer]'));
  assert.strictEqual(merged.sendButtonSelectors[0], 'button.chat-input-v2-send-button');
  assert.ok(merged.sendButtonSelectors.includes('[data-custom-send]'));
  assert.strictEqual(merged.timeoutMs, 1234);
});

test('registry inventory distinguishes verified and fallback adapters', () => {
  assert.deepStrictEqual(listTraeAdapters().map(item => ({ id: item.id, compatibility: item.compatibility })), [
    { id: 'traecn-1.107', compatibility: 'verified' },
    { id: 'traecn-unknown', compatibility: 'degraded' }
  ]);
});

summary();
if (runner.failed > 0) process.exitCode = 1;
