'use strict';

const { TraeCNAutomationError } = require('./errors');
const { sleep, safeJsValue } = require('../shared/utils');

// Map human-readable section names to sidebar item text
const SETTINGS_SECTIONS = [
  '账号', '通用', '智能体', 'MCP', '对话流', 'CUE',
  '模型', '上下文', '规则和技能', 'Beta', '关于 TRAE'
];

const SOLO_MODE_TABS = ['编辑器', '设置', '智能体', 'MCP'];

/**
 * Navigate to the Settings tab in the SOLO mode top bar.
 * The SOLO mode bar has tabs: 编辑器 / 设置 / 智能体 / MCP
 */
async function _goToSettingsTab(client) {
  await client.send('Runtime.evaluate', {
    expression: `(function() {
      var tabs = document.querySelectorAll('.icube-solo-mode-tab-item');
      for (var i = 0; i < tabs.length; i++) {
        if ((tabs[i].innerText || '').trim() === '设置') {
          tabs[i].dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, button: 0}));
          tabs[i].dispatchEvent(new MouseEvent('mouseup', {bubbles: true, cancelable: true, button: 0}));
          tabs[i].dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
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
async function _clickSidebarItem(client, sectionName) {
  const safeName = safeJsValue(sectionName);
  const result = await client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var items = document.querySelectorAll('.settings-sidebar-menu-item');
        for (var i = 0; i < items.length; i++) {
          // Text lives in nested .text span; innerText of the menu-item itself is
          // empty due to CSS overflow clipping.
          var textEl = items[i].querySelector('.text');
          var itemText = textEl ? (textEl.textContent || '').trim() : (items[i].textContent || '').trim();
          if (itemText === ${safeName}) {
            items[i].dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, button: 0}));
            items[i].dispatchEvent(new MouseEvent('mouseup', {bubbles: true, cancelable: true, button: 0}));
            items[i].dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
            return 'clicked: ' + itemText;
          }
        }
        return 'not found: ' + ${safeName};
      })()
    `,
    returnByValue: true
  });
  await sleep(600);
  return result.result?.value || 'unknown';
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
async function _readSettingsContent(client) {
  // CDP page-level WS may lose array/object return values (result.value becomes null).
  // Workaround: use JSON.stringify inside the page, return a string, parse in Node.js.
  const result = await client.send('Runtime.evaluate', {
    expression: `
      (function() {
        // Strategy 1: standard icb-setting-item-container rows (most settings sections)
        var allItems = document.querySelectorAll('.icb-setting-item-container');
        if (allItems.length > 0) {
          var results = [];
          for (var i = 0; i < allItems.length; i++) {
            var el = allItems[i];
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
          return JSON.stringify({count: results.length, items: results, type: 'standard'});
        }

        // Strategy 2: table-based model list (the \u6a21\u578b section uses a <table>)
        var tableRows = document.querySelectorAll('table tbody tr');
        if (tableRows.length > 0) {
          var results = [];
          for (var i = 0; i < tableRows.length; i++) {
            var cells = tableRows[i].querySelectorAll('td');
            if (cells.length >= 2) {
              var modelName = (cells[0].textContent || '').trim();
              var provider = (cells[1].textContent || '').trim();
              // Skip column-header rows
              if (modelName && modelName !== '\u6a21\u578b' && modelName !== '\u670d\u52a1\u5546' && modelName !== '\u64cd\u4f5c') {
                results.push({
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
          return JSON.stringify({count: results.length, items: results, type: 'model-table'});
        }

        return JSON.stringify({count: 0, type: 'none'});
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
    const waitedItems = await _waitForContent(client, 8000);
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
        var settingsPart = document.querySelector('.part.solo_settings');
        if (!settingsPart) return {error: 'no solo_settings'};

        var items = settingsPart.querySelectorAll('.icb-setting-item-container');
        for (var i = 0; i < items.length; i++) {
          var labelEl = items[i].querySelector('.icb-setting-item-label');
          if (!labelEl) continue;
          if (labelEl.innerText.trim() !== '${escapedLabel}') continue;

          // Found the item — click it to open dropdown
          items[i].dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
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
            options[i].dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
            return 'selected: ' + text;
          }
        }
        // Try partial match
        for (var i = 0; i < options.length; i++) {
          var text = options[i].innerText.trim();
          if (text.includes('${escapedValue}')) {
            options[i].dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
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
        var settingsPart = document.querySelector('.part.solo_settings');
        if (!settingsPart) return {error: 'no solo_settings'};

        var items = settingsPart.querySelectorAll('.icb-setting-item-container');
        for (var i = 0; i < items.length; i++) {
          var labelEl = items[i].querySelector('.icb-setting-item-label');
          if (!labelEl) continue;
          if (labelEl.innerText.trim() !== '${escapedLabel}') continue;

          var toggleEl = items[i].querySelector('input[type="checkbox"]');
          if (!toggleEl) return 'no toggle found for: ' + '${escapedLabel}';

          var currentChecked = toggleEl.checked;
          var targetChecked = ${checked};

          if (currentChecked !== targetChecked) {
            toggleEl.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
            return 'toggled to: ' + !currentChecked;
          }
          return 'already in desired state: ' + currentChecked;
        }
        return 'item not found: ' + '${escapedLabel}';
      })()
    `,
    returnByValue: true
  });
  await sleep(400);
  return result.result?.value || 'unknown';
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
    // Check which SOLO tab is currently active
    const activeTab = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var tabs = document.querySelectorAll('.icube-solo-mode-tab-item');
          for (var i = 0; i < tabs.length; i++) {
            if (tabs[i].classList.contains('active')) {
              return (tabs[i].innerText || '').trim();
            }
          }
          return 'none';
        })()
      `,
      returnByValue: true
    });
    const currentTab = activeTab.result?.value || 'none';

    // If already on Settings tab, just switch sidebar section
    if (currentTab === '设置') {
      this._currentTab = 'settings';
      if (section) {
        await _clickSidebarItem(this.client, section);
        await sleep(1000);
      }
      return { tab: 'settings', section: section || null };
    }

    // Otherwise click Settings tab (this works whether on Editor or 智能体)
    await _goToSettingsTab(this.client);
    await sleep(1000);
    this._currentTab = 'settings';

    // Optionally click a sidebar section
    if (section) {
      if (!SETTINGS_SECTIONS.includes(section)) {
        throw new Error(`Unknown settings section: ${section}. Valid: ${SETTINGS_SECTIONS.join(', ')}`);
      }
      await _clickSidebarItem(this.client, section);
      await sleep(1000);
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
   * @returns {Object} Full settings snapshot keyed by section name
   */
  async readAll() {
    const result = {};

    // Go to Settings first
    await this.switchTab();

    for (const section of SETTINGS_SECTIONS) {
      await _clickSidebarItem(this.client, section);
      await sleep(800);  // Wait for content to render
      const data = await _readSettingsContent(this.client);

      const seen = new Set();
      const items = [];
      for (const item of (data.items || [])) {
        if (!item.label || seen.has(item.label)) continue;
        seen.add(item.label);
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
   * Navigate back to the Chat tab.
   */
  async backToChat() {
    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var tabs = document.querySelectorAll('.icube-solo-mode-tab-item');
          for (var i = 0; i < tabs.length; i++) {
            if ((tabs[i].innerText || '').trim() === '编辑器') {
              tabs[i].dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, button: 0}));
              tabs[i].dispatchEvent(new MouseEvent('mouseup', {bubbles: true, cancelable: true, button: 0}));
              tabs[i].dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
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
  SOLO_MODE_TABS
};
