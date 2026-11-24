'use strict';

const assert = require('assert');
const http = require('http');
const { WebSocketServer } = require('ws');
const { DEFAULT_DISCOVERY_PORTS, scoreTarget, discoverTarget, fetchCDPTargets, fetchCDPVersion, classifyTargetSurface, describeCDPSurface, isTraeCNVersion } = require('./discovery');
const { createRunner } = require('../shared/test-runner');
const runner = createRunner('discovery.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = runner;

console.log('\n[discovery.test.js] Running tests...\n');

test('scoreTarget gives base score for page type', () => {
  const target = { type: 'page', title: '', url: '' };
  const score = scoreTarget(target, ['Trae']);
  assert.strictEqual(score, 10);
});

test('scoreTarget adds points for title keyword match', () => {
  const target = { type: 'page', title: 'Trae CN', url: '' };
  const score = scoreTarget(target, ['Trae']);
  assert.ok(score > 10, 'Score should be higher than base');
});

test('scoreTarget adds points for chat in title', () => {
  const target = { type: 'page', title: 'Chat', url: '' };
  const score = scoreTarget(target, ['Trae']);
  assert.ok(score >= 25, 'Score should include chat bonus');
});

test('scoreTarget penalizes devtools', () => {
  const target = { type: 'page', title: 'DevTools', url: '' };
  const score = scoreTarget(target, ['Trae']);
  assert.ok(score < 0, 'Score should be negative for devtools');
});

test('scoreTarget demotes DiffView, settings, welcome, login targets', () => {
  const keywords = ['Trae', 'TraeCNClaw'];
  const diffView = scoreTarget({ type: 'page', title: 'DiffView — TraeCNClaw', url: '' }, keywords);
  const settings = scoreTarget({ type: 'page', title: 'Settings — TraeCNClaw', url: '' }, keywords);
  const welcome = scoreTarget({ type: 'page', title: 'Welcome to Trae CN', url: '' }, keywords);
  const ide = scoreTarget({ type: 'page', title: 'src/foo.js — TraeCNClaw', url: '' }, keywords);
  const bareProject = scoreTarget({ type: 'page', title: 'TraeCNClaw', url: '' }, keywords);

  assert.ok(diffView < ide, 'DiffView should score lower than the IDE workbench');
  assert.ok(settings < ide, 'Settings should score lower than the IDE workbench');
  assert.ok(welcome < welcome ? false : welcome < bareProject, 'Welcome should score lower than the bare project target');
  assert.ok(ide > 0, 'IDE workbench should still be selectable');
});

test('scoreTarget prefers a file-tab title over a review-suffix title with the same project', () => {
  const keywords = ['Trae', 'TraeCNClaw'];
  const fileTab = scoreTarget({ type: 'page', title: 'src/cdp/discovery.js — TraeCNClaw', url: '' }, keywords);
  const reviewSuffix = scoreTarget({ type: 'page', title: 'DiffView — TraeCNClaw', url: '' }, keywords);
  assert.ok(fileTab > reviewSuffix, 'file tab must outrank a review surface sharing the same project');
});

test('scoreTarget matches multiple keywords', () => {
  const target = { type: 'page', title: 'Trae CN Chat', url: '' };
  const score = scoreTarget(target, ['Trae', 'Trae CN']);
  assert.ok(score > 30, 'Score should be high for multiple matches');
});

test('scoreTarget handles case insensitivity', () => {
  const target = { type: 'page', title: 'TRAE CN', url: '' };
  const score = scoreTarget(target, ['trae']);
  assert.ok(score > 10, 'Score should match case-insensitively');
});

test('classifyTargetSurface detects setup pages', () => {
  assert.strictEqual(classifyTargetSurface({
    type: 'page',
    title: '欢迎使用 TRAE',
    url: 'vscode-file://vscode-app/.../setup/setup.html'
  }), 'setup');
});

test('classifyTargetSurface detects workspace pages', () => {
  assert.strictEqual(classifyTargetSurface({
    type: 'page',
    title: 'Trae CN',
    url: 'vscode-file://vscode-app/.../workbench/workbench.html'
  }), 'workspace');
});

test('classifyTargetSurface recognizes the standalone Agent URL and excludes auxiliary pages', () => {
  assert.strictEqual(classifyTargetSurface({
    type: 'page',
    title: 'Agent',
    url: 'vscode-file://vscode-app/.../solo/solo-lite.html'
  }), 'workspace');
  assert.strictEqual(classifyTargetSurface({
    type: 'page',
    title: 'TRAE CN floating chat',
    url: 'file:///Applications/Trae%20CN.app/.../floatingButton.html'
  }), 'unknown');
  assert.strictEqual(isTraeCNVersion({ 'User-Agent': 'TraeCN/1.107.1 Chrome/142.0' }), true);
  assert.strictEqual(isTraeCNVersion({ 'User-Agent': 'Antigravity/1.0 Chrome/142.0' }), false);
});

test('describeCDPSurface prefers workspace over setup when both exist', () => {
  const surface = describeCDPSurface([
    { id: 'setup', type: 'page', title: '欢迎使用 TRAE', url: 'vscode-file://.../setup/setup.html' },
    { id: 'workspace', type: 'page', title: 'Trae CN', url: 'vscode-file://.../workbench/workbench.html' }
  ]);
  assert.strictEqual(surface.kind, 'workspace');
  assert.strictEqual(surface.targetId, 'workspace');
  assert.strictEqual(surface.totalPageTargets, 2);
});

test('DEFAULT_DISCOVERY_PORTS includes quickstart-style live ports', () => {
  assert.ok(DEFAULT_DISCOVERY_PORTS.includes('9333'));
  assert.ok(DEFAULT_DISCOVERY_PORTS.includes('9334'));
});

asyncTest('discoverTarget prefers the visible Agent and respects explicit workbench selection', async () => {
  const targets = [
    { id: 'floating', title: 'TRAE CN Chat', url: 'file:///Trae%20CN.app/.../floatingButton.html' },
    { id: 'stale', title: 'SOLO', url: '' },
    { id: 'setup', title: '欢迎使用', url: 'vscode-file://vscode-app/.../setup/setup.html' },
    { id: 'ide', title: 'TRAE CN', url: 'vscode-file://vscode-app/.../workbench/workbench.html' },
    { id: 'agent', title: 'Agent', url: 'vscode-file://vscode-app/.../solo/solo-lite.html' }
  ];
  const inspected = [];
  let agentVisible = true;
  const server = http.createServer((req, res) => {
    const port = server.address().port;
    res.setHeader('Content-Type', 'application/json');
    const payload = req.url === '/json/version'
      ? { 'User-Agent': 'TraeCN/1.107.1 Chrome/142.0' }
      : targets.map(target => ({
        ...target,
        type: 'page',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/${target.id}`
      }));
    res.end(JSON.stringify(payload));
  });
  const websocketServer = new WebSocketServer({ server });
  websocketServer.on('connection', (socket, request) => {
    const id = request.url.slice(1);
    inspected.push(id);
    socket.on('message', data => {
      const request = JSON.parse(data);
      socket.send(JSON.stringify({
        id: request.id,
        result: {
          result: {
            value: {
              mode: 'solo',
              focused: id === 'ide',
              visible: id !== 'agent' || agentVisible,
              composer: true
            }
          }
        }
      }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const options = { host: '127.0.0.1', port: server.address().port };
    const defaultTarget = await discoverTarget(options);
    assert.strictEqual(defaultTarget.id, 'agent');
    assert.strictEqual(defaultTarget.workspaceKind, 'agent');
    assert.strictEqual(defaultTarget.mode, 'solo');
    const workbench = await discoverTarget({ ...options, surface: 'workbench' });
    assert.strictEqual(workbench.id, 'ide');
    assert.strictEqual(workbench.mode, 'solo');
    await assert.rejects(discoverTarget({ ...options, mode: 'ide' }), /No matching Trae CN ide target/);
    agentVisible = false;
    assert.strictEqual((await discoverTarget(options)).id, 'ide');
    assert.deepStrictEqual([...new Set(inspected)].sort(), ['agent', 'ide']);
  } finally {
    for (const socket of websocketServer.clients) socket.terminate();
    await new Promise(resolve => websocketServer.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});

test('fetchCDPTargets rejects on connection failure', async () => {
  try {
    await fetchCDPTargets('127.0.0.1', 1);
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('ECONNREFUSED') || err.message.includes('connect'));
  }
});

test('fetchCDPVersion rejects on connection failure', async () => {
  try {
    await fetchCDPVersion('127.0.0.1', 1);
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('ECONNREFUSED') || err.message.includes('connect'));
  }
});

pendingAsyncTests().then(() => {
  summary();
  if (runner.failed > 0) process.exitCode = 1;
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
