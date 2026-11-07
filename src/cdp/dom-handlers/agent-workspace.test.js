'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createRunner } = require('../../shared/test-runner');
const { readAgentWorkspace, selectAgentWorkspace } = require('./agent-workspace');

const runner = createRunner('agent-workspace.test.js');
const { asyncTest, pendingAsyncTests, summary } = runner;
const alias = '/tmp/traecn-workspace';
const absolute = '/private/tmp/traecn-workspace';

function fixture({
  active = false, draftText = '', paths = [alias, absolute], selected = null, readBack = null, emptyLabel,
  searchAvailable = true, searchDelayMs = 200, interimEmpty = false, duplicateKeys = false
} = {}) {
  const moves = [];
  const clicks = [];
  const queries = [];
  let menuOpen = false;
  let hovered = null;
  let dismissed = false;
  let activeElement = null;
  let searchAt = 0;
  const element = ({ x = 0, y = 0, text = '', attributes = {}, query = () => [] } = {}) => {
    const rect = { left: x - 5, top: y - 5, width: 10, height: 10 };
    const node = {
      textContent: text,
      getClientRects: () => [rect],
      getBoundingClientRect: () => rect,
      getAttribute: name => attributes[name] || null,
      contains: other => other === node,
      closest: () => null,
      matches: selector => selector === ':hover' && hovered === node,
      querySelectorAll: query,
      querySelector: selector => query(selector)[0] || null,
      scrollIntoView() {}
    };
    return node;
  };
  const button = element({ x: 30, y: 30 });
  const searchInput = element({ x: 50, y: 40 });
  searchInput.value = '';
  searchInput.focus = () => { activeElement = searchInput; };
  const clear = element({ x: 60, y: 40 });
  clear.click = () => { searchInput.value = ''; };
  const rows = paths.map((_, index) => element({
    x: 30, y: 55 + index * 20, attributes: { 'data-key': `work-local:${duplicateKeys ? 0 : index}` }
  }));
  const composer = element({ text: draftText });
  const searchPending = () => searchInput.value && Date.now() - searchAt < searchDelayMs;
  const searchLoading = () => searchPending() && Date.now() - searchAt >= 160;
  const mountedRows = () => {
    if (!searchInput.value) return rows;
    if (searchPending()) return interimEmpty || searchLoading() ? [] : rows;
    return rows.filter((_, index) => [paths[index]].flat().some(folder => folder.toLowerCase().includes(searchInput.value.toLowerCase())));
  };
  const menu = element({ query: selector => {
    if (selector === 'input.searchInputField-Vt8WA6') return searchAvailable ? [searchInput] : [];
    if (selector === 'button.searchClearButton-XzodoV') return searchInput.value ? [clear] : [];
    if (selector === '.cascadeLoading-fSFuWt') return searchLoading() ? [element()] : [];
    if (selector === '[role="status"]') {
      const label = searchInput.value && !mountedRows().length && !searchLoading() ? '无匹配结果' : emptyLabel;
      return label ? [element({ text: label })] : [];
    }
    return mountedRows();
  } });
  const panel = element();
  const hit = (x, y) => {
    if (x === 30 && y === 30) return button;
    if (menuOpen && x === 50 && y === 40) return searchInput;
    if (menuOpen && x === 60 && y === 40 && searchInput.value) return clear;
    const row = menuOpen && x === 30 ? rows[(y - 55) / 20] : null;
    return mountedRows().includes(row) ? row : null;
  };
  const tooltip = () => {
    const rowIndex = rows.indexOf(hovered);
    const folder = menuOpen && rowIndex >= 0 ? paths[rowIndex] : hovered === button ? selected : null;
    if (!folder) return [];
    const folderPaths = Array.isArray(folder) ? folder : [folder];
    const project = element({ query: () => folderPaths.map(title => element({ attributes: { title } })) });
    project.classList = { contains: name => name === 'cascadeMenuItemTooltip-uxj87j' && rowIndex >= 0 };
    return [element({ query: () => [project] })];
  };
  const document = {
    elementFromPoint: hit,
    get activeElement() { return activeElement; },
    querySelectorAll(selector) {
      if (selector === '.chat-input-v2-input-box-editable') return [composer];
      if (selector === '.initial-chat-panel') return active ? [] : [panel];
      if (selector === '.turn.turn--last') return active ? [panel] : [];
      if (selector.startsWith('button[data-testid=')) return [button];
      if (selector.startsWith('.workWorkspaceSelectorMenu-')) return menuOpen ? [menu] : [];
      if (selector.startsWith('[role="tooltip"]')) return tooltip();
      throw new Error(`Unexpected selector ${selector}`);
    },
    querySelector: () => active ? panel : null
  };
  const driver = { client: { async send(method, args) {
    if (method === 'Runtime.evaluate') {
      const value = vm.runInNewContext(args.expression, {
        document, location: { pathname: '/vs/code/electron-browser/solo/solo-lite.html' },
        getComputedStyle: () => ({ visibility: 'visible' }), innerWidth: 100, innerHeight: 150
      });
      return { result: { value: JSON.parse(JSON.stringify(value)) } };
    }
    if (method === 'Input.dispatchKeyEvent') {
      assert.equal(args.key, 'Escape');
      menuOpen = false;
      dismissed = true;
      return {};
    }
    if (method === 'Input.insertText') {
      assert.equal(activeElement, searchInput);
      queries.push(args.text);
      searchInput.value = args.text;
      searchAt = Date.now();
      return {};
    }
    assert.equal(method, 'Input.dispatchMouseEvent');
    const target = hit(args.x, args.y);
    if (args.type === 'mouseMoved') {
      hovered = target;
      moves.push(target?.getAttribute('data-key') || (target === button ? 'trigger' : 'neutral'));
    }
    if (args.type === 'mousePressed' && menuOpen && rows.includes(target)) {
      clicks.push(target.getAttribute('data-key'));
      selected = readBack || paths[rows.indexOf(target)];
      menuOpen = false;
    }
    if (args.type === 'mouseReleased' && target === button) {
      clicks.push('trigger');
      menuOpen = true;
    }
    return {};
  } } };
  return { driver, moves, clicks, queries, dismissed: () => dismissed };
}

asyncTest('searches the full lexical path and hovers only the matching row before readback', async () => {
  const app = fixture();
  assert.deepEqual(await selectAgentWorkspace(app.driver, absolute), { success: true, projectPath: absolute });
  assert.deepEqual(app.queries, [absolute]);
  assert.deepEqual(app.clicks, ['trigger', 'work-local:1']);
  assert.deepEqual(app.moves, ['neutral', 'work-local:1', 'neutral', 'trigger']);
});

asyncTest('falls back to full tooltip verification when native search is unavailable', async () => {
  const app = fixture({ searchAvailable: false, paths: [absolute, alias] });
  assert.deepEqual(await selectAgentWorkspace(app.driver, absolute), { success: true, projectPath: absolute });
  assert.deepEqual(app.queries, []);
  assert.deepEqual(app.clicks, ['trigger', 'work-local:0']);
  assert.deepEqual(app.moves, ['neutral', 'work-local:0', 'neutral', 'work-local:1', 'neutral', 'work-local:0', 'neutral', 'trigger']);
});

asyncTest('does not report a missing folder from a pre-debounce empty result or an active search loader', async () => {
  const app = fixture({ interimEmpty: true, searchDelayMs: 270 });
  assert.deepEqual(await selectAgentWorkspace(app.driver, absolute), { success: true, projectPath: absolute });
  assert.deepEqual(app.clicks, ['trigger', 'work-local:1']);
});

asyncTest('uses the settled native no-results state without hovering unrelated projects', async () => {
  const app = fixture({ paths: [alias, '/tmp/other-project'] });
  assert.deepEqual(await selectAgentWorkspace(app.driver, absolute), { success: false, reason: 'agent_workspace_not_found' });
  assert.deepEqual(app.queries, [absolute]);
  assert.deepEqual(app.clicks, ['trigger']);
  assert.deepEqual(app.moves, []);
});

asyncTest('restores the unfiltered menu after search remains pending and then uses exact tooltips', async () => {
  const app = fixture({ searchDelayMs: 2000 });
  assert.deepEqual(await selectAgentWorkspace(app.driver, absolute), { success: true, projectPath: absolute });
  assert.deepEqual(app.queries, [absolute]);
  assert.deepEqual(app.clicks, ['trigger', 'work-local:1']);
  assert.deepEqual(app.moves, ['neutral', 'work-local:0', 'neutral', 'work-local:1', 'neutral', 'trigger']);
});

asyncTest('refuses duplicate native IDs before filtering could hide their collision', async () => {
  const app = fixture({ duplicateKeys: true });
  assert.deepEqual(await selectAgentWorkspace(app.driver, absolute), { success: false, reason: 'agent_workspace_options_unavailable' });
  assert.deepEqual(app.queries, []);
  assert.deepEqual(app.clicks, ['trigger']);
});

asyncTest('path search can narrow an oversized list but never accepts a substring tooltip', async () => {
  const paths = [absolute + '-backup', ...Array.from({ length: 35 }, (_, index) => `/tmp/other-${index}`)];
  const app = fixture({ paths });
  assert.deepEqual(await selectAgentWorkspace(app.driver, absolute), { success: false, reason: 'agent_workspace_not_found' });
  assert.deepEqual(app.queries, [absolute]);
  assert.deepEqual(app.clicks, ['trigger']);
  assert.deepEqual(app.moves, ['neutral', 'work-local:0']);
});

asyncTest('does not open the picker for an existing chat or unsent draft', async () => {
  for (const flags of [{ active: true }, { draftText: 'unsent' }]) {
    const app = fixture(flags);
    assert.deepEqual(await selectAgentWorkspace(app.driver, absolute), { success: false, reason: 'agent_workspace_draft_required' });
    assert.deepEqual(app.clicks, []);
    assert.deepEqual(app.moves, []);
  }
});

asyncTest('hover reads an existing conversation project without clicking', async () => {
  const app = fixture({ active: true, selected: absolute });
  assert.deepEqual(await readAgentWorkspace(app.driver), { success: true, projectPath: absolute });
  assert.deepEqual(app.clicks, []);
});

asyncTest('rejects an absent exact path and ambiguous duplicate exact paths', async () => {
  const missing = fixture({ paths: [alias, [absolute, '/another/folder']] });
  assert.deepEqual(await selectAgentWorkspace(missing.driver, absolute), { success: false, reason: 'agent_workspace_not_found' });
  const duplicate = fixture({ paths: [absolute, absolute] });
  assert.deepEqual(await selectAgentWorkspace(duplicate.driver, absolute), { success: false, reason: 'agent_workspace_path_ambiguous' });
  for (const app of [missing, duplicate]) {
    assert.deepEqual(app.clicks, ['trigger']);
    assert.equal(app.dismissed(), true);
  }
});

asyncTest('reports an uncertain mutation when the selected tooltip shows a different path', async () => {
  const app = fixture({ readBack: alias });
  assert.deepEqual(await selectAgentWorkspace(app.driver, absolute), {
    success: false, reason: 'agent_workspace_selection_unconfirmed', selectionDispatched: true
  });
});

asyncTest('distinguishes a visibly empty local folder list from an unsupported empty menu', async () => {
  const local = fixture({ paths: [], emptyLabel: '未找到文件夹' });
  const remote = fixture({ paths: [], emptyLabel: 'No repositories found' });
  assert.deepEqual(await selectAgentWorkspace(local.driver, absolute), { success: false, reason: 'agent_workspace_not_found' });
  assert.deepEqual(await selectAgentWorkspace(remote.driver, absolute), { success: false, reason: 'agent_workspace_options_unavailable' });
  assert.deepEqual(local.clicks, ['trigger']);
  assert.deepEqual(remote.clicks, ['trigger']);
});

pendingAsyncTests().then(() => {
  summary();
  if (runner.failed > 0) process.exitCode = 1;
});
