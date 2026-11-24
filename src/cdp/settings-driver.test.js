'use strict';

const assert = require('assert');
const vm = require('vm');
const {
  SettingsDriver,
  SETTINGS_SECTIONS,
  SOLO_MODE_TABS,
  _listSettingsSidebarSections,
  _clickSidebarItem,
  _readSettingsContent
} = require('./settings-driver');
const { createRunner } = require('../shared/test-runner');

const r = createRunner('settings-driver.test.js');
const { test, asyncTest, pendingAsyncTests, summary } = r;

function makeClient(evaluations) {
  const queue = [...(evaluations || [])];
  return {
    send: async (method, params) => {
      if (method !== 'Runtime.evaluate') return { result: { value: null } };
      const next = queue.shift();
      if (typeof next === 'function') return next(params);
      if (next === undefined) return { result: { value: 'default-no-more' } };
      return next;
    }
  };
}

// Replays the safe structure captured from TraeCN 1.107.1: a TH header table,
// TD model/provider/empty-content cells, and a custom-model-no-data panel.
// Names are synthetic; no live account settings or credentials enter fixtures.
function modelTableDom({ populated = true } = {}) {
  const rect = () => ({ x: 900, y: 180, width: 381, height: 32 });
  const header = {
    tagName: 'TR',
    getBoundingClientRect: rect,
    querySelectorAll: () => []
  };
  const models = Array.from({ length: 18 }, (_, index) => {
    const name = { className: 'model-name-content', textContent: `Fixture Model ${index + 1}` };
    const cells = [
      { tagName: 'TD', textContent: name.textContent, querySelector: () => name, getBoundingClientRect: rect },
      { tagName: 'TD', className: 'provider-content', textContent: 'Fixture Provider', getBoundingClientRect: rect },
      { tagName: 'TD', className: 'empty-content', textContent: '', getBoundingClientRect: rect }
    ];
    return {
      tagName: 'TR',
      getBoundingClientRect: rect,
      querySelectorAll: selector => selector === 'td' ? cells : []
    };
  });
  const empty = { className: 'custom-model-no-data', getBoundingClientRect: rect };
  const table = { className: 'icd-accordion-table', getBoundingClientRect: rect };
  return {
    querySelectorAll: selector => {
      const selectors = selector.split(',').map(value => value.trim());
      if (selectors.some(value => value === '.icube-settings-container table tbody tr')) {
        return populated ? [header, ...models] : [header];
      }
      if (selectors.some(value => value === '.icube-settings-container table')) return [table];
      if (selectors.some(value => value === '.icube-settings-container .custom-model-no-data')) return [empty];
      return [];
    }
  };
}

function vmSettingsClient(documentForRead, inputEvents = []) {
  const style = el => ({ visibility: el?.hidden ? 'hidden' : 'visible', display: 'block' });
  const window = { getComputedStyle: style };
  return {
    send: async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' || method === 'Input.dispatchKeyEvent') {
        inputEvents.push(params);
        return {};
      }
      assert.strictEqual(method, 'Runtime.evaluate');
      const value = vm.runInNewContext(params.expression, {
        document: typeof documentForRead === 'function' ? documentForRead() : documentForRead,
        window,
        getComputedStyle: style,
        PointerEvent: class { constructor(type) { this.type = type; } },
        MouseEvent: class { constructor(type) { this.type = type; } }
      });
      return { result: { value } };
    }
  };
}

// Content-body HTML captured in record 0186 from TraeCN 1.107.1. Only the
// decorative SVG subtrees are removed; native classes, data and text remain.
const PERMISSION_SETTINGS_HTML = `<div class="icube-settings-content-body"><div class="permission-approval-settings">
  <div class="permission-approval-settings-section-title">常规任务</div>
  <div class="permission-approval-settings-card">
    <div class="permission-approval-settings-card-header">
      <div class="permission-approval-settings-card-header-title">权限模式</div>
      <div class="permission-approval-settings-card-header-desc">从任务输入聊天框中选择权限模式。 <span class="permission-approval-settings-inline-link">了解更多</span></div>
    </div>
    <div class="permission-approval-settings-mode-item">
      <div class="permission-approval-settings-mode-radio" data-checked="true"><div class="permission-approval-settings-mode-radio-dot"></div></div>
      <div class="permission-approval-settings-mode-icon"></div>
      <div class="permission-approval-settings-mode-content"><div class="permission-approval-settings-mode-text">
        <div class="permission-approval-settings-mode-label">手动审批</div>
        <div class="permission-approval-settings-mode-desc">在隔离环境中运行。高风险操作会被阻止，重要操作需要你的批准。</div>
      </div></div>
    </div>
    <div class="permission-approval-settings-mode-item">
      <div class="permission-approval-settings-mode-radio"><div class="permission-approval-settings-mode-radio-dot"></div></div>
      <div class="permission-approval-settings-mode-icon"></div>
      <div class="permission-approval-settings-mode-content"><div class="permission-approval-settings-mode-text">
        <div class="permission-approval-settings-mode-label">自动审批</div>
        <div class="permission-approval-settings-mode-desc">在隔离环境中运行。高风险操作会被阻止，重要操作由 AI 自动批准。</div>
      </div></div>
    </div>
    <div class="permission-approval-settings-mode-item">
      <div class="permission-approval-settings-mode-radio"><div class="permission-approval-settings-mode-radio-dot"></div></div>
      <div class="permission-approval-settings-mode-icon"></div>
      <div class="permission-approval-settings-mode-content"><div class="permission-approval-settings-mode-text">
        <div class="permission-approval-settings-mode-label">完全访问</div>
        <div class="permission-approval-settings-mode-desc">直接在你的电脑上运行，不使用隔离环境。它可以读写任何文件、跳过安全检查，并且不再请求批准。</div>
      </div></div>
    </div>
    <div class="permission-approval-settings-mode-item" data-disabled="true">
      <div class="permission-approval-settings-mode-radio" data-disabled="true"><div class="permission-approval-settings-mode-radio-dot"></div></div>
      <div class="permission-approval-settings-mode-icon"><span aria-hidden="true" class="codicon codicon-settings-gear"></span></div>
      <div class="permission-approval-settings-mode-content"><div class="permission-approval-settings-mode-text">
        <div class="permission-approval-settings-mode-label">自定义配置</div>
        <div class="permission-approval-settings-mode-desc">自定义审批规则、命令规则、文件系统和网络权限。</div>
      </div><button type="button" class="permission-approval-settings-mode-action">打开配置</button></div>
    </div>
  </div>
</div></div>`;

function permissionSettingsDom({ selected = '手动审批', hiddenPanel = false, hiddenCustom = false,
  insideSettings = true } = {}) {
  function matches(node, selector) {
    const tag = selector.match(/^[\w-]+/);
    if (tag && node.tagName !== tag[0].toUpperCase()) return false;
    const classes = Array.from(selector.matchAll(/\.([\w-]+)/g), match => match[1]);
    if (!classes.every(value => node.className.split(/\s+/).includes(value))) return false;
    return Array.from(selector.matchAll(/\[([\w-]+)(?:([*^$]?=)"([^"]*)")?\]/g)).every(match => {
      const value = node.getAttribute(match[1]);
      if (value === null) return false;
      if (!match[2]) return true;
      if (match[2] === '*=') return value.includes(match[3]);
      if (match[2] === '^=') return value.startsWith(match[3]);
      if (match[2] === '$=') return value.endsWith(match[3]);
      return value === match[3];
    });
  }
  function element(tagName, attributes, parentElement) {
    return {
      tagName: tagName.toUpperCase(), attributes, parentElement, children: [],
      get className() { return attributes.class || ''; },
      get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); },
      get innerText() { return this.textContent; },
      getAttribute: name => attributes[name] ?? null,
      getBoundingClientRect: () => ({ x: 900, y: 180, width: 381, height: 32 }),
      dispatchEvent: () => { throw new Error('permission inspection must never dispatch an event'); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      querySelectorAll(selector) {
        const all = [];
        const visit = node => {
          for (const child of node.children) if (typeof child !== 'string') { all.push(child); visit(child); }
        };
        visit(this);
        return all.filter(node => selector.split(',').some(part => {
          const chain = part.trim().split(/\s+/);
          if (!matches(node, chain.pop())) return false;
          let ancestor = node.parentElement;
          while (chain.length) {
            while (ancestor && ancestor !== this && !matches(ancestor, chain[chain.length - 1])) ancestor = ancestor.parentElement;
            if (!ancestor || ancestor === this) return false;
            chain.pop();
            ancestor = ancestor.parentElement;
          }
          return true;
        }));
      }
    };
  }
  const document = element('document', {}, null);
  const stack = [document];
  for (const token of PERMISSION_SETTINGS_HTML.matchAll(/<\/([^>]+)>|<([\w-]+)([^>]*)>|([^<]+)/g)) {
    if (token[1]) stack.pop();
    else if (token[2]) {
      const attrs = Object.fromEntries(Array.from(token[3].matchAll(/([\w-]+)="([^"]*)"/g), match => [match[1], match[2]]));
      const node = element(token[2], attrs, stack[stack.length - 1]);
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else stack[stack.length - 1].children.push(token[4]);
  }
  const panel = document.querySelector('.permission-approval-settings');
  panel.hidden = hiddenPanel;
  if (!insideSettings) document.querySelector('.icube-settings-content-body').attributes.class = 'ordinary-chat-content';
  for (const mode of panel.querySelectorAll('.permission-approval-settings-mode-item')) {
    const label = mode.querySelector('.permission-approval-settings-mode-label').textContent;
    const radio = mode.querySelector('.permission-approval-settings-mode-radio');
    if (label === selected) radio.attributes['data-checked'] = 'true';
    else delete radio.attributes['data-checked'];
    if (label === '自定义配置') mode.hidden = hiddenCustom;
  }
  return document;
}

// Matches the safe 1.107.1 capture: the label/description/current-value are
// siblings, while button[role=combobox] controls a Radix portal by its ID.
// Trigger current values and another dropdown's options are deliberate decoys.
function settingsDropdownFixture({ labelText = 'Markdown 文件的默认打开方式',
  initialValue = 'Markdown 预览模式', values = ['代码编辑器', 'Markdown 预览模式', 'Markdown 预览模式（扩展）'],
  agent = false, delayedOptions = 0, delayedSelection = 0 } = {}) {
  const events = [];
  let opened = false;
  let selected = initialValue;
  let pendingSelection = null;
  let optionReads = 0;
  let selectionReads = 0;
  const rect = (x, y) => () => ({ x, y, left: x, top: y, width: 160, height: 32 });
  const label = { innerText: labelText, textContent: labelText };
  const current = {
    get innerText() {
      if (pendingSelection && ++selectionReads > delayedSelection) {
        selected = pendingSelection;
        pendingSelection = null;
      }
      return selected;
    },
    get textContent() { return selected; },
    getBoundingClientRect: rect(500, 140)
  };
  const trigger = {
    getAttribute: name => ({ 'aria-controls': 'radix-:owned-markdown:', 'aria-expanded': String(opened), role: 'combobox' })[name] ?? null,
    getBoundingClientRect: rect(500, 140), disabled: false,
    scrollIntoView() {},
    dispatchEvent: event => { events.push(`trigger:${event.type}`); if (event.type === 'pointerdown') opened = true; }
  };
  const option = (text, index) => ({ textContent: text, innerText: text, getBoundingClientRect: rect(500, 180 + index * 40),
    getAttribute: name => name === 'role' ? 'option' : null,
    dispatchEvent: event => {
      events.push(`option:${text}:${event.type}`);
      if (event.type === 'pointerdown' || event.type === 'click') { selected = text; opened = false; }
    } });
  const choices = values.map(option);
  const portal = { getBoundingClientRect: rect(500, 180),
    getAttribute: name => name === 'role' ? 'listbox' : null,
    querySelectorAll: selector => selector === '[role="option"]' && ++optionReads > delayedOptions ? choices : [] };
  const unrelated = option('不属于此设置的选项', 5);
  const row = {
    get textContent() { return `${label.textContent}Markdown 文件将默认用此方式打开${selected}`; },
    get innerText() { return this.textContent; }, getBoundingClientRect: rect(100, 100),
    querySelector: selector => {
      if (selector === '.icb-setting-item-label') return label;
      if (selector.includes('combobox')) return trigger;
      if (selector.includes('auto-test-select-option')) return current;
      if (selector === '.icb-setting-item-description') return { innerText: 'Markdown 文件将默认用此方式打开' };
      return null;
    },
    dispatchEvent: event => events.push(`row:${event.type}`)
  };
  const activeSection = {
    getBoundingClientRect: rect(100, 180),
    classList: { contains: name => name === 'active' },
    querySelector: () => ({ innerText: '通用' })
  };
  const sidebar = { getBoundingClientRect: rect(100, 180), querySelectorAll: () => [activeSection] };
  const document = {
    location: agent ? { pathname: '/test/solo/solo-lite.html' } : undefined,
    querySelector: selector => agent && selector.includes('icube-settings-content-body') ? document : null,
    querySelectorAll: selector => {
      if (agent && selector === '.icube-settings-sidebar-container') return [sidebar];
      if (selector.includes('icb-setting-item-container')) return [row];
      if (selector === '[role="option"]') return opened ? [...choices, unrelated] : [unrelated];
      if (selector.includes('auto-test-select-option')) return [current, unrelated, ...(opened ? choices : [])];
      return [];
    },
    getElementById: id => id === 'radix-:owned-markdown:' && opened ? portal : null,
    dispatchEvent: event => events.push(`document:${event.type}`)
  };
  const inputEvents = [];
  let pointerMovedSinceOpen = false;
  const client = vmSettingsClient(document, inputEvents);
  const original = client.send;
  client.send = async (method, parameters) => {
    const result = await original(method, parameters);
    if (method === 'Input.dispatchMouseEvent' && parameters.type === 'mouseMoved' && opened) {
      pointerMovedSinceOpen = true;
    }
    if (method === 'Input.dispatchMouseEvent' && parameters.type === 'mouseReleased') {
      if (parameters.y === 156) {
        opened = true;
        optionReads = 0;
        pointerMovedSinceOpen = false;
      }
      else {
        const choice = choices.find((_, index) => parameters.y === 196 + index * 40);
        // The installed Radix Select prevents the first pointerup when no
        // pointermove has occurred after opening, before its value handler.
        if (choice && pointerMovedSinceOpen) {
          if (delayedSelection) pendingSelection = choice.textContent;
          else selected = choice.textContent;
          opened = false;
          events.push(`selected:${choice.textContent}`);
        }
      }
    }
    if (method === 'Input.dispatchKeyEvent' && parameters.type === 'keyDown' && parameters.key === 'Escape') opened = false;
    return result;
  };
  return { client, events, inputEvents, getSelected: () => selected, isOpen: () => opened,
    getOptionReads: () => optionReads, getSelectionReads: () => selectionReads };
}

function settingsToggleFixture({ checked = true, applyClick = true } = {}) {
  const input = { checked, dispatchEvent: event => { if (event.type === 'click' && applyClick) input.checked = !input.checked; } };
  const label = { textContent: '语音转录快捷键', innerText: '语音转录快捷键',
    getBoundingClientRect: () => ({ width: 100, height: 32 }), querySelector: () => null, click: () => {},
    closest: () => row };
  const row = { getBoundingClientRect: () => ({ width: 300, height: 40 }),
    querySelector: selector => selector === 'input[type="checkbox"]' ? input
      : (selector === '.icb-setting-item-label' ? label : null) };
  const document = { querySelectorAll: selector => selector === '.icb-setting-item-label' ? [label]
    : (selector.includes('icb-setting-item-container') ? [row] : []) };
  return { input, client: vmSettingsClient(document) };
}

console.log('\n[settings-driver.test.js] Running tests...\n');

test('SETTINGS_SECTIONS is a non-empty string array', () => {
  assert.ok(Array.isArray(SETTINGS_SECTIONS));
  assert.ok(SETTINGS_SECTIONS.length > 0);
  for (const section of SETTINGS_SECTIONS) {
    assert.strictEqual(typeof section, 'string');
  }
});

test('SOLO_MODE_TABS contains editor and settings tabs', () => {
  assert.ok(Array.isArray(SOLO_MODE_TABS));
  assert.ok(SOLO_MODE_TABS.includes('编辑器'));
  assert.ok(SOLO_MODE_TABS.includes('设置'));
});

asyncTest('_listSettingsSidebarSections parses discovered section names', async () => {
  const client = makeClient([
    { result: { value: JSON.stringify(['通用', '模型', 'MCP']) } }
  ]);
  const sections = await _listSettingsSidebarSections(client);
  assert.deepStrictEqual(sections, ['通用', '模型', 'MCP']);
});

asyncTest('_listSettingsSidebarSections filters invalid return values', async () => {
  assert.deepStrictEqual(await _listSettingsSidebarSections(makeClient([{ result: { value: 42 } }])), []);
  assert.deepStrictEqual(await _listSettingsSidebarSections(makeClient([{ result: { value: null } }])), []);
  assert.deepStrictEqual(await _listSettingsSidebarSections(makeClient([{ result: { value: '{bad json' } }])), []);
});

asyncTest('SettingsDriver.listSections discovers the visible second-level settings menu', async () => {
  const driver = new SettingsDriver(makeClient([
    { result: { value: 'installed' } },
    { result: { value: true } },
    { result: { value: JSON.stringify(['通用', '模型', 'MCP']) } }
  ]), {});
  assert.deepStrictEqual(await driver.listSections(), ['通用', '模型', 'MCP']);
});

asyncTest('SettingsDriver.listSections fallback covers every current settings page', async () => {
  const driver = new SettingsDriver(makeClient([
    { result: { value: 'installed' } },
    { result: { value: true } },
    { result: { value: JSON.stringify([]) } }
  ]), {});

  assert.deepStrictEqual(await driver.listSections(), [
    '账号', '用量管理', '通用', '开发环境', '智能体', 'MCP', 'CUE', '模型',
    '对话流', '浏览器', '索引与文档', '技能与命令', '规则与记忆', 'Hooks',
    'Beta', '关于 TRAE'
  ]);
});

function agentSettingsFixture({ delayedContent = 0 } = {}) {
  const events = [];
  let menuOpen = false;
  let settingsOpen = false;
  let activeSection = '通用';
  let focused = null;
  let saved = '20';
  let checked = true;
  let contentReads = 0;
  const labels = ['通用', '运行环境'];
  const node = (properties = {}) => Object.defineProperties({
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 150, height: 30 }),
    getAttribute: () => null,
    querySelector: () => null
  }, Object.getOwnPropertyDescriptors(properties));
  const text = value => ({ innerText: value });
  const entries = labels.map(label => node({
    querySelector: selector => selector === '.text' ? text(label) : null,
    classList: { contains: name => name === 'active' && activeSection === label },
    click() { activeSection = label; events.push(label); }
  }));
  const back = node({
    querySelector: selector => selector === '.text' ? text('返回应用') : null,
    click() { settingsOpen = false; events.push('返回应用'); }
  });
  const sidebar = node({ querySelectorAll: selector => selector.includes('.back-to-app-container') ? [back] : entries });
  const trigger = node({ click() { menuOpen = true; events.push('account'); } });
  const menu = node({ querySelectorAll: () => [trigger] });
  const settings = node({
    querySelector: selector => selector.includes('accountMenuLabel') ? text('设置') : null,
    click() { settingsOpen = true; menuOpen = false; events.push('设置'); }
  });

  const input = node({
    value: saved,
    focus() { focused = this; },
    select() { events.push('select'); },
    blur() { saved = this.value; focused = null; events.push('blur'); }
  });
  const switchLabel = node({
    click() { checked = !checked; events.push('toggle'); }
  });
  const checkbox = node({
    get checked() { return checked; },
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    labels: [switchLabel]
  });
  const readOnly = node({ value: 'read-only value', readOnly: true });
  const row = (label, selectorFragment, control) => node({
    contains: el => control.labels?.includes(el),
    querySelector(selector) {
      if (selector === '.icb-setting-item-label') return text(label);
      return selector.includes(selectorFragment) ? control : null;
    },
    querySelectorAll: selector => selector.includes(selectorFragment) ? [control] : []
  });
  const toggle = row('语音转录快捷键', 'checkbox', checkbox);
  const threshold = row('工作树磁盘空间占用提醒', 'text', input);
  const display = row('自定义产物存储路径', 'text', readOnly);
  const body = { querySelectorAll: selector => selector === '.icb-setting-item-container' && ++contentReads > delayedContent
    ? (activeSection === '通用' ? [toggle, display] : [threshold]) : [] };
  const document = {
    location: { pathname: '/test/solo/solo-lite.html' },
    get activeElement() { return focused; },
    querySelector(selector) {
      if (selector.includes('accountHostRoot')) return menu;
      if (selector.includes('icube-settings-content-body')) return settingsOpen ? body : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.icube-settings-sidebar-container') return settingsOpen ? [sidebar] : [];
      if (selector.includes('accountMenuItem')) return menuOpen ? [settings] : [];
      if (selector === '.icb-setting-item-container') throw new Error('Agent settings must read the active settings body');
      return [];
    }
  };
  const client = vmSettingsClient(document);
  const send = client.send;
  client.send = (method, params) => {
    if (method !== 'Input.insertText') return send(method, params);
    assert.strictEqual(focused, input);
    input.value = params.text;
    events.push('insert');
    return Promise.resolve({});
  };
  return { client, document, events, getSaved: () => saved, getChecked: () => checked,
    getContentReads: () => contentReads };
}

asyncTest('Agent settings uses the real sidebar and returns to the same Agent surface', async () => {
  const fixture = agentSettingsFixture();
  const driver = new SettingsDriver(fixture.client);
  assert.deepStrictEqual(Array.from(await driver.listSections()), ['通用', '运行环境']);
  await assert.rejects(() => driver.switchTab('模型'), /Settings section "模型" was not activated/);
  await driver.switchTab('运行环境');
  assert.strictEqual(await driver.backToChat(), 'clicked: 返回应用');
  assert.strictEqual(await driver.backToChat(), 'not found');
  assert.deepStrictEqual(fixture.events, ['account', '设置', '运行环境', '返回应用']);
});

asyncTest('Agent settings fails without the native entry instead of returning legacy sections', async () => {
  const fixture = agentSettingsFixture();
  fixture.document.querySelector = () => null;
  await assert.rejects(() => new SettingsDriver(fixture.client).listSections(), /Agent settings menu/);
  assert.deepStrictEqual(fixture.events, []);
});

asyncTest('Agent settings polls for content in an active section that is still rendering', async () => {
  const fixture = agentSettingsFixture({ delayedContent: 2 });
  const driver = new SettingsDriver(fixture.client);
  await driver.switchTab('运行环境');
  const content = await driver.getContent();
  assert.strictEqual(fixture.getContentReads(), 3);
  assert.deepStrictEqual(content.items.map(item => item.label), ['工作树磁盘空间占用提醒']);
});

asyncTest('Agent dropdown waits for options to render and reads back a delayed selection', async () => {
  const fixture = settingsDropdownFixture({ agent: true, delayedOptions: 2, delayedSelection: 2 });
  const driver = new SettingsDriver(fixture.client);
  await driver.switchTab('通用');
  const label = 'Markdown 文件的默认打开方式';
  assert.deepStrictEqual(Array.from(await driver.listOptions(label)), ['代码编辑器', 'Markdown 预览模式', 'Markdown 预览模式（扩展）']);
  assert.strictEqual(fixture.getOptionReads(), 3);
  assert.strictEqual(fixture.isOpen(), false);
  assert.strictEqual(await driver.setDropdown(label, '代码编辑器'), 'selected: 代码编辑器');
  assert.strictEqual(fixture.getOptionReads(), 3);
  assert.strictEqual(fixture.getSelectionReads(), 3);
  assert.strictEqual(fixture.getSelected(), '代码编辑器');
  assert.strictEqual(fixture.isOpen(), false);
});

asyncTest('Agent settings commits scoped text on blur and leaves read-only inputs alone', async () => {
  const fixture = agentSettingsFixture();
  const driver = new SettingsDriver(fixture.client);
  await driver.switchTab('通用');
  const general = await driver.getContent();
  assert.strictEqual(general.items.find(item => item.label === '自定义产物存储路径').controlType, 'display');
  assert.match(await driver.typeText('自定义产物存储路径', 'other'), /writable control not found/);
  assert.strictEqual(await driver.setToggle('语音转录快捷键', false), 'toggled to: false');
  assert.strictEqual(await driver.setToggle('语音转录快捷键', false), 'already in desired state: false');
  assert.strictEqual(fixture.getChecked(), false);
  await driver.switchTab('运行环境');
  assert.strictEqual(await driver.typeText('工作树磁盘空间占用提醒', '21'), 'typed: 21');
  assert.strictEqual(fixture.getSaved(), '21');
  const environment = await driver.getContent();
  assert.deepStrictEqual(environment.items.map(item => [item.label, item.controlType, item.currentValue]), [
    ['工作树磁盘空间占用提醒', 'text', '21']
  ]);
  assert.deepStrictEqual(fixture.events, ['account', '设置', 'toggle', '运行环境', 'select', 'insert', 'blur']);
});

asyncTest('SettingsDriver.switchTab rejects when the requested section was not activated', async () => {
  const driver = new SettingsDriver(makeClient([
    { result: { value: 'installed' } },
    { result: { value: true } },
    { result: { value: { status: 'toggle_not_found' } } },
    { result: { value: 'installed' } },
    { result: { value: { ok: false, reason: 'not_found' } } }
  ]), {});

  await assert.rejects(() => driver.switchTab('MCP'), /Settings section "MCP" was not activated/);
});

asyncTest('SettingsDriver.switchTab opens the settings surface with native CDP mouse input', async () => {
  const evaluations = [
    { result: { value: 'installed' } },
    { result: { value: false } },
    { result: { value: 'installed' } },
    { result: { value: { x: 430, y: 60 } } }
  ];
  const inputEvents = [];
  const client = {
    send: async (method) => {
      if (method === 'Input.dispatchMouseEvent') {
        inputEvents.push(method);
        return {};
      }
      return evaluations.shift();
    }
  };
  const driver = new SettingsDriver(client, {});

  assert.deepStrictEqual(await driver.switchTab(), { tab: 'settings', section: null });
  assert.deepStrictEqual(inputEvents, ['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent']);
});

asyncTest('SettingsDriver.switchTab does not mistake an active MCP editor tab for settings', async () => {
  const staleSettingsRow = { offsetParent: {}, textContent: '启用项目级 MCP' };
  const activeMcpTab = { textContent: 'MCP', getAttribute: () => 'MCP, 编辑器组1' };
  const evaluations = [
    { result: { value: 'installed' } },
    null,
    { result: { value: 'installed' } },
    { result: { value: { x: 430, y: 60 } } }
  ];
  const inputEvents = [];
  let evaluationIndex = 0;
  const client = {
    send: async (method, params) => {
      if (method === 'Input.dispatchMouseEvent') {
        inputEvents.push(method);
        return {};
      }
      const next = evaluations[evaluationIndex++];
      if (next !== null) return next;
      const value = vm.runInNewContext(params.expression, {
        document: {
          querySelector: selector => {
            if (selector.includes(',')) return staleSettingsRow;
            if (selector.includes('.tab.active')) return activeMcpTab;
            return null;
          }
        }
      });
      return { result: { value } };
    }
  };
  const driver = new SettingsDriver(client, {});

  await driver.switchTab();

  assert.deepStrictEqual(inputEvents, ['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent']);
});

asyncTest('SettingsDriver.switchTab prefers the global settings button over a stale editor tab', async () => {
  function element(x) {
    return {
      innerText: '设置',
      textContent: '设置',
      getBoundingClientRect: () => ({ left: x, top: 10, width: 10, height: 10 })
    };
  }
  const globalButton = element(1000);
  const staleTab = element(400);
  const inputXs = [];
  let evaluation = 0;
  const client = {
    send: async (method, params) => {
      if (method === 'Input.dispatchMouseEvent') {
        inputXs.push(params.x);
        return {};
      }
      evaluation++;
      if (evaluation === 1) return { result: { value: 'installed' } };
      if (evaluation === 2) return { result: { value: false } };
      if (evaluation === 3) return { result: { value: 'installed' } };
      const value = vm.runInNewContext(params.expression, {
        document: {
          querySelectorAll: selector => {
            if (selector === '.icube-settings-button-icon.codicon-icube-Settings') return [globalButton];
            if (selector === '.tab-label[aria-label="设置"]') return [staleTab];
            return [];
          }
        },
        getComputedStyle: () => ({ visibility: 'visible', display: 'block' })
      });
      return { result: { value } };
    }
  };
  const driver = new SettingsDriver(client, {});

  await driver.switchTab();

  assert.deepStrictEqual(inputXs, [1005, 1005]);
});

asyncTest('SettingsDriver.switchTab recognizes the active IDE settings preview without reopening it', async () => {
  const preview = {
    textContent: '设置',
    getAttribute: name => ({
      'aria-label': '设置，预览, 编辑器组1',
      'data-resource-name': 'icube-settings'
    })[name] || null
  };
  const inputEvents = [];
  const driver = new SettingsDriver(vmSettingsClient({
    querySelector: selector => selector === '.tab.active' ? preview : null,
    querySelectorAll: () => [{ getBoundingClientRect: () => ({ left: 1000, top: 10, width: 10, height: 10 }) }]
  }, inputEvents));

  await driver.switchTab();

  assert.deepStrictEqual(inputEvents, [], 'an already active settings editor must not be clicked again');
});

asyncTest('_clickSidebarItem recognizes a loaded model table without waiting for standard rows', async () => {
  const initial = [
    { result: { value: { status: 'already_visible' } } },
    { result: { value: 'installed' } },
    { result: { value: { ok: true, matchedText: '模型' } } }
  ];
  const tableClient = vmSettingsClient(modelTableDom());
  const client = {
    send: (method, params) => initial.length ? Promise.resolve(initial.shift()) : tableClient.send(method, params)
  };
  const started = Date.now();

  assert.strictEqual(await _clickSidebarItem(client, '模型', 5000), 'clicked: 模型');
  assert.ok(Date.now() - started < 1500, 'a ready model table must not incur the 5-second standard-row wait');
});

asyncTest('_clickSidebarItem waits only after a click match', async () => {
  const client = makeClient([
    // Sidebar is already expanded.
    { result: { value: 'already_visible' } },
    // clickByTextEx auto-installs the radix helper.
    { result: { value: 'installed' } },
    // clickByTextEx match evaluation: returns the structured ok shape.
    { result: { value: { ok: true, matchedText: '通用', matchedSelector: '.settings-sidebar-menu-item' } } },
    // _waitForContent poll: returns a JSON-stringified items array.
    { result: { value: JSON.stringify([{ label: 'A', desc: 'd' }]) } }
  ]);
  const start = Date.now();
  const value = await _clickSidebarItem(client, '通用', 5000);
  const elapsed = Date.now() - start;
  assert.strictEqual(value, 'clicked: 通用');
  assert.ok(elapsed < 2000, 'clicked section should not wait unnecessarily, elapsed=' + elapsed);
});

asyncTest('_clickSidebarItem skips missing sections quickly', async () => {
  const client = makeClient([
    { result: { value: 'toggle_not_found' } },
    { result: { value: 'installed' } },
    { result: { value: { ok: false, reason: 'not_found' } } }
  ]);
  const start = Date.now();
  const value = await _clickSidebarItem(client, 'Missing', 5000);
  const elapsed = Date.now() - start;
  assert.strictEqual(value, 'not found: Missing');
  assert.ok(elapsed < 1000, 'missing section should not block, elapsed=' + elapsed);
});

asyncTest('_clickSidebarItem expands a collapsed settings sidebar before selecting a section', async () => {
  const client = makeClient([
    // Collapsed-sidebar probe opens the visible menu-toggle button.
    { result: { value: 'opened' } },
    // clickByTextEx installs its click helper, then finds the now-visible item.
    { result: { value: 'installed' } },
    { result: { value: { ok: true, matchedText: 'MCP', matchedSelector: '.settings-sidebar-menu-item' } } },
    // Content is available after the section click.
    { result: { value: JSON.stringify([{ label: 'MCP Server' }]) } }
  ]);

  const value = await _clickSidebarItem(client, 'MCP', 500);

  assert.strictEqual(value, 'clicked: MCP');
});

asyncTest('_clickSidebarItem passes the requested section into the live sidebar probe', async () => {
  const item = {
    textContent: 'MCP',
    querySelector: () => ({ textContent: 'MCP' }),
    getBoundingClientRect: () => ({ width: 100, height: 28 })
  };
  const remaining = [
    { result: { value: 'installed' } },
    { result: { value: { ok: true, matchedText: 'MCP', matchedSelector: '.settings-sidebar-menu-item' } } },
    { result: { value: JSON.stringify([{ label: 'MCP Server' }]) } }
  ];
  let firstEvaluation = true;
  const client = {
    send: async (method, params) => {
      assert.strictEqual(method, 'Runtime.evaluate');
      if (!firstEvaluation) return remaining.shift();
      firstEvaluation = false;
      const value = vm.runInNewContext(params.expression, {
        document: {
          querySelectorAll: () => [item],
          querySelector: () => null
        },
        getComputedStyle: () => ({ visibility: 'visible', display: 'flex' })
      });
      return { result: { value } };
    }
  };

  assert.strictEqual(await _clickSidebarItem(client, 'MCP', 500), 'clicked: MCP');
});

asyncTest('_clickSidebarItem uses native CDP mouse input to expand the settings sidebar', async () => {
  const evaluations = [
    { result: { value: { status: 'toggle', x: 30, y: 40 } } },
    { result: { value: 'installed' } },
    { result: { value: { ok: true, matchedText: 'MCP', matchedSelector: '.settings-sidebar-menu-item' } } },
    { result: { value: JSON.stringify([{ label: 'MCP Server' }]) } }
  ];
  const inputEvents = [];
  const client = {
    send: async (method) => {
      if (method === 'Input.dispatchMouseEvent') {
        inputEvents.push(method);
        return {};
      }
      return evaluations.shift();
    }
  };

  assert.strictEqual(await _clickSidebarItem(client, 'MCP', 500), 'clicked: MCP');
  assert.deepStrictEqual(inputEvents, ['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent']);
});

asyncTest('_readSettingsContent returns standard settings items', async () => {
  const items = [
    {
      label: '设置A',
      desc: '描述A',
      currentValue: 'a',
      hasToggle: true,
      hasDropdown: false,
      toggleChecked: true,
      y: 10,
      visible: true
    }
  ];
  const client = makeClient([
    { result: { value: JSON.stringify({ count: 1, items, type: 'standard' }) } }
  ]);
  const out = await _readSettingsContent(client, 5000);
  assert.deepStrictEqual(out.sections, []);
  assert.strictEqual(out.items.length, 1);
  assert.strictEqual(out.items[0].label, '设置A');
});

asyncTest('_readSettingsContent preserves actual text and number input values', async () => {
  const row = {
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 300, height: 40 }),
    querySelector: selector => selector === '.icb-setting-item-label' ? { innerText: '测试文本输入' }
      : selector.includes('input[type="text"]') ? { value: 'fixture value 42' } : null
  };
  const out = await _readSettingsContent(vmSettingsClient({
    querySelectorAll: selector => selector === '.icb-setting-item-container' ? [row] : []
  }), 500);
  assert.strictEqual(out.items[0].hasTextInput, true);
  assert.strictEqual(out.items[0].currentValue, 'fixture value 42');
});

asyncTest('SettingsDriver.setToggle reports the observed state for both directions', async () => {
  const fixture = settingsToggleFixture();
  const driver = new SettingsDriver(fixture.client);
  assert.strictEqual(await driver.setToggle('语音转录快捷键', false), 'toggled to: false');
  assert.strictEqual(fixture.input.checked, false);
  assert.strictEqual(await driver.setToggle('语音转录快捷键', true), 'toggled to: true');
  assert.strictEqual(fixture.input.checked, true);
});

asyncTest('SettingsDriver.setToggle does not claim a change when the checkbox ignores the click', async () => {
  const fixture = settingsToggleFixture({ checked: false, applyClick: false });
  const result = await new SettingsDriver(fixture.client).setToggle('语音转录快捷键', true);
  assert.match(result, /not applied/);
  assert.strictEqual(fixture.input.checked, false);
});

asyncTest('SettingsDriver.listOptions opens the real combobox and scopes its portal', async () => {
  const fixture = settingsDropdownFixture();
  const values = await new SettingsDriver(fixture.client).listOptions('Markdown 文件的默认打开方式');
  assert.deepStrictEqual(Array.from(values), ['代码编辑器', 'Markdown 预览模式', 'Markdown 预览模式（扩展）']);
  assert.strictEqual(fixture.isOpen(), false);
  assert.strictEqual(fixture.getSelected(), 'Markdown 预览模式');
  assert.deepStrictEqual(fixture.inputEvents.filter(event => event.type === 'keyDown' || event.type === 'keyUp')
    .map(event => [event.type, event.key]), [['keyDown', 'Escape'], ['keyUp', 'Escape']]);
  assert.ok(!fixture.events.some(event => event.startsWith('row:')));
});

asyncTest('SettingsDriver.setDropdown chooses the exact role option in the controlled portal', async () => {
  const fixture = settingsDropdownFixture();
  const driver = new SettingsDriver(fixture.client);
  assert.strictEqual(await driver.setDropdown('Markdown 文件的默认打开方式', '代码编辑器'), 'selected: 代码编辑器');
  assert.strictEqual(fixture.getSelected(), '代码编辑器');
  assert.strictEqual(fixture.isOpen(), false);
});

asyncTest('SettingsDriver.setDropdown rejects a substring and closes the portal without mutation', async () => {
  const fixture = settingsDropdownFixture();
  const result = await new SettingsDriver(fixture.client).setDropdown('Markdown 文件的默认打开方式', 'Markdown');
  assert.strictEqual(result, 'option not found: Markdown');
  assert.strictEqual(fixture.getSelected(), 'Markdown 预览模式');
  assert.strictEqual(fixture.isOpen(), false);
});

asyncTest('_readSettingsContent excludes hidden rows left behind by another settings page', async () => {
  function row(label, visibility) {
    const labelEl = { innerText: label };
    return {
      visibility,
      querySelector: selector => selector === '.icb-setting-item-label' ? labelEl : null,
      getBoundingClientRect: () => ({ x: 10, y: 20, width: 300, height: 40 })
    };
  }
  const hiddenGeneral = row('主题', 'hidden');
  const visibleMcp = row('启用项目级 MCP', 'visible');
  const client = {
    send: async (method, params) => {
      assert.strictEqual(method, 'Runtime.evaluate');
      const value = vm.runInNewContext(params.expression, {
        document: {
          querySelectorAll: selector => selector === '.icb-setting-item-container'
            ? [hiddenGeneral, visibleMcp]
            : []
        },
        getComputedStyle: el => ({ visibility: el.visibility, display: 'block' })
      });
      return { result: { value } };
    }
  };

  const out = await _readSettingsContent(client, 500);

  assert.strictEqual(Array.from(out.items, item => item.label).join('|'), '启用项目级 MCP');
});

asyncTest('_readSettingsContent ignores visible tables outside the settings surface', async () => {
  const settingRow = {
    querySelector: selector => selector === '.icb-setting-item-label'
      ? { innerText: '启用项目级 MCP' }
      : null,
    getBoundingClientRect: () => ({ x: 900, y: 180, width: 360, height: 40 })
  };
  function chatTableRow(command) {
    const cells = [
      { textContent: command, getBoundingClientRect: () => ({ y: 200 }) },
      { textContent: 'PASS', getBoundingClientRect: () => ({ y: 200 }) }
    ];
    return {
      querySelectorAll: selector => selector === 'td' ? cells : [],
      getBoundingClientRect: () => ({ x: 440, y: 200, width: 500, height: 36 })
    };
  }
  const chatRows = [chatTableRow('npm test'), chatTableRow('npm run lint')];
  const client = {
    send: async (method, params) => {
      assert.strictEqual(method, 'Runtime.evaluate');
      const value = vm.runInNewContext(params.expression, {
        document: {
          querySelectorAll: selector => {
            if (selector === '.icb-setting-item-container') return [settingRow];
            if (selector === 'table tbody tr') return chatRows;
            return [];
          }
        },
        getComputedStyle: () => ({ visibility: 'visible', display: 'block' })
      });
      return { result: { value } };
    }
  };

  const out = await _readSettingsContent(client, 500);

  assert.strictEqual(Array.from(out.items, item => item.label).join('|'), '启用项目级 MCP');
});

asyncTest('_readSettingsContent reads visible custom settings cards when standard rows are absent', async () => {
  function card(label) {
    return {
      innerText: label,
      textContent: label,
      className: 'ai-agent-list-item-name',
      querySelector: () => null,
      getBoundingClientRect: () => ({ x: 900, y: 180, width: 240, height: 30 })
    };
  }
  const cards = [card('Chat'), card('Agent')];
  const client = {
    send: async (method, params) => {
      assert.strictEqual(method, 'Runtime.evaluate');
      const value = vm.runInNewContext(params.expression, {
        document: {
          querySelectorAll: selector => selector.includes('.ai-agent-list-item-name') ? cards : []
        },
        getComputedStyle: () => ({ visibility: 'visible', display: 'block' })
      });
      return { result: { value } };
    }
  };

  const out = await _readSettingsContent(client, 1);

  assert.strictEqual(Array.from(out.items, item => item.label).join('|'), 'Chat|Agent');
});

asyncTest('_readSettingsContent separates code-index labels from percentage values', async () => {
  const indexCard = {
    innerText: '代码索引管理 100%',
    textContent: '代码索引管理 100%',
    className: 'codeIndex-list-item',
    querySelector: () => null,
    getBoundingClientRect: () => ({ x: 900, y: 180, width: 240, height: 50 })
  };
  const client = {
    send: async (method, params) => {
      assert.strictEqual(method, 'Runtime.evaluate');
      const value = vm.runInNewContext(params.expression, {
        document: {
          querySelectorAll: selector => selector.includes('.codeIndex-list-item') ? [indexCard] : []
        },
        getComputedStyle: () => ({ visibility: 'visible', display: 'block' })
      });
      return { result: { value } };
    }
  };

  const out = await _readSettingsContent(client, 1);

  assert.strictEqual(out.items[0].label, '代码索引管理');
  assert.strictEqual(out.items[0].currentValue, '100%');
});

asyncTest('_readSettingsContent reads the captured permission page as display-only items', async () => {
  const inputEvents = [];
  const out = await _readSettingsContent(vmSettingsClient(permissionSettingsDom(), inputEvents), 1);

  assert.deepStrictEqual(Array.from(out.items, item => item.label), ['权限模式', '自定义配置']);
  assert.strictEqual(out.items[0].currentValue, '手动审批');
  assert.strictEqual(out.items[0].desc, '在隔离环境中运行。高风险操作会被阻止，重要操作需要你的批准。');
  assert.strictEqual(out.items[1].desc, '自定义审批规则、命令规则、文件系统和网络权限。');
  assert.strictEqual(out.items[1].currentValue, '');
  assert.ok(out.items.every(item => !item.hasToggle && !item.hasDropdown && !item.hasTextInput && item.toggleChecked === null));
  assert.deepStrictEqual(inputEvents, []);
});

asyncTest('_readSettingsContent uses the checked permission radio without guessing a default', async () => {
  for (const selected of ['自动审批', '完全访问', null]) {
    const out = await _readSettingsContent(vmSettingsClient(permissionSettingsDom({ selected })), 1);
    assert.strictEqual(out.items[0]?.currentValue, selected || '');
    if (selected === '自动审批') assert.ok(out.items[0].desc.includes('重要操作由 AI 自动批准'));
    if (selected === '完全访问') assert.ok(out.items[0].desc.includes('不使用隔离环境'));
  }
});

asyncTest('_readSettingsContent excludes hidden permission ancestors and hidden custom rows', async () => {
  const hidden = await _readSettingsContent(vmSettingsClient(permissionSettingsDom({ hiddenPanel: true })), 1);
  assert.strictEqual(hidden.items.length, 0);
  const customHidden = await _readSettingsContent(vmSettingsClient(permissionSettingsDom({ hiddenCustom: true })), 1);
  assert.deepStrictEqual(Array.from(customHidden.items, item => item.label), ['权限模式']);
});

asyncTest('_readSettingsContent never treats permission-like chat content as a loaded settings section', async () => {
  const out = await _readSettingsContent(vmSettingsClient(permissionSettingsDom({ insideSettings: false })), 1);
  assert.strictEqual(out.items.length, 0);
});

asyncTest('SettingsDriver normalizes permission cards as display and exposes no write controls', async () => {
  const inputEvents = [];
  const driver = new SettingsDriver(vmSettingsClient(permissionSettingsDom(), inputEvents));
  const content = await driver.getContent();
  assert.deepStrictEqual(content.items.map(item => item.controlType), ['display', 'display']);
  assert.strictEqual(await driver.setDropdown('权限模式', '完全访问'), 'item not found: 权限模式');
  assert.match(await driver.setToggle('权限模式', true), /label not found/);
  assert.strictEqual(await driver.typeText('权限模式', '完全访问'), 'label not found: 权限模式');
  assert.deepStrictEqual(inputEvents, [], 'no permission radio or configuration button may be clicked');
});

asyncTest('SettingsDriver rejects an unactivated section even when a permission page remains loaded', async () => {
  const document = permissionSettingsDom();
  const originalQuery = document.querySelector.bind(document);
  document.querySelector = selector => selector === '.tab.active'
    ? { getAttribute: name => name === 'data-resource-name' ? 'icube-settings' : null }
    : originalQuery(selector);
  const inputEvents = [];
  const client = vmSettingsClient(document, inputEvents);
  assert.strictEqual((await _readSettingsContent(client, 1)).items.length, 2);
  const driver = new SettingsDriver(client);
  await assert.rejects(() => driver.switchTab('不存在的设置页'), /was not activated/);
  assert.deepStrictEqual(inputEvents, []);
});

asyncTest('_readSettingsContent returns fast for empty model-table sections', async () => {
  const client = makeClient([
    { result: { value: JSON.stringify({ count: 0, type: 'model-table' }) } }
  ]);
  const start = Date.now();
  const out = await _readSettingsContent(client, 8000);
  const elapsed = Date.now() - start;
  assert.deepStrictEqual(out, { sections: [], items: [] });
  assert.ok(elapsed < 1500, 'empty model-table should return fast, elapsed=' + elapsed);
});

asyncTest('_readSettingsContent reads the real model/provider table structure', async () => {
  const out = await _readSettingsContent(vmSettingsClient(modelTableDom()), 500);

  assert.strictEqual(out.items.length, 18);
  assert.strictEqual(out.items[0].label, 'Fixture Model 1');
  assert.strictEqual(out.items[0].desc, 'Fixture Provider');
  assert.ok(out.items.every(item => !item.hasToggle && !item.hasDropdown && !item.hasTextInput));
});

asyncTest('_readSettingsContent detects model rows that render after the initial snapshot', async () => {
  let reads = 0;
  const loaded = modelTableDom();
  const client = vmSettingsClient(() => ++reads === 1 ? { querySelectorAll: () => [] } : loaded);

  const out = await _readSettingsContent(client, 1000);

  assert.strictEqual(out.items.length, 18, 'polls must inspect model tables after a loading snapshot');
  assert.strictEqual(reads, 2);
});

asyncTest('_readSettingsContent recognizes a visible empty model table without polling standard rows', async () => {
  let reads = 0;
  const empty = modelTableDom({ populated: false });
  const client = vmSettingsClient(() => { reads++; return empty; });

  const out = await _readSettingsContent(client, 1000);

  assert.strictEqual(out.items.length, 0);
  assert.strictEqual(reads, 1, 'a hydrated empty model page must not poll for unrelated standard rows');
});

asyncTest('SettingsDriver.backToChat closes only the active IDE settings editor', async () => {
  let settingsActive = true;
  const inputEvents = [];
  const close = {
    getBoundingClientRect: () => ({ left: 940, top: 40, width: 16, height: 16 })
  };
  const settings = {
    getBoundingClientRect: () => ({ left: 400, top: 40, width: 550, height: 40 }),
    querySelector: selector => selector.includes('codicon-icube-SmallClose') ? close : null
  };
  const calculator = { querySelector: () => { throw new Error('the user file tab must not be inspected for a close button'); } };
  const document = {
    querySelector: selector => selector === '.tab.active[data-resource-name="icube-settings"]'
      ? (settingsActive ? settings : null)
      : (selector === '.tab.active' ? calculator : null),
    querySelectorAll: () => []
  };
  const client = vmSettingsClient(document, inputEvents);
  const send = client.send;
  client.send = async (method, params) => {
    const result = await send(method, params);
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') settingsActive = false;
    return result;
  };
  const driver = new SettingsDriver(client);

  assert.strictEqual(await driver.backToChat(), 'closed: 设置');
  assert.deepStrictEqual(inputEvents.map(event => [event.type, event.x, event.y]), [
    ['mousePressed', 948, 48], ['mouseReleased', 948, 48]
  ]);
});

asyncTest('SettingsDriver.backToChat closes the visible SOLO settings tab with no editor tab', async () => {
  let active = true;
  const inputEvents = [];
  const close = { getBoundingClientRect: () => ({ left: 550, top: 40, width: 20, height: 20 }) };
  const solo = { getBoundingClientRect: () => ({ left: 350, top: 40, width: 240, height: 40 }),
    querySelector: selector => selector.includes('icube-solo-mode-tab-close-half') ? close : null };
  const hiddenIde = { hidden: true, getBoundingClientRect: () => ({ left: 800, top: 40, width: 0, height: 0 }),
    querySelector: () => { throw new Error('hidden IDE tab close must never be inspected'); } };
  const document = {
    querySelector: selector => selector.includes('data-tab-key="solo_settings"') ? (active ? solo : null)
      : (selector === '.tab.active[data-resource-name="icube-settings"]' ? hiddenIde : null),
    querySelectorAll: () => []
  };
  const client = vmSettingsClient(document, inputEvents);
  const send = client.send;
  client.send = async (method, parameters) => {
    const result = await send(method, parameters);
    if (method === 'Input.dispatchMouseEvent' && parameters.type === 'mouseReleased') active = false;
    return result;
  };
  assert.strictEqual(await new SettingsDriver(client).backToChat(), 'closed: 设置');
  assert.deepStrictEqual(inputEvents.map(event => [event.type, event.x, event.y]), [
    ['mousePressed', 560, 50], ['mouseReleased', 560, 50]
  ]);
});

asyncTest('SettingsDriver.backToChat rejects a close that leaves the settings surface visible', async () => {
  const close = { getBoundingClientRect: () => ({ left: 550, top: 40, width: 20, height: 20 }) };
  const solo = { getBoundingClientRect: () => ({ left: 350, top: 40, width: 240, height: 40 }),
    querySelector: () => close };
  const document = { querySelector: selector => selector.includes('data-tab-key="solo_settings"') ? solo : null,
    querySelectorAll: () => [] };
  const driver = new SettingsDriver(vmSettingsClient(document));
  assert.match(await driver.backToChat(), /settings still visible/);
  assert.notStrictEqual(driver._currentTab, 'chat');
});

asyncTest('SettingsDriver.backToChat leaves inactive settings and unrelated IDE editors open', async () => {
  const inputEvents = [];
  const driver = new SettingsDriver(vmSettingsClient({
    querySelector: () => null,
    querySelectorAll: () => []
  }, inputEvents));

  assert.strictEqual(await driver.backToChat(), 'not found');
  assert.deepStrictEqual(inputEvents, []);
});

asyncTest('SettingsDriver.backToChat preserves the SOLO editor-tab route', async () => {
  const events = [];
  const editor = {
    textContent: '编辑器',
    querySelector: () => null,
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 60, height: 24 }),
    dispatchEvent: event => events.push(event.type)
  };
  const driver = new SettingsDriver(vmSettingsClient({
    querySelector: () => null,
    querySelectorAll: selector => selector === '.icube-solo-mode-tab-item' ? [editor] : []
  }));

  assert.strictEqual(await driver.backToChat(), 'clicked: 编辑器');
  assert.deepStrictEqual(events, ['pointerdown', 'mousedown', 'mouseup', 'click']);
});

asyncTest('SettingsDriver.readAll iterates discovered sections only', async () => {
  const discovered = ['通用', '模型', 'MCP'];
  const evaluations = [
    // switchTab: _ensureClickHelper
    { result: { value: 'installed' } },
    // switchTab: settings-open probe
    { result: { value: true } },
    // switchTab: list sidebar sections
    { result: { value: JSON.stringify(discovered) } }
  ];
  for (const name of discovered) {
    // Sidebar visibility probe.
    evaluations.push({ result: { value: 'already_visible' } });
    // _clickSidebarItem: clickByTextEx auto-installs radix helper
    evaluations.push({ result: { value: 'installed' } });
    // _clickSidebarItem: match outcome (structured ok shape)
    evaluations.push({ result: { value: { ok: true, matchedText: name, matchedSelector: '.settings-sidebar-menu-item' } } });
    // _waitForContent: returns a non-empty array
    evaluations.push({ result: { value: JSON.stringify([{ label: name + '项' }]) } });
    // _readSettingsContent: full structured payload
    evaluations.push({
      result: {
        value: JSON.stringify({
          count: 1,
          items: [{
            label: name + '项',
            desc: 'd',
            currentValue: '',
            hasToggle: false,
            hasDropdown: false,
            toggleChecked: null,
            y: 0,
            visible: true
          }],
          type: 'standard'
        })
      }
    });
  }
  const driver = new SettingsDriver(makeClient(evaluations), {});
  const result = await driver.readAll();
  assert.deepStrictEqual(Object.keys(result).sort(), discovered.slice().sort());
});

asyncTest('SettingsDriver.readAll marks missing sections as skipped', async () => {
  const discovered = ['Exists', 'Missing'];
  const evaluations = [
    // switchTab helpers + sidebar list
    { result: { value: 'installed' } },
    { result: { value: true } },
    { result: { value: JSON.stringify(discovered) } },
    // Exists section: sidebar probe + helper install + match + wait + read
    { result: { value: 'already_visible' } },
    { result: { value: 'installed' } },
    { result: { value: { ok: true, matchedText: 'Exists', matchedSelector: '.settings-sidebar-menu-item' } } },
    { result: { value: JSON.stringify([{ label: 'Exists项' }]) } },
    {
      result: {
        value: JSON.stringify({
          count: 1,
          items: [{ label: 'Exists项', desc: 'd', currentValue: '', hasToggle: false, hasDropdown: false, toggleChecked: null, y: 0, visible: true }],
          type: 'standard'
        })
      }
    },
    // Missing section: sidebar probe + helper install + match returns not_found (no wait)
    { result: { value: 'toggle_not_found' } },
    { result: { value: 'installed' } },
    { result: { value: { ok: false, reason: 'not_found' } } }
  ];
  const driver = new SettingsDriver(makeClient(evaluations), {});
  const result = await driver.readAll();
  assert.strictEqual(result.Missing.skipped, true);
  assert.strictEqual(result.Missing.reason, 'section_not_found');
  assert.strictEqual(result.Exists.items.length, 1);
});

asyncTest('SettingsDriver.getContent de-duplicates items by label', async () => {
  const items = [
    { label: 'Dup', desc: 'first', currentValue: 'v1', hasToggle: false, hasDropdown: false, toggleChecked: null, y: 0, visible: true },
    { label: 'Dup', desc: 'second', currentValue: 'v2', hasToggle: false, hasDropdown: false, toggleChecked: null, y: 10, visible: true },
    { label: 'Unique', desc: 'one', currentValue: 'v3', hasToggle: false, hasDropdown: false, hasTextInput: true, toggleChecked: null, y: 20, visible: true }
  ];
  const driver = new SettingsDriver(makeClient([
    { result: { value: JSON.stringify({ count: items.length, items, type: 'standard' }) } }
  ]), {});
  const out = await driver.getContent();
  assert.deepStrictEqual(out.items.map(item => item.label), ['Dup', 'Unique']);
  assert.deepStrictEqual(out.items.map(item => item.controlType), ['display', 'text']);
});

asyncTest('SettingsDriver.listOptions returns visible dropdown choices', async () => {
  const fixture = settingsDropdownFixture({ labelText: '语言', initialValue: '简体中文', values: ['简体中文', 'English'] });
  const driver = new SettingsDriver(fixture.client, {});
  assert.deepStrictEqual(Array.from(await driver.listOptions('语言')), ['简体中文', 'English']);
  assert.strictEqual(fixture.getSelected(), '简体中文');
  assert.strictEqual(fixture.isOpen(), false);
});

asyncTest('SettingsDriver.action(read) returns content shape', async () => {
  const driver = new SettingsDriver(makeClient([
    { result: { value: JSON.stringify({ count: 1, items: [{ label: 'R1' }], type: 'standard' }) } }
  ]), {});
  const out = await driver.action('read');
  assert.ok(Array.isArray(out.sections));
  assert.ok(Array.isArray(out.items));
});

asyncTest('SettingsDriver.action rejects unknown actions', async () => {
  const driver = new SettingsDriver(makeClient([]), {});
  await assert.rejects(() => driver.action('does-not-exist'), /Unknown settings action/);
});

(async () => {
  // asyncTest() at the top level returned unawaited promises; drain them
  // here so the final counts reflect every body completing.
  await pendingAsyncTests();
  summary();
  process.exit(r.failed > 0 ? 1 : 0);
})();
