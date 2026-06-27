'use strict';

const { TraeCNAutomationError } = require('./errors');
const { sleep, safeJsValue } = require('../shared/utils');
const { RADIX_CLICK_INJECTION } = require('./base-driver');

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
  await client.send('Runtime.evaluate', {
    expression: `(function() {
      var buttons = document.querySelectorAll('.icube-settings-wrapper, .icube-settings-button, .codicon-icube-Settings');
      for (var i = 0; i < buttons.length; i++) {
        var rect = buttons[i].getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          window.__radixClick(buttons[i]);
          return 'clicked settings button';
        }
      }
      var tabs = document.querySelectorAll('.icube-solo-mode-tab-item');
      for (var i = 0; i < tabs.length; i++) {
        if ((tabs[i].innerText || '').trim() === '设置') {
          window.__radixClick(tabs[i]);
          return 'clicked';
        }
      }
      return 'not found';
    })()`,
    returnByValue: true
  });
  await sleep(800);
}

/**
 * Click a sidebar item in the Settings panel.
 * Must be called while on the Settings tab.
 */
async function _clickSidebarItem(client, sectionName, waitMs = 5000) {
  const safeName = safeJsValue(sectionName);
  await _ensureClickHelper(client);
  const result = await client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var items = document.querySelectorAll('.settings-sidebar-menu-item');
        if (items.length === 0) {
          // Try broader selector fallback
          items = document.querySelectorAll('[class*="sidebar-item"], [class*="menu-item"]');
        }
        for (var i = 0; i < items.length; i++) {
          // Text: try .text span first, then any text node, then aria-label
          var textEl = items[i].querySelector('.text');
          var itemText = textEl ? (textEl.textContent || '').trim()
                        : (items[i].textContent || '').trim()
                        || (items[i].getAttribute('aria-label') || '').trim();
          if (itemText === ${safeName}) {
            window.__radixClick(items[i]);
            return 'clicked: ' + itemText;
          }
        }
        // Last resort: partial match on any descendant text
        var allItems = document.querySelectorAll('[class*="sidebar"], [class*="menu"]');
        for (var i = 0; i < allItems.length; i++) {
          var txt = (allItems[i].textContent || '').trim();
          if (txt === ${safeName}) {
            window.__radixClick(allItems[i]);
            return 'clicked: ' + txt;
          }
        }
        return 'not found: ' + ${safeName};
      })()
    `,
    returnByValue: true
  });
  const value = result.result?.value || 'unknown';
  if (String(value).startsWith('clicked:')) {
    await _waitForContent(client, waitMs);
  }
  return value;
}

async function _listSettingsSidebarSections(client) {
  const result = await client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var selectors = [
          '.settings-sidebar-menu-item',
          '[class*="settings-sidebar"] [class*="menu-item"]',
          '[class*="settings"] [class*="sidebar"] [role="button"]',
          '[class*="settings"] [class*="sidebar"] button'
        ];
        var seen = Object.create(null);
        var sections = [];
        function add(text) {
          text = String(text || '').replace(/\\s+/g, ' ').trim();
          if (!text || text.length > 40 || seen[text]) return;
          seen[text] = true;
          sections.push(text);
        }
        for (var s = 0; s < selectors.length; s++) {
          var items = document.querySelectorAll(selectors[s]);
          for (var i = 0; i < items.length; i++) {
            var item = items[i];
            var textEl = item.querySelector('.text');
            add(textEl ? textEl.textContent : (item.textContent || item.getAttribute('aria-label')));
          }
          if (sections.length > 0) break;
        }
        return JSON.stringify(sections);
      })()
    `,
    returnByValue: true
  });
  const rawValue = result.result?.value;
  if (typeof rawValue !== 'string') return [];
  try {
    const sections = JSON.parse(rawValue);
    return Array.isArray(sections) ? sections.filter(Boolean) : [];
  } catch(e) {
    return [];
  }
}

/**
 * Wait for setting items to appear (handles async network loading).
 * Polls every 500ms up to maxWait ms.
 */
async function _waitForContent(client, maxWait = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const result = await client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var containerEls = document.querySelectorAll('.icb-setting-item-container');
          if (containerEls.length === 0) return 'NO_ITEMS';
          var results = [];
          for (var i = 0; i < containerEls.length; i++) {
            var el = containerEls[i];
            var labelEl = el.querySelector('.icb-setting-item-label');
            var descEl = el.querySelector('.icb-setting-item-description');
            var toggleEl = el.querySelector('input[type="checkbox"]');
            var dropdownEl = el.querySelector('[class*="auto-test-select-option"]');
            var r = el.getBoundingClientRect();
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
          return JSON.stringify(results);
        })()
      `,
      returnByValue: true
    });

    const rawValue = result.result?.value;
    if (typeof rawValue === 'string' && rawValue !== 'NO_ITEMS') {
      try {
        const items = JSON.parse(rawValue);
        if (Array.isArray(items) && items.length > 0) return items;
      } catch(e) {}
    }
    await sleep(500);
  }
  return [];
}

/**
 * Read all visible setting items in the current section.
 * Returns structured data with labels, descriptions, toggle/dropdown state, and current values.
 */
async function _readSettingsContent(client, waitMs = 8000) {
  // CDP page-level WS may lose array/object return values (result.value becomes null).
  // Workaround: use JSON.stringify inside the page, return a string, parse in Node.js.
  const result = await client.send('Runtime.evaluate', {
    expression: `
      (function() {
        // Strategy 1: standard icb-setting-item-container rows (most settings sections)
        var containerItems = document.querySelectorAll('.icb-setting-item-container');

        // Strategy 2: table-based model list (the \u6a21\u578b section uses a <table>)
        var tableRows = document.querySelectorAll('table tbody tr');

        // Prefer whichever strategy returned more items
        var containerResults = [];
        var tableResults = [];

        if (containerItems.length > 0) {
          for (var i = 0; i < containerItems.length; i++) {
            var el = containerItems[i];
            var labelEl = el.querySelector('.icb-setting-item-label');
            var descEl = el.querySelector('.icb-setting-item-description');
            var toggleEl = el.querySelector('input[type="checkbox"]');
            var dropdownEl = el.querySelector('[class*="auto-test-select-option"]');
            var r = el.getBoundingClientRect();
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
          for (var i = 0; i < tableRows.length; i++) {
            var cells = tableRows[i].querySelectorAll('td');
            if (cells.length >= 2) {
              var modelName = (cells[0].textContent || '').trim();
              var provider = (cells[1].textContent || '').trim();
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
        var chosen = containerResults.length >= tableResults.length ? containerResults : tableResults;
        var strategy = containerResults.length >= tableResults.length ? 'standard' : 'model-table';

        if (chosen.length === 0) return JSON.stringify({count: 0, type: 'none'});
        return JSON.stringify({count: chosen.length, items: chosen, type: strategy});
      })()
    `,
    returnByValue: true
  });

  const rawValue = result.result?.value;
  let parsed = {count: 0, items: [], type: 'none'};
  if (typeof rawValue === 'string') {
    try { parsed = JSON.parse(rawValue); } catch(e) {}
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
 */
async function _setDropdown(client, labelText, value) {
  const escapedLabel = labelText.replace(/'/g, "\\'");
  const escapedValue = value.replace(/'/g, "\\'");

  const result = await client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var root = document.querySelector('.icb-settings-container, .part.solo_settings, [class*="settings-content"]') || document.body;

        var items = root.querySelectorAll('.icb-setting-item-container');
        for (var i = 0; i < items.length; i++) {
          var labelEl = items[i].querySelector('.icb-setting-item-label');
          if (!labelEl) continue;
          if (labelEl.innerText.trim() !== '${escapedLabel}') continue;

          // Found the item — click it to open dropdown
          window.__radixClick(items[i]);
          return 'clicked item: ' + labelEl.innerText.trim();
        }
        return 'item not found: ' + '${escapedLabel}';
      })()
    `,
    returnByValue: true
  });
  await sleep(600);

  // Now select the option
  const optionResult = await client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var options = document.querySelectorAll('[class*="auto-test-select-option"]');
        for (var i = 0; i < options.length; i++) {
          var text = options[i].innerText.trim();
          if (text === '${escapedValue}' || text.startsWith('${escapedValue}')) {
            window.__radixClick(options[i]);
            return 'selected: ' + text;
          }
        }
        // Try partial match
        for (var i = 0; i < options.length; i++) {
          var text = options[i].innerText.trim();
          if (text.includes('${escapedValue}')) {
            window.__radixClick(options[i]);
            return 'selected (partial): ' + text;
          }
        }
        return 'option not found: ' + '${escapedValue}';
      })()
    `,
    returnByValue: true
  });
  await sleep(400);
  return optionResult.result?.value || 'unknown';
}

/**
 * Find a setting item by label text and toggle it.
 */
async function _setToggle(client, labelText, checked) {
  const escapedLabel = labelText.replace(/'/g, "\\'");

  const result = await client.send('Runtime.evaluate', {
    expression: `
      (function() {
        // Search ALL roots for the label text, then navigate to its container and toggle
        var found = null;
        var toggleEl = null;

        // Search every .icb-setting-item-label in the entire document
        var allLabels = document.querySelectorAll('.icb-setting-item-label');
        for (var i = 0; i < allLabels.length; i++) {
          var el = allLabels[i];
          var inner = (el.innerText || '').trim();
          if (inner === '${escapedLabel}') {
            found = el;
            var container = el.closest('.icb-setting-item-container');
            if (container) toggleEl = container.querySelector('input[type="checkbox"]');
            break;
          }
        }

        if (!found) {
          var debug = { searched: '${escapedLabel}', foundLabels: [] };
          var allLabelEls = document.querySelectorAll('.icb-setting-item-label');
          for (var i = 0; i < Math.min(allLabelEls.length, 10); i++) {
            debug.foundLabels.push((allLabelEls[i].innerText || '').trim());
          }
          return JSON.stringify({ error: 'label not found', debug: debug });
        }

        if (!toggleEl) return 'no toggle found';

        var currentChecked = toggleEl.checked;
        var targetChecked = ${checked};

        if (currentChecked !== targetChecked) {
          window.__radixClick(toggleEl);
          return 'toggled to: ' + !currentChecked;
        }
        return 'already in desired state: ' + currentChecked;
      })()
    `,
    returnByValue: true
  });
  await sleep(400);
  return result.result?.value || 'unknown';
}

/**
 * Inject __radixClick helper into the page if not already present.
 * Radix UI components only respond to pointerdown, not synthetic MouseEvent('click').
 * Uses the shared RADIX_CLICK_INJECTION constant from base-driver.js.
 */
async function _ensureClickHelper(client) {
  await client.send('Runtime.evaluate', {
    expression: RADIX_CLICK_INJECTION,
    returnByValue: true
  });
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
    const settingsOpen = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var s = document.querySelector('.settings-sidebar-menu-item, .icb-setting-item-container, .part.solo_settings, [class*="settings-sidebar"]');
          if (s && s.offsetParent !== null) return true;
          return false;
        })()
      `,
      returnByValue: true
    });

    if (!settingsOpen.result?.value) {
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
    } catch (e) {
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
    const safeName = safeJsValue(text);
    return await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var items = document.querySelectorAll('.settings-sidebar-menu-item');
          for (var i = 0; i < items.length; i++) {
            var textEl = items[i].querySelector('.text');
            var itemText = textEl ? (textEl.textContent || '').trim() : (items[i].textContent || '').trim();
            if (itemText === ${safeName}) {
              window.__radixClick(items[i]);
              return 'clicked: ' + itemText;
            }
          }
          return 'not found: ' + ${safeName};
        })()
      `,
      returnByValue: true
    }).then(r => r.result?.value || 'unknown');
  }

  /**
   * Click a sub-tab within the current settings section.
   * @param {string} tabText - Tab label text
   */
  async clickTab(tabText) {
    await _ensureClickHelper(this.client);
    const safeName = safeJsValue(tabText);
    return await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var items = document.querySelectorAll('.settings-sidebar-menu-item');
          for (var i = 0; i < items.length; i++) {
            var textEl = items[i].querySelector('.text');
            var itemText = textEl ? (textEl.textContent || '').trim() : (items[i].textContent || '').trim();
            if (itemText === ${safeName}) {
              window.__radixClick(items[i]);
              return 'clicked: ' + itemText;
            }
          }
          return 'not found: ' + ${safeName};
        })()
      `,
      returnByValue: true
    }).then(r => r.result?.value || 'unknown');
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
    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var tabs = document.querySelectorAll('.icube-solo-mode-tab-item');
          for (var i = 0; i < tabs.length; i++) {
            if ((tabs[i].innerText || '').trim() === '编辑器') {
              window.__radixClick(tabs[i]);
              return 'clicked: 编辑器';
            }
          }
          return 'not found';
        })()
      `,
      returnByValue: true
    });
    await sleep(800);
    this._currentTab = 'chat';
    return result.result?.value || 'unknown';
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
