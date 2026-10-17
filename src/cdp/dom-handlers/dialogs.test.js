'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { checkForApprovalDialog, approveDialog } = require('./dialogs');
const { DomDriver } = require('../dom-driver');
const { createRunner } = require('../../shared/test-runner');
const r = createRunner('dialogs.test.js');
const { asyncTest, pendingAsyncTests, summary } = r;

function element(tag, attributes = {}, text = '', children = []) {
  const node = {
    nodeType: 1, tagName: tag.toUpperCase(), className: attributes.class || '', parentElement: null, attributes,
    children, childNodes: [], value: attributes.value || '',
    get textContent() { return node.childNodes.map(child => child.textContent).join(''); },
    get innerText() { return node.childNodes.map(child => child.textContent).join('\n'); },
    get offsetParent() { return attributes.hidden || node.parentElement?.offsetParent === null ? null : {}; },
    getAttribute(name) { return name === 'class' ? node.className : (attributes[name] ?? null); },
    getBoundingClientRect() { return { width: 420, height: 152, top: 0, bottom: 152 }; },
    matches(selectors) {
      return selectors.split(',').some(selector => {
        const tagMatch = selector.trim().match(/^[a-z][\w-]*/i);
        if (tagMatch && node.tagName !== tagMatch[0].toUpperCase()) return false;
        const outsideAttributes = selector.replace(/\[[^\]]+\]/g, '');
        for (const match of outsideAttributes.matchAll(/\.([\w-]+)/g)) {
          if (!node.className.split(/\s+/).includes(match[1])) return false;
        }
        for (const match of selector.matchAll(/\[([\w-]+)(?:([*]?=)["']?([^\]"']*)["']?)?\]/g)) {
          const value = node.getAttribute(match[1]);
          if (value === null) return false;
          if (match[2] === '=' && value !== match[3]) return false;
          if (match[2] === '*=' && !String(value).includes(match[3])) return false;
        }
        return true;
      });
    },
    closest(selectors) {
      for (let current = node; current; current = current.parentElement) {
        if (current.matches(selectors)) return current;
      }
      return null;
    },
    querySelectorAll(selectors) {
      const matches = [];
      const visit = current => {
        for (const child of current.children) {
          if (child.matches(selectors)) matches.push(child);
          visit(child);
        }
      };
      visit(node);
      return matches;
    },
    querySelector(selectors) { return node.querySelectorAll(selectors)[0] || null; }
  };
  if (text) node.childNodes.push({ nodeType: 3, textContent: text, parentElement: node });
  children.forEach(child => { child.parentElement = node; node.childNodes.push(child); });
  return node;
}

const cpuNotice = '系统 CPU 使用率 99%，python（PID 90379）运行 skillspector 扫描占用 87.1% CPU，建议在活动监视器中查看处理';

function notification({ text = cpuNotice, role = 'dialog', detached = false, buttons = null } = {}) {
  const row = element('div', { class: 'monaco-list-row', role }, '', [
    element('div', { class: 'notification-list-item expanded' }, '', [
      element('div', { class: 'notification-list-item-buttons-container' }, '', buttons || [
        element('a', { role: 'button', class: 'icube-btn-primary-primary' }, '查看详情'),
        element('a', { role: 'button', class: 'icube-btn-secondary-primary' }, '一键优化'),
        element('a', { role: 'button', class: 'icube-btn-secondary-primary' }, '今日不再提醒')
      ]),
      element('div', { class: 'notification-list-item-message' }, text)
    ])
  ]);
  if (detached) return row;
  return element('div', { class: 'notifications-toasts visible' }, '', [
    element('div', { class: 'notification-toast-container' }, '', [
      element('div', { class: 'notification-toast notification-fade-in-done' }, '', [
        element('div', { class: 'notifications-list-container' }, '', [
          element('div', { class: 'monaco-list mouse-support' }, '', [
            element('div', { class: 'monaco-scrollable-element', role: 'presentation' }, '', [
              element('div', { class: 'monaco-list-rows' }, '', [row])
            ])
          ])
        ])
      ])
    ])
  ]);
}

function commandCard(command = 'find /tmp/fixture -delete') {
  return element('div', { class: 'icd-run-command-card-v2 icd-card-container-active' },
    '检测到高风险命令，是否仍要运行？', [
      element('textarea', { value: command }),
      element('button', {}, '跳过'), element('button', {}, '运行')
    ]);
}

function dialogDriver(children, { beforeEvaluation } = {}) {
  const body = element('body', {}, '', children);
  const document = {
    body,
    querySelectorAll: selectors => body.querySelectorAll(selectors),
    querySelector: selectors => body.querySelector(selectors),
    createTreeWalker(root, _whatToShow, filter) {
      const nodes = [];
      const visit = node => {
        if (node.nodeType === 3) {
          if (filter.acceptNode(node) === 1) nodes.push(node);
        } else node.childNodes.forEach(visit);
      };
      visit(root);
      return { nextNode: () => nodes.shift() || null };
    }
  };
  let evaluations = 0;
  const driver = {
    config: { postActionDelayMs: 0 },
    client: { async send(method, params) {
      assert.strictEqual(method, 'Runtime.evaluate');
      if (beforeEvaluation) beforeEvaluation(++evaluations);
      const value = vm.runInNewContext(params.expression, {
        document, window: { innerHeight: 900 },
        getComputedStyle: node => ({ display: node.attributes?.hidden ? 'none' : 'block', visibility: 'visible' }),
        PointerEvent: class { constructor(type) { this.type = type; } },
        MouseEvent: class { constructor(type) { this.type = type; } },
        NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 }
      }, { timeout: 1000 });
      return { result: { value: JSON.parse(JSON.stringify(value)) } };
    } }
  };
  driver.checkForApprovalDialog = () => checkForApprovalDialog(driver);
  return driver;
}

async function detect(children) {
  return checkForApprovalDialog(dialogDriver(children));
}

const ACTUAL_NATIVE_COMMAND = '/bin/rm /private/tmp/traecnclaw-approval-fixture-20261003-0437.txt; echo "EXIT_CODE=$?"';

// Verbatim sanitized live panel from record 0227, without account/profile DOM.
// Parse the actual HTML, then execute the real detection/click expressions.
function nativeCommandPanel({ hidden = false, disabled = false, busy = false,
  noCommand = false, noActions = false, command = ACTUAL_NATIVE_COMMAND } = {}) {
  const root = element('root');
  const stack = [root];
  const html = fs.readFileSync(path.join(__dirname, '../../../tests/fixtures/cdp/command-approval-panel-1.107.1.html'), 'utf8');
  for (const token of html.matchAll(/<\/([^>]+)>|<([\w-]+)([^>]*)>|([^<]+)/g)) {
    if (token[1]) stack.pop();
    else if (token[2]) {
      const attributes = Object.fromEntries(Array.from(token[3].matchAll(/([\w-]+)="([^"]*)"/g), match => [match[1], match[2]]));
      const node = element(token[2], attributes);
      const parent = stack[stack.length - 1];
      parent.children.push(node);
      parent.childNodes.push(node);
      node.parentElement = parent;
      stack.push(node);
    } else stack[stack.length - 1].childNodes.push({ nodeType: 3, textContent: token[4], parentElement: stack[stack.length - 1] });
  }
  const panel = root.children[0];
  panel.attributes.hidden = hidden;
  const commandNode = panel.querySelector('.commandText-rHrSgO');
  commandNode.childNodes = [{ nodeType: 3, textContent: command, parentElement: commandNode }];
  function remove(node) {
    node.parentElement.children = node.parentElement.children.filter(child => child !== node);
    node.parentElement.childNodes = node.parentElement.childNodes.filter(child => child !== node);
  }
  if (noCommand) remove(commandNode);
  if (noActions) remove(panel.querySelector('.confirmActionList-HHLy11'));
  const clicks = [];
  const actions = panel.querySelectorAll('.confirmActionItem-R9PwIE');
  for (const action of actions) {
    action.attributes['aria-disabled'] = String(disabled);
    action.attributes['aria-busy'] = String(busy);
    const label = action.querySelector('.confirmActionLabel-FBOWQC').textContent;
    action.dispatchEvent = event => {
      if (event.type === 'click') { clicks.push(label); if (panel.parentElement) remove(panel); }
    };
    action.click = () => { throw new Error('native action must be clicked once'); };
  }
  return { panel, clicks, actions, commandNode };
}

function decoyRunButton() {
  const clicks = [];
  const button = element('button', {}, '运行');
  button.dispatchEvent = event => { if (event.type === 'click') clicks.push('dispatch'); };
  button.click = () => clicks.push('native');
  return { button, clicks };
}

asyncTest('observed CPU notification role=dialog is not a task approval', async () => {
  assert.deepStrictEqual(await detect([notification()]), { needsApproval: false });
});

asyncTest('notification content is excluded from legacy approval text fallback', async () => {
  assert.deepStrictEqual(await detect([notification({ text: 'Do you want to proceed? requires your confirmation' })]), {
    needsApproval: false
  });
});

asyncTest('notification approval-like buttons and alertdialog roles remain excluded', async () => {
  assert.deepStrictEqual(await detect([notification({ role: 'alertdialog', text: '需要您的批准', buttons: [
    element('button', { 'aria-label': 'Allow', class: 'approve' }, '运行')
  ] })]), { needsApproval: false });
});

asyncTest('a detached Monaco notification row is identified by its actual notification item', async () => {
  assert.deepStrictEqual(await detect([notification({ detached: true })]), { needsApproval: false });
});

asyncTest('a notification preceding a genuine modal cannot mask the task approval', async () => {
  const result = await detect([notification(), element('div', { role: 'dialog', class: 'monaco-dialog' }, '', [
    element('div', { class: 'monaco-dialog-title' }, '运行危险命令需要确认'),
    element('button', {}, '批准'), element('button', {}, '取消')
  ])]);
  assert.strictEqual(result.needsApproval, true);
  assert.strictEqual(result.dialogType, 'monaco-dialog');
  assert.strictEqual(result.question, '运行危险命令需要确认');
  assert.strictEqual(result.canAutoApprove, false);
});

asyncTest('a real modal with the notification text is still detected outside notification containers', async () => {
  const result = await detect([element('div', { role: 'dialog', class: 'notification-permissions-dialog' }, cpuNotice, [
    element('button', {}, '确认')
  ])]);
  assert.strictEqual(result.needsApproval, true);
  assert.strictEqual(result.isCommandExec, true);
  assert.strictEqual(result.commandRisk, 'unknown');
});

asyncTest('high-risk inline command approval remains detectable beside an application notification', async () => {
  const result = await detect([notification(), commandCard()]);
  assert.strictEqual(result.needsApproval, true);
  assert.strictEqual(result.dialogType, 'command_execution');
  assert.strictEqual(result.command, 'find /tmp/fixture -delete');
  assert.strictEqual(result.commandRisk, 'high');
  assert.deepStrictEqual(result.riskReasons, ['filesystem_write_via_find']);
  assert.strictEqual(result.canAutoApprove, false);
});

asyncTest('unknown inline commands continue to require explicit review', async () => {
  const result = await detect([notification(), commandCard('custom-tool inspect repo')]);
  assert.strictEqual(result.needsApproval, true);
  assert.strictEqual(result.commandRisk, 'unknown');
  assert.strictEqual(result.approvalDecision, 'agent_review');
  assert.deepStrictEqual(result.riskReasons, ['unknown_command']);
});

asyncTest('real legacy approval text remains detectable outside application notifications', async () => {
  const result = await detect([notification(), element('section', {}, 'requires your confirmation')]);
  assert.strictEqual(result.needsApproval, true);
  assert.strictEqual(result.dialogType, 'text-pattern');
  assert.strictEqual(result.question, 'requires your confirmation');
});

asyncTest('review-scope questions remain detectable beside unrelated notifications', async () => {
  const card = element('div', { class: 'ask-user-question-card-container' }, 'What would you like me to review? Review Scope', [
    element('div', { role: 'option' }, 'Latest commit changes'),
    element('div', { role: 'option' }, 'Uncommitted changes'),
    element('button', {}, 'Cancel'), element('button', {}, 'Next')
  ]);
  const result = await detect([notification(), card]);
  assert.strictEqual(result.needsApproval, true);
  assert.strictEqual(result.dialogType, 'review_scope_question');
  assert.strictEqual(result.isCommandExec, false);
  assert.deepStrictEqual(result.options.map(option => option.label), ['Latest commit changes', 'Uncommitted changes']);
});

asyncTest('captured native command panel exposes the complete command and exact action labels', async () => {
  const fixture = nativeCommandPanel();
  const result = await detect([fixture.panel]);
  assert.strictEqual(result.needsApproval, true);
  assert.strictEqual(result.dialogType, 'command_execution');
  assert.strictEqual(result.question, '是否允许运行这个命令？');
  assert.strictEqual(result.command, ACTUAL_NATIVE_COMMAND);
  assert.deepStrictEqual(result.buttons, ['运行', '跳过']);
  assert.strictEqual(result.approvalDecision, 'agent_review');
  assert.strictEqual(result.commandRisk, 'high');
  assert.strictEqual(result.canAutoApprove, false);
  assert.deepStrictEqual(fixture.clicks, [], 'detection must not act');
});

asyncTest('native command extraction preserves long text, semicolons and shell quotes', async () => {
  const command = `/bin/rm /private/tmp/${'fixture-'.repeat(170)}.txt; echo "EXIT_CODE=$?"`;
  const result = await detect([nativeCommandPanel({ command }).panel]);
  assert.strictEqual(result.command, command);
});

asyncTest('hidden, busy and fully disabled native panels cannot reenter legacy text fallback', async () => {
  for (const options of [{ hidden: true }, { disabled: true }, { busy: true }]) {
    assert.deepStrictEqual(await detect([nativeCommandPanel(options).panel]), { needsApproval: false });
  }
  const parent = element('section', { hidden: true }, '', [nativeCommandPanel().panel]);
  assert.deepStrictEqual(await detect([parent]), { needsApproval: false });
});

asyncTest('a native title without a command or complete actions is not executable approval', async () => {
  for (const options of [{ noCommand: true }, { noActions: true }, { command: '' }]) {
    assert.deepStrictEqual(await detect([nativeCommandPanel(options).panel]), { needsApproval: false });
  }
});

asyncTest('chat, code and notifications quoting the native panel do not request approval', async () => {
  for (const wrapper of [element('pre'), element('code'), element('section', { class: 'markdown-renderer' }),
    element('div', { class: 'notification-list-item' })]) {
    const panel = nativeCommandPanel().panel;
    wrapper.children.push(panel); wrapper.childNodes.push(panel); panel.parentElement = wrapper;
    assert.deepStrictEqual(await detect([wrapper]), { needsApproval: false });
  }
  assert.deepStrictEqual(await detect([element('section', { class: 'markdown-renderer' },
    '引用：是否允许运行这个命令？')]), { needsApproval: false });
});

asyncTest('native approve clicks one scoped Run action and ignores unrelated Run buttons', async () => {
  const fixture = nativeCommandPanel();
  const decoy = decoyRunButton();
  const result = await approveDialog(dialogDriver([decoy.button, notification(), fixture.panel]), 'approve');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.buttonClicked, '运行');
  assert.deepStrictEqual(fixture.clicks, ['运行']);
  assert.deepStrictEqual(decoy.clicks, []);
});

asyncTest('native deny clicks the exact Skip action once', async () => {
  const fixture = nativeCommandPanel();
  const decoy = decoyRunButton();
  const result = await approveDialog(dialogDriver([decoy.button, fixture.panel]), 'deny');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.buttonClicked, '跳过');
  assert.deepStrictEqual(fixture.clicks, ['跳过']);
  assert.deepStrictEqual(decoy.clicks, []);
});

asyncTest('a disabled native Run never falls back to another Run button', async () => {
  const fixture = nativeCommandPanel();
  fixture.actions[0].attributes['aria-disabled'] = 'true';
  const decoy = decoyRunButton();
  const result = await approveDialog(dialogDriver([decoy.button, fixture.panel]), 'approve');
  assert.strictEqual(result.success, false);
  assert.deepStrictEqual(fixture.clicks, []);
  assert.deepStrictEqual(decoy.clicks, []);
});

asyncTest('native approval rejects command changes and multiple pending panels before any click', async () => {
  const changed = nativeCommandPanel();
  const driver = dialogDriver([changed.panel], { beforeEvaluation: number => {
    if (number === 2) changed.commandNode.childNodes[0].textContent = 'echo changed';
  } });
  assert.strictEqual((await approveDialog(driver, 'approve')).success, false);
  assert.deepStrictEqual(changed.clicks, []);
  const first = nativeCommandPanel();
  const second = nativeCommandPanel({ command: 'echo another' });
  assert.strictEqual((await approveDialog(dialogDriver([first.panel, second.panel]), 'approve')).success, false);
  assert.deepStrictEqual(first.clicks, []);
  assert.deepStrictEqual(second.clicks, []);
});

asyncTest('native approval does not claim success while the pending panel remains', async () => {
  const fixture = nativeCommandPanel();
  fixture.actions[0].dispatchEvent = event => { if (event.type === 'click') fixture.clicks.push('运行'); };
  const result = await approveDialog(dialogDriver([fixture.panel]), 'approve');
  assert.strictEqual(result.success, false);
  assert.deepStrictEqual(fixture.clicks, ['运行']);
});

asyncTest('native approval requires a successful post-click readback', async () => {
  const fixture = nativeCommandPanel();
  const driver = dialogDriver([fixture.panel], { beforeEvaluation: number => {
    if (number === 3) throw new Error('offline readback failure');
  } });
  const result = await approveDialog(driver, 'deny');
  assert.strictEqual(result.success, false);
  assert.deepStrictEqual(fixture.clicks, ['跳过']);
});

asyncTest('native approve and deny preserve the owner expected command through the thin shim', async () => {
  for (const action of ['approve', 'deny']) {
    const fixture = nativeCommandPanel();
    const client = dialogDriver([fixture.panel]).client;
    const driver = new DomDriver(client, { postActionDelayMs: 0 });
    const result = await driver.approveDialog(action, { expectedCommand: 'echo previously-authorized-command' });
    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(fixture.clicks, []);
  }
});

asyncTest('owner command binding rejects a replacement legacy approval before its Run can be clicked', async () => {
  const replacement = commandCard('echo replacement');
  const run = replacement.querySelectorAll('button')[1];
  const clicks = [];
  run.dispatchEvent = event => { if (event.type === 'click') clicks.push('dispatch'); };
  run.click = () => clicks.push('native');
  const result = await approveDialog(dialogDriver([replacement]), 'approve', { expectedCommand: ACTUAL_NATIVE_COMMAND });
  assert.strictEqual(result.success, false);
  assert.deepStrictEqual(clicks, []);
});

asyncTest('native command binding preserves internal whitespace and trims only outside whitespace', async () => {
  const command = '/bin/rm "/private/tmp/a   b.txt"; echo "EXIT_CODE=$?"';
  const mismatch = nativeCommandPanel({ command });
  const wrong = command.replace('a   b', 'a b');
  assert.strictEqual((await approveDialog(dialogDriver([mismatch.panel]), 'approve', { expectedCommand: wrong })).success, false);
  assert.deepStrictEqual(mismatch.clicks, []);
  const correct = nativeCommandPanel({ command });
  const result = await approveDialog(dialogDriver([correct.panel]), 'deny', { expectedCommand: `\n  ${command}  \n` });
  assert.strictEqual(result.success, true);
  assert.deepStrictEqual(correct.clicks, ['跳过']);
});

asyncTest('native readback ignores quoted and notification copies of the old panel', async () => {
  const fixture = nativeCommandPanel();
  const quotation = element('pre', {}, '', [nativeCommandPanel().panel]);
  const notice = element('div', { class: 'notification-list-item' }, '', [nativeCommandPanel().panel]);
  const result = await approveDialog(dialogDriver([quotation, notice, fixture.panel]), 'approve');
  assert.strictEqual(result.success, true);
  assert.deepStrictEqual(fixture.clicks, ['运行']);
});

asyncTest('native readback cannot claim disappearance when the old card is disabled or moved offscreen', async () => {
  for (const transition of ['disabled', 'offscreen']) {
    const fixture = nativeCommandPanel();
    fixture.actions[0].dispatchEvent = event => {
      if (event.type !== 'click') return;
      fixture.clicks.push('运行');
      if (transition === 'disabled') for (const node of fixture.actions) node.attributes['aria-disabled'] = 'true';
      else fixture.panel.getBoundingClientRect = () => ({ width: 420, height: 152, top: 5000, bottom: 5152 });
    };
    const result = await approveDialog(dialogDriver([fixture.panel]), 'approve');
    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(fixture.clicks, ['运行']);
  }
});

(async () => {
  await pendingAsyncTests();
  summary();
  if (r.failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
