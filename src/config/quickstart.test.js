'use strict';

const assert = require('assert');
const {
  buildStartCommand,
  findTraeCNBinary,
  isTraeCNMainProcessCommand,
  isTraeCNRunning,
  quitTraeCN,
  restartTraeCNWithDebug,
  getQuickstartConfig
} = require('./quickstart');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`        ${err.message}`);
  }
}

console.log('\n[quickstart.test.js] Running tests...\n');

test('getQuickstartConfig returns object with required keys', () => {
  const config = getQuickstartConfig();
  assert.ok('useIsolatedProfile' in config);
  assert.ok('profileMode' in config);
  assert.ok('remoteDebuggingPort' in config);
  assert.ok('gatewayPort' in config);
  assert.ok('gatewayHost' in config);
});

test('getQuickstartConfig default gatewayPort is 8788', () => {
  delete process.env.PORT;
  const config = getQuickstartConfig();
  assert.strictEqual(config.gatewayPort, '8788');
});

test('getQuickstartConfig default gatewayHost is 127.0.0.1', () => {
  delete process.env.HOST;
  const config = getQuickstartConfig();
  assert.strictEqual(config.gatewayHost, '127.0.0.1');
});

test('getQuickstartConfig default remoteDebuggingPort is 9334', () => {
  delete process.env.TRAECN_QUICKSTART_REMOTE_DEBUGGING_PORT;
  delete process.env.TRAE_QUICKSTART_REMOTE_DEBUGGING_PORT;
  const config = getQuickstartConfig();
  assert.strictEqual(config.remoteDebuggingPort, '9334');
});

test('getQuickstartConfig defaults to existing profile', () => {
  delete process.env.TRAECN_QUICKSTART_USE_ISOLATED_PROFILE;
  delete process.env.TRAE_QUICKSTART_USE_ISOLATED_PROFILE;
  delete process.env.TRAECN_QUICKSTART_PROFILE_MODE;
  delete process.env.TRAE_QUICKSTART_PROFILE_MODE;
  const config = getQuickstartConfig();
  assert.strictEqual(config.useIsolatedProfile, false);
  assert.strictEqual(config.profileMode, 'existing');
});

test('getQuickstartConfig supports isolated-profile mode', () => {
  process.env.TRAECN_QUICKSTART_PROFILE_MODE = 'isolated';
  const config = getQuickstartConfig();
  assert.strictEqual(config.useIsolatedProfile, true);
  assert.strictEqual(config.profileMode, 'isolated');
  delete process.env.TRAECN_QUICKSTART_PROFILE_MODE;
});

test('findTraeCNBinary returns string or null', () => {
  delete process.env.TRAECN_BIN;
  delete process.env.TRAE_BIN;
  const result = findTraeCNBinary();
  assert.ok(result === null || typeof result === 'string');
});

test('quickstart exports confirmed restart helpers', () => {
  assert.strictEqual(typeof quitTraeCN, 'function');
  assert.strictEqual(typeof restartTraeCNWithDebug, 'function');
});

test('isTraeCNMainProcessCommand ignores Crashpad helper profile paths', () => {
  assert.strictEqual(
    isTraeCNMainProcessCommand('/Applications/Trae CN.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler --user-data-dir=/tmp/traecnclaw-profile-9334'),
    false
  );
  assert.strictEqual(
    isTraeCNMainProcessCommand('/Applications/Trae CN.app/Contents/MacOS/Electron --remote-debugging-port=9334'),
    true
  );
});

test('findTraeCNBinary respects TRAECN_BIN env var', () => {
  process.env.TRAECN_BIN = '/custom/traecn/path';
  const result = findTraeCNBinary();
  assert.strictEqual(result, '/custom/traecn/path');
  delete process.env.TRAECN_BIN;
});

test('findTraeCNBinary falls back to TRAE_BIN env var', () => {
  delete process.env.TRAECN_BIN;
  process.env.TRAE_BIN = '/custom/trae/path';
  const result = findTraeCNBinary();
  assert.strictEqual(result, '/custom/trae/path');
  delete process.env.TRAE_BIN;
});

test('buildStartCommand uses macOS open for normal app bundle launches', () => {
  const result = buildStartCommand('/Applications/Trae CN.app', ['--remote-debugging-port=9222'], {
    platform: 'darwin',
    newInstance: false
  });
  assert.strictEqual(result.command, 'open');
  assert.deepStrictEqual(result.commandArgs, ['-a', '/Applications/Trae CN.app', '--args', '--remote-debugging-port=9222']);
});

test('buildStartCommand uses direct Electron executable for debug new instances when present', () => {
  const result = buildStartCommand('/Applications/Trae CN.app', ['--remote-debugging-port=9222'], {
    platform: 'darwin',
    newInstance: true
  });
  if (result.command === 'open') {
    assert.deepStrictEqual(result.commandArgs, ['-na', '/Applications/Trae CN.app', '--args', '--remote-debugging-port=9222']);
  } else {
    assert.ok(result.command.endsWith('/Applications/Trae CN.app/Contents/MacOS/Electron'));
    assert.deepStrictEqual(result.commandArgs, ['--remote-debugging-port=9222']);
  }
});

test('startTraeCN command can include isolated profile args through dry-run helper', () => {
  const result = buildStartCommand('/Applications/Trae CN.app', [
    '--remote-debugging-port=9222',
    '--user-data-dir=/tmp/traecnclaw-profile-9222'
  ], {
    platform: 'darwin',
    newInstance: true
  });
  assert.ok(result.command === 'open' || result.command.includes('Electron'));
  assert.ok(result.commandArgs.includes('--user-data-dir=/tmp/traecnclaw-profile-9222'));
});

console.log(`\n[quickstart.test.js] Results: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
