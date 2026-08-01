'use strict';

const assert = require('assert');
const { createRunner } = require('../shared/test-runner');
const { detectTraeEnvironment, parseTraeVersion } = require('./detect');

const runner = createRunner('trae-adapters/detect.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = runner;

test('parseTraeVersion reads product and CDP version strings without guessing Chromium', () => {
  assert.strictEqual(parseTraeVersion({ productVersion: '1.107.1' }), '1.107.1');
  assert.strictEqual(parseTraeVersion({ Browser: 'TraeCN/1.107.1 Chrome/142.0.0.0 Electron/39.0.0' }), '1.107.1');
  assert.strictEqual(parseTraeVersion({ 'User-Agent': 'Mozilla/5.0 Trae CN 1.108.2 Electron/39.0.0' }), '1.108.2');
  assert.strictEqual(parseTraeVersion({ Browser: 'Chrome/142.0.7444.59' }), null);
});

asyncTest('detectTraeEnvironment combines product metadata with structural mode evidence', async () => {
  const environment = await detectTraeEnvironment({
    platform: 'darwin',
    cdpVersion: {
      Browser: 'Chrome/142.0.7444.59',
      'Protocol-Version': '1.3'
    },
    target: { title: '<workspace> — Trae CN', url: 'vscode-file://vscode-app/workbench.html' },
    client: {
      async send(method) {
        assert.strictEqual(method, 'Runtime.evaluate');
        return {
          result: {
            value: {
              productName: 'Trae CN',
              productVersion: '1.107.1',
              mode: 'solo',
              structures: {
                composer: true,
                conversationIdentity: true,
                reviewGate: true,
                settingsUI: true
              }
            }
          }
        };
      }
    }
  });

  assert.deepStrictEqual(environment, {
    product: 'Trae CN',
    traeVersion: '1.107.1',
    platform: 'darwin',
    mode: 'solo',
    cdp: {
      browser: 'Chrome/142.0.7444.59',
      protocolVersion: '1.3'
    },
    target: {
      title: '<workspace> — Trae CN',
      surface: 'workspace'
    },
    structures: {
      composer: true,
      conversationIdentity: true,
      reviewGate: true,
      settingsUI: true
    },
    versionSource: 'product'
  });
});

Promise.resolve().then(async () => {
  await pendingAsyncTests();
  summary();
  if (runner.failed > 0) process.exitCode = 1;
});
