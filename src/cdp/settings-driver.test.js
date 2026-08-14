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
  const driver = new SettingsDriver(makeClient([
    { result: { value: 'installed' } },
    { result: { value: 'installed' } },
    { result: { value: { ok: true, matchedText: '语言' } } },
    { result: { value: JSON.stringify(['简体中文', 'English']) } },
    { result: { value: 'closed' } }
  ]), {});
  assert.deepStrictEqual(await driver.listOptions('语言'), ['简体中文', 'English']);
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
