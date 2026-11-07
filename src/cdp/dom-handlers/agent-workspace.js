'use strict';

/* global document, getComputedStyle, innerHeight, innerWidth, location */

const path = require('path');
const { evaluate } = require('../browser-dom');
const { sleep } = require('../../shared/utils');
const SEARCH_DEBOUNCE_MS = 200;

function inspectWorkspace(request = {}) {
  if (!location.pathname.endsWith('/solo/solo-lite.html')) return { standalone: false };

  const buttonSelector = 'button[data-testid="work-workspace-selector"]';
  const menuSelector = '.workWorkspaceSelectorMenu-wSsIU5.projectSelectorMenu-Alaj5s';
  const rowSelector = '[role="menuitem"][data-key^="work-local:"]:not([aria-disabled="true"])';
  const tooltipSelector = '[role="tooltip"].visible-Rkwtkd';
  const projectClass = '.container-AtQquj';
  const menuTooltipClass = 'cascadeMenuItemTooltip-uxj87j';
  const visible = el => Boolean(el?.getClientRects().length && getComputedStyle(el).visibility === 'visible');
  const visibleNodes = (root, selector) => Array.from(root.querySelectorAll(selector)).filter(visible);
  const one = nodes => nodes.length === 1 ? nodes[0] : null;
  const hit = point => document.elementFromPoint(point.x, point.y);
  const pointFor = el => {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const target = hit(point);
    return target && el.contains(target) && !target.closest('[data-cascade-control="true"]') ? point : null;
  };

  const composers = visibleNodes(document, '.chat-input-v2-input-box-editable');
  const draft = composers.length === 1 && !composers[0].textContent.trim()
    && visibleNodes(document, '.initial-chat-panel').length === 1
    && !document.querySelector('.task-list-panel .taskItem.taskItemSelected')
    && !visibleNodes(document, '.turn.turn--last').length;
  const button = one(visibleNodes(document, buttonSelector));
  const menus = visibleNodes(document, menuSelector);
  const menu = one(menus);
  const rows = menu ? visibleNodes(menu, rowSelector) : [];
  const keys = rows.map(el => el.getAttribute('data-key'));
  const statusLabels = menu ? visibleNodes(menu, '[role="status"]').map(el => el.textContent.trim()) : [];
  const emptyLocalMenu = statusLabels.some(label => ['未找到文件夹', 'No folders found', 'フォルダが見つかりません'].includes(label));
  const emptySearch = statusLabels.some(label => ['无匹配结果', 'No matching results', '一致する結果がありません'].includes(label));
  const searchInput = menu && one(visibleNodes(menu, 'input.searchInputField-Vt8WA6'));
  const searchLoading = menu && visibleNodes(menu, '.cascadeLoading-fSFuWt').length > 0;
  if (request.focusSearch && draft && searchInput?.value === '' && !searchInput.disabled && pointFor(searchInput)) searchInput.focus();
  if (request.clearSearch && draft && searchInput?.value === request.clearSearch) {
    const clear = one(visibleNodes(menu, 'button.searchClearButton-XzodoV'));
    if (pointFor(clear)) clear.click();
  }
  const row = request.key && one(rows.filter(el => el.getAttribute('data-key') === request.key));
  if (request.scroll && draft && row) row.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  const tooltips = visibleNodes(document, tooltipSelector).filter(el => el.querySelector(projectClass));
  const tooltip = one(tooltips);
  const project = tooltip?.querySelector(projectClass);
  const trigger = request.key ? row : button;
  const hovered = request.point && trigger?.contains(hit(request.point)) && trigger.matches(':hover');
  const folders = hovered && project?.classList.contains(menuTooltipClass) === Boolean(request.key)
    ? visibleNodes(project, '.folderPath-wV5dUi[title]').map(el => el.getAttribute('title'))
    : null;
  const neutral = [{ x: 2, y: 2 }, { x: innerWidth - 3, y: 2 }, { x: 2, y: innerHeight - 3 }]
    .find(point => !hit(point)?.closest(`${buttonSelector}, ${rowSelector}, ${tooltipSelector}`));

  return {
    standalone: true,
    draft,
    button: pointFor(button),
    buttonDisabled: button?.disabled === true || button?.getAttribute('aria-disabled') === 'true',
    menuCount: menus.length,
    emptyLocalMenu,
    emptySearch,
    searchLoading: Boolean(searchLoading),
    searchValue: searchInput?.value ?? null,
    searchFocused: Boolean(searchInput && document.activeElement === searchInput),
    keys,
    row: pointFor(row),
    neutral,
    tooltipCount: tooltips.length,
    folders
  };
}

const failure = (reason, details = {}) => ({ success: false, reason, ...details });
const read = (driver, request) => evaluate(driver.client, inspectWorkspace, [request || {}]);
const move = (driver, point) => driver.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, buttons: 0 });

async function click(driver, point) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await driver.client.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  }
}

async function waitFor(driver, predicate, request, timeoutMs = 950) {
  const deadline = Date.now() + timeoutMs;
  do {
    const state = await read(driver, request);
    if (predicate(state)) return state;
    await sleep(50);
  } while (Date.now() < deadline);
  return null;
}

async function clearTooltip(driver, state) {
  if (!state.neutral) return false;
  await move(driver, state.neutral);
  return Boolean(await waitFor(driver, current => current.tooltipCount === 0));
}

async function hoverPath(driver, point, key) {
  await move(driver, point);
  const state = await waitFor(driver, current => Array.isArray(current.folders), { point, key });
  const folders = state?.folders;
  return {
    observed: Boolean(folders),
    projectPath: folders?.length === 1 && path.isAbsolute(folders[0]) ? folders[0] : null
  };
}

async function searchWorkspaceOptions(driver, menu, absolutePath) {
  if (menu.keys.length < 2 || menu.searchValue !== '') return menu;
  const focused = await read(driver, { focusSearch: true });
  if (!focused.draft || focused.menuCount !== 1 || focused.searchValue) return null;
  if (!focused.searchFocused) return focused;

  await driver.client.send('Input.insertText', { text: absolutePath });
  const earliestResultAt = Date.now() + SEARCH_DEBOUNCE_MS;
  const results = await waitFor(driver, state => Date.now() >= earliestResultAt
    && state.draft && state.menuCount === 1 && state.searchValue === absolutePath && !state.searchLoading
    && (state.keys.length > 0 || state.emptySearch));
  if (results) return results;

  // Restore the unfiltered native menu before falling back to tooltip scanning.
  await read(driver, { clearSearch: absolutePath });
  return waitFor(driver, state => state.draft && state.menuCount === 1 && state.searchValue === ''
    && !state.searchLoading && (state.keys.length > 0 || state.emptyLocalMenu));
}

function sameWorkspaceMenu(current, menu) {
  return current.draft && current.menuCount === 1 && current.searchValue === menu.searchValue
    && !current.searchLoading && current.keys.length === menu.keys.length
    && current.keys.every(key => menu.keys.includes(key));
}

async function readAgentWorkspace(driver) {
  const state = await read(driver);
  if (!state.standalone) return failure('standalone_agent_required');
  if (!state.button || state.menuCount) return failure('agent_workspace_selector_unavailable');
  if (!await clearTooltip(driver, state)) return failure('agent_workspace_tooltip_unavailable');
  const current = await read(driver);
  if (!current.button || current.menuCount) return failure('agent_workspace_selector_unavailable');
  const { projectPath } = await hoverPath(driver, current.button);
  return projectPath ? { success: true, projectPath } : failure('agent_workspace_path_unavailable');
}

async function selectAgentWorkspace(driver, absolutePath) {
  if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath) || absolutePath.includes('\0')) {
    return failure('absolute_project_path_required');
  }
  const initial = await read(driver);
  if (!initial.standalone) return failure('standalone_agent_required');
  if (!initial.draft) return failure('agent_workspace_draft_required');
  if (!initial.button || initial.buttonDisabled || initial.menuCount) return failure('agent_workspace_selector_unavailable');

  let selectionDispatched = false;
  try {
    await click(driver, initial.button);
    const opened = await waitFor(driver, state => state.menuCount === 1 && state.keys.length > 0) || await read(driver);
    if (!opened.draft || opened.menuCount !== 1 || opened.searchValue) return failure('agent_workspace_menu_unavailable');
    if (new Set(opened.keys).size !== opened.keys.length) return failure('agent_workspace_options_unavailable');
    const menu = await searchWorkspaceOptions(driver, opened, absolutePath);
    if (!menu?.draft) return failure('agent_workspace_menu_unavailable');
    if (menu.menuCount !== 1) return failure('agent_workspace_menu_unavailable');
    if (!menu.keys.length && (menu.emptyLocalMenu || (menu.searchValue === absolutePath && menu.emptySearch))) {
      return failure('agent_workspace_not_found');
    }
    if (!menu.keys.length || menu.keys.length > 32 || new Set(menu.keys).size !== menu.keys.length) {
      return failure('agent_workspace_options_unavailable');
    }

    let match = null;
    let lastHovered = null;
    for (const key of menu.keys) {
      const state = await read(driver);
      if (!sameWorkspaceMenu(state, menu) || !await clearTooltip(driver, state)) return failure('agent_workspace_menu_changed');
      const option = await read(driver, { key, scroll: true });
      if (!sameWorkspaceMenu(option, menu) || !option.row) return failure('agent_workspace_menu_changed');
      const candidate = await hoverPath(driver, option.row, key);
      if (!candidate.observed) return failure('agent_workspace_tooltip_unavailable');
      lastHovered = { key, point: option.row };
      if (candidate.projectPath === absolutePath) {
        if (match) return failure('agent_workspace_path_ambiguous');
        match = key;
      }
    }
    if (!match) {
      return failure(sameWorkspaceMenu(await read(driver), menu) ? 'agent_workspace_not_found' : 'agent_workspace_menu_changed');
    }

    let point = lastHovered.key === match ? lastHovered.point : null;
    if (!point) {
      const state = await read(driver);
      if (!sameWorkspaceMenu(state, menu) || !await clearTooltip(driver, state)) return failure('agent_workspace_menu_changed');
      const option = await read(driver, { key: match, scroll: true });
      if (!sameWorkspaceMenu(option, menu) || !option.row) return failure('agent_workspace_menu_changed');
      point = option.row;
      await hoverPath(driver, point, match);
    }
    const confirmed = await read(driver, { key: match, point });
    if (!sameWorkspaceMenu(confirmed, menu) || confirmed.folders?.length !== 1 || confirmed.folders[0] !== absolutePath) {
      return failure('agent_workspace_menu_changed');
    }
    selectionDispatched = true;
    await click(driver, point);
    if (await waitFor(driver, state => state.menuCount === 0 && state.draft)) {
      const selected = await readAgentWorkspace(driver);
      if (selected.projectPath === absolutePath) return selected;
    }
    return failure('agent_workspace_selection_unconfirmed', { selectionDispatched });
  } catch (error) {
    if (selectionDispatched) return failure('agent_workspace_selection_unconfirmed', { selectionDispatched });
    throw error;
  } finally {
    const state = await read(driver).catch(() => null);
    if (state?.draft && state.menuCount === 1) {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await driver.client.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
      }
    }
  }
}

module.exports = { readAgentWorkspace, selectAgentWorkspace };
