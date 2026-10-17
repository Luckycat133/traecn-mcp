'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRunner } = require('../src/shared/test-runner');
const { summarizeReadiness, buildDiagnostics, assertReady } = require('./live-uat');

const r = createRunner('live-uat.test.js');
const liveReadiness = {
  ready: false,
  composer: null,
  sendButton: null,
  responseRegion: { matchedSelector: '.chat-list-wrapper' },
  mode: { mode: 'ide', confidence: 0.8 },
  blocker: 'login_required',
  blockers: { loginVisible: true, guideVisible: false }
};

r.test('current live readiness preserves login blocker, mode and missing controls', () => {
  const summary = summarizeReadiness(liveReadiness);
  assert.strictEqual(summary.ready, false);
  assert.strictEqual(summary.reason, 'login_required');
  assert.strictEqual(summary.blocker, 'login_required');
  assert.strictEqual(summary.currentMode, 'ide');
  assert.deepStrictEqual(summary.missing, ['composer', 'sendButton']);
});

r.test('legacy readiness keeps explicit reason, model and missing checks', () => {
  const summary = summarizeReadiness({
    ready: false,
    reason: 'legacy_not_ready',
    checks: { composer: false, sendButton: null, responseRegion: true },
    currentMode: 'solo',
    currentModel: 'Fixture Model'
  });
  assert.strictEqual(summary.reason, 'legacy_not_ready');
  assert.strictEqual(summary.currentMode, 'solo');
  assert.strictEqual(summary.currentModel, 'Fixture Model');
  assert.deepStrictEqual(summary.missing, ['composer', 'sendButton']);
});

r.test('ready state passes while malformed and failed readiness remain blocked', () => {
  assert.deepStrictEqual(summarizeReadiness({ ready: true }), { ready: true });
  assert.strictEqual(summarizeReadiness(null).ready, false);
  assert.strictEqual(summarizeReadiness('not-json').ready, false);
  assert.strictEqual(summarizeReadiness({ ready: false, error: 'driver_failed' }).reason, 'driver_failed');
});

r.test('readiness gate returns the observed blocker in its error and diagnostics', () => {
  const diagnostics = buildDiagnostics({ host: '127.0.0.1', port: 9222, version: {} }, {}, liveReadiness);
  assert.throws(() => assertReady(liveReadiness, diagnostics, '--require-ready'), err => {
    assert.match(err.message, /--require-ready.*login_required/);
    assert.strictEqual(err.diagnostics, diagnostics);
    return true;
  });
  assertReady({ ready: true }, diagnostics, '--require-ready');
});

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'traecnclaw-live-uat-test-'));
try {
  const preload = path.join(fixtureRoot, 'preload.js');
  fs.writeFileSync(preload, String.raw`
'use strict';
const http = require('http');
const Module = require('module');
const originalLoad = Module._load;
const routes = [];
const readiness = process.env.TRAECN_TEST_READY === '1'
  ? { ready: true, composer: {}, sendButton: {}, responseRegion: {}, mode: { mode: 'ide' } }
  : ${JSON.stringify(liveReadiness)};
const sessions = [];
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename.endsWith('/scripts/live-uat.js')) {
    if (request === '../src/cdp/discovery') {
      return { resolveCDPEndpoint: async () => ({ isTraeCN: true, host: '127.0.0.1', port: 1, version: { Browser: 'fixture' } }) };
    }
    if (request === '../src/http/gateway') {
      return { startGateway: async () => {
        const server = http.createServer((req, res) => {
          routes.push(req.method + ' ' + req.url);
          let data;
          if (req.url.startsWith('/api/status')) {
            data = { status: 'connected', mockBridge: false, traeAdapter: { verified: true, adapter: 'fixture', traeVersion: 'fixture' } };
          } else if (req.url === '/api/readiness') {
            data = readiness;
          } else if (req.url === '/api/queue-status') {
            data = { queued: false };
          } else if (req.url === '/api/dialog/status') {
            data = { hasDialog: !readiness.ready };
          } else if (req.url === '/api/preflight') {
            data = { commandPlan: { command: 'delegate_async' }, nextAction: 'login_traecn', ready: readiness.ready };
          } else if (req.url === '/api/capabilities') {
            data = require(process.cwd() + '/src/capabilities').buildCapabilities({ commands: require(process.cwd() + '/src/client/command-set').listCommands() });
          } else if (['/api/delegate', '/api/delegate-async', '/api/solo/chats/submit'].includes(req.url)) {
            res.statusCode = 400;
            data = { error: 'generic_queue_probe_task_rejected' };
          } else if (req.url === '/api/confirm/plan') {
            data = { risk: 'high', requiresConfirmation: true };
          } else if (req.url === '/api/settings/set') {
            res.statusCode = 409;
            data = { code: 'OPERATION_CONFIRMATION_REQUIRED' };
          } else if (req.url === '/openapi.json') {
            data = require(process.cwd() + '/src/http/openapi').generateOpenAPISpec();
          } else if (readiness.ready && req.url === '/api/sessions') {
            if (req.method === 'POST') {
              res.statusCode = 201;
              const id = 'session-' + (sessions.length + 1);
              sessions.push({ id });
              data = { sessionId: id };
            } else {
              data = { sessions };
            }
          } else if (readiness.ready && req.url.startsWith('/api/sessions/')) {
            data = { messages: [] };
          } else if (readiness.ready && req.url.startsWith('/api/settings/read')) {
            data = { items: [] };
          } else if (readiness.ready && req.url === '/api/solo/chats') {
            data = { mode: 'ide', count: 0 };
          } else if (readiness.ready && req.url === '/api/solo/chats/cleanup-foreign-queue') {
            data = { support: 'delete_supported', matched: 0 };
          } else {
            res.statusCode = 409;
            data = { error: 'UI_DEPENDENT_REQUEST_SHOULD_NOT_RUN', code: 'PROJECT_NOT_OPEN' };
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(data));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        return { server, gateway: { gracefulShutdown: async () => {
          await new Promise(resolve => server.close(resolve));
          console.log('[live-fixture] ' + JSON.stringify({ routes, shutdown: true }));
        } } };
      } };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};
`);

  for (const flag of ['--require-ready', '--delegate', '--exercise-background-workflow']) {
    r.test(`${flag} fails before dependent UI/session requests and closes its gateway`, () => {
      const child = spawnSync(process.execPath, ['--require', preload, path.join(__dirname, 'live-uat.js'), '--strict', flag], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, TRAECN_ENABLE_MOCK_BRIDGE: '0' }
      });
      assert.ifError(child.error);
      assert.strictEqual(child.status, 1, child.stderr || child.stdout);
      const combined = child.stdout + child.stderr;
      assert.match(combined, /requires Trae CN UI readiness; login_required/);
      assert.ok(!combined.includes('UI_DEPENDENT_REQUEST_SHOULD_NOT_RUN'), combined);
      const record = child.stdout.split('\n').find(line => line.startsWith('[live-fixture] '));
      assert.ok(record, combined);
      const fixture = JSON.parse(record.slice('[live-fixture] '.length));
      assert.strictEqual(fixture.shutdown, true);
      assert.deepStrictEqual(fixture.routes, [
        'GET /api/status?allowAutoStart=false',
        'GET /api/readiness',
        'GET /api/status?allowAutoStart=false'
      ]);
    });
  }

  for (const ready of [false, true]) {
    r.test(`dry live checks preserve ${ready ? 'ready session/settings coverage' : 'unready skips without model submission'}`, () => {
      const child = spawnSync(process.execPath, ['--require', preload, path.join(__dirname, 'live-uat.js'), '--strict', ...(ready ? ['--require-ready'] : [])], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, TRAECN_ENABLE_MOCK_BRIDGE: '0', TRAECN_TEST_READY: ready ? '1' : '0' }
      });
      assert.ifError(child.error);
      assert.strictEqual(child.status, 0, child.stderr || child.stdout);
      assert.match(child.stdout, /"status": "PASS"/);
      assert.ok(!child.stderr.includes('UI_DEPENDENT_REQUEST_SHOULD_NOT_RUN'), child.stderr);
      const record = child.stdout.split('\n').find(line => line.startsWith('[live-fixture] '));
      const fixture = JSON.parse(record.slice('[live-fixture] '.length));
      assert.strictEqual(fixture.shutdown, true);
      const sessionRequests = fixture.routes.filter(route => route.includes('/api/sessions'));
      assert.strictEqual(sessionRequests.length, ready ? 4 : 0);
      assert.strictEqual(fixture.routes.filter(route => route.startsWith('POST /api/delegate-async')).length, 1);
      assert.strictEqual(fixture.routes.some(route => route === 'POST /api/task/submit'), false);
      if (!ready) {
        assert.match(child.stdout, /"name": "logical-sessions",\s+"ok": true,\s+"skipped": true,\s+"reason": "login_required"/);
      }
    });
  }
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

r.summary();
if (r.failed) process.exitCode = 1;
