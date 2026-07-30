'use strict';

const assert = require('assert');
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

asyncTest('_clickSidebarItem waits only after a click match', async () => {
  const client = makeClient([
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
    { result: { value: 'installed' } },
    { result: { value: { ok: false, reason: 'not_found' } } }
  ]);
  const start = Date.now();
  const value = await _clickSidebarItem(client, 'Missing', 5000);
  const elapsed = Date.now() - start;
  assert.strictEqual(value, 'not found: Missing');
  assert.ok(elapsed < 1000, 'missing section should not block, elapsed=' + elapsed);
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
    // Exists section: helper install + match + wait + read
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
    // Missing section: helper install + match returns not_found (no wait)
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
