'use strict';

const assert = require('assert');
const { DomDriver, getConfig, sanitizeActivityText, DEFAULT_COMPOSER_SELECTORS, DEFAULT_SEND_BUTTON_SELECTORS, DEFAULT_RESPONSE_SELECTORS } = require('./dom-driver');

let passed = 0;
let failed = 0;
const pendingAsyncTests = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pendingAsyncTests.push({
        name,
        promise: Promise.resolve(result)
          .then(() => ({ ok: true }))
          .catch((err) => ({ ok: false, err }))
      });
      return;
    }
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`        ${err.message}`);
  }
}

console.log('\n[dom-driver.test.js] Running tests...\n');

test('getConfig returns default composer selectors', () => {
  const config = getConfig();
  assert.ok(Array.isArray(config.composerSelectors));
  assert.ok(config.composerSelectors.length > 0);
});

test('getConfig returns default send button selectors', () => {
  const config = getConfig();
  assert.ok(Array.isArray(config.sendButtonSelectors));
  assert.ok(config.sendButtonSelectors.length > 0);
});

test('getConfig returns default response selectors', () => {
  const config = getConfig();
  assert.ok(Array.isArray(config.responseSelectors));
  assert.ok(config.responseSelectors.length > 0);
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

test('getConfig leaves queueMaxWaitMs unset by default', () => {
  delete process.env.TRAECN_QUEUE_MAX_WAIT_MS;
  delete process.env.TRAE_QUEUE_MAX_WAIT_MS;
  const config = getConfig();
  assert.strictEqual(config.queueMaxWaitMs, null);
});

test('getConfig parses explicit queueMaxWaitMs', () => {
  process.env.TRAECN_QUEUE_MAX_WAIT_MS = '12345';
  const config = getConfig();
  assert.strictEqual(config.queueMaxWaitMs, 12345);
  delete process.env.TRAECN_QUEUE_MAX_WAIT_MS;
});

test('getConfig sendTrigger defaults to button', () => {
  delete process.env.TRAECN_SEND_TRIGGER;
  delete process.env.TRAE_SEND_TRIGGER;
  const config = getConfig();
  assert.strictEqual(config.sendTrigger, 'button');
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
  assert.strictEqual(result.queued, false);
  assert.ok(expression.includes('polling error'));
  assert.ok(expression.includes('monaco-editor'));
  assert.ok(expression.includes('queueSurface'));
  assert.ok(expression.includes('model|request|server|service'));
});

test('sanitizeActivityText removes Chinese thinking indicators', () => {
  const result = sanitizeActivityText('正在思考… some text');
  assert.ok(!result.includes('正在思考'));
  assert.ok(result.includes('some text'));
});

test('sanitizeActivityText removes English thinking indicators', () => {
  const result = sanitizeActivityText('Generating… some text');
  assert.ok(!result.includes('Generating'));
  assert.ok(result.includes('some text'));
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

test('restricted mode summary treats trusted workspace page as not restricted', () => {
  const driver = new DomDriver(null, getConfig());
  const summary = driver._summarizeRestrictedModeState({
    bodyText: '工作区信任\n你信任此文件夹\n配置设置',
    buttonTexts: ['不信任', '配置设置'],
    hasOverlay: true
  });
  assert.strictEqual(summary.restricted, false);
  assert.strictEqual(summary.trusted, true);
  assert.strictEqual(summary.panelOpen, true);
});

test('restricted mode summary detects actionable trust panel', () => {
  const driver = new DomDriver(null, getConfig());
  const summary = driver._summarizeRestrictedModeState({
    bodyText: '工作区信任\n此文件夹中的功能受限，请信任此文件夹',
    buttonTexts: ['信任', '配置设置'],
    hasOverlay: true
  });
  assert.strictEqual(summary.restricted, true);
  assert.strictEqual(summary.trusted, false);
  assert.strictEqual(summary.panelOpen, true);
  assert.strictEqual(summary.trustButtonFound, true);
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
      if (expression.includes('window.__enhancedClick("开始")')) {
        clickCount += 1;
        return { result: { value: { clicked: true, text: '开始' } } };
      }
      if (expression.includes('window.__enhancedClick("继续")')) {
        clickCount += 1;
        return { result: { value: { clicked: true, text: '继续' } } };
      }
      if (expression.includes('if (window.__enhancedClick) return')) {
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
      if (expression.includes('if (window.__enhancedClick) return')) {
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
      if (expression.includes('window.__enhancedClick("跳过")')) {
        clicked = true;
        return { result: { value: { clicked: true, text: '跳过' } } };
      }
      if (expression.includes('if (window.__enhancedClick) return')) {
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
      if (expression.includes('window.__enhancedClick("继续"')) {
        clicked = true;
        return { result: { value: { clicked: true, text: '继续' } } };
      }
      if (expression.includes('if (window.__enhancedClick) return')) {
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
      : { needsApproval: true, question: '批准执行命令?', dialogType: 'command', buttons: ['允许'] };
  };

  const result = await driver.collectResponse();
  assert.strictEqual(result.needsApproval, true);
  assert.strictEqual(result.dialogType, 'command');
  assert.ok(typeof result.text === 'string');
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

test('deleteSoloChats deletes matched Solo queue probe and verifies by title', async () => {
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
      if (expression.includes('var anchor =')) {
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

  const result = await driver.deleteSoloChats({
    candidates: [
      {
        index: 0,
        title: 'Wait for Trae Queue 进行中 14:07',
        text: 'Wait for Trae Queue 进行中 14:07'
      }
    ]
  });

  assert.strictEqual(result.deleted, 1);
  assert.strictEqual(result.attempts[0].success, true);
  assert.strictEqual(result.attempts[0].deletePoint.nodeText, '删除任务');
  assert.strictEqual(result.attempts[0].confirmPoint.nodeText, '删除');
  assert.ok(mouseEvents.some(event => event.type === 'mousePressed' && event.x === 169 && event.y === 150));
  assert.ok(mouseEvents.some(event => event.type === 'mousePressed' && event.x === 99 && event.y === 273));
  assert.ok(mouseEvents.some(event => event.type === 'mousePressed' && event.x === 879 && event.y === 488));
  assert.ok(runtimeExpressions.some(expression => expression.includes('.soloaisidebar')));
});

test('deleteSoloChats does not treat menu text insertion as deletion success', async () => {
  const driver = new DomDriver({
    async send(method, payload) {
      if (method === 'Input.dispatchMouseEvent') return {};
      assert.strictEqual(method, 'Runtime.evaluate');
      const expression = payload.expression || '';
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
      if (expression.includes('var anchor =')) {
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

test('getConfig respects TRAECN_COMPOSER_SELECTORS env var', () => {
  process.env.TRAECN_COMPOSER_SELECTORS = '.custom-input,textarea';
  const config = getConfig();
  assert.deepStrictEqual(config.composerSelectors, ['.custom-input', 'textarea']);
  delete process.env.TRAECN_COMPOSER_SELECTORS;
});

test('getConfig falls back to TRAE_COMPOSER_SELECTORS', () => {
  delete process.env.TRAECN_COMPOSER_SELECTORS;
  process.env.TRAE_COMPOSER_SELECTORS = '.trae-input';
  const config = getConfig();
  assert.deepStrictEqual(config.composerSelectors, ['.trae-input']);
  delete process.env.TRAE_COMPOSER_SELECTORS;
});

(async () => {
  for (const { name, promise } of pendingAsyncTests) {
    try {
      const result = await promise;
      if (!result.ok) throw result.err;
      passed++;
      console.log(`  PASS: ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL: ${name}`);
      console.error(`        ${err.message}`);
    }
  }

  console.log(`\n[dom-driver.test.js] Results: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
