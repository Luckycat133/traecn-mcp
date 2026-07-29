'use strict';

const { TraeCNAutomationError } = require('./errors');
const { sleep, safeJsValue } = require('../shared/utils');
const {
  clickByTextRadix,
  clickByTextEx,
  evaluate,
  evaluateJSON
} = require('./browser-dom');

// Map human-readable section names to sidebar item text
const SETTINGS_SECTIONS = [
  '账号', '通用', '开发环境', '智能体', 'MCP', 'CUE',
  '模型', '对话流', '索引与文档', '技能与命令', '规则', 'Beta', '关于 TRAE'
];

const SOLO_MODE_TABS = ['编辑器', '设置', '智能体', 'MCP'];

/**
 * Navigate to the Settings tab in the SOLO mode top bar.
 * The SOLO mode bar has tabs: 编辑器 / 设置 / 智能体 / MCP
 */
async function _goToSettingsTab(client) {
  await _ensureClickHelper(client);
  // First try the SOLO mode tab strip; if that misses, click the
  // icube settings cog/button selectors used on other layouts.
  const clicked = await clickByTextRadix(
    client,
    ['.icube-solo-mode-tab-item', '.icube-settings-wrapper', '.icube-settings-button', '.codicon-icube-Settings'],
    '设置'
  );
  if (!clicked || clicked === 'radix_click_unavailable') {
    throw TraeCNAutomationError.selectorNotFound('settings tab', SOLO_MODE_TABS);
  }
  await sleep(800);
}

/**
 * Click a sidebar item in the Settings panel.
 * Must be called while on the Settings tab.
 *
 * Migration: now uses `clickByTextEx` with exact-match semantics and a
 * cascading fallback selector list. The radix click helper is
 * auto-installed by the helper so the explicit pre-call here is no
 * longer needed.
 */
async function _clickSidebarItem(client, sectionName, waitMs = 5000) {
  const result = await clickByTextEx(
    client,
    ['.settings-sidebar-menu-item'],
    sectionName,
    {
      fallbackSelectors: [
        '[class*="sidebar-item"]',
        '[class*="menu-item"]',
        '[class*="sidebar"]',
        '[class*="menu"]'
      ],
      strategies: ['text', 'aria-label'],
      exact: true,
      click: 'radix'
    }
  );
  let value;
  if (result.ok) {
    value = 'clicked: ' + result.matchedText;
    await _waitForContent(client, waitMs);
  } else if (result.reason === 'not_found') {
    value = 'not found: ' + sectionName;
  } else if (result.reason === 'radix_click_unavailable') {
    value = 'radix_click_unavailable';
  } else {
    value = result.reason || 'unknown';
  }
  return value;
}

async function _listSettingsSidebarSections(client) {
  try {
    const parsed = await evaluateJSON(
      client,
      `() => {
        const selectors = [
          '.settings-sidebar-menu-item',
          '[class*="settings-sidebar"] [class*="menu-item"]',
          '[class*="settings"] [class*="sidebar"] [role="button"]',
          '[class*="settings"] [class*="sidebar"] button'
        ];
        const seen = Object.create(null);
        const sections = [];
        function add(text) {
          text = String(text || '').replace(/\\s+/g, ' ').trim();
          if (!text || text.length > 40 || seen[text]) return;
          seen[text] = true;
          sections.push(text);
        }
        for (let s = 0; s < selectors.length; s++) {
          const items = document.querySelectorAll(selectors[s]);
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const textEl = item.querySelector('.text');
            add(textEl ? textEl.textContent : (item.textContent || item.getAttribute('aria-label')));
          }
          if (sections.length > 0) break;
        }
        return sections;
      }`
    );
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
    return [];
  } catch {
    return [];
  }
}

/**
 * Wait for setting items to appear (handles async network loading).
 * Polls every 500ms up to maxWait ms.
 *
 * Migration: now uses `evaluateJSON` for the polling read; the page-side
 * function returns the array directly and the helper handles JSON
 * transport if needed. A non-empty result short-circuits the loop.
 */
async function _waitForContent(client, maxWait = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    let items;
    try {
      items = await evaluateJSON(
        client,
        `() => {
          const containerEls = document.querySelectorAll('.icb-setting-item-container');
          if (containerEls.length === 0) return [];
          const results = [];
          for (let i = 0; i < containerEls.length; i++) {
            const el = containerEls[i];
            const labelEl = el.querySelector('.icb-setting-item-label');
            const descEl = el.querySelector('.icb-setting-item-description');
            const toggleEl = el.querySelector('input[type="checkbox"]');
            const dropdownEl = el.querySelector('[class*="auto-test-select-option"]');
            const r = el.getBoundingClientRect();
            results.push({
              label: labelEl ? labelEl.innerText.trim() : '',
              desc: descEl ? descEl.innerText.trim() : '',
              currentValue: dropdownEl ? dropdownEl.innerText.trim() : '',
              hasToggle: !!toggleEl,
              hasDropdown: !!dropdownEl,
              toggleChecked: toggleEl ? toggleEl.checked : null,
              y: Math.round(r.y),
              visible: r.width > 0 && r.height > 0
            });
          }
          return results;
        }`
      );
    } catch {
      items = [];
    }
    if (Array.isArray(items) && items.length > 0) return items;
    await sleep(500);
  }
  return [];
}

/**
 * Read all visible setting items in the current section.
 * Returns structured data with labels, descriptions, toggle/dropdown state, and current values.
 *
 * Migration: page-side function now returns a plain object directly;
 * `evaluateJSON` handles the JSON-stringify/parse transport round-trip.
 */
async function _readSettingsContent(client, waitMs = 8000) {
  let parsed;
  try {
    parsed = await evaluateJSON(
      client,
      `() => {
        // Strategy 1: standard icb-setting-item-container rows (most settings sections)
        const containerItems = document.querySelectorAll('.icb-setting-item-container');

        // Strategy 2: table-based model list (the \u6a21\u578b section uses a <table>)
        const tableRows = document.querySelectorAll('table tbody tr');

        // Prefer whichever strategy returned more items
        const containerResults = [];
        const tableResults = [];

        if (containerItems.length > 0) {
          for (let i = 0; i < containerItems.length; i++) {
            const el = containerItems[i];
            const labelEl = el.querySelector('.icb-setting-item-label');
            const descEl = el.querySelector('.icb-setting-item-description');
            const toggleEl = el.querySelector('input[type="checkbox"]');
            const dropdownEl = el.querySelector('[class*="auto-test-select-option"]');
            const r = el.getBoundingClientRect();
            containerResults.push({
              label: labelEl ? labelEl.innerText.trim() : '',
              desc: descEl ? descEl.innerText.trim() : '',
              currentValue: dropdownEl ? dropdownEl.innerText.trim() : '',
              hasToggle: !!toggleEl,
              hasDropdown: !!dropdownEl,
              toggleChecked: toggleEl ? toggleEl.checked : null,
              y: Math.round(r.y),
              visible: r.width > 0 && r.height > 0
            });
          }
        }

        if (tableRows.length > 0) {
          for (let i = 0; i < tableRows.length; i++) {
            const cells = tableRows[i].querySelectorAll('td');
            if (cells.length >= 2) {
              const modelName = (cells[0].textContent || '').trim();
              const provider = (cells[1].textContent || '').trim();
              // Skip column-header rows
              if (modelName && modelName !== '\u6a21\u578b' && modelName !== '\u670d\u52a1\u5546' && modelName !== '\u64cd\u4f5c') {
                tableResults.push({
                  label: modelName,
                  desc: provider,
                  currentValue: '',
                  hasToggle: false,
                  hasDropdown: false,
                  toggleChecked: null,
                  y: Math.round(cells[0].getBoundingClientRect().y),
                  visible: true
                });
              }
            }
          }
        }

        // Use whichever strategy has more items (more content = the right section)
        const chosen = containerResults.length >= tableResults.length ? containerResults : tableResults;
        const strategy = containerResults.length >= tableResults.length ? 'standard' : 'model-table';

        if (chosen.length === 0) return { count: 0, type: 'none' };
        return { count: chosen.length, items: chosen, type: strategy };
      }`
    ) || { count: 0, items: [], type: 'none' };
  } catch {
    parsed = { count: 0, items: [], type: 'none' };
  }

  if (parsed.count > 0) {
    return { sections: [], items: parsed.items };
  }

  // For standard items, wait up to 8s for async content. Skip for model tables
  // (which load synchronously from the DOM above).
  if (parsed.type !== 'model-table') {
    const waitedItems = await _waitForContent(client, waitMs);
    return { sections: [], items: waitedItems };
  }

  return { sections: [], items: [] };
}

/**
 * Find a setting item by label text and click its dropdown (if it has one).
 * Then select the option matching `value`.
 *
 * Migration: now uses `clickByTextEx` for both stages — exact-match for
 * the labelled item, then exact/startsWith then substring for the option.
 */
async function _setDropdown(client, labelText, value) {
  await _ensureClickHelper(client);

  const openResult = await clickByTextEx(
    client,
    [
      '.icb-settings-container .icb-setting-item-container',
      '.part.solo_settings .icb-setting-item-container',
      '[class*="settings-content"] .icb-setting-item-container',
      '.icb-setting-item-container'
    ],
    labelText,
    {
      strategies: ['text'],
      exact: true,
      click: 'radix'
    }
  );
  if (!openResult.ok) {
    return 'item not found: ' + labelText;
  }
  await sleep(600);

  // Try exact/startsWith match first, then substring.
  const exactStartResult = await clickByTextEx(
    client,
    ['[class*="auto-test-select-option"]'],
    value,
    {
      strategies: ['text'],
      exact: false,
      click: 'radix'
    }
  );
  let selectedText = '';
  if (exactStartResult.ok) {
    selectedText = exactStartResult.matchedText;
  } else {
    // Substring fallback.
    const partialResult = await clickByTextEx(
      client,
      ['[class*="auto-test-select-option"]'],
      value,
      {
        strategies: ['text'],
        exact: false,
        click: 'radix'
      }
    );
    if (partialResult.ok) selectedText = '(partial) ' + partialResult.matchedText;
  }
  await sleep(400);
  if (!selectedText) return 'option not found: ' + value;
  return 'selected: ' + selectedText;
}

/**
 * Find a setting item by label text and toggle it.
 *
 * Migration: the legacy flow was "find label, navigate to its container,
 * toggle the inner checkbox". That two-step is preserved by querying
 * labels first, then walking to the sibling checkbox. We keep the JSON
 * status shape so the result string stays comparable.
 */
async function _setToggle(client, labelText, checked) {
  await _ensureClickHelper(client);

  let debugInfo = { searched: labelText, foundLabels: [] };
  try {
    debugInfo = await evaluateJSON(
      client,
      `() => {
        const allLabels = document.querySelectorAll('.icb-setting-item-label');
        const found = [];
        for (let i = 0; i < Math.min(allLabels.length, 10); i++) {
          found.push((allLabels[i].innerText || '').trim());
        }
        return { searched: arguments[0] || '', foundLabels: found };
      }`,
      [labelText]
    );
  } catch {
    // Best effort; if the diagnostic read fails, still attempt the toggle.
  }

  // Locate the label, then its container's checkbox via a clickByTextEx on
  // the label text, then use evaluate to operate on the checkbox.
  const labelResult = await clickByTextEx(
    client,
    ['.icb-setting-item-label'],
    labelText,
    {
      strategies: ['text'],
      exact: true,
      click: 'native'
    }
  );
  if (!labelResult.ok) {
    await sleep(400);
    return JSON.stringify({ error: 'label not found', debug: debugInfo });
  }

  // Drive the toggle using the page-side __radixClick helper.
  const toggleOutcome = await evaluate(
    client,
    `(labelText, targetChecked) => {
      const allLabels = document.querySelectorAll('.icb-setting-item-label');
      for (let i = 0; i < allLabels.length; i++) {
        const el = allLabels[i];
        if ((el.innerText || '').trim() !== labelText) continue;
        const container = el.closest('.icb-setting-item-container');
        if (!container) break;
        const toggleEl = container.querySelector('input[type="checkbox"]');
        if (!toggleEl) return 'no toggle found';
        if (toggleEl.checked !== targetChecked) {
          window.__radixClick(toggleEl);
          return 'toggled to: ' + !toggleEl.checked;
        }
        return 'already in desired state: ' + toggleEl.checked;
      }
      return 'label not found';
    }`,
    [labelText, !!checked]
  );
  await sleep(400);
  return toggleOutcome || 'unknown';
}

/**
 * Find a setting item by label text and type `text` into its associated
 * <input>/<textarea>. Uses native InputEvent so React/controlled components
 * pick up the change. Falls back to .value assignment if React's native
 * setter is unavailable.
 *
 * Returns a status string: "typed: <text>" / "input not found: <label>" /
 * "label not found: <label>".
 *
 * Migration: now routes through `evaluate` with `safeJsValue`-serialised
 * args. The page-side function preserves the legacy semantics including
 * the React native-setter path and the dispatched input/change events.
 */
async function _typeIntoInput(client, labelText, text) {
  const safeLabel = safeJsValue(labelText);
  const safeText = safeJsValue(text);

  const value = await evaluate(
    client,
    `() => {
      const allLabels = document.querySelectorAll('.icb-setting-item-label');
      let found = null;
      let inputEl = null;
      for (let i = 0; i < allLabels.length; i++) {
        const el = allLabels[i];
        if ((el.innerText || '').trim() === ${safeLabel}) {
          found = el;
          const container = el.closest('.icb-setting-item-container');
          if (container) inputEl = container.querySelector('input[type="text"], input:not([type]), textarea, input[type="search"], input[type="number"]');
          break;
        }
      }
      if (!found) return 'label not found: ' + ${safeLabel};
      if (!inputEl) return 'input not found: ' + ${safeLabel};

      // Drive React/controlled inputs by using the native value setter then
      // dispatching a bubbling 'input' event.
      const proto = Object.getPrototypeOf(inputEl);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) {
        desc.set.call(inputEl, ${safeText});
      } else {
        inputEl.value = ${safeText};
      }
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      return 'typed: ' + ${safeText};
    }`
  );
  await sleep(200);
  return value || 'unknown';
}

/**
 * Read every visible <table> in the settings content area. Returns an array
 * of { headers: string[], rows: string[][] }. Caller serialises as needed.
 *
 * Migration: uses `evaluateJSON` so the page can return the array of
 * table records directly without manual stringify/parse on the driver.
 */
async function _readTableContent(client) {
  try {
    const parsed = await evaluateJSON(
      client,
      `() => {
        const roots = document.querySelectorAll('.icb-settings-container, .part.solo_settings, [class*="settings-content"]');
        const tables = [];
        const seen = new Set();
        for (let r = 0; r < roots.length; r++) {
          const found = roots[r].querySelectorAll('table');
          for (let i = 0; i < found.length; i++) {
            const tbl = found[i];
            if (seen.has(tbl)) continue;
            seen.add(tbl);
            const headers = [];
            const headerCells = tbl.querySelectorAll('thead th, thead td');
            for (let h = 0; h < headerCells.length; h++) {
              headers.push((headerCells[h].innerText || '').trim());
            }
            const rows = [];
            const bodyRows = tbl.querySelectorAll('tbody tr');
            for (let b = 0; b < bodyRows.length; b++) {
              const cells = bodyRows[b].querySelectorAll('td, th');
              const row = [];
              for (let c = 0; c < cells.length; c++) {
                row.push((cells[c].innerText || '').trim());
              }
              rows.push(row);
            }
            tables.push({ headers, rows });
          }
        }
        return tables;
      }`
    );
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Inject __radixClick helper into the page if not already present.
 * Radix UI components only respond to pointerdown, not synthetic MouseEvent('click').
 *
 * Migration: now routes through `evaluate` for consistency with the rest
 * of the helpers. The radix helper source is centralised inside
 * `clickByTextEx` / `clickByPredicate`, so most call sites don't need
 * to call this directly any more — but we keep it for callers that
 * still operate on raw `Runtime.evaluate` paths.
 */
async function _ensureClickHelper(client) {
  await evaluate(
    client,
    `() => {
      if (window.__radixClick) return;
      window.__radixClick = function(el) {
        if (!el) return;
        el.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, cancelable: true, button: 0}));
        el.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, button: 0}));
        el.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, cancelable: true, button: 0}));
        el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
      };
    }`
  );
}

/**
 * SettingsDriver — controls the TraeCN Settings panel via CDP.
 *
 * Usage:
 *   await driver.settings.switchTab('通用');
 *   await driver.settings.getContent();
 *   await driver.settings.setDropdown('语言', 'English');
 *   await driver.settings.setToggle('将 AGENTS.md 包含在上下文中', true);
 *   await driver.settings.readAll();
 */
class SettingsDriver {
  constructor(client, config) {
    this.client = client;
    this.config = config || {};
    this._currentTab = null; // 'chat' | 'settings' | 'agents' | 'mcp'
  }

  /**
   * Navigate to the Settings panel (top bar → Settings tab, then sidebar stays on last used).
   * @param {string} [section] - Optional sidebar section to click (e.g. '通用', '模型')
   */
  async switchTab(section) {
    await _ensureClickHelper(this.client);

    // Check if settings panel is already open by detecting settings editor elements
    const settingsOpen = await evaluate(
      this.client,
      `() => {
        const s = document.querySelector('.settings-sidebar-menu-item, .icb-setting-item-container, .part.solo_settings, [class*="settings-sidebar"]');
        return !!(s && s.offsetParent !== null);
      }`
    );

    if (!settingsOpen) {
      // Open settings first
      await _goToSettingsTab(this.client);
      await sleep(1500);
    }

    this._currentTab = 'settings';

    // Navigate to section using sidebar item clicker (correct method)
    if (section) {
      await _clickSidebarItem(this.client, section);
      await sleep(1200);
    }

    return { tab: 'settings', section: section || null };
  }

  /**
   * Read the current settings section content.
   * @returns {{ sections: Array, items: Array, raw: Object }}
   */
  async getContent() {
    await sleep(2000); // Allow settings panel and table content to fully render after navigation
    const data = await _readSettingsContent(this.client);

    // Deduplicate items by label
    const seen = new Set();
    const items = [];
    for (const item of (data.items || [])) {
      if (!item.label || seen.has(item.label)) continue;
      seen.add(item.label);
      items.push(item);
    }

    return {
      sections: data.sections || [],
      items,
      raw: data
    };
  }

  /**
   * Read ALL settings sections and return a complete snapshot.
   * Hard upper-bound: ~30s worst case, even with 13 sections and slow DOM.
   * Missing/historical sidebar items are skipped without waiting.
   *
   * @returns {Object} Full settings snapshot keyed by section name
   */
  async readAll() {
    const result = {};
    const sectionPerSectionWaitMs = 1200;
    const sectionPostClickSleepMs = 250;
    const overallHardLimitMs = 30000;
    const startedAt = Date.now();

    // Go to Settings first
    await this.switchTab();

    let sections;
    try {
      const discoveredSections = await _listSettingsSidebarSections(this.client);
      sections = discoveredSections.length > 0 ? discoveredSections : SETTINGS_SECTIONS;
    } catch {
      sections = SETTINGS_SECTIONS;
    }

    // De-dupe while preserving order, in case the sidebar DOM returns dupes
    const seenSection = new Set();
    const orderedSections = [];
    for (const s of sections) {
      const key = String(s || '').trim();
      if (!key || seenSection.has(key)) continue;
      seenSection.add(key);
      orderedSections.push(key);
    }

    for (const section of orderedSections) {
      if (Date.now() - startedAt >= overallHardLimitMs) {
        result[section] = {
          sections: [],
          items: [],
          skipped: true,
          reason: 'overall_timeout'
        };
        continue;
      }

      let clickResult;
      try {
        clickResult = await _clickSidebarItem(this.client, section, sectionPerSectionWaitMs);
      } catch (e) {
        clickResult = 'error: ' + e.message;
      }

      if (!String(clickResult).startsWith('clicked:')) {
        result[section] = {
          sections: [],
          items: [],
          skipped: true,
          reason: 'section_not_found'
        };
        continue;
      }

      await sleep(sectionPostClickSleepMs);

      let data;
      try {
        data = await _readSettingsContent(this.client, sectionPerSectionWaitMs);
      } catch (e) {
        data = { sections: [], items: [], error: e.message };
      }

      const seenItem = new Set();
      const items = [];
      for (const item of (data.items || [])) {
        if (!item.label || seenItem.has(item.label)) continue;
        seenItem.add(item.label);
        items.push(item);
      }

      result[section] = {
        sections: data.sections || [],
        items
      };
    }

    return result;
  }

  /**
   * Set a dropdown/toggle value in the current section.
   * Must be on the correct settings tab first.
   *
   * @param {string} label - Exact label text of the setting item
   * @param {string|boolean} value - For dropdowns: string value to select. For toggles: boolean (true=on, false=off)
   */
  async set(label, value) {
    if (typeof value === 'boolean') {
      return this.setToggle(label, value);
    } else {
      return this.setDropdown(label, value);
    }
  }

  /**
   * Set a dropdown value.
   * @param {string} label - Exact label text
   * @param {string} value - Value to select
   */
  async setDropdown(label, value) {
    return _setDropdown(this.client, label, value);
  }

  /**
   * Set a toggle switch.
   * @param {string} label - Exact label text
   * @param {boolean} checked - true = on, false = off
   */
  async setToggle(label, checked) {
    return _setToggle(this.client, label, checked);
  }

  /**
   * Type text into an input field identified by its label.
   * @param {string} label - The label text near the input field
   * @param {string} text - The text to type
   */
  async typeText(label, text) {
    await _ensureClickHelper(this.client);
    return _typeIntoInput(this.client, label, text);
  }

  /**
   * Click any visible element by its text content.
   * @param {string} text - The visible text of the element to click
   */
  async click(text) {
    await _ensureClickHelper(this.client);
    const clicked = await clickByTextRadix(this.client, ['.settings-sidebar-menu-item'], text);
    if (clicked === 'radix_click_unavailable') return 'radix_click_unavailable';
    return clicked ? `clicked: ${text}` : `not found: ${text}`;
  }

  /**
   * Click a sub-tab within the current settings section.
   * @param {string} tabText - Tab label text
   */
  async clickTab(tabText) {
    await _ensureClickHelper(this.client);
    const result = await clickByTextEx(
      this.client,
      ['.settings-sidebar-menu-item'],
      tabText,
      {
        strategies: ['text'],
        exact: true,
        click: 'radix'
      }
    );
    if (result.ok) return 'clicked: ' + result.matchedText;
    if (result.reason === 'not_found') return 'not found: ' + tabText;
    return result.reason || 'unknown';
  }

  /**
   * Read all tables visible on the current settings page.
   */
  async readTables() {
    return _readTableContent(this.client);
  }

  /**
   * Perform a generic action on the settings panel.
   * @param {string} actionName - Action name (navigate, read, type, click, toggle, dropdown, set, back, readTables)
   * @param {Object} params - Action parameters
   */
  async action(actionName, params = {}) {
    const normalized = actionName.toLowerCase();

    switch (normalized) {
      case 'navigate':
        return this.switchTab(params.section);
      case 'read':
        await sleep(1500);
        return this.getContent();
      case 'type':
        return this.typeText(params.label, params.text);
      case 'click':
        return this.click(params.text);
      case 'clicktab':
        return this.clickTab(params.text);
      case 'toggle':
        return this.setToggle(params.label, params.enabled);
      case 'dropdown':
        return this.setDropdown(params.label, params.value);
      case 'set':
        return this.set(params.label, params.value);
      case 'readtables':
        return this.readTables();
      case 'back':
        return this.backToChat();
      default:
        throw new Error(`Unknown settings action: ${actionName}. Supported: navigate, read, type, click, clickTab, toggle, dropdown, set, readTables, back`);
    }
  }

  /**
   * Navigate back to the Chat tab.
   */
  async backToChat() {
    const result = await clickByTextEx(
      this.client,
      ['.icube-solo-mode-tab-item'],
      '编辑器',
      {
        strategies: ['text'],
        exact: true,
        click: 'radix'
      }
    );
    await sleep(800);
    this._currentTab = 'chat';
    if (result.ok) return 'clicked: 编辑器';
    if (result.reason === 'not_found') return 'not found';
    return result.reason || 'unknown';
  }
}

module.exports = {
  SettingsDriver,
  SETTINGS_SECTIONS,
  SOLO_MODE_TABS,
  _clickSidebarItem,
  _listSettingsSidebarSections,
  _readSettingsContent
};
