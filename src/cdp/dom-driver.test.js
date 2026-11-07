'use strict';

const assert = require('assert');
const vm = require('vm');
const { DomDriver, getConfig, sanitizeActivityText, isTruncationSignal, DEFAULT_COMPOSER_SELECTORS, DEFAULT_SEND_BUTTON_SELECTORS, DEFAULT_RESPONSE_SELECTORS } = require('./dom-driver');
const { cleanAssistantResultText, NATIVE_TURN_OWNERSHIP } = require('./dom-handlers/response-collection');
const { _normalizeModelName } = require('./dom-handlers/model');
const { createRunner } = require('../shared/test-runner');

const r = createRunner('dom-driver.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = r;

console.log('\n[dom-driver.test.js] Running tests...\n');

function windowVisibilityFixture({ state = 'visible', activated = true, remainsHidden = false } = {}) {
  let current = state;
  let activations = 0;
  const reads = [];
  const driver = new DomDriver({ async send(method, params) {
    reads.push({ method, expression: params.expression });
    assert.strictEqual(method, 'Runtime.evaluate');
    const value = vm.runInNewContext(params.expression, { document: { visibilityState: current } });
    return { result: { value } };
  } }, getConfig(), { activateWindow: async () => {
    activations++;
    if (activated && !remainsHidden) current = 'visible';
    return activated;
  } });
  return { driver, reads, activations: () => activations };
}

asyncTest('visible window preparation leaves direct unconfigured drivers unchanged', async () => {
  let reads = 0;
  const driver = new DomDriver({ send: async () => { reads++; } }, getConfig());
  await driver._ensureVisibleWindow();
  assert.strictEqual(reads, 0);
});

asyncTest('visible windows do not trigger native activation', async () => {
  const fixture = windowVisibilityFixture();
  await fixture.driver._ensureVisibleWindow();
  assert.strictEqual(fixture.activations(), 0);
  assert.strictEqual(fixture.reads.length, 1);
});

asyncTest('hidden windows activate the existing application and confirm renderer visibility', async () => {
  const fixture = windowVisibilityFixture({ state: 'hidden' });
  await fixture.driver._ensureVisibleWindow();
  await fixture.driver._ensureVisibleWindow();
  assert.strictEqual(fixture.activations(), 1);
  assert.strictEqual(fixture.reads.length, 3);
});

asyncTest('failed window activation blocks chat creation, sends and result collection before UI work', async () => {
  for (const operation of ['newChat', 'sendMessage', 'collectResponse']) {
    const fixture = windowVisibilityFixture({ state: 'hidden', activated: false });
    await assert.rejects(() => fixture.driver[operation]('a new task'), error => error.code === 'WINDOW_NOT_VISIBLE');
    assert.strictEqual(fixture.activations(), 1);
    assert.strictEqual(fixture.reads.length, 1);
  }
});

asyncTest('window activation success without visible renderer state still blocks the action', async () => {
  const fixture = windowVisibilityFixture({ state: 'hidden', remainsHidden: true });
  fixture.driver._waitForExpression = async (expression, timeoutMs, pollMs) => {
    assert.strictEqual(timeoutMs, 5000);
    assert.strictEqual(pollMs, 200);
    return false;
  };
  await assert.rejects(() => fixture.driver._ensureVisibleWindow(), error => error.code === 'WINDOW_NOT_VISIBLE');
  assert.strictEqual(fixture.activations(), 1);
});

asyncTest('unavailable renderer visibility cannot authorize a send', async () => {
  const fixture = windowVisibilityFixture({ state: undefined });
  fixture.driver.client.send = async () => ({ result: {} });
  await assert.rejects(() => fixture.driver._ensureVisibleWindow(), error => error.code === 'WINDOW_NOT_VISIBLE');
  assert.strictEqual(fixture.activations(), 0);
});

asyncTest('switchMode waits for a newly advertised IDE window to mount', async () => {
  let reads = 0;
  let tabProbes = 0;
  const driver = new DomDriver({ async send(method, { expression }) {
    assert.strictEqual(method, 'Runtime.evaluate');
    if (expression.includes('tabs[0].click()')) {
      tabProbes++;
      return { result: { value: 'waiting' } };
    }
    const ready = ++reads >= 3;
    return { result: { value: { mode: ready ? 'ide' : 'solo', confidence: ready ? 0.8 : 0.5 } } };
  } }, getConfig(), { traeAdapter: { environment: { appVersion: '3.4.15' } } });
  const result = await driver.switchMode('ide');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.currentMode, 'ide');
  assert.strictEqual(tabProbes, 1);
});

test('getConfig returns default composer selectors', () => {
  delete process.env.TRAECN_COMPOSER_SELECTORS;
  delete process.env.TRAE_COMPOSER_SELECTORS;
  const config = getConfig();
  assert.deepStrictEqual(config.composerSelectors, DEFAULT_COMPOSER_SELECTORS);
});

test('getConfig returns default send button selectors', () => {
  delete process.env.TRAECN_SEND_BUTTON_SELECTORS;
  delete process.env.TRAE_SEND_BUTTON_SELECTORS;
  const config = getConfig();
  assert.deepStrictEqual(config.sendButtonSelectors, DEFAULT_SEND_BUTTON_SELECTORS);
});

test('getConfig returns default response selectors', () => {
  delete process.env.TRAECN_RESPONSE_SELECTORS;
  delete process.env.TRAE_RESPONSE_SELECTORS;
  const config = getConfig();
  assert.deepStrictEqual(config.responseSelectors, DEFAULT_RESPONSE_SELECTORS);
});

test('getConfig returns numeric poll interval', () => {
  const config = getConfig();
  assert.strictEqual(typeof config.pollIntervalMs, 'number');
  assert.ok(config.pollIntervalMs > 0);
});

test('getConfig returns numeric timeout', () => {
  const config = getConfig();
  assert.strictEqual(typeof config.timeoutMs, 'number');
  assert.ok(config.timeoutMs > 0);
});

function workspaceFixture({ title, hasExplorer = false, childName = '', resourceLabel = '', configuration }) {
  const resource = { getAttribute: name => name === 'aria-label' ? resourceLabel : null };
  const row = {
    getAttribute: name => name === 'aria-label' ? childName : null,
    querySelector: selector => selector === '.explorer-item[aria-label]' ? resource : null
  };
  const explorer = {
    querySelector: selector => selector === '[role="treeitem"][aria-level="1"]' ? row : null
  };
  const document = {
    title,
    querySelector: selector => selector === '.explorer-folders-view, .explorer-viewlet' && hasExplorer
      ? explorer : null
  };
  const window = configuration === undefined ? {} : {
    vscode: {
      context: {
        configuration: typeof configuration === 'function' ? configuration : () => configuration
      }
    }
  };
  return new DomDriver({
    async send(method, payload) {
      assert.strictEqual(method, 'Runtime.evaluate');
      assert.strictEqual(payload.returnByValue, true);
      const value = vm.runInNewContext(payload.expression, { document, window });
      return { result: { value: JSON.parse(JSON.stringify(value)) } };
    }
  }, getConfig());
}

asyncTest('getWorkspaceContext reports the open Trae folder from the workspace surface', async () => {
  const workspace = await workspaceFixture({
    title: 'gemini-web-mcp', hasExplorer: true, childName: 'src',
    resourceLabel: '~/Documents/gh-repos/gemini-web-mcp/src'
  }).getWorkspaceContext();

  assert.deepStrictEqual(workspace, {
    title: 'gemini-web-mcp',
    folderName: 'gemini-web-mcp',
    rootPath: '~/Documents/gh-repos/gemini-web-mcp',
    hasExplorer: true
  });
});

asyncTest('getWorkspaceContext uses the workspace title when Solo hides the explorer', async () => {
  const workspace = await workspaceFixture({ title: 'TRAECNclaw' }).getWorkspaceContext();

  assert.deepStrictEqual(workspace, {
    title: 'TRAECNclaw',
    folderName: 'TRAECNclaw',
    rootPath: null,
    hasExplorer: false
  });
});

asyncTest('getWorkspaceContext recognizes the live editor-prefixed title with Explorer hidden', async () => {
  const workspace = await workspaceFixture({ title: '更新日志 — TRAECNclaw' }).getWorkspaceContext();
  assert.deepStrictEqual(workspace, {
    title: '更新日志 — TRAECNclaw', folderName: 'TRAECNclaw', rootPath: null, hasExplorer: false
  });
});

asyncTest('getWorkspaceContext prefers the Explorer resource root over a stale editor title', async () => {
  const workspace = await workspaceFixture({
    title: 'README.md — previous-repo', hasExplorer: true, childName: 'src',
    resourceLabel: '/Users/example/projects/current-repo/src'
  }).getWorkspaceContext();
  assert.deepStrictEqual(workspace, {
    title: 'README.md — previous-repo', folderName: 'current-repo',
    rootPath: '/Users/example/projects/current-repo', hasExplorer: true
  });
});

asyncTest('getWorkspaceContext keeps unreadable Explorer root unknown while parsing the title', async () => {
  const workspace = await workspaceFixture({
    title: '更新日志 — TRAECNclaw', hasExplorer: true, childName: 'src'
  }).getWorkspaceContext();
  assert.deepStrictEqual(workspace, {
    title: '更新日志 — TRAECNclaw', folderName: 'TRAECNclaw', rootPath: null, hasExplorer: true
  });
});

asyncTest('getWorkspaceContext preserves distinct resource paths with the same folder basename', async () => {
  const roots = ['/Users/example/projects/TRAECNclaw', '/Users/example/other/TRAECNclaw'];
  const contexts = await Promise.all(roots.map(root => workspaceFixture({
    title: '更新日志 — TRAECNclaw', hasExplorer: true, childName: 'src', resourceLabel: `${root}/src`
  }).getWorkspaceContext()));
  assert.deepStrictEqual(contexts.map(context => context.folderName), ['TRAECNclaw', 'TRAECNclaw']);
  assert.deepStrictEqual(contexts.map(context => context.rootPath), roots);
});

asyncTest('getWorkspaceContext reads the native single-folder file URI with the Explorer hidden', async () => {
  const rootPath = '/Users/example/projects/recovery-fixture';
  const workspace = await workspaceFixture({
    title: 'README.md — previous-repo',
    configuration: {
      windowId: 1,
      workspace: {
        id: 'fixture-workspace',
        uri: { scheme: 'file', authority: '', path: rootPath, _fsPath: rootPath }
      }
    }
  }).getWorkspaceContext();
  assert.deepStrictEqual(workspace, {
    title: 'README.md — previous-repo', folderName: 'recovery-fixture', rootPath, hasExplorer: false
  });
});

asyncTest('getWorkspaceContext prefers the native file URI over a stale Explorer resource', async () => {
  const workspace = await workspaceFixture({
    title: 'README.md — workspace', hasExplorer: true, childName: 'src',
    resourceLabel: '/Users/example/campaign/workspace/src',
    configuration: {
      workspace: { uri: { scheme: 'file', authority: '', path: '/Users/example/recovery/workspace' } }
    }
  }).getWorkspaceContext();
  assert.strictEqual(workspace.folderName, 'workspace');
  assert.strictEqual(workspace.rootPath, '/Users/example/recovery/workspace');
});

asyncTest('getWorkspaceContext preserves distinct native paths with the same folder basename', async () => {
  const roots = ['/Users/example/campaign/workspace', '/Users/example/recovery/workspace'];
  const contexts = await Promise.all(roots.map(rootPath => workspaceFixture({
    title: 'workspace',
    configuration: { workspace: { uri: { scheme: 'file', authority: '', path: rootPath } } }
  }).getWorkspaceContext()));
  assert.deepStrictEqual(contexts.map(context => context.folderName), ['workspace', 'workspace']);
  assert.deepStrictEqual(contexts.map(context => context.rootPath), roots);
});

asyncTest('getWorkspaceContext retains literal spaces and percent signs in the native URI path', async () => {
  const rootPath = '/Users/example/projects/my project%20';
  const workspace = await workspaceFixture({
    title: 'my project%20',
    configuration: { workspace: { uri: { scheme: 'file', authority: '', path: rootPath } } }
  }).getWorkspaceContext();
  assert.strictEqual(workspace.folderName, 'my project%20');
  assert.strictEqual(workspace.rootPath, rootPath);
});

asyncTest('getWorkspaceContext keeps Explorer fallback when native configuration is unavailable', async () => {
  const workspace = await workspaceFixture({
    title: 'README.md — previous-repo', hasExplorer: true, childName: 'src',
    resourceLabel: '/Users/example/current-repo/src',
    configuration() { throw new Error('configuration is not yet available'); }
  }).getWorkspaceContext();
  assert.strictEqual(workspace.folderName, 'current-repo');
  assert.strictEqual(workspace.rootPath, '/Users/example/current-repo');
});

asyncTest('getWorkspaceContext does not treat a multi-folder config URI as a single folder', async () => {
  const workspace = await workspaceFixture({
    title: 'current-repo', hasExplorer: true, childName: 'src',
    resourceLabel: '/Users/example/current-repo/src',
    configuration: {
      workspace: { configPath: { scheme: 'file', authority: '', path: '/Users/example/multi.code-workspace' } }
    }
  }).getWorkspaceContext();
  assert.strictEqual(workspace.folderName, 'current-repo');
  assert.strictEqual(workspace.rootPath, '/Users/example/current-repo');
});

asyncTest('getWorkspaceContext leaves nonlocal or relative native URI paths unknown', async () => {
  for (const uri of [
    { scheme: 'vscode-remote', authority: 'ssh-remote+fixture', path: '/remote/workspace' },
    { scheme: 'file', authority: 'remote-host', path: '/remote/workspace' },
    { scheme: 'file', authority: '', path: 'relative/workspace', _fsPath: '/unobserved/workspace' }
  ]) {
    const workspace = await workspaceFixture({
      title: 'workspace', configuration: { workspace: { uri } }
    }).getWorkspaceContext();
    assert.strictEqual(workspace.folderName, 'workspace');
    assert.strictEqual(workspace.rootPath, null);
  }
});

asyncTest('getWorkspaceContext preserves workspace names containing ordinary hyphens', async () => {
  const workspace = await workspaceFixture({ title: 'README.md — my-project - tools' }).getWorkspaceContext();
  assert.strictEqual(workspace.folderName, 'my-project - tools');
  assert.strictEqual(workspace.rootPath, null);
});

asyncTest('getWorkspaceContext does not infer a workspace from the application-only title', async () => {
  const workspace = await workspaceFixture({ title: 'Trae CN', hasExplorer: true }).getWorkspaceContext();
  assert.deepStrictEqual(workspace, { title: 'Trae CN', folderName: null, rootPath: null, hasExplorer: true });
});

asyncTest('getWorkspaceContext keeps a relative resource label as an unknown root', async () => {
  const workspace = await workspaceFixture({
    title: 'README.md — TRAECNclaw', hasExplorer: true, childName: 'src', resourceLabel: 'TRAECNclaw/src'
  }).getWorkspaceContext();
  assert.strictEqual(workspace.folderName, 'TRAECNclaw');
  assert.strictEqual(workspace.rootPath, null);
});

asyncTest('getWorkspaceContext retains the existing backslash resource path format', async () => {
  const workspace = await workspaceFixture({
    title: 'README.md — previous-repo', hasExplorer: true, childName: 'src',
    resourceLabel: 'C:\\projects\\current-repo\\src'
  }).getWorkspaceContext();
  assert.strictEqual(workspace.folderName, 'current-repo');
  assert.strictEqual(workspace.rootPath, 'C:\\projects\\current-repo');
});

asyncTest('getWorkspaceContext accepts an observed root named like the application', async () => {
  const workspace = await workspaceFixture({
    title: 'Trae CN', hasExplorer: true, childName: 'src', resourceLabel: '/Users/example/projects/Trae CN/src'
  }).getWorkspaceContext();
  assert.strictEqual(workspace.folderName, 'Trae CN');
  assert.strictEqual(workspace.rootPath, '/Users/example/projects/Trae CN');
});

test('getConfig leaves queueMaxWaitMs unset by default', () => {
  delete process.env.TRAECN_QUEUE_MAX_WAIT_MS;
  delete process.env.TRAE_QUEUE_MAX_WAIT_MS;
  try {
    const config = getConfig();
    assert.strictEqual(config.queueMaxWaitMs, null);
  } finally {
    delete process.env.TRAECN_QUEUE_MAX_WAIT_MS;
    delete process.env.TRAE_QUEUE_MAX_WAIT_MS;
  }
});

test('getConfig parses explicit queueMaxWaitMs', () => {
  process.env.TRAECN_QUEUE_MAX_WAIT_MS = '12345';
  try {
    const config = getConfig();
    assert.strictEqual(config.queueMaxWaitMs, 12345);
  } finally {
    delete process.env.TRAECN_QUEUE_MAX_WAIT_MS;
  }
});

test('getConfig sendTrigger defaults to button', () => {
  delete process.env.TRAECN_SEND_TRIGGER;
  delete process.env.TRAE_SEND_TRIGGER;
  try {
    const config = getConfig();
    assert.strictEqual(config.sendTrigger, 'button');
  } finally {
    delete process.env.TRAECN_SEND_TRIGGER;
    delete process.env.TRAE_SEND_TRIGGER;
  }
});

asyncTest('sendMessage verifies debug prompts containing angle brackets and arrows', async () => {
  const text = 'Debug route -> 500 and inspect <handler> without editing files';
  const normalized = text.replace(/\s+/g, ' ').trim();
  const expressions = [];
  const insertTexts = [];
  const mouseEvents = [];
  const fakeClient = {
    async send(method, payload = {}) {
      if (method === 'Runtime.evaluate') {
        const expression = payload.expression || '';
        expressions.push(expression);
        if (expression.includes('el.focus()')) {
          return { result: { value: { ok: true } } };
        }
        if (expression.includes('normalized ===')) {
          return { result: { value: { ok: true, text: normalized, normalized } } };
        }
        if (expression.includes('button.chat-input-v2-send-button')) {
          return { result: { value: { ok: true, x: 726, y: 810 } } };
        }
        return { result: { value: {} } };
      }
      if (method === 'Input.insertText') {
        insertTexts.push(payload.text);
        return {};
      }
      if (method === 'Input.dispatchKeyEvent') return {};
      if (method === 'Input.dispatchMouseEvent') {
        mouseEvents.push(payload);
        return {};
      }
      throw new Error(`unexpected CDP method ${method}`);
    }
  };
  const driver = new DomDriver(fakeClient, { ...getConfig(), postActionDelayMs: 0, sendTrigger: 'button' });
  driver.checkTaskReviewGate = async () => ({ awaitingReview: false, reviewCount: 0 });
  driver.findSendButton = async () => ({ nodeId: 1 });

  await driver.sendMessage(text);

  const verification = expressions.find(expression => expression.includes('normalized ==='));
  assert.ok(verification.includes('\\u003E'));
  assert.ok(verification.includes('\\u003C'));
  assert.ok(!verification.includes('normalized === ,'));
  assert.deepStrictEqual(insertTexts, [text]);
  assert.deepStrictEqual(mouseEvents.map(event => event.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

asyncTest('sendMessage rejects a click that does not create a visible user message', async () => {
  const text = 'Verify that this request is visible in the Solo conversation';
  const fakeClient = {
    async send(method, payload = {}) {
      if (method === 'Runtime.evaluate') {
        const expression = payload.expression || '';
        if (expression.includes('el.focus()')) return { result: { value: { ok: true } } };
        if (expression.includes('normalized ===')) {
          return { result: { value: { ok: true, text, normalized: text } } };
        }
        if (expression.includes('button.chat-input-v2-send-button')) {
          return { result: { value: { ok: true, x: 726, y: 810 } } };
        }
        return { result: { value: {} } };
      }
      if (method === 'Input.insertText' || method === 'Input.dispatchKeyEvent' || method === 'Input.dispatchMouseEvent') return {};
      throw new Error(`unexpected CDP method ${method}`);
    }
  };
  const driver = new DomDriver(fakeClient, { ...getConfig(), postActionDelayMs: 0, sendTrigger: 'button' });
  driver.checkTaskReviewGate = async () => ({ awaitingReview: false, reviewCount: 0 });
  driver.findSendButton = async () => ({ nodeId: 1 });
  driver._waitForExpression = async () => false;

  await assert.rejects(
    () => driver.sendMessage(text),
    error => error && error.code === 'SEND_FAILED' && error.details.submissionDispatched === true && /did not appear/.test(error.message)
  );
});

test('checkQueueStatus ignores historical queue text without visible queue notice', async () => {
  let expression = '';
  const fakeClient = {
    async send(method, payload) {
      assert.strictEqual(method, 'Runtime.evaluate');
      expression = payload.expression || '';
      assert.ok(expression.includes('queueCandidates'));
      return {
        result: {
          value: {
            found: true,
            queued: false,
            isDisabled: false,
            hasDisabledClass: false,
            sendDisabled: false,
            currentModel: 'DeepSeek-V4-Pro'
          }
        }
      };
    }
  };
  const driver = new DomDriver(fakeClient, getConfig());
  const result = await driver.checkQueueStatus();
  // Behavioral assertion: historical queue text must not be treated as active queue.
  assert.strictEqual(result.queued, false);
  // Regression guards: the probe expression must inspect the queue surface DOM
  // (not just body text) and filter transient model/service status strings.
  assert.ok(expression.includes('queueSurface'));
  assert.ok(expression.includes('monaco-editor'));
  assert.ok(expression.includes('model|request|server|service'));
});

test('sanitizeActivityText removes Chinese thinking indicators', () => {
  const result = sanitizeActivityText('正在思考… some text');
  assert.ok(!result.includes('正在思考'));
  assert.ok(result.includes('some text'));
});

test('sanitizeActivityText removes 思考中 indicator', () => {
  const result = sanitizeActivityText('思考中… progress');
  assert.ok(!result.includes('思考中'));
  assert.ok(result.includes('progress'));
});

test('sanitizeActivityText removes English thinking indicators', () => {
  const result = sanitizeActivityText('Generating… some text');
  assert.ok(!result.includes('Generating'));
  assert.ok(result.includes('some text'));
});

test('sanitizeActivityText removes Thinking indicator', () => {
  const result = sanitizeActivityText('Thinking… reasoning');
  assert.ok(!result.includes('Thinking'));
  assert.ok(result.includes('reasoning'));
});

test('sanitizeActivityText handles empty input', () => {
  assert.strictEqual(sanitizeActivityText(''), '');
  assert.strictEqual(sanitizeActivityText(null), '');
  assert.strictEqual(sanitizeActivityText(undefined), '');
});

test('sanitizeActivityText collapses whitespace', () => {
  const result = sanitizeActivityText('hello   world');
  assert.strictEqual(result, 'hello world');
});

test('isTruncationSignal returns false for empty or null input', () => {
  assert.strictEqual(isTruncationSignal(''), false);
  assert.strictEqual(isTruncationSignal(null), false);
  assert.strictEqual(isTruncationSignal(undefined), false);
});

test('isTruncationSignal returns false for non-truncation text', () => {
  assert.strictEqual(isTruncationSignal('任务完成'), false);
  assert.strictEqual(isTruncationSignal('normal response text'), false);
});

test('isTruncationSignal detects Builder manual termination', () => {
  assert.strictEqual(isTruncationSignal('Builder手动终止输出'), true);
  assert.strictEqual(isTruncationSignal('用户 Builder手动终止输出 已停止'), true);
});

test('isTruncationSignal detects manual termination', () => {
  assert.strictEqual(isTruncationSignal('手动终止输出'), true);
});

test('isTruncationSignal detects output terminated', () => {
  assert.strictEqual(isTruncationSignal('输出已终止'), true);
});

test('isTruncationSignal detects generation stopped', () => {
  assert.strictEqual(isTruncationSignal('生成已停止'), true);
});

test('isTruncationSignal detects waiting ellipsis variants', () => {
  assert.strictEqual(isTruncationSignal('等待中...'), true);
  assert.strictEqual(isTruncationSignal('等待中…'), true);
});

test('isTruncationSignal detects queue reminder', () => {
  assert.strictEqual(isTruncationSignal('排队提醒'), true);
});

test('isTruncationSignal detects analyzing problem variants', () => {
  assert.strictEqual(isTruncationSignal('正在分析问题...'), true);
  assert.strictEqual(isTruncationSignal('正在分析问题…'), true);
});

test('cleanAssistantResultText extracts Trae final bug report from process transcript', () => {
  const result = cleanAssistantResultText([
    'TRAECNclaw/src/http',
    'Thought 在工作区搜索 route-table',
    'GET /api/tasks/histo%72y -> _handleGetTask params={"taskId":"history"}',
    'ThoughtBug found (TRAECN_DEBUG_SYNC_GLM52) Likely bug: URL-encoded path segments bypass exact routing.',
    'Root cause: matchRoute compares the raw pathname before decoding unreserved characters.',
    'Suggested patch: normalize exact-match paths while preserving encoded slashes in params.'
  ].join(' '));

  assert.ok(result.startsWith('Bug found (TRAECN_DEBUG_SYNC_GLM52)'));
  assert.ok(result.includes('Likely bug: URL-encoded path segments'));
  assert.ok(!result.includes('Thought 在工作区搜索'));
  assert.ok(!result.includes('GET /api/tasks/histo%72y'));
});

test('DEFAULT_COMPOSER_SELECTORS includes textarea', () => {
  assert.ok(DEFAULT_COMPOSER_SELECTORS.includes('textarea'));
});

test('DEFAULT_SEND_BUTTON_SELECTORS includes submit button', () => {
  assert.ok(DEFAULT_SEND_BUTTON_SELECTORS.some(s => s.includes('submit')));
});

test('DEFAULT_RESPONSE_SELECTORS includes assistant class', () => {
  assert.ok(DEFAULT_RESPONSE_SELECTORS.some(s => s.includes('assistant')));
});

test('approveDialog trust labels include Monaco trust button text', () => {
  const driver = new DomDriver(null, getConfig());
  const labels = driver._getButtonLabelsForAction('trust');
  assert.ok(labels.includes('是，我信任此作者'));
});

test('approveDialog approve labels include Monaco trust button text', () => {
  const driver = new DomDriver(null, getConfig());
  const labels = driver._getButtonLabelsForAction('approve');
  assert.ok(labels.includes('是，我信任此作者'));
});

test('approveDialog approve labels include inline command run button', () => {
  const driver = new DomDriver(null, getConfig());
  const labels = driver._getButtonLabelsForAction('approve');
  assert.ok(labels.includes('运行'));
});

test('approveDialog deny labels include the Trae v2 command-card skip button', () => {
  const driver = new DomDriver(null, getConfig());
  const labels = driver._getButtonLabelsForAction('deny');
  assert.ok(labels.includes('跳过'));
});

asyncTest('approveDialog searches every button inside the active Trae v2 command card', async () => {
  let calls = 0;
  const driver = new DomDriver({
    send: async (_method, params) => {
      calls++;
      if (calls === 1) {
        return {
          result: {
            value: {
              found: true,
              title: '检测到高风险命令',
              buttons: ['跳过', '运行'],
              type: 'command_execution',
              isCommandExec: true,
              canAutoApprove: false,
              command: 'find /tmp/test -delete'
            }
          }
        };
      }
      assert.ok(params.expression.includes('inlineCard.querySelectorAll'));
      return { result: { value: { clicked: false, searchedLabels: ['跳过'] } } };
    }
  }, getConfig());

  await driver.approveDialog('deny');
  assert.strictEqual(calls, 2);
});

test('command approval assessment requires explicit review for an entirely read-only command chain', () => {
  const driver = new DomDriver(null, getConfig());
  const assessment = driver._assessCommandApproval(
    'git status && git diff --stat HEAD'
  );

  assert.deepStrictEqual(assessment, {
    decision: 'agent_review',
    risk: 'low',
    reasonCodes: ['explicit_command_review_required']
  });
});

test('command approval assessment never auto-approves sensitive or cross-workspace reads', () => {
  const driver = new DomDriver(null, getConfig());

  for (const command of [
    'cat .env',
    'cat /etc/passwd',
    'git -C /tmp/other-repository status',
    'cd /tmp && git status'
  ]) {
    const assessment = driver._assessCommandApproval(command);
    assert.notStrictEqual(assessment.decision, 'auto_approve', command);
  }
});

test('command approval assessment sends write or network commands to the calling agent', () => {
  const driver = new DomDriver(null, getConfig());

  assert.deepStrictEqual(
    driver._assessCommandApproval('git status && git push origin main'),
    {
      decision: 'agent_review',
      risk: 'high',
      reasonCodes: ['git_write_or_remote']
    }
  );
  assert.deepStrictEqual(
    driver._assessCommandApproval('curl https://example.com/upload --data @report.json'),
    {
      decision: 'agent_review',
      risk: 'high',
      reasonCodes: ['network_or_data_transfer']
    }
  );
});

test('command approval assessment rejects commands with hidden side effects from auto approval', () => {
  const driver = new DomDriver();
  for (const command of [
    'find . -name "*.tmp" -delete',
    'sed -n "1,20w /tmp/copied" README.md',
    'npm test',
    'node --test',
    'rg --pre ./formatter secret .',
    'git diff --ext-diff'
  ]) {
    const assessment = driver._assessCommandApproval(command);
    assert.notStrictEqual(assessment.decision, 'auto_approve', command);
  }
});

test('command approval assessment sends unknown commands to the calling agent', () => {
  const driver = new DomDriver(null, getConfig());
  assert.deepStrictEqual(driver._assessCommandApproval('custom-tool inspect repo'), {
    decision: 'agent_review',
    risk: 'unknown',
    reasonCodes: ['unknown_command']
  });
});

asyncTest('checkForApprovalDialog detects inline command approval cards', async () => {
  let evaluatedExpression = '';
  const driver = new DomDriver({
    send: async (_method, params) => {
      evaluatedExpression = params.expression;
      const supportsInlineCommandApproval = evaluatedExpression.includes('icd-run-command-card-v2')
        && evaluatedExpression.includes('\\u547d\\u4ee4\\u5728\\u6c99\\u7bb1\\u4e2d\\u8fd0\\u884c\\u4e0d\\u901a\\u8fc7');
      return {
        result: {
          value: supportsInlineCommandApproval
            ? {
                found: true,
                title: '命令在沙箱中运行不通过，是否仍然要在沙箱外运行？',
                buttons: ['跳过', '添加 3 个命令到白名单', '运行'],
                type: 'command_execution',
                isCommandExec: true,
                canAutoApprove: true,
                command: 'git status && git diff --stat HEAD'
              }
            : { found: false }
        }
      };
    }
  }, getConfig());

  const dialog = await driver.checkForApprovalDialog();

  assert.strictEqual(dialog.needsApproval, true);
  assert.strictEqual(dialog.dialogType, 'command_execution');
  assert.strictEqual(dialog.isCommandExec, true);
  assert.ok(dialog.buttons.includes('运行'));
  assert.strictEqual(dialog.canAutoApprove, false);
  assert.strictEqual(dialog.approvalDecision, 'agent_review');
  assert.deepStrictEqual(dialog.riskReasons, ['explicit_command_review_required']);
});

asyncTest('checkForApprovalDialog detects Trae v2 high-risk command cards', async () => {
  const driver = new DomDriver({
    send: async (_method, params) => {
      const supportsHighRiskV2 = params.expression.includes('\\u68c0\\u6d4b\\u5230\\u9ad8\\u98ce\\u9669\\u547d\\u4ee4');
      return {
        result: {
          value: supportsHighRiskV2
            ? {
                found: true,
                title: '检测到高风险命令，运行命令可能会带来严重后果，是否仍要在沙箱中运行？',
                buttons: ['跳过', "添加 'find' 到白名单", '运行'],
                type: 'command_execution',
                isCommandExec: true,
                canAutoApprove: false,
                command: 'find /Users/tester/traecn-live-uat-safe -delete'
              }
            : { found: false }
        }
      };
    }
  }, getConfig());

  const dialog = await driver.checkForApprovalDialog();

  assert.strictEqual(dialog.needsApproval, true);
  assert.strictEqual(dialog.canAutoApprove, false);
  assert.strictEqual(dialog.approvalDecision, 'agent_review');
  assert.deepStrictEqual(dialog.riskReasons, ['filesystem_write_via_find']);
});

test('restricted mode summary treats trusted workspace page as not restricted', () => {
  const driver = new DomDriver(null, getConfig());
  const modeSummary = driver._summarizeRestrictedModeState({
    bodyText: '工作区信任\n你信任此文件夹\n配置设置',
    buttonTexts: ['不信任', '配置设置'],
    hasOverlay: true
  });
  assert.strictEqual(modeSummary.restricted, false);
  assert.strictEqual(modeSummary.trusted, true);
  assert.strictEqual(modeSummary.panelOpen, true);
});

test('restricted mode summary detects actionable trust panel', () => {
  const driver = new DomDriver(null, getConfig());
  const modeSummary = driver._summarizeRestrictedModeState({
    bodyText: '工作区信任\n此文件夹中的功能受限，请信任此文件夹',
    buttonTexts: ['信任', '配置设置'],
    hasOverlay: true
  });
  assert.strictEqual(modeSummary.restricted, true);
  assert.strictEqual(modeSummary.trusted, false);
  assert.strictEqual(modeSummary.panelOpen, true);
  assert.strictEqual(modeSummary.trustButtonFound, true);
});

test('completeSetupIfPresent advances multi-step setup wizard and exits when workspace is ready', async () => {
  let inspectCount = 0;
  let clickCount = 0;
  const fakeClient = {
    async send(method, payload) {
      if (method !== 'Runtime.evaluate') throw new Error(`unexpected method: ${method}`);
      const expression = payload.expression || '';
      if (expression.includes('const url = String(location.href || \'\')')) {
        inspectCount += 1;
        if (inspectCount === 1) {
          return {
            result: {
              value: {
                isSetup: true,
                url: 'vscode-file://.../setup/setup.html',
                text: '欢迎使用\\n开始',
                buttons: [
                  { text: '开始', disabled: false, visible: true }
                ]
              }
            }
          };
        }
        if (inspectCount === 2) {
          return {
            result: {
              value: {
                isSetup: true,
                url: 'vscode-file://.../setup/setup.html',
                text: '快捷键\\nVS Code\\n继续',
                buttons: [
                  { text: 'VS Code', disabled: false, visible: true },
                  { text: '继续', disabled: false, visible: true }
                ]
              }
            }
          };
        }
        return {
          result: {
            value: {
              isSetup: false,
              url: 'vscode-file://.../workbench/workbench.html',
              text: 'workspace',
              buttons: []
            }
          }
        };
      }
      if (expression.includes('window.__traeEnhancedClick_v1("开始")')) {
        clickCount += 1;
        return { result: { value: { clicked: true, text: '开始' } } };
      }
      if (expression.includes('window.__traeEnhancedClick_v1("继续")')) {
        clickCount += 1;
        return { result: { value: { clicked: true, text: '继续' } } };
      }
      if (expression.includes('if (window.__traeEnhancedClick_v1) return')) {
        return { result: { value: undefined } };
      }
      throw new Error(`unexpected expression: ${expression.slice(0, 80)}`);
    }
  };
  const driver = new DomDriver(fakeClient, { ...getConfig(), postActionDelayMs: 0 });
  const result = await driver.completeSetupIfPresent({ delayMs: 0 });
  assert.strictEqual(result.completed, true);
  assert.strictEqual(result.steps, 2);
  assert.strictEqual(clickCount, 2);
});

test('completeSetupIfPresent returns no_actionable_setup_button when setup page has no supported CTA', async () => {
  const fakeClient = {
    async send(method, payload) {
      if (method !== 'Runtime.evaluate') throw new Error(`unexpected method: ${method}`);
      const expression = payload.expression || '';
      if (expression.includes('const url = String(location.href || \'\')')) {
        return {
          result: {
            value: {
              isSetup: true,
              url: 'vscode-file://.../setup/setup.html',
              text: '某个未知引导页',
              buttons: [
                { text: '稍后提醒我', disabled: false, visible: true }
              ]
            }
          }
        };
      }
      if (expression.includes('if (window.__traeEnhancedClick_v1) return')) {
        return { result: { value: undefined } };
      }
      throw new Error(`unexpected expression: ${expression.slice(0, 80)}`);
    }
  };
  const driver = new DomDriver(fakeClient, getConfig());
  const result = await driver.completeSetupIfPresent();
  assert.strictEqual(result.completed, false);
  assert.strictEqual(result.reason, 'no_actionable_setup_button');
});

test('completeSetupIfPresent can click setup skip links rendered as pointer divs', async () => {
  let inspectCount = 0;
  let clicked = false;
  const fakeClient = {
    async send(method, payload) {
      if (method !== 'Runtime.evaluate') throw new Error(`unexpected method: ${method}`);
      const expression = payload.expression || '';
      if (expression.includes('const url = String(location.href || \'\')')) {
        inspectCount += 1;
        if (inspectCount === 1) {
          return {
            result: {
              value: {
                isSetup: true,
                url: 'vscode-file://.../setup/setup.html',
                text: '添加命令行\\n安装 `trae-cn` 命令\\n跳过',
                buttons: [
                  { text: '安装 `trae-cn` 命令', disabled: false, visible: true, clickable: true },
                  { text: '跳过', disabled: false, visible: true, clickable: true }
                ]
              }
            }
          };
        }
        return {
          result: {
            value: {
              isSetup: false,
              url: 'vscode-file://.../workbench/workbench.html',
              text: 'workspace',
              buttons: []
            }
          }
        };
      }
      if (expression.includes('window.__traeEnhancedClick_v1("跳过")')) {
        clicked = true;
        return { result: { value: { clicked: true, text: '跳过' } } };
      }
      if (expression.includes('if (window.__traeEnhancedClick_v1) return')) {
        return { result: { value: undefined } };
      }
      throw new Error(`unexpected expression: ${expression.slice(0, 80)}`);
    }
  };
  const driver = new DomDriver(fakeClient, { ...getConfig(), postActionDelayMs: 0 });
  const result = await driver.completeSetupIfPresent({ delayMs: 0 });
  assert.strictEqual(result.completed, true);
  assert.strictEqual(clicked, true);
});

test('dismissWorkspaceGuideIfPresent clears visible workspace onboarding overlay', async () => {
  let clicked = false;
  const fakeClient = {
    async send(method, payload) {
      if (method !== 'Runtime.evaluate') throw new Error(`unexpected method: ${method}`);
      const expression = payload.expression || '';
      if (expression.includes('window.__traeEnhancedClick_v1("继续"')) {
        clicked = true;
        return { result: { value: { clicked: true, text: '继续' } } };
      }
      if (expression.includes('if (window.__traeEnhancedClick_v1) return')) {
        return { result: { value: undefined } };
      }
      throw new Error(`unexpected expression: ${expression.slice(0, 80)}`);
    }
  };
  const driver = new DomDriver(fakeClient, { ...getConfig(), postActionDelayMs: 0 });
  let inspectCount = 0;
  driver.inspectWorkspaceBlockers = async () => {
    inspectCount += 1;
    if (inspectCount === 1) {
      return {
        bodyText: 'NEW SOLO BETA\\n继续',
        titles: ['NEW SOLO BETA'],
        guideVisible: true,
        guideButtons: [{ text: '继续', x: 120, y: 200 }],
        loginVisible: false,
        newTaskVisible: false,
        visibleControls: [{ text: '继续' }]
      };
    }
    return {
      bodyText: 'workspace',
      titles: [],
      guideVisible: false,
      guideButtons: [],
      loginVisible: false,
      newTaskVisible: true,
      visibleControls: [{ text: '新建会话' }]
    };
  };
  const result = await driver.dismissWorkspaceGuideIfPresent({ delayMs: 0 });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.dismissed, 1);
  assert.strictEqual(clicked, true);
});

test('checkTaskReviewGate detects visible keep/discard controls', async () => {
  const fakeClient = {
    async send() {
      return {
        result: {
          value: {
            awaitingReview: true,
            taskCompleted: true,
            waitingToSend: true,
            reviewCount: 1,
            keepAll: { text: '全部保留', x: 100, y: 200 },
            revertAll: { text: '全部撤销', x: 80, y: 200 },
            newChatDisabled: true,
            visibleButtons: [{ text: '全部保留' }, { text: '全部撤销' }]
          }
        }
      };
    }
  };
  const driver = new DomDriver(fakeClient, getConfig());
  const gate = await driver.checkTaskReviewGate();
  assert.strictEqual(gate.awaitingReview, true);
  assert.strictEqual(gate.reviewCount, 1);
  assert.strictEqual(gate.keepAll.text, '全部保留');
});

test('resolveTaskReviewGate short-circuits when no review gate is present', async () => {
  const driver = new DomDriver({ send: async () => ({ result: { value: null } }) }, getConfig());
  driver.checkTaskReviewGate = async () => ({ awaitingReview: false });
  const result = await driver.resolveTaskReviewGate('keep_all');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, 'no_review_gate');
});

test('approveDialog dismiss handles Trae review scope question cards', async () => {
  let calls = 0;
  const driver = new DomDriver({
    send: async () => {
      calls++;
      if (calls === 1) {
        return {
          result: {
            value: {
              found: true,
              title: 'Review Scope',
              buttons: ['取消', '下一个'],
              type: 'review_scope_question',
              isCommandExec: false,
              canAutoApprove: false
            }
          }
        };
      }
      if (calls === 2) {
        return { result: { value: { clicked: true, buttonText: '取消' } } };
      }
      return { result: { value: { found: false } } };
    }
  }, getConfig());

  const result = await driver.approveDialog('dismiss');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.buttonClicked, '取消');
  assert.strictEqual(calls, 3);
});

test('checkForApprovalDialog exposes review scope answer options', async () => {
  const driver = new DomDriver({
    send: async () => ({
      result: {
        value: {
          found: true,
          title: 'Review Scope',
          buttons: ['取消', '下一个'],
          options: [
            { label: 'Latest commit changes', description: 'Review only the changes in the most recent commit' },
            { label: 'Uncommitted changes', description: 'Review any uncommitted or staged workspace changes' }
          ],
          type: 'review_scope_question',
          isCommandExec: false,
          canAutoApprove: false
        }
      }
    })
  }, getConfig());

  const dialog = await driver.checkForApprovalDialog();

  assert.strictEqual(dialog.needsApproval, true);
  assert.strictEqual(dialog.dialogType, 'review_scope_question');
  assert.strictEqual(dialog.options.length, 2);
  assert.strictEqual(dialog.options[1].label, 'Uncommitted changes');
});

test('checkForApprovalDialog parses current Trae review scope option labels', async () => {
  const cardText = [
    'What would you like me to review?',
    'Current workspace changes',
    'Review uncommitted/staged changes in the workspace',
    'Changes compared to a branch',
    'Review diff against a specific branch (e.g., main, develop)',
    'A specific MR/PR',
    'Review a specific pull request by number',
    'Specific files',
    'Review specific file(s) in the project',
    '其他',
    '1/2',
    'Review scope',
    '取消',
    '下一个',
    '正在等待你的操作'
  ].join(' ');
  const driver = new DomDriver({
    send: async () => ({
      result: {
        value: {
          found: true,
          title: 'Review Scope',
          buttons: ['取消', '下一个'],
          options: [
            { label: 'Current workspace changes', description: 'Review uncommitted/staged changes in the workspace' },
            { label: 'Changes compared to a branch', description: 'Review diff against a specific branch (e.g., main, develop)' },
            { label: 'A specific MR/PR', description: 'Review a specific pull request by number' },
            { label: 'Specific files', description: 'Review specific file(s) in the project' },
            { label: '其他', description: '1/2 Review scope 取消 下一个 正在等待你的操作' }
          ],
          type: 'review_scope_question',
          isCommandExec: false,
          canAutoApprove: false,
          debugText: cardText
        }
      }
    })
  }, getConfig());

  const dialog = await driver.checkForApprovalDialog();

  assert.deepStrictEqual(dialog.options.slice(0, 4).map(option => option.label), [
    'Current workspace changes',
    'Changes compared to a branch',
    'A specific MR/PR',
    'Specific files'
  ]);
});

test('answerQuestionDialog selects a review scope option and advances', async () => {
  let calls = 0;
  const driver = new DomDriver({
    send: async () => {
      calls++;
      if (calls === 1) {
        return {
          result: {
            value: {
              found: true,
              title: 'Review Scope',
              buttons: ['取消', '下一个'],
              type: 'review_scope_question',
              isCommandExec: false,
              canAutoApprove: false
            }
          }
        };
      }
      if (calls === 2) {
        return {
          result: {
            value: {
              success: true,
              selectedOption: 'Uncommitted changes Review any uncommitted or staged workspace changes',
              buttonClicked: '下一个'
            }
          }
        };
      }
      return { result: { value: { found: false } } };
    }
  }, getConfig());

  const result = await driver.answerQuestionDialog('Uncommitted changes');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.action, 'answer');
  assert.strictEqual(result.buttonClicked, '下一个');
  assert.match(result.selectedOption, /Uncommitted changes/);
  assert.strictEqual(calls, 3);
});

test('newChat ignores empty review gate with zero pending files', async () => {
  const driver = new DomDriver({
    send: async () => ({ result: { value: null } })
  }, getConfig());
  let resolveCalled = false;
  let captures = 0;
  driver.checkTaskReviewGate = async () => ({ awaitingReview: true, reviewCount: 0 });
  driver.resolveTaskReviewGate = async () => {
    resolveCalled = true;
    return { success: false };
  };
  driver._captureIdePanelText = async () => (++captures === 1 ? 'old panel' : 'new panel');
  driver._waitForExpression = async () => true;
  driver.findNewChatButton = async () => null;

  const result = await driver.newChat();

  assert.strictEqual(resolveCalled, false);
  assert.strictEqual(result, true);
});

test('newChat accepts an already blank composer as a fresh conversation', async () => {
  let calls = 0;
  const driver = new DomDriver({
    send: async (method) => {
      calls += 1;
      assert.strictEqual(method, 'Runtime.evaluate');
      return { result: { value: true } };
    }
  }, getConfig());
  driver.checkTaskReviewGate = async () => ({ awaitingReview: false, reviewCount: 0 });
  driver._captureIdePanelText = async () => {
    throw new Error('already-fresh path must not compare panel text');
  };

  const result = await driver.newChat();

  assert.strictEqual(result, true);
  assert.strictEqual(calls, 1);
});

test('newChat verifies the standalone Agent draft and preserves unsent text', async () => {
  let selected = true;
  let clicks = 0;
  const composer = { getClientRects: () => [{}], textContent: '' };
  const draft = { getClientRects: () => selected ? [] : [{}] };
  const button = {
    getClientRects: () => [{}],
    click() { clicks++; selected = false; }
  };
  const document = {
    querySelector(selector) {
      if (selector === '.initial-chat-panel') return draft;
      if (selector === '.task-list-panel .taskItem.taskItemSelected') return selected ? {} : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.chat-input-v2-input-box-editable') return [composer];
      if (selector === '.task-list-panel .task-list-new-task-item:not(.task-list-skills-item)') return [button];
      return [];
    }
  };
  const driver = new DomDriver({
    async send(method, payload) {
      assert.strictEqual(method, 'Runtime.evaluate');
      return { result: { value: vm.runInNewContext(payload.expression, { document }) } };
    }
  }, getConfig(), { traeAdapter: { environment: { target: { workspaceKind: 'agent' } } } });
  driver.checkTaskReviewGate = async () => ({ awaitingReview: false, reviewCount: 0 });
  assert.strictEqual(await driver.newChat(), true);
  assert.strictEqual(selected, false);
  assert.strictEqual(await driver.newChat(), true);
  assert.strictEqual(clicks, 1);
  composer.textContent = 'Unsent draft';
  await assert.rejects(driver.newChat(), error => error.code === 'FRESH_CHAT_FAILED');
  assert.strictEqual(clicks, 1);
});

test('newChat clears a populated Trae 1.107 virtualized conversation', async () => {
  const composer = { getBoundingClientRect: () => ({ width: 300, height: 50 }), offsetParent: {} };
  const turn = { getBoundingClientRect: () => ({ width: 400, height: 100 }), offsetParent: {} };
  const document = {
    querySelectorAll(selector) {
      if (selector === '[contenteditable="true"]') return [composer];
      if (selector === '.virtualized-message-list-view__virtuoso .turn') return [turn];
      return [];
    }
  };
  const keyEvents = [];
  const driver = new DomDriver({
    async send(method, payload) {
      if (method === 'Runtime.evaluate') {
        return { result: { value: vm.runInNewContext(payload.expression, { document }) } };
      }
      assert.strictEqual(method, 'Input.dispatchKeyEvent');
      keyEvents.push(payload);
      return {};
    }
  }, { ...getConfig(), composerSelectors: ['[contenteditable="true"]'] });
  let captures = 0;
  driver.checkTaskReviewGate = async () => ({ awaitingReview: false, reviewCount: 0 });
  driver._captureIdePanelText = async () => (++captures === 1 ? 'previous task and response' : '');
  driver._waitForExpression = async () => true;
  driver.findNewChatButton = async () => null;
  driver._lastTaskText = 'previous response';
  driver._pendingUserTask = 'previous task';
  driver._preSendSnapshot = 'previous transcript';

  assert.strictEqual(await driver.newChat(), true);
  assert.deepStrictEqual(keyEvents.map(event => event.type), ['keyDown', 'keyUp']);
  assert.ok(captures >= 2);
  assert.strictEqual(driver._lastTaskText, '');
  assert.strictEqual(driver._pendingUserTask, '');
  assert.strictEqual(driver._preSendSnapshot, '');
});

test('extractLatestIdeAssistantState waits for assistant turn after latest user turn', () => {
  const driver = new DomDriver(null, getConfig());
  const state = driver._extractLatestIdeAssistantState({
    fullText: '旧回答 用户新问题',
    turns: [
      { className: 'chat-turn assistant task', text: '旧回答\\n任务完成' },
      { className: 'chat-turn user', text: '用户新问题' }
    ]
  }, '旧回答 任务完成');
  assert.strictEqual(state.awaitingAssistant, true);
  assert.strictEqual(state.inProgress, true);
  assert.strictEqual(state.latestUserText, '用户新问题');
});

test('extractLatestIdeAssistantState prefers assistant turn after latest user turn', () => {
  const driver = new DomDriver(null, getConfig());
  const state = driver._extractLatestIdeAssistantState({
    fullText: '用户新问题 Agent 正在分析问题',
    turns: [
      { className: 'chat-turn user', text: '用户新问题' },
      { className: 'chat-turn assistant task', text: 'Agent\\n正在分析问题' }
    ]
  }, '');
  assert.strictEqual(state.awaitingAssistant, undefined);
  assert.strictEqual(state.inProgress, true);
  assert.ok(state.text.includes('正在分析问题'));
});

test('extractLatestIdeAssistantState does not mark percentage progress as complete', () => {
  const driver = new DomDriver(null, getConfig());
  const state = driver._extractLatestIdeAssistantState({
    fullText: '用户新问题 Agent 正在处理 任务完成 16%',
    turns: [
      { className: 'chat-turn user', text: '用户新问题' },
      { className: 'chat-turn assistant task', text: 'Agent\n任务完成 16%' }
    ]
  }, '');

  assert.strictEqual(state.inProgress, true);
  assert.strictEqual(state.isComplete, false);
  assert.strictEqual(state.hasResponse, false);
});

test('extractLatestIdeAssistantState trusts the visible completed status over context usage percent', () => {
  const driver = new DomDriver(null, getConfig());
  const state = driver._extractLatestIdeAssistantState({
    fullText: '用户问题 Agent 思考过程 LIVE-UAT-READONLY-PASS 任务完成 9%',
    taskComplete: true,
    taskInProgress: false,
    turns: [
      { className: 'chat-turn user', text: '用户问题' },
      { className: 'chat-turn assistant task', text: 'Agent\n思考过程\nLIVE-UAT-READONLY-PASS\n任务完成\n9%' }
    ]
  }, '');

  assert.strictEqual(state.inProgress, false);
  assert.strictEqual(state.isComplete, true);
  assert.strictEqual(state.hasResponse, true);
});

test('extractLatestIdeAssistantState can return the full trace on explicit request', () => {
  const driver = new DomDriver(null, getConfig());
  const state = driver._extractLatestIdeAssistantState({
    fullText: '用户问题 Agent 思考过程 工具调用 完成总结 最终结果 任务完成',
    taskComplete: true,
    taskInProgress: false,
    turns: [
      { className: 'chat-turn user', text: '用户问题' },
      {
        className: 'chat-turn assistant task',
        text: 'Agent\n思考过程\n工具调用\n完成总结\n最终结果\n任务完成',
        finalText: '完成总结\n最终结果'
      }
    ]
  }, '', { detailLevel: 'trace' });

  assert.ok(state.text.includes('思考过程'));
  assert.ok(state.text.includes('工具调用'));
});

// Sanitized text and classes captured from TraeCN 1.107.1's IDE task surface.
const capturedWorkbenchNoise = '点击重启以更新点击重启以更新650 新任务⌃⌘N插件市场任务1未命名任务进行中21:56 资源管理器文件calculator.jscalculator.test.jspackage.json.monaco-list.list_id_1 .monaco-list-rows { background: var(--vscode-var(--vscode-panel-background---vscode-sidebar-background)); } .monaco-list.list_id_1:focus .monaco-list-row.focused { background-color: var(--vscode-list-focusBackground); } .monaco-list.list_id_1:focus .monaco-list-row.focused:hover { background-color: var(--vscode-list-focusBackground); } .theme-icube .monaco-list.list_id_1:fo';
const capturedFinishSummary = '测试已通过。注意：环境中的 Node 是 v24.13.0（无 Node 22 可用）。\n修改（calculator.js:4）：\nreturn unitPriceCents * quantity + shippingCents;\n测试结果：CALCULATOR_UAT_PASS: 3 cases\n三组断言均通过：1200*3+500=4100、875*4+0=3500、999*1+199=1198。';

function responseDomElement(tag, attributes = {}, text = '', children = []) {
  const element = {
    tagName: tag.toUpperCase(), className: attributes.class || '', parentElement: null,
    offsetParent: attributes.hidden ? null : {}, children,
    getAttribute: name => name === 'class' ? element.className : (attributes[name] ?? null),
    getBoundingClientRect: () => ({ width: 800, height: 400, y: 100 }),
    get textContent() { return text + children.map(child => child.textContent).join(''); },
    get innerText() { return tag === 'style' ? '' : text + children.map(child => child.innerText).join('\n'); },
    contains(node) { return node === element || children.some(child => child.contains(node)); },
    matches(selector) { return selector.split(',').some(part => responseDomMatches(element, part.trim())); },
    closest(selector) {
      for (let node = element; node; node = node.parentElement) if (node.matches(selector)) return node;
      return null;
    },
    querySelectorAll(selector) {
      const descendants = [];
      const walk = node => { for (const child of node.children) { descendants.push(child); walk(child); } };
      walk(element);
      return descendants.filter(node => node.matches(selector));
    },
    querySelector(selector) { return element.querySelectorAll(selector)[0] || null; }
  };
  children.forEach(child => { child.parentElement = element; });
  return element;
}

function responseDomMatches(element, selector) {
  const parts = selector.match(/(?:\[[^\]]+\]|[^\s])+/g) || [];
  const compoundMatches = (node, compound) => {
    const tag = compound.match(/^[a-z][\w-]*/i);
    if (tag && node.tagName !== tag[0].toUpperCase()) return false;
    const outsideAttributes = compound.replace(/\[[^\]]+\]/g, '');
    for (const match of outsideAttributes.matchAll(/\.([\w-]+)/g)) {
      if (!String(node.className).split(/\s+/).includes(match[1])) return false;
    }
    for (const match of compound.matchAll(/\[([\w-]+)(?:([*]?=)["']?([^\]"']*)["']?)?\]/g)) {
      const value = node.getAttribute(match[1]);
      if (value === null) return false;
      if (match[2] === '=' && value !== match[3]) return false;
      if (match[2] === '*=' && !String(value).includes(match[3])) return false;
    }
    return true;
  };
  if (!parts.length || !compoundMatches(element, parts.pop())) return false;
  let parent = element.parentElement;
  while (parts.length) {
    const compound = parts.pop();
    while (parent && !compoundMatches(parent, compound)) parent = parent.parentElement;
    if (!parent) return false;
    parent = parent.parentElement;
  }
  return true;
}

function capturedResponseFixture({
  finish = true, running = false, newUser = false, empty = false, panelSelectors = null, standalone = false,
  summaryText = capturedFinishSummary, sessionIds = [],
  prompt = '请修复 calculator.js，并运行 calculator.test.js，返回实际修改和测试结果。'
} = {}) {
  const node = responseDomElement;
  const summary = node('div', { class: 'markdown-renderer' }, summaryText);
  const finishCard = node('div', { class: 'agent-plan-item', 'data-toolcall-type': 'finish' }, '', [
    node('div', { class: 'core-finish-card' }, '', [node('div', { class: 'core-finish-card__summary' }, '', [summary])])
  ]);
  const userAttributes = standalone ? { class: 'turn__user-message', 'data-role': 'user' } : {};
  const userMessage = text => standalone ? node('div', userAttributes, '', [
    node('div', { class: 'user-message__text-content' }, text),
    node('div', { class: 'user-message__expand-float' }, '展开'),
    node('div', { class: 'user-message__bottom-bar' }, '14:07')
  ]) : node('div', userAttributes, text);
  const user = userMessage(prompt);
  const assistant = node('div', { class: 'turn__agent-message', 'data-role': 'assistant' }, '', [
    node('div', { class: 'agent-message__header' }, standalone ? 'TRAE' : 'Agent'),
    node('div', { class: 'todo-progress-content' }, '思考过程：已完成第一步，将继续检查。'),
    ...(finish ? [finishCard] : [node('div', { class: 'markdown-renderer' }, '已完成第一步，将继续检查。')]),
    ...(standalone ? [node('div', { class: 'agent-message' }, '由 AI 生成\n13%')] : [])
  ]);
  const turns = empty ? [] : [node('div', { class: newUser ? 'turn' : 'turn turn--last' }, '', [user, assistant])];
  if (newUser) turns.push(node('div', { class: 'turn turn--last' }, '', [
    userMessage('现在处理下一项授权修复。')
  ]));
  if (running) turns.push(node('span', { class: 'codicon-stop-circle' }));
  const viewport = node('div', { class: standalone ? 'standalone-view' : 'virtualized-message-list-view__virtuoso' }, '', turns);
  const sidebar = node('div', { class: 'task-list-panel' }, '', sessionIds.map(sessionId =>
    node('div', { class: 'task-list-row-wrapper', 'data-session-id': sessionId }, '', [
      node('div', { class: 'taskItem taskItemSelected' })
    ])
  ));
  const workbench = node('div', {
    class: 'monaco-workbench nopanel icube-ai-chat-commercial-popup-anchor', role: 'application'
  }, capturedWorkbenchNoise, [node('style', {}, '.monaco-list { background: var(--vscode-list-focusBackground); }'.repeat(20)), viewport, sidebar]);
  const body = node('body', {}, '', [workbench]);
  const html = node('html', {}, '', [body]);
  const document = {
    body, documentElement: html,
    querySelector: selector => html.querySelector(selector),
    querySelectorAll: selector => html.querySelectorAll(selector)
  };
  const config = { ...getConfig(), timeoutMs: 1000, pollIntervalMs: 1 };
  if (panelSelectors) config.ideTaskPanelSelectors = panelSelectors;
  const driver = new DomDriver({
    async send(method, payload) {
      if (method === 'Log.enable') return {};
      assert.strictEqual(method, 'Runtime.evaluate');
      const value = vm.runInNewContext(payload.expression, { document });
      return { result: { value: JSON.parse(JSON.stringify(value)) } };
    }, on() {}, off() {}
  }, config);
  driver.detectMode = async () => ({ mode: standalone ? 'solo' : 'ide' });
  if (standalone) driver.traeAdapter = { environment: { target: { workspaceKind: 'agent' } } };
  driver.checkForApprovalDialog = async () => ({ needsApproval: false });
  driver.checkTaskReviewGate = async () => ({ awaitingReview: false, taskCompleted: false });
  driver._pendingUserTask = prompt;
  return { driver, summary, assistant, workbench };
}

asyncTest('standalone Agent returns the short finish summary without UI or process text', async () => {
  const summaryText = 'TRAECN_UAT_OK_6NQ';
  const { driver, assistant } = capturedResponseFixture({ standalone: true, summaryText });
  const state = await driver._queryTaskSource('');
  assert.strictEqual(state.text, summaryText);
  assert.strictEqual(state.hasResponse, true);
  const result = await driver.collectResponse();
  assert.strictEqual(result.text, summaryText);
  assert.strictEqual(result.stable, true);
  assert.strictEqual(result.traceText, assistant.innerText.trim());
});

asyncTest('standalone Agent proves a final answer belongs to its exact native session and user prompt', async () => {
  const { driver } = capturedResponseFixture({
    standalone: true, sessionIds: ['session-a'], summaryText: 'Read-only check complete.',
    prompt: 'Inspect this test fixture.\n\nTRAECN_UAT_PROMPT_ONLY'
  });
  driver._pendingUserTask = 'A previously sent prompt';
  const expectedTask = 'Inspect  this test fixture. TRAECN_UAT_PROMPT_ONLY';
  const result = await driver.collectResponse({ expectedSessionId: 'session-a', expectedTask });
  assert.strictEqual(result.text, 'Read-only check complete.');
  assert.strictEqual(result.stable, true);
  assert.deepStrictEqual(result[NATIVE_TURN_OWNERSHIP], {
    sessionId: 'session-a', taskText: 'Inspect this test fixture. TRAECN_UAT_PROMPT_ONLY'
  });
  assert.strictEqual({ ...result }[NATIVE_TURN_OWNERSHIP], undefined);
  assert.ok(!JSON.stringify(result).includes('session-a'));
});

asyncTest('standalone Agent rejects missing or ambiguous native session and a mere prompt substring', async () => {
  const expectedTask = 'Inspect this fixture.';
  for (const fixtureOptions of [
    { sessionIds: [] },
    { sessionIds: ['session-b'] },
    { sessionIds: ['session-a', 'session-b'] },
    { sessionIds: ['session-a'], prompt: `Before that, ${expectedTask}` }
  ]) {
    const { driver } = capturedResponseFixture({ standalone: true, prompt: expectedTask, ...fixtureOptions });
    const state = await driver._pollResponseState({ expectedSessionId: 'session-a', expectedTask });
    assert.strictEqual(state.nativeOwnershipPending, true);
    assert.strictEqual(state.taskComplete, false);
    assert.strictEqual(state.taskText, '');
    assert.strictEqual(state.nativeTurnOwnership, undefined);
  }
});

asyncTest('standalone Agent never captures another session’s dialog or renderer log as task output', async () => {
  const { driver } = capturedResponseFixture({ standalone: true, sessionIds: ['session-b'], prompt: 'Inspect this fixture.' });
  driver.config.timeoutMs = 80;
  driver.client.on = (event, callback) => {
    if (event === 'Log.entryAdded') callback({ entry: { type: 'log', text: 'Other session log' } });
  };
  driver.checkForApprovalDialog = async () => assert.fail('Unbound session dialog was checked');
  const result = await driver.collectResponse({ expectedSessionId: 'session-a', expectedTask: 'Inspect this fixture.' });
  assert.strictEqual(result.timedOut, true);
  assert.strictEqual(result.text, '');
  assert.strictEqual(result[NATIVE_TURN_OWNERSHIP], undefined);
});

asyncTest('standalone Agent does not reuse an old finish summary across turns', async () => {
  const { driver } = capturedResponseFixture({ standalone: true, newUser: true });
  driver._pendingUserTask = '现在处理下一项授权修复。';
  const state = await driver._pollResponseState();
  assert.strictEqual(state.awaitingAssistant, true);
  assert.strictEqual(state.taskComplete, false);
  assert.strictEqual(state.taskText, '');
  assert.strictEqual(state.responseText, '');
});

asyncTest('standalone Agent waits if the latest visible user turn still belongs to an earlier prompt', async () => {
  const { driver } = capturedResponseFixture({ standalone: true });
  driver._pendingUserTask = '现在处理下一项授权修复。';
  const state = await driver._pollResponseState();
  assert.strictEqual(state.awaitingAssistant, true);
  assert.strictEqual(state.taskComplete, false);
  assert.strictEqual(state.taskText, '');
});

asyncTest('standalone Agent preserves the unfinished turn and a pending native approval', async () => {
  const { driver } = capturedResponseFixture({ standalone: true, finish: false });
  const state = await driver._pollResponseState();
  assert.strictEqual(state.taskInProgress, true);
  assert.strictEqual(state.taskComplete, false);
  assert.ok(state.taskText.includes('已完成第一步，将继续检查。'));
  let approvalChecks = 0;
  driver.checkForApprovalDialog = async () => (++approvalChecks > 1
    ? { needsApproval: true, dialogType: 'tool_confirmation', question: '是否允许运行命令？' }
    : { needsApproval: false });
  const result = await driver.collectResponse();
  assert.strictEqual(result.needsApproval, true);
  assert.strictEqual(result.question, '是否允许运行命令？');
  assert.strictEqual(result.stable, false);
});

asyncTest('bound native turn detects approval on the next response poll', async () => {
  const prompt = 'Inspect this fixture.';
  const { driver } = capturedResponseFixture({ standalone: true, finish: false, sessionIds: ['session-a'], prompt });
  driver.config.pollIntervalMs = 5;
  driver.config.approvalPollIntervalMs = 3000;
  driver.config.timeoutMs = 800;
  let polls = 0;
  const pollResponse = driver._pollResponseState.bind(driver);
  driver._pollResponseState = options => { polls++; return pollResponse(options); };
  driver.checkForApprovalDialog = async () => polls >= 2
    ? { needsApproval: true, dialogType: 'command_execution', command: 'echo fixture' }
    : { needsApproval: false };
  const result = await driver.collectResponse({ expectedSessionId: 'session-a', expectedTask: prompt });
  assert.strictEqual(result.needsApproval, true);
  assert.strictEqual(result.command, 'echo fixture');
  assert.strictEqual(polls, 2);
});

asyncTest('standalone Agent preserves line breaks and leading role words in the native final text', async () => {
  const summaryText = 'Agent configuration\n\n开始分析 is an example.';
  const { driver } = capturedResponseFixture({ standalone: true, summaryText });
  const result = await driver.collectResponse();
  assert.strictEqual(result.text, summaryText);
  assert.strictEqual(result.stable, true);
});

asyncTest('captured IDE DOM returns the current assistant finish summary instead of workbench CSS', async () => {
  const { driver, assistant } = capturedResponseFixture();
  const state = await driver._queryTaskSource('');
  assert.strictEqual(state.text, capturedFinishSummary);
  assert.strictEqual(state.traceText, assistant.innerText.trim());
  assert.strictEqual(state.isComplete, true);
  assert.strictEqual(state.inProgress, false);
  assert.ok(!state.text.includes('.monaco-list'));
});

asyncTest('captured IDE DOM preserves the assistant trace only when requested', async () => {
  const { driver } = capturedResponseFixture();
  const state = await driver._queryTaskSource('', { detailLevel: 'trace' });
  assert.ok(state.text.includes('思考过程'));
  assert.ok(state.text.includes('v24.13.0'));
  assert.ok(!state.text.includes('点击重启以更新'));
});

asyncTest('captured IDE DOM waits at a newer turn without an assistant instead of reusing an old finish card', async () => {
  const { driver } = capturedResponseFixture({ newUser: true });
  const state = await driver._pollResponseState();
  assert.strictEqual(state.awaitingAssistant, true);
  assert.strictEqual(state.taskComplete, false);
  assert.strictEqual(state.responseText, '');
  assert.strictEqual(state.traceText, undefined);
});

asyncTest('captured IDE DOM does not equate an ordinary assistant message with task completion', async () => {
  const { driver } = capturedResponseFixture({ finish: false });
  const state = await driver._queryTaskSource('');
  assert.strictEqual(state.inProgress, true);
  assert.strictEqual(state.isComplete, false);
  assert.strictEqual(state.hasResponse, false);
  assert.strictEqual(state.traceText, undefined);
});

asyncTest('captured IDE DOM keeps a finish card pending while a visible stop control is active', async () => {
  const { driver } = capturedResponseFixture({ running: true });
  const state = await driver._queryTaskSource('');
  assert.strictEqual(state.inProgress, true);
  assert.strictEqual(state.isComplete, false);
  assert.strictEqual(state.traceText, undefined);
});

asyncTest('captured empty message viewport cannot complete from surrounding workbench text', async () => {
  const { driver } = capturedResponseFixture({ empty: true });
  const state = await driver._pollResponseState();
  assert.strictEqual(state.awaitingAssistant, true);
  assert.strictEqual(state.taskText, '');
  assert.strictEqual(state.responseText, '');
});

asyncTest('IDE capture rejects the observed workbench class-substring false match even when configured', async () => {
  const { driver, workbench } = capturedResponseFixture({ panelSelectors: ['[class*="panel"][class*="chat"]'] });
  assert.strictEqual(workbench.matches('[class*="panel"][class*="chat"]'), true);
  assert.strictEqual(await driver._queryIdeTaskPanel(''), null);
  assert.strictEqual(await driver._captureIdePanelText(), '');
});

asyncTest('collectResponse uses the captured finish summary and preserves its actual Node version', async () => {
  const { driver, assistant } = capturedResponseFixture();
  const result = await driver.collectResponse();
  assert.strictEqual(result.stable, true);
  assert.strictEqual(result.text, capturedFinishSummary.replace(/\s+/g, ' ').trim());
  assert.ok(result.text.includes('v24.13.0'));
  assert.strictEqual(result.traceText, assistant.innerText.trim());
});

asyncTest('collectResponse exits a cancelled empty turn and removes its CDP listeners', async () => {
  const listeners = new Set();
  const config = getConfig();
  config.timeoutMs = 60000;
  const driver = new DomDriver({
    send: async () => ({}),
    on: name => listeners.add(name),
    off: name => listeners.delete(name)
  }, config);
  driver._ensureVisibleWindow = async () => {};
  driver.checkForApprovalDialog = async () => ({ needsApproval: false });
  driver.detectMode = async () => ({ mode: 'solo' });
  let cancelled = false;
  let polls = 0;
  driver._pollResponseState = async () => {
    polls++;
    await Promise.resolve();
    cancelled = true;
    return { awaitingAssistant: true, taskText: '' };
  };
  driver.checkTaskReviewGate = async () => { throw new Error('cancelled turn must not process another UI gate'); };
  const start = Date.now();
  const result = await driver.collectResponse({ shouldStop: () => cancelled });
  assert.strictEqual(result.cancelled, true);
  assert.strictEqual(result.stable, false);
  assert.strictEqual(result.text, '');
  assert.strictEqual(polls, 1);
  assert.strictEqual(listeners.size, 0);
  assert.ok(Date.now() - start < 1000, 'cancelled collection must not wait for the response timeout');
});

asyncTest('response polling carries the trace and final summary from the same captured assistant', async () => {
  const { driver, assistant } = capturedResponseFixture();
  const state = await driver._pollResponseState();
  assert.strictEqual(state.taskText, capturedFinishSummary);
  assert.strictEqual(state.taskComplete, true);
  assert.strictEqual(state.traceText, assistant.innerText.trim());
  assert.ok(!state.traceText.includes('.monaco-list'));
});

const capturedInterruptedPartial = 'Agent\n思考过程\nAll complete. Summary:\nImplementation\nrecovery-sum.js exports sumSafeIntegers(values).\nBarrier flow\nready.json written by wait-for-release.js (status BLOCKED_WAITING_FOR_ROOT_RELEASE, module';

function interruptedResponseFixture({
  mode = 'solo', legacy = false, statusText = '手动终止输出', statusHidden = false,
  previousInterrupted = false, finish = false, quoted = false, userOnly = false, embeddedStatus = false
} = {}) {
  const node = responseDomElement;
  const bar = (text, hidden = false) => node('div', { class: 'latest-assistant-bar latest-assistant-bar-stage-0', hidden }, '', [
    node('div', { class: 'latest-assistant-bar-left-part', hidden }, '', [
      node('div', { class: 'status', hidden }, '', [node('span', { class: 'status-text', hidden }, text)])
    ]),
    node('span', { hidden }, '19%')
  ]);
  const prompt = quoted ? '请解释“手动终止输出”并测试对应代码。' : 'Implement safe integer sum with tests.';
  const user = node('div', { class: legacy ? 'chat-turn user' : 'turn__user-message', 'data-role': 'user' }, prompt);
  const text = quoted ? '代码已完成：const label = "手动终止输出"; 断言全部通过。' : capturedInterruptedPartial;
  const summary = finish ? node('div', { class: 'core-finish-card__summary' }, '', [
    node('div', { class: 'markdown-renderer' }, text)
  ]) : node('div', { class: legacy ? 'chat-markdown' : 'markdown-renderer' }, text, embeddedStatus ? [bar('手动终止输出')] : []);
  const assistant = node('div', {
    class: legacy ? 'chat-turn assistant' : 'turn__agent-message', 'data-role': 'assistant'
  }, '', [summary, ...(statusText ? [bar(statusText, statusHidden)] : [])]);
  const oldAssistant = node('div', {
    class: legacy ? 'chat-turn assistant' : 'turn__agent-message', 'data-role': 'assistant'
  }, 'previous interrupted response', [bar('手动终止输出')]);
  const currentTurns = legacy
    ? [...(previousInterrupted ? [oldAssistant] : []), user, ...(userOnly ? [] : [assistant])]
    : [
        ...(previousInterrupted ? [node('div', { class: 'turn' }, '', [oldAssistant])] : []),
        node('div', { class: 'turn turn--last' }, '', [user, ...(userOnly ? [] : [assistant])])
      ];
  const sidebar = node('div', { class: 'soloaisidebar' }, '历史会话 任务中断', [
    node('div', { class: 'chat-turn assistant' }, 'previous sidebar assistant', [bar('手动终止输出')])
  ]);
  const viewport = node('div', { class: 'virtualized-message-list-view__virtuoso' }, '', currentTurns);
  const body = node('body', {}, '页面引用：手动终止输出', [sidebar, viewport]);
  const html = node('html', {}, '', [body]);
  const document = {
    body, documentElement: html,
    querySelector: selector => html.querySelector(selector),
    querySelectorAll: selector => html.querySelectorAll(selector)
  };
  const listeners = new Set();
  const expressions = [];
  const driver = new DomDriver({
    async send(method, payload) {
      if (method === 'Log.enable') return {};
      assert.strictEqual(method, 'Runtime.evaluate');
      expressions.push(payload.expression);
      const value = vm.runInNewContext(payload.expression, { document });
      return { result: { value: JSON.parse(JSON.stringify(value)) } };
    },
    on(name) { listeners.add(name); },
    off(name) { listeners.delete(name); }
  }, { ...getConfig(), timeoutMs: 1000, pollIntervalMs: 1 });
  driver.detectMode = async () => ({ mode });
  driver.checkForApprovalDialog = async () => ({ needsApproval: false });
  driver.checkTaskReviewGate = async () => ({ awaitingReview: false, taskCompleted: false });
  driver._pendingUserTask = prompt;
  return { driver, listeners, expressions };
}

asyncTest('current assistant interruption detects the observed native SOLO status bar', async () => {
  const { driver } = interruptedResponseFixture();
  const state = await driver._queryTaskSource('');
  assert.strictEqual(state.interrupted, true);
  assert.strictEqual(state.inProgress, false);
  assert.strictEqual(state.isComplete, false);
  assert.strictEqual(state.hasResponse, false);
  assert.strictEqual(state.traceText, undefined);
  assert.ok(state.text.includes('BLOCKED_WAITING_FOR_ROOT_RELEASE'));
});

asyncTest('current assistant interruption detects a legacy SOLO assistant status bar', async () => {
  const { driver } = interruptedResponseFixture({ legacy: true });
  const state = await driver._queryTaskSource('');
  assert.strictEqual(state.interrupted, true);
  assert.strictEqual(state.inProgress, false);
  assert.strictEqual(state.isComplete, false);
  assert.strictEqual(state.hasResponse, false);
});

asyncTest('current assistant interruption ignores previous assistant and sidebar status bars', async () => {
  for (const legacy of [false, true]) {
    const { driver } = interruptedResponseFixture({ previousInterrupted: true, statusText: '', legacy });
    const state = await driver._queryTaskSource('');
    assert.notStrictEqual(state.interrupted, true);
    assert.ok(!state.text.includes('previous interrupted response'));
  }
});

asyncTest('current assistant interruption does not complete from an interrupted previous turn after a new user', async () => {
  const { driver } = interruptedResponseFixture({ previousInterrupted: true, userOnly: true, quoted: true });
  const state = await driver._pollResponseState();
  assert.strictEqual(state.awaitingAssistant, true);
  assert.notStrictEqual(state.interrupted, true);
  assert.strictEqual(state.taskText, '');
});

asyncTest('current assistant interruption ignores quoted user text and completed code mentioning termination', async () => {
  const { driver } = interruptedResponseFixture({ finish: true, quoted: true, statusText: '任务完成' });
  const state = await driver._queryTaskSource('');
  assert.notStrictEqual(state.interrupted, true);
  assert.strictEqual(state.isComplete, true);
  assert.strictEqual(state.hasResponse, true);
  const result = await driver.collectResponse();
  assert.strictEqual(result.stable, true);
  assert.notStrictEqual(result.interrupted, true);
  assert.ok(result.text.includes('const label = "手动终止输出"'));
});

asyncTest('current assistant interruption requires a visible exact native status label', async () => {
  for (const options of [{ statusHidden: true }, { statusText: '手动终止输出（示例）' }]) {
    const { driver } = interruptedResponseFixture(options);
    const state = await driver._queryTaskSource('');
    assert.notStrictEqual(state.interrupted, true);
  }
});

asyncTest('current assistant interruption ignores status-shaped HTML rendered inside assistant markdown', async () => {
  for (const legacy of [false, true]) {
    const { driver } = interruptedResponseFixture({ statusText: '', embeddedStatus: true, legacy });
    const state = await driver._queryTaskSource('');
    assert.notStrictEqual(state.interrupted, true);
  }
});

asyncTest('current assistant interruption polling excludes unrelated body text and completed traces', async () => {
  const { driver } = interruptedResponseFixture();
  driver._scanContentArea = async () => { throw new Error('interrupted turn must not scan unrelated content'); };
  driver._captureVisibleText = async () => { throw new Error('interrupted turn must not scan the page body'); };
  const state = await driver._pollResponseState();
  assert.strictEqual(state.interrupted, true);
  assert.strictEqual(state.taskComplete, false);
  assert.strictEqual(state.taskInProgress, false);
  assert.strictEqual(state.responseText, '');
  assert.strictEqual(state.traceText, undefined);
});

asyncTest('current assistant interruption collection returns a failure promptly and removes its listeners', async () => {
  const { driver, listeners } = interruptedResponseFixture();
  let gateChecks = 0;
  let gateActions = 0;
  driver.checkTaskReviewGate = async () => {
    gateChecks++;
    return { awaitingReview: true, taskCompleted: true };
  };
  driver.resolveTaskReviewGate = async () => { gateActions++; return { success: true }; };
  const result = await driver.collectResponse();
  assert.strictEqual(result.stable, false);
  assert.strictEqual(result.interrupted, true);
  assert.match(result.error, /interrupted/i);
  assert.ok(result.elapsedMs < driver.config.timeoutMs);
  assert.strictEqual(result.timedOut, undefined);
  assert.strictEqual(result.traceText, undefined);
  assert.strictEqual(gateChecks, 0);
  assert.strictEqual(gateActions, 0);
  assert.strictEqual(listeners.size, 0);
});

asyncTest('current assistant interruption keeps cancellation ahead of a detected native stop', async () => {
  const { driver, listeners } = interruptedResponseFixture();
  let cancelled = false;
  const originalPoll = driver._pollResponseState.bind(driver);
  driver._pollResponseState = async () => {
    const state = await originalPoll();
    cancelled = true;
    return state;
  };
  const result = await driver.collectResponse({ shouldStop: () => cancelled });
  assert.strictEqual(result.cancelled, true);
  assert.strictEqual(result.stable, false);
  assert.strictEqual(result.interrupted, undefined);
  assert.strictEqual(listeners.size, 0);
});

test('local legacy transcript compaction recognizes a standalone Chinese finish heading', () => {
  const transcript = 'Agent\n思考过程\n工具调用和中间步骤\n完成总结\n最终改动和测试结果\n任务完成';
  assert.strictEqual(cleanAssistantResultText(transcript), '完成总结\n最终改动和测试结果');
});

test('local compaction retains ordinary sentences mentioning the Chinese finish heading', () => {
  const text = '保留工具输出。\n这次完成总结需要包含思考过程的可见记录。\n最终结论保持完整。';
  assert.strictEqual(cleanAssistantResultText(text), text);
});

asyncTest('collectResponse resolves the current finish-card review without a body completion label', async () => {
  const { driver, assistant } = capturedResponseFixture();
  driver.config.postActionDelayMs = 0;
  let reviewPending = true;
  const actions = [];
  driver.checkTaskReviewGate = async () => ({
    awaitingReview: reviewPending, taskCompleted: false, reviewCount: 1
  });
  driver.resolveTaskReviewGate = async action => {
    actions.push(action);
    reviewPending = false;
    return { success: true };
  };

  const result = await driver.collectResponse();

  assert.deepStrictEqual(actions, ['keep_all']);
  assert.strictEqual(result.stable, true);
  assert.strictEqual(reviewPending, false);
  assert.strictEqual(result.text, capturedFinishSummary.replace(/\s+/g, ' ').trim());
  assert.strictEqual(result.traceText, assistant.innerText.trim());
});

asyncTest('collectResponse keeps an unresolved finish-card review pending and retries the same result', async () => {
  for (const taskCompleted of [false, true]) {
    const { driver, assistant } = capturedResponseFixture();
    driver.config.postActionDelayMs = 0;
    let resolved = false;
    const actions = [];
    driver.checkTaskReviewGate = async () => ({
      awaitingReview: !resolved, taskCompleted, reviewCount: 1
    });
    driver.resolveTaskReviewGate = async action => {
      actions.push(action);
      if (actions.length === 1) return { success: false, reason: 'review_gate_persisted' };
      resolved = true;
      return { success: true };
    };

    const pending = await driver.collectResponse();
    assert.strictEqual(pending.stable, false);
    assert.strictEqual(pending.reviewGatePending, true);
    assert.strictEqual(pending.timedOut, false);
    assert.strictEqual(pending.traceText, undefined);
    assert.strictEqual(pending.text, capturedFinishSummary.replace(/\s+/g, ' ').trim());
    assert.deepStrictEqual(actions, ['keep_all']);

    const result = await driver.collectResponse();
    assert.strictEqual(result.stable, true);
    assert.strictEqual(result.reviewGatePending, undefined);
    assert.strictEqual(result.text, pending.text);
    assert.strictEqual(result.traceText, assistant.innerText.trim());
    assert.deepStrictEqual(actions, ['keep_all', 'keep_all']);
  }
});

asyncTest('collectResponse does not resolve a review from historical body completion while the current turn is running', async () => {
  const { driver } = capturedResponseFixture({ finish: false });
  let resolutions = 0;
  driver.checkTaskReviewGate = async () => ({ awaitingReview: true, taskCompleted: true, reviewCount: 1 });
  driver.resolveTaskReviewGate = async () => {
    resolutions++;
    return { success: false, reason: 'review_gate_persisted' };
  };

  const result = await driver.collectResponse();

  assert.strictEqual(resolutions, 0);
  assert.strictEqual(result.stable, false);
  assert.strictEqual(result.traceText, undefined);
});

asyncTest('collectResponse does not resolve a review for a stale finish summary', async () => {
  const { driver } = capturedResponseFixture();
  driver._preSendSnapshot = capturedFinishSummary.replace(/\s+/g, ' ').trim();
  let resolutions = 0;
  driver.checkTaskReviewGate = async () => ({ awaitingReview: true, taskCompleted: true, reviewCount: 1 });
  driver.resolveTaskReviewGate = async () => {
    resolutions++;
    return { success: false, reason: 'review_gate_persisted' };
  };

  const result = await driver.collectResponse();

  assert.strictEqual(resolutions, 0);
  assert.strictEqual(result.stable, false);
  assert.strictEqual(result.traceText, undefined);
});

asyncTest('collectResponse preserves the completed SOLO task route when resolving review', async () => {
  const { driver } = capturedResponseFixture();
  driver.config.postActionDelayMs = 0;
  driver.detectMode = async () => ({ mode: 'solo' });
  driver._pollResponseState = async () => ({
    taskComplete: true, taskInProgress: false,
    taskText: 'Agent 修改和测试已完成，三个断言均通过。任务完成', responseText: ''
  });
  const actions = [];
  driver.checkTaskReviewGate = async () => ({ awaitingReview: actions.length === 0, taskCompleted: false, reviewCount: 1 });
  driver.resolveTaskReviewGate = async action => { actions.push(action); return { success: true }; };

  const result = await driver.collectResponse();

  assert.deepStrictEqual(actions, ['keep_all']);
  assert.strictEqual(result.stable, true);
  assert.strictEqual(result.text, '修改和测试已完成，三个断言均通过。');
});

asyncTest('collectResponse does not finish the captured ordinary message merely because no stop button exists', async () => {
  const { driver } = capturedResponseFixture({ finish: false });
  const result = await driver.collectResponse();
  assert.strictEqual(result.stable, false);
  assert.strictEqual(result.timedOut, true);
});

test('extractLatestIdeAssistantState retains an observed running flag without recognized turns', () => {
  const driver = new DomDriver(null, getConfig());
  const state = driver._extractLatestIdeAssistantState({
    fullText: capturedWorkbenchNoise, turns: [], taskInProgress: true, taskComplete: false
  }, '');
  assert.strictEqual(state.inProgress, true);
  assert.strictEqual(state.isComplete, false);
});

asyncTest('queryTaskSource reads the current Solo assistant turn instead of an older sidebar row', async () => {
  const driver = new DomDriver({
    async send(method, payload) {
      assert.strictEqual(method, 'Runtime.evaluate');
      if (payload.expression.includes('var sels =')) {
        return {
          result: {
            value: {
              fullText: '当前验收 LIVE-UAT-READONLY-PASS 任务完成',
              taskComplete: true,
              taskInProgress: false,
              turns: [
                { className: 'chat-turn user', text: '当前验收' },
                { className: 'chat-turn assistant task', text: 'LIVE-UAT-READONLY-PASS\n任务完成' }
              ]
            }
          }
        };
      }
      return {
        result: {
          value: {
            text: '昨天的任务 任务完成',
            inProgress: false,
            isComplete: true,
            hasResponse: true
          }
        }
      };
    }
  }, getConfig());
  driver.detectMode = async () => ({ mode: 'solo' });

  const state = await driver._queryTaskSource('');

  assert.ok(state.text.includes('LIVE-UAT-READONLY-PASS'));
});

asyncTest('queryTaskSource reads top-level Solo chat turns before panel fallbacks', async () => {
  const driver = new DomDriver({
    async send(method, payload) {
      assert.strictEqual(method, 'Runtime.evaluate');
      if (payload.expression.includes('soloTopLevelTurns')) {
        return {
          result: {
            value: {
              soloTopLevelTurns: true,
              fullText: '当前用户请求 Agent MCP 更新完成 测试结果 任务完成',
              taskComplete: true,
              taskInProgress: false,
              turns: [
                { className: 'chat-turn user', text: '当前用户请求' },
                { className: 'chat-turn assistant', text: 'Agent\nMCP 更新完成\n测试结果\n任务完成' }
              ]
            }
          }
        };
      }
      return { result: { value: null } };
    }
  }, getConfig());
  driver.detectMode = async () => ({ mode: 'solo' });

  const state = await driver._queryTaskSource('');

  assert.ok(state.text.includes('MCP 更新完成'));
  assert.strictEqual(state.hasResponse, true);
  assert.strictEqual(state.isComplete, true);
});

asyncTest('queryTaskSource returns the final Solo markdown instead of the folded process transcript', async () => {
  const driver = new DomDriver({
    async send(method, payload) {
      assert.strictEqual(method, 'Runtime.evaluate');
      if (!payload.expression.includes('soloTopLevelTurns')) return { result: { value: null } };
      assert.doesNotThrow(() => new Function(`return ${payload.expression}`));
      return {
        result: {
          value: {
            soloTopLevelTurns: true,
            fullText: '当前请求 Agent 思考过程 大量工具调用 完成总结 最终结果 任务完成',
            taskComplete: true,
            taskInProgress: false,
            turns: [
              { className: 'chat-turn user', text: '当前请求' },
              {
                className: 'chat-turn assistant',
                text: 'Agent\n思考过程\n大量工具调用\n完成总结\n最终结果\n任务完成',
                finalText: '完成总结\n这是只包含最终结论、改动文件和测试结果的完整回复。'
              }
            ]
          }
        }
      };
    }
  }, getConfig());
  driver.detectMode = async () => ({ mode: 'solo' });

  const state = await driver._queryTaskSource('');

  assert.strictEqual(state.text, '完成总结\n这是只包含最终结论、改动文件和测试结果的完整回复。');
  assert.strictEqual(state.hasResponse, true);
});

test('isIncompleteResponseText treats skill invocation preamble as incomplete', () => {
  const driver = new DomDriver(null, getConfig());
  assert.strictEqual(driver._isIncompleteResponseText('Agent'), true);
  assert.strictEqual(driver._isIncompleteResponseText('Thought'), true);
  assert.strictEqual(
    driver._isIncompleteResponseText("I'll start by invoking the relevant code review skill, then explore the project structure.调用技能: TRAE-code-review"),
    true
  );
  assert.strictEqual(
    driver._isIncompleteResponseText('[P1] src/http/gateway.js: restart recovery can time out\\n问题: ...\\n建议: ...'),
    false
  );
  assert.strictEqual(
    driver._isIncompleteResponseText('SOLO Agent思考中...The user explicitly asked for a marker'),
    true
  );
  assert.strictEqual(
    driver._isIncompleteResponseText('SOLO Agent思考中...The user is asking for a complete code review of the project at /Users/Shared/projects/TRAECNclaw. Then list'),
    true
  );
  assert.strictEqual(
    driver._isIncompleteResponseText('调用技能: TRAE-code-reviewThoughtNow I have the code review skill loaded. Let me start by exploring the project structure to understand what we are working with. '.repeat(6)),
    true
  );
});

test('isModelErrorResponseText detects Trae model provider failures', () => {
  const driver = new DomDriver(null, getConfig());
  assert.strictEqual(
    driver._isModelErrorResponseText('Agent\n模型请求失败，点击右侧箭头展开模型服务商错误信息进行排查。\n异常打断'),
    true
  );
  assert.strictEqual(
    driver._isModelErrorResponseText('Agent\n今日对话额度已耗尽。你可以等待至 2026-07-24 凌晨 0 点（北京时间）额度重置。'),
    true
  );
  assert.strictEqual(driver._isModelErrorResponseText('Findings:\\n[P2] no model issue'), false);
});

test('collectResponse returns mid-stream approval without currentText initialization error', async () => {
  const config = getConfig();
  config.timeoutMs = 200;
  config.pollIntervalMs = 10;
  config.approvalPollIntervalMs = 0;
  const driver = new DomDriver({
    send: async () => {},
    on: () => {},
    off: () => {}
  }, config);
  let approvalChecks = 0;
  driver.detectMode = async () => ({ mode: 'solo', confidence: 0.9, indicators: [] });
  driver._pollResponseState = async () => ({
    taskComplete: false,
    taskText: '排队中',
    taskInProgress: false,
    responseText: ''
  });
  driver.checkTaskReviewGate = async () => ({ awaitingReview: false, taskCompleted: false });
  driver.checkForApprovalDialog = async () => {
    approvalChecks++;
    return approvalChecks === 1
      ? { needsApproval: false }
      : {
          needsApproval: true,
          question: '批准执行命令?',
          dialogType: 'command_execution',
          buttons: ['运行'],
          isCommandExec: true,
          canAutoApprove: false,
          approvalDecision: 'agent_review',
          commandRisk: 'high',
          riskReasons: ['git_write_or_remote'],
          command: 'git push origin main'
        };
  };

  const result = await driver.collectResponse();
  assert.strictEqual(result.needsApproval, true);
  assert.strictEqual(result.dialogType, 'command_execution');
  assert.strictEqual(result.approvalDecision, 'agent_review');
  assert.strictEqual(result.commandRisk, 'high');
  assert.deepStrictEqual(result.riskReasons, ['git_write_or_remote']);
  assert.strictEqual(result.command, 'git push origin main');
  assert.ok(typeof result.text === 'string');
});

test('collectResponse exposes command metadata when approval is already pending', async () => {
  const driver = new DomDriver(null, getConfig());
  driver.checkForApprovalDialog = async () => ({
    needsApproval: true,
    question: '批准执行命令?',
    dialogType: 'command_execution',
    buttons: ['运行'],
    isCommandExec: true,
    canAutoApprove: false,
    approvalDecision: 'agent_review',
    commandRisk: 'low',
    riskReasons: ['explicit_command_review_required'],
    command: 'git status'
  });

  const result = await driver.collectResponse();
  assert.strictEqual(result.approvalDecision, 'agent_review');
  assert.strictEqual(result.commandRisk, 'low');
  assert.deepStrictEqual(result.riskReasons, ['explicit_command_review_required']);
  assert.strictEqual(result.command, 'git status');
});

test('collectResponse never auto-approves a command card from legacy adapter metadata', async () => {
  const config = getConfig();
  config.timeoutMs = 200;
  config.pollIntervalMs = 10;
  config.approvalPollIntervalMs = 1;
  config.approvalTimeoutMs = 1;
  const driver = new DomDriver({
    send: async () => {},
    on: () => {},
    off: () => {}
  }, config);
  let approveCalls = 0;
  let approvalChecks = 0;
  driver.detectMode = async () => ({ mode: 'solo', confidence: 0.9, indicators: [] });
  driver._pollResponseState = async () => ({
    taskComplete: false,
    taskText: '等待命令审批',
    taskInProgress: false,
    responseText: ''
  });
  driver.checkTaskReviewGate = async () => ({ awaitingReview: false, taskCompleted: false });
  driver.checkForApprovalDialog = async () => {
    approvalChecks++;
    return approvalChecks === 1
      ? { needsApproval: false }
      : {
          needsApproval: true,
          question: '批准执行命令?',
          dialogType: 'command_execution',
          buttons: ['运行'],
          isCommandExec: true,
          canAutoApprove: true,
          approvalDecision: 'auto_approve',
          commandRisk: 'low',
          riskReasons: ['legacy_read_only_allowlist'],
          command: 'cat .env'
        };
  };
  driver.approveDialog = async () => {
    approveCalls++;
    return { success: false };
  };

  const result = await driver.collectResponse();
  assert.strictEqual(approveCalls, 0);
  assert.strictEqual(result.needsApproval, true);
  assert.strictEqual(result.command, 'cat .env');
});

test('collectResponse strips IDE role and completion wrappers', async () => {
  const config = getConfig();
  config.timeoutMs = 200;
  config.pollIntervalMs = 10;
  config.approvalPollIntervalMs = 0;
  const driver = new DomDriver({
    send: async () => {},
    on: () => {},
    off: () => {}
  }, config);
  driver.detectMode = async () => ({ mode: 'ide', confidence: 0.9, indicators: ['ide'] });
  driver._pollResponseState = async () => ({
    taskComplete: true,
    taskText: 'Agent\n思考过程\n\nTRAECN_REAL_UAT_OK_20260612B\n\n任务完成',
    taskInProgress: true,
    responseText: ''
  });
  driver.checkTaskReviewGate = async () => ({ awaitingReview: false, taskCompleted: false });
  driver.checkForApprovalDialog = async () => ({ needsApproval: false });

  const result = await driver.collectResponse();
  assert.strictEqual(result.stable, true);
  assert.strictEqual(result.text, 'TRAECN_REAL_UAT_OK_20260612B');
});

test('collectResponse extracts final report from completed GLM process transcript', async () => {
  const config = getConfig();
  config.timeoutMs = 200;
  config.pollIntervalMs = 10;
  config.approvalPollIntervalMs = 0;
  const driver = new DomDriver({
    send: async () => {},
    on: () => {},
    off: () => {}
  }, config);
  driver.detectMode = async () => ({ mode: 'ide', confidence: 0.9, indicators: ['ide'] });
  driver._pollResponseState = async () => ({
    taskComplete: true,
    taskText: [
      'Agent',
      '思考过程',
      '调用技能: TRAE-code-review',
      'ThoughtNow I have the code review skill loaded. Let me start by exploring the project structure.',
      'Command: rg -n "collectResponse|dialog|queue"',
      'Review complete. I have enough evidence to produce the final report.',
      '',
      'TRAECNclaw Code Review — Findings First',
      '',
      'Findings:',
      '[P1] src/cdp/dom-driver.js: completed process transcript was misread as incomplete',
      '问题: final report was present but hidden behind process logs.',
      '建议: extract the final report marker before incomplete-response checks.',
      '',
      '任务完成'
    ].join('\n'),
    taskInProgress: true,
    responseText: 'Use GLM-5.2 to review TRAECNclaw and return Findings First.'
  });
  driver.checkTaskReviewGate = async () => ({ awaitingReview: false, taskCompleted: false });
  driver.checkForApprovalDialog = async () => ({ needsApproval: false });

  const result = await driver.collectResponse();
  assert.strictEqual(result.stable, true);
  assert.ok(result.text.startsWith('TRAECNclaw Code Review — Findings First'));
  assert.ok(result.text.includes('[P1] src/cdp/dom-driver.js'));
  assert.ok(!result.text.includes('调用技能'));
  assert.ok(!result.text.includes('ThoughtNow'));
  assert.ok(!result.text.endsWith('任务完成'));
});

test('collectResponse waits past IDE prompt echo before final assistant text', async () => {
  const config = getConfig();
  config.timeoutMs = 500;
  config.pollIntervalMs = 10;
  config.approvalPollIntervalMs = 0;
  const driver = new DomDriver({
    send: async () => {},
    on: () => {},
    off: () => {}
  }, config);
  let polls = 0;
  driver.detectMode = async () => ({ mode: 'ide', confidence: 0.9, indicators: ['ide'] });
  driver._pollResponseState = async () => {
    polls++;
    if (polls === 1) {
      return {
        taskComplete: true,
        taskText: '',
        taskInProgress: false,
        responseText: '09:20 用户 演示任务：请只回复 TRAECN_DEMO_OK_20260613，不要输出其它内容。Agent'
      };
    }
    return {
      taskComplete: true,
      taskText: 'Agent\n思考过程\n\nTRAECN_DEMO_OK_20260613\n\n任务完成',
      taskInProgress: true,
      responseText: ''
    };
  };
  driver.checkTaskReviewGate = async () => ({ awaitingReview: false, taskCompleted: false });
  driver.checkForApprovalDialog = async () => ({ needsApproval: false });

  const result = await driver.collectResponse();
  assert.strictEqual(result.stable, true);
  assert.strictEqual(result.text, 'TRAECN_DEMO_OK_20260613');
});

test('stopGeneration clicks visible stop button', async () => {
  const driver = new DomDriver({
    send: async (method, params) => {
      assert.strictEqual(method, 'Runtime.evaluate');
      assert.ok(params.expression.includes('codicon-stop-circle'));
      return { result: { value: { success: true, reason: 'clicked_stop_button' } } };
    }
  }, { ...getConfig(), postActionDelayMs: 0 });
  const result = await driver.stopGeneration();
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.reason, 'clicked_stop_button');
});

test('switchModel busy guard ignores stale body-only generating text', async () => {
  let currentModelCalls = 0;
  let busyExpression = '';
  const driver = new DomDriver({
    send: async (method, params) => {
      assert.strictEqual(method, 'Runtime.evaluate');
      if (params.expression.includes('stopIcon')) {
        busyExpression = params.expression;
        return { result: { value: { busy: false } } };
      }
      if (params.expression.includes('var all = Array.from')) {
        return { result: { value: 1 } };
      }
      if (params.expression.includes('modeItem')) {
        return { result: { value: 'auto mode already off' } };
      }
      if (params.expression.includes('targetName')) {
        return { result: { value: 'clicked: GLM-5.2 at index 0' } };
      }
      if (params.expression.includes('[role="alert"]')) {
        return { result: { value: '' } };
      }
      throw new Error('Unexpected Runtime.evaluate expression');
    }
  }, { ...getConfig(), postActionDelayMs: 0 });
  driver.getCurrentModel = async () => {
    currentModelCalls++;
    return currentModelCalls === 1 ? 'Doubao-1.5' : 'GLM-5.2';
  };

  const result = await driver.switchModel('GLM-5.2');
  assert.strictEqual(result.success, true);
  assert.ok(busyExpression.includes('stopIcon'));
  assert.ok(!busyExpression.includes('document.body'));
});

test('switchModel busy guard blocks when live stop state is visible', async () => {
  const driver = new DomDriver({
    send: async (method, params) => {
      assert.strictEqual(method, 'Runtime.evaluate');
      assert.ok(params.expression.includes('stopIcon'));
      return { result: { value: { busy: true, reason: 'generating' } } };
    }
  }, { ...getConfig(), postActionDelayMs: 0 });
  driver.getCurrentModel = async () => 'Doubao-1.5';

  const result = await driver.switchModel('GLM-5.2');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.switchResult, 'model_switch_blocked: generating');
  assert.strictEqual(result.error, 'generating');
});

test('model normalization preserves formal-edition identity', () => {
  assert.notStrictEqual(
    _normalizeModelName('DeepSeek-V4-Pro 正式版'),
    _normalizeModelName('DeepSeek-V4-Pro')
  );
});

test('switchModel recognizes Seed models in the live picker', async () => {
  let currentModelCalls = 0;
  const driver = new DomDriver({
    send: async (method, params) => {
      assert.strictEqual(method, 'Runtime.evaluate');
      if (params.expression.includes('stopIcon')) return { result: { value: { busy: false } } };
      if (params.expression.includes('var all = Array.from')) {
        assert.ok(params.expression.includes('/Seed|Doubao'));
        return { result: { value: 1 } };
      }
      if (params.expression.includes('modeItem')) return { result: { value: 'auto mode already off' } };
      if (params.expression.includes('targetName')) {
        assert.ok(params.expression.includes('/Seed|Doubao'));
        return { result: { value: 'clicked: Seed-2.1-Pro at index 0' } };
      }
      if (params.expression.includes('[role="alert"]')) return { result: { value: '' } };
      throw new Error('Unexpected Runtime.evaluate expression');
    }
  }, { ...getConfig(), postActionDelayMs: 0 });
  driver.getCurrentModel = async () => (++currentModelCalls === 1 ? 'DeepSeek-V4-Flash' : 'Seed-2.1-Pro');

  const result = await driver.switchModel('Seed-2.1-Pro');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.model, 'Seed-2.1-Pro');
});

test('switchModel ignores unrelated upgrade prompts elsewhere on the page', async () => {
  let currentModelCalls = 0;
  const driver = new DomDriver({
    send: async (method, params) => {
      assert.strictEqual(method, 'Runtime.evaluate');
      if (params.expression.includes('stopIcon')) return { result: { value: { busy: false } } };
      if (params.expression.includes('var all = Array.from')) return { result: { value: 1 } };
      if (params.expression.includes('modeItem')) return { result: { value: 'auto mode already off' } };
      if (params.expression.includes('targetName')) return { result: { value: 'clicked: GLM-5.2 at index 0' } };
      if (params.expression.includes('[role="alert"]')) {
        return {
          result: {
            value: vm.runInNewContext(params.expression, {
              document: {
                body: { innerText: '排队提醒 当前模型请求量较高 升级权益' },
                querySelectorAll: () => []
              },
              getComputedStyle: () => ({ visibility: 'visible', display: 'block' })
            })
          }
        };
      }
      throw new Error('Unexpected Runtime.evaluate expression');
    }
  }, { ...getConfig(), postActionDelayMs: 0 });
  driver.getCurrentModel = async () => (++currentModelCalls === 1 ? 'Doubao-1.5' : 'GLM-5.2');

  const result = await driver.switchModel('GLM-5.2');

  assert.strictEqual(result.success, true);
});

test('switchModel surfaces a membership notice containing whitespace', async () => {
  const driver = new DomDriver({
    send: async (method, params) => {
      assert.strictEqual(method, 'Runtime.evaluate');
      if (params.expression.includes('stopIcon')) return { result: { value: { busy: false } } };
      if (params.expression.includes('var all = Array.from')) return { result: { value: 1 } };
      if (params.expression.includes('modeItem')) return { result: { value: 'auto mode already off' } };
      if (params.expression.includes('targetName')) return { result: { value: 'clicked: Kimi-K3 at index 0' } };
      if (params.expression.includes('[role="alert"]')) {
        const notice = {
          innerText: '仅   会员 Pro 用户可用',
          getBoundingClientRect: () => ({ width: 240, height: 80 })
        };
        return {
          result: {
            value: vm.runInNewContext(params.expression, {
              document: { querySelectorAll: () => [notice] },
              getComputedStyle: () => ({ visibility: 'visible', display: 'block' })
            })
          }
        };
      }
      throw new Error('Unexpected Runtime.evaluate expression');
    }
  }, { ...getConfig(), postActionDelayMs: 0 });
  driver.getCurrentModel = async () => 'GLM-5.2';

  const result = await driver.switchModel('Kimi-K3');

  assert.strictEqual(result.code, 'MODEL_ACCESS_DENIED');
  assert.match(result.error, /仅\s+会员/);
});

asyncTest('listModels returns the currently offered TraeCN models', async () => {
  let expression = '';
  let inputEvents = 0;
  const driver = new DomDriver({
    async send(method, payload) {
      if (method === 'Input.dispatchMouseEvent') {
        inputEvents++;
        return {};
      }
      assert.strictEqual(method, 'Runtime.evaluate');
      expression = payload.expression || '';
      if (expression.includes('expanded:')) {
        return { result: { value: { x: 100, y: 200, expanded: false } } };
      }
      return {
        result: {
          value: {
            models: ['GLM-5.2', '0.40x', 'DeepSeek-V3.2']
          }
        }
      };
    }
  }, getConfig());
  driver.getCurrentModel = async () => 'GLM-5.2';

  const result = await driver.listModels();

  assert.deepStrictEqual(result, {
    current: 'GLM-5.2',
    models: ['GLM-5.2', 'DeepSeek-V3.2']
  });
  assert.ok(expression.includes('.chat-model-label'));
  assert.ok(expression.includes('modelPicker'));
  assert.strictEqual(inputEvents, 4);
});

asyncTest('listModels ignores the permission combobox and reads the model trigger', async () => {
  let pickerOpen = false;
  const visibleRect = { width: 120, height: 24 };
  const permissionTrigger = {
    className: 'permission-mode-select-trigger',
    innerText: '',
    textContent: '',
    getBoundingClientRect: () => visibleRect,
    click: () => { throw new Error('permission picker must not be opened'); }
  };
  const modelTrigger = {
    className: 'icd-model-select-trigger',
    innerText: 'DeepSeek-V4-Flash',
    textContent: 'DeepSeek-V4-Flash',
    getBoundingClientRect: () => visibleRect,
    getAttribute: name => name === 'aria-expanded' ? String(pickerOpen) : null,
    click: () => { pickerOpen = !pickerOpen; }
  };
  const item = label => ({
    innerText: label + ' 0.77x',
    textContent: label + ' 0.77x',
    getBoundingClientRect: () => visibleRect,
    querySelector: () => ({ innerText: label, textContent: label })
  });
  const driver = new DomDriver({
    async send(method, payload) {
      if (method === 'Input.dispatchMouseEvent') {
        if (payload.type === 'mouseReleased') pickerOpen = !pickerOpen;
        return {};
      }
      assert.strictEqual(method, 'Runtime.evaluate');
      const value = await vm.runInNewContext(payload.expression, {
        document: {
          querySelectorAll(selector) {
            if (selector.includes('[role="combobox"]')) return [permissionTrigger, modelTrigger];
            if (selector.includes('modelPicker')) {
              return pickerOpen ? [item('Seed-2.1-Pro'), item('DeepSeek-V4-Flash')] : [];
            }
            return [];
          }
        },
        setTimeout
      });
      return { result: { value } };
    }
  }, getConfig());
  driver.getCurrentModel = async () => 'DeepSeek-V4-Flash';

  const result = await driver.listModels();

  assert.deepStrictEqual(result, {
    current: 'DeepSeek-V4-Flash',
    models: ['Seed-2.1-Pro', 'DeepSeek-V4-Flash']
  });
});

test('checkReadiness reports login blocker when composer is unavailable', async () => {
  const driver = new DomDriver(null, getConfig());
  driver.findComposer = async () => null;
  driver.findSendButton = async () => null;
  driver.findResponseRegion = async () => null;
  driver.dismissWorkspaceGuideIfPresent = async () => ({ success: false, dismissed: 0, guideVisible: false, reason: null });
  driver.detectMode = async () => ({ mode: 'ide', confidence: 0.9, indicators: ['workbench'] });
  driver.inspectWorkspaceBlockers = async () => ({
    guideVisible: false,
    guideButtons: [],
    loginVisible: true,
    newTaskVisible: false
  });
  driver.checkRestrictedMode = async () => ({ restricted: false });
  driver.checkForApprovalDialog = async () => ({ needsApproval: false });

  const readiness = await driver.checkReadiness();
  assert.strictEqual(readiness.ready, false);
  assert.strictEqual(readiness.blocker, 'login_required');
  assert.strictEqual(readiness.blockers.loginVisible, true);
});

test('checkReadiness accepts runtime-visible composer with disabled empty send button', async () => {
  const config = getConfig();
  config.composerSelectors = ['.chat-input-v2-input-box-editable'];
  config.sendButtonSelectors = ['button.chat-input-v2-send-button'];
  const driver = new DomDriver({
    send: async (method, params) => {
      if (method === 'Runtime.evaluate') {
        if (params.expression.includes('.chat-input-v2-input-box-editable')) {
          return { result: { value: { matchedSelector: '.chat-input-v2-input-box-editable', visible: true, disabled: false } } };
        }
        if (params.expression.includes('button.chat-input-v2-send-button')) {
          return { result: { value: { matchedSelector: 'button.chat-input-v2-send-button', visible: true, disabled: true } } };
        }
      }
      return { result: { value: null } };
    }
  }, config);
  driver.findComposer = async () => null;
  driver.findSendButton = async () => null;
  driver.findResponseRegion = async () => null;
  driver.dismissWorkspaceGuideIfPresent = async () => ({ success: false, dismissed: 0, guideVisible: false, reason: null });
  driver.detectMode = async () => ({ mode: 'solo', confidence: 0.9, indicators: ['chat'] });
  driver.inspectWorkspaceBlockers = async () => ({ guideVisible: false, guideButtons: [], loginVisible: false, newTaskVisible: false });
  driver.checkRestrictedMode = async () => ({ restricted: false });
  driver.checkForApprovalDialog = async () => ({ needsApproval: false });

  const readiness = await driver.checkReadiness();
  assert.strictEqual(readiness.ready, true);
  assert.strictEqual(readiness.blocker, null);
  assert.strictEqual(readiness.composer.runtimeFallback, true);
  assert.strictEqual(readiness.sendButton.runtimeFallback, true);
  assert.strictEqual(readiness.sendButton.disabled, true);
});

test('listSoloChats returns Solo sidebar conversations from runtime evaluation', async () => {
  let expression = '';
  const driver = new DomDriver({
    async send(method, payload) {
      assert.strictEqual(method, 'Runtime.evaluate');
      assert.strictEqual(payload.awaitPromise, true);
      expression = payload.expression || '';
      return {
        result: {
          value: {
            mode: 'solo',
            chats: [
              { index: 0, title: 'Implement feature', text: 'Implement feature 任务完成', active: true, status: 'done' }
            ],
            count: 1
          }
        }
      };
    }
  }, getConfig());

  const result = await driver.listSoloChats();
  assert.strictEqual(result.mode, 'solo');
  assert.strictEqual(result.count, 1);
  assert.strictEqual(result.chats[0].title, 'Implement feature');
  assert.ok(expression.includes('.soloaisidebar'));
  assert.ok(expression.includes('conversation-item'));
  assert.ok(expression.includes('task-items-list'));
  assert.ok(expression.includes('task-item-info'));
  assert.ok(expression.includes('findScrollHost'));
  assert.ok(expression.includes('parentElement'));
  assert.ok(expression.includes('document.scrollingElement'));
  assert.ok(expression.includes('scrollTop'));
  assert.ok(expression.includes("scanned: 'scroll'"));
});

function nativeSoloSidebarFixture() {
  const actions = [];
  const sidebar = {
    className: 'soloaisidebar', offsetParent: {}, clientHeight: 200, scrollHeight: 200, scrollTop: 0,
    parentElement: null,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 250, height: 200, right: 250 }),
    querySelectorAll: () => rows
  };
  const makeRow = (sessionId, active = false) => ({
    sessionId, className: `index-module__task-item___zOpfg ${active ? 'index-module__selected___VDArP' : ''}`,
    innerText: 'Same title 任务中断 09:41', textContent: 'Same title 任务中断 09:41',
    offsetParent: sidebar, parentElement: sidebar, clientHeight: 0, scrollHeight: 0,
    getAttribute: name => name === 'data-session-id' ? sessionId : null,
    querySelectorAll: () => [],
    querySelector: selector => selector.includes('title') ? { innerText: 'Same title', textContent: 'Same title' } :
      selector.includes('action') ? { getBoundingClientRect: () => ({ x: 220, y: 100, width: 20, height: 20 }),
        click: () => actions.push(['menu', sessionId]) } : null,
    getBoundingClientRect: () => ({ x: 0, y: 80, left: 0, top: 80, width: 250, height: 40 }),
    scrollIntoView() {},
    dispatchEvent: () => actions.push(['select', sessionId]),
    click: () => actions.push(['select', sessionId])
  });
  const rows = [makeRow('6ac05d3c1407a4b5492e7496', true), makeRow('6ac05c911407a4b5492e7476')];
  const page = { clientHeight: 800, scrollHeight: 800, offsetParent: {}, querySelectorAll: () => [] };
  const sandbox = {
    document: { querySelector: selector => selector.includes('sidebar') ? sidebar : null,
      body: page, documentElement: page, scrollingElement: page },
    window: { innerHeight: 800, getComputedStyle: () => ({ overflow: 'visible', overflowY: 'visible' }) },
    requestAnimationFrame: callback => callback(),
    PointerEvent: class {}, MouseEvent: class {}
  };
  const client = { async send(method, params) {
    assert.strictEqual(method, 'Runtime.evaluate');
    return { result: { value: await vm.runInNewContext(params.expression, sandbox) } };
  } };
  return { driver: new DomDriver(client, { ...getConfig(), postActionDelayMs: 1 }), client, rows, actions };
}

test('listSoloChats keeps duplicate titles separate through native sessions and reads the title node', async () => {
  const fixture = nativeSoloSidebarFixture();
  const result = await fixture.driver.listSoloChats();
  assert.strictEqual(result.count, 2);
  assert.deepStrictEqual(Array.from(result.chats, chat => chat.sessionId), fixture.rows.map(row => row.sessionId));
  assert.ok(result.chats.every(chat => chat.title === 'Same title'));
});

test('standalone Agent discovers and switches conversations by native row identity', async () => {
  const ids = ['agent-session-a', 'agent-session-b'];
  let active = ids[0];
  let switchUpdatesActive = true;
  let pendingSelection;
  let selectionReads = 0;
  const clicks = [];
  const rows = ids.map(id => {
    const item = {
      classList: { contains: name => name === 'taskItemSelected' && active === id },
      click() {
        clicks.push(id);
        if (switchUpdatesActive) pendingSelection = id;
      }
    };
    return {
      className: 'task-list-row-wrapper',
      innerText: 'New Task · 进行中',
      getAttribute: name => name === 'data-session-id' ? id : null,
      querySelector: selector => ({
        '.taskText': { innerText: 'New Task' },
        '.taskItem': item,
        '.taskItem.taskItemSelected': active === id ? item : null
      })[selector] || null,
      getBoundingClientRect: () => ({ y: 100, width: 200, height: 40 }),
      scrollIntoView() {}
    };
  });
  const sidebar = {
    classList: { contains: name => name === 'task-list-panel' },
    offsetParent: {},
    getBoundingClientRect: () => ({ right: 250, width: 250 }),
    querySelectorAll: selector => selector === '.task-list-row-wrapper[data-session-id]' ? rows : []
  };
  const sandbox = {
    document: { querySelector: selector => selector.includes('.task-list-panel') ? sidebar : null },
    window: { innerHeight: 800 }
  };
  const driver = new DomDriver({
    async send(method, params) {
      assert.strictEqual(method, 'Runtime.evaluate');
      if (pendingSelection && params.expression.includes('collectVisible(scrollInfo)') && ++selectionReads === 2) {
        active = pendingSelection;
        pendingSelection = null;
      }
      return { result: { value: await vm.runInNewContext(params.expression, sandbox) } };
    }
  }, { ...getConfig(), postActionDelayMs: 1 });
  const list = await driver.listSoloChats();
  assert.deepStrictEqual(Array.from(list.chats, chat => [chat.sessionId, chat.title, chat.active, chat.status]), [
    [ids[0], 'New Task', true, 'unknown'], [ids[1], 'New Task', false, 'unknown']
  ]);
  const selected = await driver.switchSoloChat({ sessionId: ids[1] });
  assert.strictEqual(selected.success, true);
  assert.strictEqual(selectionReads, 2, 'selection should wait for the exact native row to become active');
  assert.strictEqual((await driver.getActiveSoloChat()).active.sessionId, ids[1]);
  assert.strictEqual((await driver.switchSoloChat({ sessionId: ids[1] })).success, true);
  assert.deepStrictEqual(clicks, [ids[1]]);
  switchUpdatesActive = false;
  const notSelected = await driver.switchSoloChat({ sessionId: ids[0] });
  assert.deepStrictEqual(notSelected, { success: false, reason: 'chat_switch_not_confirmed' });
});

function soloSidebarRafFixture({ scrollable = true, raf = 'never', native = true,
  activeIndex = 1, bothActive = false, activate, sameTitle = true, sidebarPresent = true } = {}) {
  const events = { raf: 0, cancelledFrames: [], scrollWrites: [], clicks: [], activations: 0, evaluate: 0 };
  let scrollTop = scrollable ? 150 : 0;
  let mountedTop = scrollTop;
  const sidebar = {
    tagName: 'DIV', className: 'soloaisidebar', offsetParent: {}, parentElement: null,
    clientHeight: 200, scrollHeight: scrollable ? 400 : 200,
    get scrollTop() { return scrollTop; },
    set scrollTop(value) { scrollTop = value; events.scrollWrites.push(value); },
    getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 250, width: 250, height: 200 }),
    querySelectorAll: () => scrollable ? [rows[mountedTop === 0 ? 0 : 1]] : rows
  };
  const rows = ['6ac05c911407a4b5492e7476', '6ac05d3c1407a4b5492e7496'].map((sessionId, index) => {
    const title = sameTitle ? 'Same title' : `Legacy title ${index}`;
    return {
      sessionId, className: `index-module__task-item___zOpfg ${bothActive || index === activeIndex ? 'index-module__selected___VDArP' : ''}`,
      innerText: `${title} 进行中 09:41`, textContent: `${title} 进行中 09:41`,
      offsetParent: sidebar, parentElement: sidebar, clientHeight: 0, scrollHeight: 0,
      getAttribute: name => name === 'data-session-id' ? (native ? sessionId : null) : null,
      querySelectorAll: () => [],
      querySelector: selector => selector.includes('title') ? { innerText: title, textContent: title } : null,
      getBoundingClientRect: () => ({ x: 0, y: 80, left: 0, top: 80, width: 250, height: 40 }),
      scrollIntoView() {},
      dispatchEvent: () => events.clicks.push(sessionId), click: () => events.clicks.push(sessionId)
    };
  });
  const page = { clientHeight: 800, scrollHeight: 800, offsetParent: {}, querySelectorAll: () => [] };
  const document = {
    hidden: raf !== 'normal', visibilityState: raf === 'normal' ? 'visible' : 'hidden',
    querySelector: selector => selector.includes('sidebar') && sidebarPresent ? sidebar : null,
    body: page, documentElement: page, scrollingElement: page
  };
  const sandbox = {
    document,
    window: { innerHeight: 800, getComputedStyle: () => ({ overflow: 'visible', overflowY: 'visible' }) },
    requestAnimationFrame: raf === 'absent' ? undefined : callback => {
      const id = ++events.raf;
      if (raf === 'normal' || document.visibilityState === 'visible' ||
        (raf === 'first-only' && id === 1) || (raf === 'after-first-settle' && id <= 2)) {
        queueMicrotask(() => { mountedTop = scrollTop; callback(); });
      }
      return id;
    },
    cancelAnimationFrame: frame => events.cancelledFrames.push(frame), setTimeout, clearTimeout,
    PointerEvent: class {}, MouseEvent: class {}
  };
  const client = { async send(method, params) {
    assert.strictEqual(method, 'Runtime.evaluate', 'the fixture never connects to CDP or dispatches native input');
    events.evaluate++;
    return { result: { value: await vm.runInNewContext(params.expression, sandbox) } };
  } };
  const options = activate ? { activateWindow: async () => {
    events.activations++;
    assert.deepStrictEqual(events.scrollWrites, [], 'visibility is prepared before changing the sidebar scroll');
    return activate(document);
  } } : {};
  return { driver: new DomDriver(client, { ...getConfig(), postActionDelayMs: 1 }, options), sidebar, rows, events, document };
}

async function withinSidebarDeadline(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('sidebar call did not settle within 1000ms')), 1000); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('listSoloChats rejects an unpainted hidden virtualized scan and restores scroll', async () => {
  for (const raf of ['never', 'first-only', 'after-first-settle', 'absent']) {
    const fixture = soloSidebarRafFixture({ raf });
    await assert.rejects(withinSidebarDeadline(fixture.driver.listSoloChats()), error => error.code === 'CDP_TIMEOUT');
    assert.strictEqual(fixture.sidebar.scrollTop, 150);
    assert.deepStrictEqual(fixture.events.clicks, []);
    if (raf !== 'absent') assert.ok(fixture.events.cancelledFrames.length > 0);
  }
});

test('listSoloChats still scans painted virtualized native rows and restores scroll', async () => {
  const fixture = soloSidebarRafFixture({ raf: 'normal' });
  const result = await withinSidebarDeadline(fixture.driver.listSoloChats());
  assert.strictEqual(result.mode, 'solo');
  assert.strictEqual(result.scanned, 'scroll');
  assert.strictEqual(result.count, 2);
  assert.deepStrictEqual(Array.from(result.chats, chat => chat.sessionId), fixture.rows.map(row => row.sessionId));
  assert.ok(result.chats.every(chat => chat.title === 'Same title'));
  assert.strictEqual(fixture.sidebar.scrollTop, 150);
});

test('getActiveSoloChat reads the mounted native identity without scroll, RAF, or window activation', async () => {
  const fixture = soloSidebarRafFixture({ activate: () => { throw new Error('active identity must not activate a window'); } });
  const result = await withinSidebarDeadline(fixture.driver.getActiveSoloChat());
  assert.strictEqual(result.mode, 'solo');
  assert.strictEqual(result.active.sessionId, fixture.rows[1].sessionId);
  assert.strictEqual(result.active.title, 'Same title');
  assert.strictEqual(result.active.text, 'Same title 进行中 09:41');
  assert.strictEqual(result.active.status, 'running');
  assert.strictEqual(result.active.scanned, 'visible');
  assert.strictEqual(result.count, 1, 'fast snapshots count only the mounted conversations');
  assert.strictEqual(fixture.events.evaluate, 1);
  assert.strictEqual(fixture.events.raf, 0);
  assert.strictEqual(fixture.events.activations, 0);
  assert.deepStrictEqual(fixture.events.scrollWrites, []);
});

test('getActiveSoloChat safely rejects conflicting active native identities', async () => {
  const fixture = soloSidebarRafFixture({ scrollable: false, bothActive: true });
  const result = await withinSidebarDeadline(fixture.driver.getActiveSoloChat());
  assert.strictEqual(result.active, null);
  assert.strictEqual(result.reason, 'active_solo_chat_ambiguous');
  assert.strictEqual(result.count, 2);
  assert.strictEqual(fixture.events.evaluate, 1);
  assert.deepStrictEqual(fixture.events.scrollWrites, []);
});

test('getActiveSoloChat keeps the full legacy scan response without fabricating native IDs from titles', async () => {
  const fixture = soloSidebarRafFixture({ scrollable: false, native: false, sameTitle: false });
  const legacy = { index: 5, sessionId: null, title: 'Legacy title 1', text: 'Legacy title 1 进行中', active: true, status: 'running' };
  let scans = 0;
  fixture.driver.listSoloChats = async () => { scans++; return { mode: 'solo', chats: [legacy], count: 6 }; };
  const result = await withinSidebarDeadline(fixture.driver.getActiveSoloChat());
  assert.strictEqual(result.active, legacy);
  assert.strictEqual(result.active.sessionId, null);
  assert.strictEqual(result.count, 6);
  assert.strictEqual(scans, 1);
  assert.strictEqual(fixture.events.raf, 0);
});

test('getActiveSoloChat can still find an unmounted native active row through a confirmed full scan', async () => {
  const fixture = soloSidebarRafFixture({ raf: 'normal', activeIndex: 0 });
  const result = await withinSidebarDeadline(fixture.driver.getActiveSoloChat());
  assert.strictEqual(result.active.sessionId, fixture.rows[0].sessionId);
  assert.strictEqual(result.count, 2);
  assert.strictEqual(result.active.scanned, 'scroll');
  assert.strictEqual(fixture.sidebar.scrollTop, 150);
});

test('getActiveSoloChat preserves the non-Solo reason without guessing from a title', async () => {
  const fixture = soloSidebarRafFixture({ sidebarPresent: false });
  const result = await fixture.driver.getActiveSoloChat();
  assert.strictEqual(result.mode, 'not_solo');
  assert.strictEqual(result.active, null);
  assert.strictEqual(result.reason, 'sidebar_element_not_found');
  assert.strictEqual(fixture.events.evaluate, 1);
});

test('getActiveSoloChat returns unavailable when runtime has no snapshot', async () => {
  const driver = new DomDriver({ send: async () => ({ result: {} }) }, getConfig());
  const result = await driver.getActiveSoloChat();
  assert.strictEqual(result.active, null);
  assert.strictEqual(result.mode, 'unknown');
  assert.strictEqual(result.reason, 'solo_chats_unavailable');
});

test('listSoloChats keeps no-scroll legacy reads independent of RAF and window activation', async () => {
  const fixture = soloSidebarRafFixture({ scrollable: false, native: false,
    activate: () => { throw new Error('no-scroll reads must not activate a window'); } });
  const result = await fixture.driver.listSoloChats();
  assert.strictEqual(result.scanned, 'visible');
  assert.strictEqual(result.count, 1);
  assert.strictEqual(result.chats[0].sessionId, null);
  assert.strictEqual(fixture.events.raf, 0);
  assert.strictEqual(fixture.events.activations, 0);
  assert.deepStrictEqual(fixture.events.scrollWrites, []);
});

test('listSoloChats prepares a hidden renderer once through the existing hook before a full scan', async () => {
  const fixture = soloSidebarRafFixture({ activate: document => {
    document.visibilityState = 'visible'; document.hidden = false;
    return true;
  } });
  const result = await withinSidebarDeadline(fixture.driver.listSoloChats());
  assert.strictEqual(result.count, 2);
  assert.strictEqual(result.scanned, 'scroll');
  assert.strictEqual(fixture.events.activations, 1);
  assert.strictEqual(fixture.sidebar.scrollTop, 150);
});

test('listSoloChats fails before scrolling when native activation fails or leaves the renderer hidden', async () => {
  for (const activationResult of [false, true]) {
    const fixture = soloSidebarRafFixture({ activate: () => activationResult });
    fixture.driver._waitForExpression = async (expression, timeout, poll) => {
      assert.strictEqual(expression, 'document.visibilityState === "visible"');
      assert.strictEqual(timeout, 5000);
      assert.strictEqual(poll, 200);
      return false;
    };
    await assert.rejects(withinSidebarDeadline(fixture.driver.listSoloChats()), error => error.code === 'WINDOW_NOT_VISIBLE');
    assert.strictEqual(fixture.events.activations, 1);
    assert.strictEqual(fixture.events.raf, 0);
    assert.deepStrictEqual(fixture.events.scrollWrites, []);
    assert.strictEqual(fixture.sidebar.scrollTop, 150);
  }
});

test('native row location with missing RAF stops safely and restores scroll without selecting a legacy match', async () => {
  const fixture = soloSidebarRafFixture();
  const result = await withinSidebarDeadline(fixture.driver.switchSoloChat({ sessionId: 'missing-native-session', index: 0, titleIncludes: 'Same title' }));
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, 'sidebar_scan_timeout');
  assert.strictEqual(fixture.sidebar.scrollTop, 150);
  assert.deepStrictEqual(fixture.events.clicks, []);
});

test('native deletion cannot proceed after an unconfirmed virtualized row scan', async () => {
  const fixture = soloSidebarRafFixture();
  const result = await withinSidebarDeadline(fixture.driver.deleteSoloChats({ candidates: [
    { sessionId: 'missing-native-session', index: 0, title: 'Same title' }
  ] }));
  assert.strictEqual(result.deleted, 0);
  assert.strictEqual(result.attempts[0].reason, 'sidebar_scan_timeout');
  assert.deepStrictEqual(fixture.events.clicks, []);
  assert.strictEqual(fixture.sidebar.scrollTop, 150);
});

test('native row location prepares the hidden renderer once and selects only the painted exact ID', async () => {
  const fixture = soloSidebarRafFixture({ activate: document => {
    document.visibilityState = 'visible'; document.hidden = false;
    return true;
  } });
  const result = await withinSidebarDeadline(fixture.driver.switchSoloChat({ sessionId: fixture.rows[0].sessionId, index: 1 }));
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.sessionId, fixture.rows[0].sessionId);
  assert.strictEqual(fixture.events.activations, 1);
  assert.ok(fixture.events.clicks.length > 0);
  assert.ok(fixture.events.clicks.every(sessionId => sessionId === fixture.rows[0].sessionId));
});

test('native row location restores scroll after a complete painted scan finds no exact ID', async () => {
  const fixture = soloSidebarRafFixture({ raf: 'normal' });
  const result = await withinSidebarDeadline(fixture.driver.switchSoloChat({ sessionId: 'missing-native-session' }));
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, 'candidate_not_found');
  assert.strictEqual(fixture.sidebar.scrollTop, 150);
  assert.deepStrictEqual(fixture.events.clicks, []);
});

test('listSoloChats never reports a complete list after reaching the virtualized scan limit', async () => {
  const fixture = soloSidebarRafFixture({ raf: 'normal' });
  fixture.sidebar.scrollHeight = 40000;
  await assert.rejects(withinSidebarDeadline(fixture.driver.listSoloChats()), error => error.code === 'CDP_TIMEOUT');
  assert.strictEqual(fixture.sidebar.scrollTop, 150);
  assert.ok(fixture.events.scrollWrites.at(-2) < 39800);
});

test('native row location safely distinguishes an incomplete bounded scan from proven absence', async () => {
  const fixture = soloSidebarRafFixture({ raf: 'normal' });
  fixture.sidebar.scrollHeight = 40000;
  const result = await withinSidebarDeadline(fixture.driver.switchSoloChat({ sessionId: 'missing-native-session' }));
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, 'sidebar_scan_incomplete');
  assert.strictEqual(fixture.sidebar.scrollTop, 150);
  assert.deepStrictEqual(fixture.events.clicks, []);
});

function fractionalSoloSidebarFixture(actualMax = 114.5, originalTop = 0) {
  const fixture = soloSidebarRafFixture({ raf: 'normal' });
  const descriptor = Object.getOwnPropertyDescriptor(fixture.sidebar, 'scrollTop');
  // Exact geometry from live record0250: integer height807/clientHeight692,
  // requested bottom115 and confirmed physical bottom114.5 after painting.
  fixture.sidebar.clientHeight = 692;
  fixture.sidebar.scrollHeight = 807;
  Object.defineProperty(fixture.sidebar, 'scrollTop', {
    get: descriptor.get,
    set(value) { descriptor.set(Math.max(0, Math.min(actualMax, value))); }
  });
  fixture.sidebar.scrollTop = originalTop;
  fixture.events.scrollWrites.length = 0;
  return fixture;
}

test('listSoloChats accepts the measured fractional bottom and the exact one-pixel boundary', async () => {
  for (const actualMax of [114.5, 114]) {
    const fixture = fractionalSoloSidebarFixture(actualMax);
    const result = await withinSidebarDeadline(fixture.driver.listSoloChats());
    assert.strictEqual(result.scanned, 'scroll');
    assert.strictEqual(result.count, 2);
    assert.deepStrictEqual(Array.from(result.chats, chat => chat.sessionId), fixture.rows.map(row => row.sessionId));
    assert.strictEqual(fixture.sidebar.scrollTop, 0);
    assert.strictEqual(fixture.events.scrollWrites.at(-2), actualMax);
  }
});

test('native row location at the measured fractional bottom proves absence without a title fallback click', async () => {
  const fixture = fractionalSoloSidebarFixture();
  const result = await withinSidebarDeadline(fixture.driver.switchSoloChat({ sessionId: 'missing-native-session', index: 0, titleIncludes: 'Same title' }));
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, 'candidate_not_found');
  assert.strictEqual(fixture.sidebar.scrollTop, 0);
  assert.deepStrictEqual(fixture.events.clicks, []);
});

test('fractional bottom tolerance cannot accept a true shortfall beyond one pixel', async () => {
  for (const actualMax of [113.99, 110]) {
    const fixture = fractionalSoloSidebarFixture(actualMax);
    await assert.rejects(withinSidebarDeadline(fixture.driver.listSoloChats()), error => error.code === 'CDP_TIMEOUT');
    assert.strictEqual(fixture.sidebar.scrollTop, 0);
    const located = await withinSidebarDeadline(fixture.driver.switchSoloChat({ sessionId: 'missing-native-session' }));
    assert.strictEqual(located.success, false);
    assert.strictEqual(located.reason, 'sidebar_scan_incomplete');
    assert.strictEqual(fixture.sidebar.scrollTop, 0);
    assert.deepStrictEqual(fixture.events.clicks, []);
  }
});

test('a confirmed fractional-bottom full list restores an original nonzero scroll position', async () => {
  const fixture = fractionalSoloSidebarFixture(114.5, 75);
  await withinSidebarDeadline(fixture.driver.listSoloChats());
  assert.strictEqual(fixture.sidebar.scrollTop, 75);
});

test('switchSoloChat selects only the exact native session even when legacy criteria match another row', async () => {
  const fixture = nativeSoloSidebarFixture();
  const sessionId = fixture.rows[1].sessionId;
  const result = await fixture.driver.switchSoloChat({ sessionId, index: 0, titleIncludes: 'Same title' });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.sessionId, sessionId);
  assert.ok(fixture.actions.length > 0);
  assert.ok(fixture.actions.every(action => action[1] === sessionId));
});

test('switchSoloChat never falls back from a missing native session to title or index', async () => {
  const fixture = nativeSoloSidebarFixture();
  const result = await fixture.driver.switchSoloChat({ sessionId: 'missing-native-session', index: 0, titleIncludes: 'Same title' });
  assert.strictEqual(result.success, false);
  assert.strictEqual(fixture.actions.length, 0);
});

test('deleteSoloChats never opens another row menu when the native session is missing', async () => {
  const fixture = nativeSoloSidebarFixture();
  const result = await fixture.driver.deleteSoloChats({ candidates: [
    { sessionId: 'missing-native-session', index: 0, title: 'Same title' }
  ] });
  assert.strictEqual(result.deleted, 0);
  assert.strictEqual(result.attempts[0].reason, 'candidate_not_found');
  assert.strictEqual(fixture.actions.length, 0);
});

test('deleteSoloChats verifies exact native identity when titles change or duplicate titles remain', async () => {
  for (const targetRemains of [true, false]) {
    const fixture = nativeSoloSidebarFixture();
    const sessionId = fixture.rows[1].sessionId;
    const evaluate = fixture.client.send;
    fixture.client.send = async (method, params) => {
      if (method === 'Input.dispatchMouseEvent') return {};
      if (params.expression.includes('[role="dialog"]') || params.expression.includes("querySelectorAll('.context-menu-container")) {
        return { result: { value: { x: 100, y: 100 } } };
      }
      return evaluate(method, params);
    };
    fixture.driver.listSoloChats = async () => ({ mode: 'solo', chats: [targetRemains
      ? { sessionId, title: 'Renamed after the menu opened' }
      : { sessionId: fixture.rows[0].sessionId, title: 'Same title' }] });
    const result = await fixture.driver.deleteSoloChats({ candidates: [{ sessionId, index: 0, title: 'Same title' }] });
    assert.strictEqual(result.deleted, targetRemains ? 0 : 1);
    assert.strictEqual(result.attempts[0].reason, targetRemains ? 'delete_verification_failed' : null);
    assert.ok(fixture.actions.length > 0);
    assert.ok(fixture.actions.every(action => action[1] === sessionId), 'only the native target row menu may open');
  }
});

test('switchSoloChat clicks matching Solo conversation and clears task state', async () => {
  let expression = '';
  const driver = new DomDriver({
    async send(method, payload) {
      assert.strictEqual(method, 'Runtime.evaluate');
      expression = payload.expression || '';
      return {
        result: {
          value: {
            success: true,
            index: 1,
            title: 'Second chat',
            text: 'Second chat details'
          }
        }
      };
    }
  }, { ...getConfig(), postActionDelayMs: 0 });
  driver._lastTaskText = 'old task';
  driver._pendingUserTask = 'pending task';
  driver._preSendSnapshot = 'snapshot';

  const result = await driver.switchSoloChat({ index: 1 });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.index, 1);
  assert.ok(expression.includes('var targetIndex = 1'));
  assert.ok(expression.includes('dispatchEvent'));
  assert.strictEqual(driver._lastTaskText, '');
  assert.strictEqual(driver._pendingUserTask, '');
  assert.strictEqual(driver._preSendSnapshot, '');
});

test('switchSoloChat requires a selection criterion', async () => {
  const driver = new DomDriver({ send: async () => ({ result: { value: {} } }) }, getConfig());
  await assert.rejects(() => driver.switchSoloChat({}), /requires index, textIncludes, or titleIncludes/);
});

// Shared fake client factory for the deleteSoloChats happy path.
// Returns { driver, mouseEvents, runtimeExpressions } so each focused
// test can assert on one aspect without duplicating the ~80-line setup.
function createDeleteHappyPathDriver() {
  const mouseEvents = [];
  const runtimeExpressions = [];
  const driver = new DomDriver({
    async send(method, payload) {
      if (method === 'Input.dispatchMouseEvent') {
        mouseEvents.push(payload);
        return {};
      }
      assert.strictEqual(method, 'Runtime.evaluate');
      const expression = payload.expression || '';
      runtimeExpressions.push(expression);
      if (expression.includes('openRowActionMenu')) {
        return {
          result: {
            value: {
              success: true,
              domClicked: true,
              x: 169,
              y: 150,
              title: 'Wait for Trae Queue 进行中 14:07'
            }
          }
        };
      }
      if (expression.includes('var candidate =')) {
        assert.strictEqual(payload.awaitPromise, true);
        assert.ok(expression.includes('"Wait for Trae Queue 进行中 14:07"'));
        assert.ok(expression.indexOf('candidate.title') < expression.indexOf('candidate.index'));
        assert.ok(expression.includes('findScrollHost'));
        assert.ok(expression.includes('scrollTop'));
        return {
          result: {
            value: {
              index: 0,
              title: 'Wait for Trae Queue 进行中 14:07',
              actionPoint: { x: 169, y: 150, kind: 'action' },
              rowPoint: { x: 100, y: 162, kind: 'row' }
            }
          }
        };
      }
      if (expression.includes('var anchor =') || expression.includes("querySelectorAll('.context-menu-container")) {
        return {
          result: {
            value: {
              x: 99,
              y: 273,
              score: 160,
              nodeText: '删除任务',
              nodeClass: 'context-menu-container-delete',
              clickClass: 'context-menu-container-delete'
            }
          }
        };
      }
      if (expression.includes('querySelectorAll') && expression.includes('[role="dialog"]')) {
        return {
          result: {
            value: {
              x: 879,
              y: 488,
              score: 90,
              nodeText: '删除',
              nodeClass: 'icd-btn-content'
            }
          }
        };
      }
      if (expression.includes('.soloaisidebar')) {
        return {
          result: {
            value: {
              mode: 'solo',
              chats: [
                { index: 0, title: '正常工作 任务完成', text: '正常工作 任务完成' }
              ],
              count: 1
            }
          }
        };
      }
      throw new Error(`unexpected expression: ${expression.slice(0, 120)}`);
    }
  }, { ...getConfig(), postActionDelayMs: 0 });
  return { driver, mouseEvents, runtimeExpressions };
}

const DELETE_CANDIDATE = {
  index: 0,
  title: 'Wait for Trae Queue 进行中 14:07',
  text: 'Wait for Trae Queue 进行中 14:07'
};

test('deleteSoloChats reports successful deletion with correct delete and confirm points', async () => {
  const { driver } = createDeleteHappyPathDriver();
  const result = await driver.deleteSoloChats({ candidates: [DELETE_CANDIDATE] });
  assert.strictEqual(result.deleted, 1);
  assert.strictEqual(result.attempts[0].success, true);
  assert.strictEqual(result.attempts[0].deletePoint.nodeText, '删除任务');
  assert.strictEqual(result.attempts[0].confirmPoint.nodeText, '删除');
});

test('deleteSoloChats opens the Trae v2 row action menu through its dedicated DOM control', async () => {
  const { driver, runtimeExpressions } = createDeleteHappyPathDriver();
  await driver.deleteSoloChats({ candidates: [DELETE_CANDIDATE] });
  assert.ok(
    runtimeExpressions.some(expression => expression.includes('task-item-action___')
      && expression.includes('actionButton.click()')),
    'should click the dedicated row action control'
  );
});

test('deleteSoloChats clicks delete and confirm buttons at computed coordinates', async () => {
  const { driver, mouseEvents } = createDeleteHappyPathDriver();
  await driver.deleteSoloChats({ candidates: [DELETE_CANDIDATE] });
  assert.ok(mouseEvents.some(event => event.type === 'mousePressed' && event.x === 99 && event.y === 273));
  assert.ok(mouseEvents.some(event => event.type === 'mousePressed' && event.x === 879 && event.y === 488));
});

test('deleteSoloChats re-queries sidebar to verify deletion by title', async () => {
  const { driver, runtimeExpressions } = createDeleteHappyPathDriver();
  await driver.deleteSoloChats({ candidates: [DELETE_CANDIDATE] });
  assert.ok(runtimeExpressions.some(expression => expression.includes('.soloaisidebar')));
});

test('deleteSoloChats does not treat menu text insertion as deletion success', async () => {
  const driver = new DomDriver({
    async send(method, payload) {
      if (method === 'Input.dispatchMouseEvent') return {};
      assert.strictEqual(method, 'Runtime.evaluate');
      const expression = payload.expression || '';
      if (expression.includes('openRowActionMenu')) {
        return {
          result: {
            value: { success: true, domClicked: true, x: 169, y: 150, title: 'Wait for Trae Queue 进行中 14:11' }
          }
        };
      }
      if (expression.includes('var candidate =')) {
        return {
          result: {
            value: {
              index: 0,
              title: 'Wait for Trae Queue 进行中 14:11',
              actionPoint: { x: 169, y: 150, kind: 'action' },
              rowPoint: { x: 100, y: 162, kind: 'row' }
            }
          }
        };
      }
      if (expression.includes('var anchor =') || expression.includes("querySelectorAll('.context-menu-container")) {
        return {
          result: {
            value: {
              x: 99,
              y: 273,
              score: 160,
              nodeText: '删除任务',
              nodeClass: 'context-menu-container-delete',
              clickClass: 'context-menu-container-delete'
            }
          }
        };
      }
      if (expression.includes('querySelectorAll') && expression.includes('[role="dialog"]')) {
        return { result: { value: null } };
      }
      if (expression.includes('.soloaisidebar')) {
        return {
          result: {
            value: {
              mode: 'solo',
              chats: [
                {
                  index: 0,
                  title: 'Wait for Trae Queue 重命名 导出 复制会话 删除任务 进行中 14:11',
                  text: 'Wait for Trae Queue 重命名 导出 复制会话 删除任务 进行中 14:11'
                }
              ],
              count: 1
            }
          }
        };
      }
      throw new Error(`unexpected expression: ${expression.slice(0, 120)}`);
    }
  }, { ...getConfig(), postActionDelayMs: 0 });

  const result = await driver.deleteSoloChats({
    candidates: [
      {
        index: 0,
        title: 'Wait for Trae Queue 进行中 14:11',
        text: 'Wait for Trae Queue 进行中 14:11'
      }
    ]
  });

  assert.strictEqual(result.deleted, 0);
  assert.strictEqual(result.attempts[0].success, false);
  assert.strictEqual(result.attempts[0].reason, 'delete_verification_failed');
});

asyncTest('Settings operations reject a hidden window before changing preferences', async () => {
  let inputCalls = 0;
  const driver = new DomDriver({ send: async () => { inputCalls++; throw new Error('Unexpected UI operation'); } }, getConfig());
  driver._ensureVisibleWindow = async () => {
    const error = new Error('Renderer stayed hidden');
    error.code = 'WINDOW_NOT_VISIBLE';
    throw error;
  };
  for (const operation of [
    () => driver.settings.switchTab('通用'),
    () => driver.settings.setDropdown('Markdown 文件的默认打开方式', '代码编辑器'),
    () => driver.settings.setToggle('动态 UI', false),
    () => driver.settings.typeText('字体大小', '15')
  ]) {
    await assert.rejects(operation, { code: 'WINDOW_NOT_VISIBLE' });
  }
  assert.strictEqual(inputCalls, 0);
});

test('getConfig respects TRAECN_COMPOSER_SELECTORS env var', () => {
  process.env.TRAECN_COMPOSER_SELECTORS = '.custom-input,textarea';
  try {
    const config = getConfig();
    assert.deepStrictEqual(config.composerSelectors, ['.custom-input', 'textarea']);
  } finally {
    delete process.env.TRAECN_COMPOSER_SELECTORS;
  }
});

test('getConfig falls back to TRAE_COMPOSER_SELECTORS', () => {
  delete process.env.TRAECN_COMPOSER_SELECTORS;
  process.env.TRAE_COMPOSER_SELECTORS = '.trae-input';
  try {
    const config = getConfig();
    assert.deepStrictEqual(config.composerSelectors, ['.trae-input']);
  } finally {
    delete process.env.TRAE_COMPOSER_SELECTORS;
  }
});

(async () => {
  await pendingAsyncTests();
  summary();
  if (r.failed > 0) {
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
