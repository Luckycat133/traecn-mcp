'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRunner } = require('../src/shared/test-runner');

const runner = createRunner('quickstart.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = runner;

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

function close(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  return new Promise(resolve => server.close(resolve));
}

console.log('\n[quickstart.test.js] Running tests...\n');

test('quickstart module import has no launch or gateway side effects', () => {
  const result = spawnSync(process.execPath, ['-e', `
    require('./scripts/quickstart');
    process.stdout.write('IMPORTED');
  `], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      TRAECN_AUTO_START_TRAE: '0',
      TRAECN_CDP_HOST: '127.0.0.1',
      TRAECN_REMOTE_DEBUGGING_PORT: '1'
    }
  });

  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  assert.strictEqual(result.stdout, 'IMPORTED');
});

asyncTest('probeTraeCNCDP accepts a TraeCN CDP version response', async () => {
  const server = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      Browser: 'Trae/1.107.1',
      'Protocol-Version': '1.3',
      'User-Agent': 'TraeCN/1.107.1'
    }));
  });

  try {
    const { probeTraeCNCDP } = require('./quickstart');
    const address = server.address();
    const version = await probeTraeCNCDP({
      host: '127.0.0.1',
      port: address.port,
      timeoutMs: 250
    });
    assert.strictEqual(version.Browser, 'Trae/1.107.1');
  } finally {
    await close(server);
  }
});

asyncTest('probeTraeCNCDP rejects a non-TraeCN CDP endpoint', async () => {
  const server = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'Chrome/140.0', 'User-Agent': 'Chrome/140.0' }));
  });

  try {
    const { probeTraeCNCDP } = require('./quickstart');
    await assert.rejects(
      probeTraeCNCDP({ host: '127.0.0.1', port: server.address().port, timeoutMs: 250 }),
      /does not identify TraeCN/i
    );
  } finally {
    await close(server);
  }
});

asyncTest('probeTraeCNCDP rejects invalid JSON from the CDP endpoint', async () => {
  const server = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{not-json');
  });

  try {
    const { probeTraeCNCDP } = require('./quickstart');
    await assert.rejects(
      probeTraeCNCDP({ host: '127.0.0.1', port: server.address().port, timeoutMs: 250 }),
      /parse CDP version/i
    );
  } finally {
    await close(server);
  }
});

asyncTest('probeTraeCNCDP rejects a non-success HTTP response', async () => {
  const server = await listen((req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not ready' }));
  });

  try {
    const { probeTraeCNCDP } = require('./quickstart');
    await assert.rejects(
      probeTraeCNCDP({ host: '127.0.0.1', port: server.address().port, timeoutMs: 250 }),
      /HTTP 503/i
    );
  } finally {
    await close(server);
  }
});

asyncTest('probeTraeCNCDP times out a stalled endpoint', async () => {
  const server = await listen(() => {});

  try {
    const { probeTraeCNCDP } = require('./quickstart');
    await assert.rejects(
      probeTraeCNCDP({ host: '127.0.0.1', port: server.address().port, timeoutMs: 25 }),
      /timed out after 25ms/i
    );
  } finally {
    await close(server);
  }
});

asyncTest('probeTraeCNCDP reports connection refusal', async () => {
  const server = await listen((req, res) => res.end());
  const port = server.address().port;
  await close(server);

  const { probeTraeCNCDP } = require('./quickstart');
  await assert.rejects(
    probeTraeCNCDP({ host: '127.0.0.1', port, timeoutMs: 250 }),
    /ECONNREFUSED|connect/i
  );
});

asyncTest('probeTraeCNCDP allows an injected version fetcher', async () => {
  const calls = [];
  const { probeTraeCNCDP } = require('./quickstart');
  const version = await probeTraeCNCDP({
    host: '127.0.0.9',
    port: 9333,
    timeoutMs: 250,
    fetchVersion: async (host, port) => {
      calls.push({ host, port });
      return { Browser: 'Trae/1.108.0' };
    }
  });

  assert.deepStrictEqual(calls, [{ host: '127.0.0.9', port: 9333 }]);
  assert.strictEqual(version.Browser, 'Trae/1.108.0');
});

test('running-without-debug recovery points to the confirmed restart command', () => {
  const { buildCdpRecoveryInstructions } = require('./quickstart');
  assert.deepStrictEqual(buildCdpRecoveryInstructions(true), [
    'TraeCN is running, but its debug endpoint is unavailable.',
    'Quit TraeCN, then restart the logged-in profile with:',
    'TRAECN_QUICKSTART_PROFILE_MODE=existing npm run start:traecn -- --force-new --use-existing-profile'
  ]);
});

(async () => {
  await pendingAsyncTests();
  summary();
  process.exit(runner.failed > 0 ? 1 : 0);
})();
