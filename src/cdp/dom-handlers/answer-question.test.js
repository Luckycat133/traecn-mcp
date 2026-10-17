'use strict';

const assert = require('assert');
const vm = require('vm');
const { checkForApprovalDialog } = require('./dialogs');
const { answerQuestionDialog } = require('./answer-question');
const { createRunner } = require('../../shared/test-runner');

const r = createRunner('answer-question.test.js');
const { asyncTest, pendingAsyncTests, summary } = r;

function element(tag, attributes = {}, text = '', children = []) {
  const node = {
    nodeType: 1, tagName: tag.toUpperCase(), className: attributes.class || '', parentElement: null,
    children, childNodes: [],
    get textContent() { return node.childNodes.map(child => child.textContent).join(''); },
    get innerText() { return node.childNodes.map(child => child.textContent).join('\n'); },
    get offsetParent() { return attributes.hidden || node.parentElement?.offsetParent === null ? null : {}; },
    getAttribute(name) { return name === 'class' ? node.className : (attributes[name] ?? null); },
    getBoundingClientRect() { return { x: 0, y: 0, width: 420, height: 152, top: 0, bottom: 152 }; },
    matches(selectors) {
      return selectors.split(',').some(selector => {
        const negativeSelectors = [...selector.matchAll(/:not\(([^)]+)\)/g)].map(match => match[1]);
        if (negativeSelectors.some(negative => node.matches(negative))) return false;
        selector = selector.replace(/:not\([^)]+\)/g, '');
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
    querySelector(selectors) { return node.querySelectorAll(selectors)[0] || null; },
    dispatchEvent(event) {
      if (event.type === 'click') node.click();
      return true;
    },
    click() { if (node.offsetParent !== null && !attributes.disabled) attributes.onClick?.(); }
  };
  if (text) node.childNodes.push({ nodeType: 3, textContent: text, parentElement: node });
  children.forEach(child => { child.parentElement = node; node.childNodes.push(child); });
  return node;
}

function replaceChildren(node, children) {
  node.children = children;
  node.childNodes = children;
  children.forEach(child => { child.parentElement = node; });
}

function parseHtml(html) {
  const root = element('body');
  const stack = [root];
  for (const token of html.match(/<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('</')) { stack.pop(); continue; }
    if (token.startsWith('<')) {
      const tag = /^<([\w-]+)/.exec(token)?.[1];
      if (!tag) continue;
      const attributes = {};
      for (const match of token.slice(tag.length + 1).matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
        attributes[match[1]] = match[2] === undefined ? true : match[2];
      }
      const node = element(tag, attributes);
      const parent = stack[stack.length - 1];
      node.parentElement = parent;
      parent.children.push(node);
      parent.childNodes.push(node);
      if (!/^(input|br|hr|img)$/i.test(tag)) stack.push(node);
    } else {
      const parent = stack[stack.length - 1];
      parent.childNodes.push({ nodeType: 3, textContent: token, parentElement: parent });
    }
  }
  return root;
}

// Captured in 0139-real-native-question-all-actual-classes.json, 2026-10-03.
// Only decorative SVGs and inline styles were removed; classes, options,
// keyboard hints and native buttons retain their actual captured structure.
const observedNativePanelHtml = "<div class=\"ask-user-question-bottom-panel\"><div><div class=\"questionCard-dak5fA\"><div class=\"header-M0_b83\"><div class=\"headerLeft-IvszEi\"><span class=\"avatar-DpTSCw\"><div class=\"agent-avatar agent-avatar--solo-code\"></div></span><span class=\"trigger-RljaZJ\"><span class=\"textEllipsis-S7xiKR multiLine-xA7XuE title-KhzjW7\">What would you like me to review?</span></span></div><div class=\"headerRight-WJVH1v\"><div class=\"pagination-5D1TfU\"><button class=\"paginationBtn-Yjsgrq\" disabled=\"\" aria-label=\"Previous question\"><span class=\"ai-chat-v2-icon-wrap\"></span></button><span class=\"paginationText-sxAhz7\">1 of 1</span><button class=\"paginationBtn-Yjsgrq\" disabled=\"\" aria-label=\"Next question\"><span class=\"ai-chat-v2-icon-wrap\"></span></button></div><span class=\"trigger-RljaZJ\"><button class=\"iconButton-Q3VY7z tertiary-kDbrxb small-OBA1vF closeBtn-SSnnSL\" aria-label=\"Close\"><span class=\"icon-_l_X9w\"><span class=\"ai-chat-v2-icon-wrap\"></span></span></button></span></div></div><div class=\"body-s2RLDN\"><div class=\"choiceList-hYzxPX\"><div class=\"optionItem-FPs_un optionItemFocused-ocAJvB\"><div class=\"optionContent-RwGn8B\"><div class=\"optionLabelRow-gcwffZ\"><span class=\"optionLabel-i_zksK\">Current workspace changes</span><span class=\"trigger-RljaZJ\"><span class=\"textEllipsis-S7xiKR singleLine-fhb4IH optionDescription-e6HnVI\">Review uncommitted changes in the current working directory</span></span></div></div><div class=\"optionIcons-HsyL1U\"><span class=\"arrowIcon-HN8neg arrowIconDisabled-cPhw1E\"></span><span class=\"arrowIcon-HN8neg \"></span></div></div><div class=\"optionItem-FPs_un\"><div class=\"optionContent-RwGn8B\"><div class=\"optionLabelRow-gcwffZ\"><span class=\"optionLabel-i_zksK\">Latest commit changes</span><span class=\"trigger-RljaZJ\"><span class=\"textEllipsis-S7xiKR singleLine-fhb4IH optionDescription-e6HnVI\">Review changes introduced in the most recent commit</span></span></div></div></div><div class=\"optionItem-FPs_un\"><div class=\"optionContent-RwGn8B\"><div class=\"optionLabelRow-gcwffZ\"><span class=\"optionLabel-i_zksK\">Specific files or folder</span><span class=\"trigger-RljaZJ\"><span class=\"textEllipsis-S7xiKR singleLine-fhb4IH optionDescription-e6HnVI\">Review a specific set of files or a folder you designate</span></span></div></div></div><div class=\"optionItem-FPs_un optionItemOther-RebrrH\"><div class=\"optionContent-RwGn8B\"><div class=\"optionLabelRow-gcwffZ\"><span class=\"optionLabel-i_zksK\">其他</span><div class=\"otherInputContainer-p1dFmJ\"><div class=\"otherInputWrapper-m5HxHa\"><textarea class=\"otherTextarea-H6vnYk custom-scrollbar\" placeholder=\"请输入\" data-qa-other=\"1\" data-single-line=\"1\"></textarea><span class=\"otherCounter-n7dNkh\">0/500</span></div></div></div></div></div></div></div><div class=\"footerWrapper-O2K1Mw footerVisible-An8MZv\"><div class=\"footer-jgAdou\"><button class=\"button-eTMLAq secondary-vqziyI large-pMPYfj footerBtnFixed-otR2Yd\"><span class=\"label-ID0ZqM \">取消<kbd class=\"footerKbd-bFlf1Z\">ESC</kbd></span></button><button class=\"button-eTMLAq primary-neY4ia large-pMPYfj footerBtnFixed-otR2Yd\"><span class=\"label-ID0ZqM \">提交<kbd class=\"footerKbd-bFlf1Z\"></kbd></span></button></div></div></div></div></div>";

function capturedPanelFixture({ retainAfterSubmit = false, nonReview = false } = {}) {
  let html = observedNativePanelHtml;
  if (nonReview) {
    html = html.replace('What would you like me to review?', 'Which output format do you prefer?')
      .replace('Current workspace changes', 'JSON').replace('Latest commit changes', 'CSV').replace('Specific files or folder', 'Plain text');
  }
  const body = parseHtml(html);
  const panel = body.querySelector('.ask-user-question-bottom-panel');
  const state = { selected: null, optionActivations: 0, actionActivations: 0, otherActivations: 0, submitted: false };
  // Bind the captured optionItem nodes, not their label/content wrappers.
  for (const option of panel.querySelectorAll('[class*="optionItem-"]')) {
    option.activate = () => {
      if (option.className.includes('optionItemOther-')) { state.otherActivations++; return; }
      state.optionActivations++;
      state.selected = option.querySelector('[class*="optionLabel-"]').textContent;
    };
  }
  const submit = panel.querySelector('[class*="primary-"]');
  submit.activate = () => {
    state.actionActivations++;
    if (!state.selected) return;
    state.submitted = true;
    if (!retainAfterSubmit) replaceChildren(body, []);
  };
  const driver = {
    config: { postActionDelayMs: 0 },
    client: { async send(method, params) {
      assert.strictEqual(method, 'Runtime.evaluate');
      const value = vm.runInNewContext(params.expression, {
        document: { body, querySelectorAll: selectors => body.querySelectorAll(selectors), querySelector: selectors => body.querySelector(selectors) },
        window: { innerHeight: 900 },
        PointerEvent: class { constructor(type) { this.type = type; } },
        MouseEvent: class { constructor(type) { this.type = type; } }
      }, { timeout: 1000 });
      return { result: { value: JSON.parse(JSON.stringify(value)) } };
    } }
  };
  // Exercise the actual click event once, including its nearest native handler.
  const bindClicks = node => {
    node.dispatchEvent = event => {
      if (event.type === 'click') node.activate?.();
      return true;
    };
    node.click = () => node.activate?.();
    node.children.forEach(bindClicks);
  };
  bindClicks(body);
  driver.checkForApprovalDialog = () => checkForApprovalDialog(driver);
  return { driver, state };
}

function fixture({ question = 'What would you like me to review?', options = ['Latest commit changes', 'Uncommitted changes'], submit = '提交', next = '下一个', count = 1, cancel = false, retainAfterSubmit = false, ordinary = false } = {}) {
  const state = { index: 0, selected: null, submitted: false, clicked: [], answers: [], optionActivations: 0, actionActivations: 0 };
  const cardAttributes = { class: 'ask-user-question-card-container ask-user-question-card-status-pending' };
  const card = element('div', cardAttributes);

  // Structural fixture taken from the installed desktop-modules/dist/index.mjs:
  // QuestionCard -> question-content -> SingleChoice -> CheckboxItem -> ActionBar.
  // The actual V2 footer uses Next before the last question, then Submit.
  function render() {
    const choiceItems = options.map(label => element('div', { class: 'ask-user-single-choice-item' }, '', [
      element('div', { class: 'icd-checkbox-item-container', onClick() {
        state.optionActivations++;
        state.selected = label;
        state.clicked.push(`option:${label}`);
      } }, '', [
        element('div', { class: 'icd-checkbox-item-checkbox-wrapper' }),
        element('div', { class: 'icd-checkbox-item-content' }, '', [element('div', { class: 'icd-checkbox-item-label' }, label)])
      ])
    ]));
    const label = state.index < count - 1 ? next : submit;
    const buttons = [element('button', { onClick() {
      state.actionActivations++;
      state.clicked.push(label);
      if (!state.selected) return;
      state.answers.push(state.selected);
      if (state.index < count - 1) {
        state.index++;
        state.selected = null;
        render();
      } else {
        state.submitted = true;
        if (!retainAfterSubmit) {
          card.className = 'ask-user-question-card-container ask-user-question-card-status-completed';
          replaceChildren(card, [element('div', { class: 'ask-user-question-history' }, `${question} ${state.selected}`)]);
        }
      }
    } }, label)];
    if (cancel) buttons.unshift(element('button', {}, '取消'));
    replaceChildren(card, [element('div', { class: 'ask-user-question-card-content-wrapper' }, '', [
      element('div', { class: 'ask-user-question-card-content' }, '', [
        element('div', { class: 'ask-user-question-content-container' }, '', [
          element('div', { class: 'ask-user-question-content-title-section' }, question),
          element('div', { class: 'ask-user-question-content-options-section' }, '', [
            element('div', { class: 'ask-user-single-choice-container' }, '', choiceItems)
          ]),
          element('div', { class: 'ask-user-question-content-action-section' }, '', [
            element('div', { class: 'icd-action-bar-container' }, '', [element('div', { class: 'icd-action-bar-right' }, '', buttons)])
          ])
        ])
      ])
    ])]);
  }
  render();
  const body = ordinary
    ? element('body', {}, '', [element('div', { class: 'turn__agent-message', 'data-role': 'assistant' }, `${question} Review Scope Latest commit changes Uncommitted changes 提交`)])
    : element('body', {}, '', [card]);
  const driver = {
    config: { postActionDelayMs: 0 },
    client: { async send(method, params) {
      assert.strictEqual(method, 'Runtime.evaluate');
      const value = vm.runInNewContext(params.expression, {
        document: { body, querySelectorAll: selectors => body.querySelectorAll(selectors), querySelector: selectors => body.querySelector(selectors) },
        window: { innerHeight: 900 },
        PointerEvent: class { constructor(type) { this.type = type; } },
        MouseEvent: class { constructor(type) { this.type = type; } }
      }, { timeout: 1000 });
      return { result: { value: JSON.parse(JSON.stringify(value)) } };
    } }
  };
  driver.checkForApprovalDialog = () => checkForApprovalDialog(driver);
  return { driver, state };
}

for (const submit of ['Submit', '提交']) {
  asyncTest(`native single-question review scope detects its ${submit} footer`, async () => {
    const f = fixture({ submit });
    const dialog = await f.driver.checkForApprovalDialog();
    assert.strictEqual(dialog.needsApproval, true);
    assert.strictEqual(dialog.dialogType, 'review_scope_question');
    assert.ok(dialog.buttons.includes(submit));
    assert.deepStrictEqual(dialog.options.map(option => option.label), ['Latest commit changes', 'Uncommitted changes']);
  });

  asyncTest(`native single-question review scope selects its real option and ${submit}`, async () => {
    const f = fixture({ submit, cancel: true });
    const result = await answerQuestionDialog(f.driver, 'Uncommitted changes');
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.buttonClicked, submit);
    assert.deepStrictEqual(f.state.answers, ['Uncommitted changes']);
    assert.strictEqual(f.state.optionActivations, 1);
    assert.strictEqual(f.state.actionActivations, 1);
    assert.strictEqual(f.state.submitted, true);
    assert.deepStrictEqual(await f.driver.checkForApprovalDialog(), { needsApproval: false });
  });
}

asyncTest('multi-question review scope retains Next and requires final Submit before success', async () => {
  const f = fixture({ count: 2, next: 'Next', submit: 'Submit', cancel: true });
  const first = await answerQuestionDialog(f.driver, 'Uncommitted changes');
  assert.strictEqual(first.success, false, 'an unanswered second question cannot be treated as resolved');
  assert.strictEqual(first.buttonClicked, 'Next');
  assert.strictEqual(f.state.index, 1);
  assert.strictEqual(f.state.submitted, false);
  assert.strictEqual(f.state.optionActivations, 1);
  assert.strictEqual(f.state.actionActivations, 1);
  const second = await answerQuestionDialog(f.driver, 'Latest commit changes');
  assert.strictEqual(second.success, true, second.error);
  assert.strictEqual(second.buttonClicked, 'Submit');
  assert.deepStrictEqual(f.state.answers, ['Uncommitted changes', 'Latest commit changes']);
  assert.strictEqual(f.state.optionActivations, 2);
  assert.strictEqual(f.state.actionActivations, 2);
});

asyncTest('a Submit click that leaves the review scope card visible cannot report success', async () => {
  const f = fixture({ retainAfterSubmit: true, cancel: true });
  const result = await answerQuestionDialog(f.driver, 'Uncommitted changes');
  assert.strictEqual(f.state.submitted, true);
  assert.strictEqual(result.success, false);
  assert.match(result.error, /remained visible/);
});

asyncTest('ordinary assistant review wording is not a native question card', async () => {
  const f = fixture({ ordinary: true });
  assert.deepStrictEqual(await f.driver.checkForApprovalDialog(), { needsApproval: false });
  const result = await answerQuestionDialog(f.driver, 'Uncommitted changes');
  assert.strictEqual(result.success, false);
  assert.deepStrictEqual(f.state.clicked, []);
});

asyncTest('a non-review native question remains outside the review-scope answering contract', async () => {
  const f = fixture({ question: 'Which output format do you prefer?', options: ['JSON', 'CSV'], cancel: true });
  assert.deepStrictEqual(await f.driver.checkForApprovalDialog(), { needsApproval: false });
  const result = await answerQuestionDialog(f.driver, 'JSON');
  assert.strictEqual(result.success, false);
  assert.deepStrictEqual(f.state.clicked, []);
});

asyncTest('captured bottom panel is detected with exact labels, descriptions and keyboard-free footer', async () => {
  const f = capturedPanelFixture();
  const dialog = await f.driver.checkForApprovalDialog();
  assert.strictEqual(dialog.needsApproval, true);
  assert.strictEqual(dialog.dialogType, 'review_scope_question');
  assert.deepStrictEqual(dialog.buttons, ['取消', '提交']);
  assert.deepStrictEqual(dialog.options, [
    { label: 'Current workspace changes', description: 'Review uncommitted changes in the current working directory' },
    { label: 'Latest commit changes', description: 'Review changes introduced in the most recent commit' },
    { label: 'Specific files or folder', description: 'Review a specific set of files or a folder you designate' }
  ]);
});

asyncTest('captured bottom panel selects its original optionItem and submits once', async () => {
  const f = capturedPanelFixture();
  const result = await answerQuestionDialog(f.driver, 'Current workspace changes');
  assert.strictEqual(result.success, true, result.error);
  assert.strictEqual(result.buttonClicked, '提交');
  assert.strictEqual(f.state.selected, 'Current workspace changes');
  assert.strictEqual(f.state.optionActivations, 1);
  assert.strictEqual(f.state.actionActivations, 1);
  assert.strictEqual(f.state.otherActivations, 0);
  assert.strictEqual(f.state.submitted, true);
});

asyncTest('captured bottom panel still visible after Submit remains unresolved', async () => {
  const f = capturedPanelFixture({ retainAfterSubmit: true });
  const result = await answerQuestionDialog(f.driver, 'Current workspace changes');
  assert.strictEqual(f.state.submitted, true);
  assert.strictEqual(result.success, false);
  assert.match(result.error, /remained visible/);
  assert.strictEqual(f.state.actionActivations, 1);
});

asyncTest('captured bottom panel cannot treat Other input wrappers as an offered click-only answer', async () => {
  const f = capturedPanelFixture();
  const result = await answerQuestionDialog(f.driver, '其他');
  assert.strictEqual(result.success, false);
  assert.strictEqual(f.state.otherActivations, 0);
  assert.strictEqual(f.state.actionActivations, 0);
});

asyncTest('a bottom panel with non-review question/options remains outside scope', async () => {
  const f = capturedPanelFixture({ nonReview: true });
  assert.deepStrictEqual(await f.driver.checkForApprovalDialog(), { needsApproval: false });
  const result = await answerQuestionDialog(f.driver, 'JSON');
  assert.strictEqual(result.success, false);
  assert.strictEqual(f.state.optionActivations, 0);
  assert.strictEqual(f.state.actionActivations, 0);
});

(async () => {
  await pendingAsyncTests();
  summary();
  if (r.failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
