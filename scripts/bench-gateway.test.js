'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRunner } = require('../src/shared/test-runner');
const { parseArgs, requestStatus } = require('./bench-gateway');

const r = createRunner('bench-gateway');
const script = path.join(__dirname, 'bench-gateway.js');

async function withResponse(handler, check) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await check(server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function main() {
  r.test('importing the benchmark does not start Gateway or change process state', () => {
    const child = spawnSync(process.execPath, ['-e', `
      const assert = require('assert');
      const cwd = process.cwd();
      const env = { ...process.env };
      require(${JSON.stringify(script)});
      assert.deepStrictEqual({ ...process.env }, env);
      assert.strictEqual(process.cwd(), cwd);
      assert.ok(!Object.keys(require.cache).some(key => key.endsWith('/src/http/gateway.js')));
    `], { encoding: 'utf8', timeout: 5000 });
    assert.strictEqual(child.status, 0, child.stderr);
    assert.strictEqual(child.stdout, '');
  });

  r.test('invalid counts and unknown flags fail instead of reporting successful empty work', () => {
    for (const args of [['0'], ['-1'], ['1.5'], ['NaN'], ['9007199254740992'], ['--concurrency'], ['--concurrency', '0'], ['--unknown']]) {
      assert.throws(() => parseArgs(args));
    }
    const child = spawnSync(process.execPath, [script, '-1'], { encoding: 'utf8', timeout: 5000 });
    assert.strictEqual(child.status, 1, child.stderr);
    assert.doesNotMatch(child.stdout, /startup_ms|successful/);
  });

  await r.asyncTest('HTTP errors are rejected even when they contain valid Mock JSON', async () => {
    await withResponse((_request, response) => {
      response.writeHead(429);
      response.end(JSON.stringify({ mockBridge: true, service: 'traecn-cdp-http-bridge' }));
    }, port => assert.rejects(requestStatus(port), /HTTP 429/));
  });

  await r.asyncTest('wrong bridge and invalid JSON are rejected', async () => {
    for (const body of ['not-json', JSON.stringify({ mockBridge: false, service: 'traecn-cdp-http-bridge' })]) {
      await withResponse((_request, response) => response.end(body), port => assert.rejects(requestStatus(port)));
    }
  });

  await r.asyncTest('truncated HTTP responses cannot count as completed requests', async () => {
    await withResponse((_request, response) => {
      response.writeHead(200, { 'Content-Length': '999' });
      response.end('{"mockBridge":true}');
    }, port => assert.rejects(requestStatus(port)));
  });

  r.test('concurrent Gateway run validates every request, emits JSON, and preserves caller state files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'traecnclaw-bench-regression-'));
    try {
      const userState = path.join(root, 'caller-state.json');
      const sentinel = '{"preserve":"caller state"}\n';
      fs.writeFileSync(userState, sentinel);
      fs.writeFileSync(path.join(root, '.env'), 'TRAECN_ENABLE_MOCK_BRIDGE=0\n');
      const child = spawnSync(process.execPath, [script, '36', '--concurrency', '6', '--json'], {
        cwd: root,
        env: {
          ...process.env, TMPDIR: root,
          TRAECN_CONFIG_FILE: userState,
          TRAECN_ENABLE_MOCK_BRIDGE: '0',
          TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH: userState,
          TRAECN_TASK_EVENT_PERSISTENCE_PATH: userState,
          TRAECN_TASK_HISTORY_PERSISTENCE_PATH: userState,
          TRAECN_AUDIT_LOG_DIR: path.join(root, 'caller-audit')
        },
        encoding: 'utf8', timeout: 15000
      });
      assert.strictEqual(child.status, 0, child.stderr || child.stdout);
      const result = JSON.parse(child.stdout);
      assert.strictEqual(result.successfulRequests, 36);
      assert.strictEqual(result.concurrency, 6);
      assert.strictEqual(result.environment.bridge, 'mock');
      assert.strictEqual(result.environment.cdp, 'owned-loopback-fixture');
      for (const value of Object.values(result.latency_ms)) assert.ok(Number.isFinite(value) && value > 0);
      assert.ok(result.latency_ms.p50 <= result.latency_ms.p95);
      assert.ok(result.latency_ms.p95 <= result.latency_ms.p99);
      assert.ok(result.latency_ms.p99 <= result.latency_ms.max);
      assert.ok(result.elapsed_ms > 0 && result.throughput_rps > 0);
      assert.ok(result.memory_bytes.rssPeakSampled >= result.memory_bytes.rssBefore);
      assert.strictEqual(fs.readFileSync(userState, 'utf8'), sentinel);
      assert.deepStrictEqual(fs.readdirSync(root).sort(), ['.env', 'caller-state.json']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  r.summary();
  if (r.failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
