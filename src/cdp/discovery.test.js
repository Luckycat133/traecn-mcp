'use strict';

const assert = require('assert');
const { DEFAULT_DISCOVERY_PORTS, scoreTarget, discoverTarget, fetchCDPTargets, fetchCDPVersion, classifyTargetSurface, describeCDPSurface } = require('./discovery');
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
