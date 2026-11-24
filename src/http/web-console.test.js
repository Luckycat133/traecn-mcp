'use strict';

const assert = require('assert');
const packageInfo = require('../../package.json');
const { createRunner } = require('../shared/test-runner');
const { makeReqRes } = require('../shared/test-helpers');
const { Gateway } = require('./gateway');
const {
  WEB_CONSOLE_ASSETS,
  WEB_CONSOLE_CSP,
  getWebConsoleAsset,
  renderChatUI,
} = require('./chat-ui');
const { matchRoute } = require('./route-table');

const runner = createRunner('web-console.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = runner;

console.log('\n[web-console.test.js] Running Web Control Console tests...\n');

function responseHeader(res, name) {
  const expected = name.toLowerCase();
  const entry = Object.entries(res._writtenHead || {}).find(
    ([key]) => key.toLowerCase() === expected
  );
  return entry ? entry[1] : undefined;
}

test('Web console shell uses semantic landmarks and fixed same-origin assets', () => {
  const html = renderChatUI();
  assert.match(html, /<title>TraeCN MCP · Web Control Console<\/title>/);
  assert.match(html, /<header\b/);
  assert.match(html, /<nav\b/);
  assert.match(html, /<main\b[^>]*id="main-content"/);
  assert.match(html, /<section\b/);
  assert.match(html, /<aside\b/);
  assert.match(html, /<dialog\b/);
  assert.match(html, /href="\/assets\/web-console\/styles\.css"/);
  assert.match(html, /src="\/assets\/web-console\/state\.js"/);
  assert.match(html, /src="\/assets\/web-console\/app\.js"/);
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /https?:\/\//i);
});

test('Web console asset lookup accepts only the fixed allowlist', () => {
  assert.deepStrictEqual(Array.from(WEB_CONSOLE_ASSETS.keys()), [
    '/assets/web-console/styles.css',
    '/assets/web-console/state.js',
    '/assets/web-console/app.js',
  ]);
  assert.match(getWebConsoleAsset('/assets/web-console/styles.css').contentType, /^text\/css/);
  assert.match(getWebConsoleAsset('/assets/web-console/app.js').contentType, /^text\/javascript/);
  assert.strictEqual(getWebConsoleAsset('/assets/web-console/../../chat-ui.js'), null);
  assert.strictEqual(getWebConsoleAsset('/assets/web-console/unknown.js'), null);
});

test('Web console CSP permits only first-party executable content', () => {
  assert.match(WEB_CONSOLE_CSP, /script-src 'self'/);
  assert.match(WEB_CONSOLE_CSP, /style-src 'self'/);
  assert.match(WEB_CONSOLE_CSP, /connect-src 'self'/);
  assert.match(WEB_CONSOLE_CSP, /object-src 'none'/);
  assert.match(WEB_CONSOLE_CSP, /frame-ancestors 'none'/);
  assert.doesNotMatch(WEB_CONSOLE_CSP, /unsafe-inline|unsafe-eval|https?:/);
});

test('Published package manifest includes non-JavaScript console assets', () => {
  assert.ok(packageInfo.files.includes('src/http/web-console/*.html'));
  assert.ok(packageInfo.files.includes('src/http/web-console/*.css'));
  assert.ok(packageInfo.files.includes('src/**/*.js'));
});

test('Narrow-screen controls preserve the 40 pixel touch target contract', () => {
  const css = getWebConsoleAsset('/assets/web-console/styles.css').body;
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*button,[\s\S]*\.button,[\s\S]*\.text-action\s*\{\s*min-height: 40px;/);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.icon-button\s*\{[\s\S]*width: 40px;[\s\S]*height: 40px;/);
});

test('Route table exposes exactly the fixed console asset paths', () => {
  for (const pathname of WEB_CONSOLE_ASSETS.keys()) {
    const match = matchRoute('GET', pathname);
    assert.ok(match, pathname);
    assert.strictEqual(match.route.handler, '_handleWebConsoleAsset');
    assert.strictEqual(match.route.requiresAuth, false);
  }
  assert.strictEqual(matchRoute('GET', '/assets/web-console/unknown.js'), null);
  assert.strictEqual(matchRoute('GET', '/assets/chat-ui.js'), null);
});

asyncTest('Gateway serves the public shell with strict no-store security headers', async () => {
  const gateway = new Gateway();
  gateway.token = 'configured-private-token';
  const { req, res } = makeReqRes({}, '/', 'GET');
  await gateway.handleRequest(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.match(responseHeader(res, 'content-type'), /^text\/html/);
  assert.strictEqual(responseHeader(res, 'cache-control'), 'no-store');
  assert.strictEqual(responseHeader(res, 'x-content-type-options'), 'nosniff');
  assert.strictEqual(responseHeader(res, 'content-security-policy'), WEB_CONSOLE_CSP);
  assert.match(res._body, /Web Control Console/);
  assert.doesNotMatch(res._body, /configured-private-token/);
});

asyncTest('Gateway serves fixed assets with exact types and the same strict policy', async () => {
  const gateway = new Gateway();
  gateway.token = 'configured-private-token';
  const expectations = new Map([
    ['/assets/web-console/styles.css', /^text\/css/],
    ['/assets/web-console/state.js', /^text\/javascript/],
    ['/assets/web-console/app.js', /^text\/javascript/],
  ]);

  for (const [pathname, contentType] of expectations) {
    const { req, res } = makeReqRes({}, pathname, 'GET');
    await gateway.handleRequest(req, res);
    assert.strictEqual(res.statusCode, 200, pathname);
    assert.match(responseHeader(res, 'content-type'), contentType, pathname);
    assert.strictEqual(responseHeader(res, 'cache-control'), 'no-store', pathname);
    assert.strictEqual(responseHeader(res, 'x-content-type-options'), 'nosniff', pathname);
    assert.strictEqual(responseHeader(res, 'content-security-policy'), WEB_CONSOLE_CSP, pathname);
    assert.ok(String(res._body).length > 20, pathname);
    assert.doesNotMatch(String(res._body), /configured-private-token/, pathname);
  }
});

asyncTest('Gateway rejects unknown and traversal-like console paths', async () => {
  const gateway = new Gateway();
  for (const pathname of [
    '/assets/web-console/unknown.js',
    '/assets/chat-ui.js',
    '/assets/web-console/%2e%2e/chat-ui.js',
  ]) {
    const { req, res } = makeReqRes({}, pathname, 'GET');
    await gateway.handleRequest(req, res);
    assert.strictEqual(res.statusCode, 404, pathname);
    assert.deepStrictEqual(JSON.parse(res._body), { error: 'Not found' }, pathname);
  }
});

(async () => {
  await pendingAsyncTests();
  summary();
  if (runner.failed > 0) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
