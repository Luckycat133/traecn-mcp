'use strict';

const assert = require('assert');
const vm = require('vm');
const { createRunner } = require('../../shared/test-runner');
const { getCurrentModel, listModels, switchModel } = require('./model');

const runner = createRunner('dom-handlers/model.test.js');
const { asyncTest, pendingAsyncTests, summary } = runner;

function corePickerFixture({ current, auto, initiallyOpen, manualNames = [], applySelection = true }) {
  let expanded = initiallyOpen;
  let currentLabel = current;
  const actions = [];
  const choices = [];
  const trigger = {
    get innerText() { return currentLabel; },
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 24 }),
    matches: selector => selector === 'button.core-model-select-trigger[role="combobox"]',
    getAttribute: name => ({
      'aria-controls': 'model-picker',
      'aria-expanded': String(expanded)
    })[name] || null
  };
  const makeChoice = (name, index) => ({
    name,
    getBoundingClientRect: () => ({ x: 10, y: 100 + index * 30, width: 100, height: 24 }),
    getAttribute: key => key === 'aria-label' ? name : null,
    hasAttribute: () => false,
    contains: hit => hit?.name === name,
    closest: () => null
  });
  const autoSwitch = makeChoice('Auto', 0);
  Object.defineProperty(autoSwitch, 'checked', { get: () => auto });
  const rows = manualNames.map((name, index) => makeChoice(name, index + 1));
  const labels = rows.map(row => ({
    innerText: row.name,
    getClientRects: () => [{}],
    closest: selector => selector === '.core-model-select-model-item[role="option"]' ? row : null
  }));
  const hitChoice = (x, y) => [autoSwitch, ...rows].find(choice => {
    const rect = choice.getBoundingClientRect();
    return x === rect.x + rect.width / 2 && y === rect.y + rect.height / 2;
  });
  const portal = {
    getAttribute: name => name === 'role' ? 'listbox' : null,
    querySelector(selector) {
      if (selector === '.core-auto-mode-switch-label') return { innerText: 'Auto' };
      if (selector === '.core-model-select-model-list') return auto ? null : {};
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes('[role="switch"]')) return [autoSwitch];
      assert.strictEqual(selector, '.core-model-select-model-item-name');
      return auto ? [] : labels;
    }
  };
  const driver = {
    getCurrentModel: () => getCurrentModel(driver),
    client: {
      async send(method, params) {
        if (method === 'Input.dispatchMouseEvent') {
          actions.push(params.type);
          if (params.type === 'mouseReleased' && params.y === 32) expanded = true;
          const choice = hitChoice(params.x, params.y);
          if (choice && params.type === 'mouseReleased') {
            choices.push(choice.name);
            if (applySelection) {
              currentLabel = choice.name;
              auto = choice === autoSwitch;
            }
          }
          return {};
        }
        if (method === 'Input.dispatchKeyEvent') {
          assert.strictEqual(params.key, 'Escape');
          actions.push(params.type);
          expanded = false;
          return {};
        }
        assert.strictEqual(method, 'Runtime.evaluate');
        const value = vm.runInNewContext(params.expression, {
          document: {
            querySelector: () => null,
            querySelectorAll(selector) {
              if (selector.includes('[role="combobox"]')) return [trigger];
              if (/stop|\[role="button"\]/.test(selector)) return [];
              throw new Error(`Unexpected document-wide selector: ${selector}`);
            },
            getElementById: id => id === 'model-picker' && expanded ? portal : null,
            elementFromPoint: hitChoice
          }
        });
        return { result: { value } };
      }
    }
  };
  return { driver, actions, choices, isExpanded: () => expanded };
}

asyncTest('lists Auto while manual models are hidden and restores the closed picker', async () => {
  const { driver, actions, isExpanded } = corePickerFixture({ current: 'Auto', auto: true, initiallyOpen: false });
  assert.deepStrictEqual(await listModels(driver), {
    current: 'Auto', models: ['Auto'], manualModelsHidden: true
  });
  assert.deepStrictEqual(actions, ['mouseMoved', 'mousePressed', 'mouseReleased', 'rawKeyDown', 'keyUp']);
  assert.strictEqual(isExpanded(), false);
});

asyncTest('reads exact labels only from the native portal and leaves an existing open picker alone', async () => {
  const { driver, actions, isExpanded } = corePickerFixture({
    current: 'My Custom Model Beta',
    auto: false,
    initiallyOpen: true,
    manualNames: ['My Custom Model Beta', 'Seed 2.1 Pro', 'My Custom Model Beta']
  });
  assert.deepStrictEqual(await listModels(driver), {
    current: 'My Custom Model Beta',
    models: ['Auto', 'My Custom Model Beta', 'Seed 2.1 Pro']
  });
  assert.deepStrictEqual(actions, []);
  assert.strictEqual(isExpanded(), true);
});

asyncTest('treats the legacy Auto Mode name as the active native Auto selection', async () => {
  const { driver, actions } = corePickerFixture({ current: 'Auto', auto: true, initiallyOpen: false });
  const result = await switchModel(driver, 'Auto Mode');
  assert.strictEqual(result.alreadySelected, true);
  assert.deepStrictEqual(actions, []);
});

asyncTest('selects an exact unique manual label once and verifies the native trigger', async () => {
  const { driver, choices, isExpanded } = corePickerFixture({
    current: 'My Custom Model Beta',
    auto: false,
    initiallyOpen: false,
    manualNames: ['My Custom Model Beta', 'My Custom Model']
  });
  const result = await switchModel(driver, 'My Custom Model');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.model, 'My Custom Model');
  assert.strictEqual(result.previousModel, 'My Custom Model Beta');
  assert.deepStrictEqual(choices, ['My Custom Model']);
  assert.strictEqual(isExpanded(), false);
});

asyncTest('does not select a partial or repeated native display name', async () => {
  const { driver, choices } = corePickerFixture({
    current: 'Seed 2.1 Pro',
    auto: false,
    initiallyOpen: false,
    manualNames: ['Seed 2.1 Pro', 'Duplicated Model', 'Duplicated Model']
  });
  assert.strictEqual((await switchModel(driver, 'Duplicated')).code, 'MODEL_NOT_FOUND');
  assert.strictEqual((await switchModel(driver, 'Duplicated Model')).code, 'MODEL_LABEL_AMBIGUOUS');
  assert.deepStrictEqual(choices, []);
});

asyncTest('reports hidden manual options and leaves Auto active', async () => {
  const { driver, choices, isExpanded } = corePickerFixture({
    current: 'Auto', auto: true, initiallyOpen: false
  });
  const result = await switchModel(driver, 'Seed 2.1 Pro');
  assert.strictEqual(result.code, 'MANUAL_MODELS_HIDDEN');
  assert.strictEqual(await driver.getCurrentModel(), 'Auto');
  assert.deepStrictEqual(choices, []);
  assert.strictEqual(isExpanded(), false);
});

asyncTest('activates the labeled native Auto switch only for an explicit Auto selection', async () => {
  const { driver, choices, isExpanded } = corePickerFixture({
    current: 'Seed 2.1 Pro',
    auto: false,
    initiallyOpen: false,
    manualNames: ['Seed 2.1 Pro']
  });
  const result = await switchModel(driver, 'Auto');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.model, 'Auto');
  assert.deepStrictEqual(choices, ['Auto']);
  assert.strictEqual(isExpanded(), false);
});

asyncTest('does not report success or retry a click when the native selection stays unchanged', async () => {
  const { driver, choices } = corePickerFixture({
    current: 'Seed 2.1 Pro',
    auto: false,
    initiallyOpen: false,
    manualNames: ['Seed 2.1 Pro', 'Other Model'],
    applySelection: false
  });
  const result = await switchModel(driver, 'Other Model');
  assert.strictEqual(result.code, 'MODEL_CHANGE_UNVERIFIED');
  assert.strictEqual(result.model, 'Seed 2.1 Pro');
  assert.deepStrictEqual(choices, ['Other Model']);
});

pendingAsyncTests().then(() => {
  summary();
  if (runner.failed > 0) process.exitCode = 1;
});
