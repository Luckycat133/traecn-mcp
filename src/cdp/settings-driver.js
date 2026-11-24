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
  '账号', '用量管理', '通用', '开发环境', '智能体', 'MCP', 'CUE', '模型',
  '对话流', '浏览器', '索引与文档', '技能与命令', '规则与记忆', 'Hooks',
  'Beta', '关于 TRAE'
];

const SOLO_MODE_TABS = ['编辑器', '设置', '智能体', 'MCP'];
const AGENT_SETTINGS_BODY = '.icube-settings-container .icube-settings-content-body';
const TEXT_SETTING_CONTROL = 'input[type="text"], input:not([type]), textarea, input[type="search"], input[type="number"]';

const VISIBLE_ELEMENT = `function visible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}`;

const MATCH_SETTING_ROWS = `function matchingRows(root, labelText) {
  return Array.from(root?.querySelectorAll('.icb-setting-item-container') || []).filter(row => {
    const label = row.querySelector('.icb-setting-item-label');
    return visible(row) && String(label?.innerText || label?.textContent || '').trim() === labelText;
  });
}`;

async function _agentSettingsUi(client, action = 'read', section = null) {
  return evaluate(client, `(action, section) => {
    ${VISIBLE_ELEMENT}
    function clickOnly(elements) {
      if (elements.length !== 1 || elements[0].disabled || elements[0].getAttribute('aria-disabled') === 'true') return false;
      elements[0].click();
      return true;
    }
    function label(el, selector) {
      const text = el.querySelector(selector);
      return String(text?.innerText || text?.textContent || '').trim();
    }

    if (action === 'open-menu') {
      const menu = document.querySelector('[class*="accountHostRoot"]');
      const triggers = Array.from(menu?.querySelectorAll('button[class*="accountTrigger"]') || []).filter(visible);
      return triggers.length === 1 && (triggers[0].getAttribute('aria-expanded') === 'true' || clickOnly(triggers));
    }
    if (action === 'open-settings') {
      const entries = Array.from(document.querySelectorAll('button[class*="accountMenuItem"]')).filter(el =>
        visible(el) && ['设置', 'Settings'].includes(label(el, '[class*="accountMenuLabel"]')));
      return clickOnly(entries);
    }

    const sidebars = Array.from(document.querySelectorAll('.icube-settings-sidebar-container')).filter(visible);
    if (sidebars.length !== 1) return { open: sidebars.length > 0, active: null, sections: [] };
    const sidebar = sidebars[0];
    if (action === 'back') {
      const entries = Array.from(sidebar.querySelectorAll('.back-to-app-container .settings-sidebar-menu-item')).filter(el =>
        visible(el) && ['返回应用', 'Back to App'].includes(label(el, '.text')));
      return clickOnly(entries);
    }

    const rows = Array.from(sidebar.querySelectorAll('.settings-sidebar-menu-item.menu-item2')).filter(visible);
    if (action === 'section') {
      const matches = rows.filter(el => label(el, '.text') === section);
      return matches.length === 1 && (matches[0].classList.contains('active') || clickOnly(matches));
    }
    const active = rows.filter(el => el.classList.contains('active'));
    return {
      open: true,
      active: active.length === 1 ? label(active[0], '.text') : null,
      sections: [...new Set(rows.map(el => label(el, '.text')).filter(Boolean))]
    };
  }`, [action, section]);
}

async function _waitForAgentSettingsUi(read, ready) {
  const end = Date.now() + 3000;
  do {
    const state = await read();
    if (ready(state)) return state;
    await sleep(125);
  } while (Date.now() < end);
  return null;
}

async function _goToAgentSettings(client) {
  if (!await _agentSettingsUi(client, 'open-settings')) {
    if (!await _agentSettingsUi(client, 'open-menu') || !await _waitForAgentSettingsUi(
      () => _agentSettingsUi(client, 'open-settings'), Boolean
    )) {
      throw TraeCNAutomationError.selectorNotFound('Agent settings menu', ['设置', 'Settings']);
    }
  }
  const ready = await _waitForAgentSettingsUi(() => _agentSettingsUi(client), state => Boolean(state.active));
  if (!ready) throw TraeCNAutomationError.selectorNotFound('Agent settings sidebar', ['.settings-sidebar-menu-item.menu-item2.active']);
}

async function _clickAgentSettingsSection(client, section) {
  if (!await _agentSettingsUi(client, 'section', section)) return `not found: ${section}`;
  const ready = await _waitForAgentSettingsUi(() => _agentSettingsUi(client), state => state.active === section);
  return ready ? `clicked: ${section}` : 'native sidebar did not confirm the selection';
}

/**
 * Navigate to the Settings tab in the SOLO mode top bar.
 * The SOLO mode bar has tabs: 编辑器 / 设置 / 智能体 / MCP
 */
async function _goToSettingsTab(client) {
  await _ensureClickHelper(client);
  const point = await evaluateJSON(client, `() => {
    const selectors = [
      '.icube-settings-button-icon.codicon-icube-Settings',
      '[class*="settings-button"] .codicon-icube-Settings',
      '.tab-label[aria-label="设置"]',
      '.tab[aria-label^="设置"]',
      '.icube-solo-mode-tab-item',
      '[aria-label="设置"]',
      '[title="设置"]',
      '[aria-label*="Settings"]',
      '[title*="Settings"]',
      '.codicon-icube-Settings',
      '.codicon-settings'
    ];
    let target = null;
    for (const selector of selectors) {
      target = Array.from(document.querySelectorAll(selector)).find(el => {
        const text = String(el.innerText || el.textContent || '').trim();
        if (selector === '.icube-solo-mode-tab-item' && text !== '设置') return false;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 4 && r.height > 4
          && style.visibility !== 'hidden'
          && style.display !== 'none';
      });
      if (target) break;
    }
    if (!target) return null;
    const r = target.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }`);
  if (point) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1
    });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1
    });
    await sleep(800);
    return;
  }
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
  await _expandSettingsSidebarIfNeeded(client, sectionName);
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

async function _expandSettingsSidebarIfNeeded(client, sectionName) {
  const result = await evaluate(
    client,
    `function() {
      const sectionName = arguments[0];
      function isVisible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0
          && style.visibility !== 'hidden'
          && style.display !== 'none';
      }
      const items = Array.from(document.querySelectorAll('.settings-sidebar-menu-item'));
      const requestedVisible = items.some(el => {
        const text = String(el.querySelector('.text')?.textContent || el.textContent || '').trim();
        return text === sectionName && isVisible(el);
      });
      if (requestedVisible) return { status: 'already_visible' };

      const toggle = document.querySelector(
        '.icube-settings-sidebar-nav-button-container button, button:has(.codicon-icube-menuToggle)'
      );
      if (!isVisible(toggle)) return { status: 'toggle_not_found' };
      const r = toggle.getBoundingClientRect();
      return { status: 'toggle', x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }`,
    [sectionName]
  );
  if (result?.status === 'toggle') {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: result.x,
      y: result.y,
      button: 'left',
      clickCount: 1
    });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: result.x,
      y: result.y,
      button: 'left',
      clickCount: 1
    });
    await sleep(250);
    return 'opened';
  }
  return result?.status || result;
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
async function _waitForContent(client, maxWait = 8000, agent = false) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const parsed = await _inspectSettingsContent(client, agent);
    const items = Array.isArray(parsed) ? parsed : parsed.items;
    if (Array.isArray(items) && items.length > 0) return items;
    if (parsed.type === 'model-table') return [];
    await sleep(agent ? 125 : 500);
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
async function _inspectSettingsContent(client, agent = false) {
  let parsed;
  try {
    parsed = await evaluateJSON(
      client,
      `(agent) => {
        const root = agent ? document.querySelector(${safeJsValue(AGENT_SETTINGS_BODY)}) : document;
        if (!root) return { count: 0, items: [], type: 'none' };
        // Strategy 1: standard icb-setting-item-container rows (most settings sections)
        const containerItems = root.querySelectorAll('.icb-setting-item-container');

        // Strategy 2: table-based model list (the \u6a21\u578b section uses a <table>)
        const tableRows = root.querySelectorAll([
          '.icube-settings-container table tbody tr',
          '.part.solo_settings table tbody tr',
          '[class*="settings-content"] table tbody tr'
        ].join(','));

        // Strategy 3: settings pages that use custom cards/lists instead of
        // the standard setting-row component (usage, agents, index/docs).
        const customItems = root.querySelectorAll([
          '.ai-agent-list-item-name',
          '.codeIndex-list-item',
          '.user-entitlement-credits-overview-card',
          '.user-entitlement-credits-item',
          '.icd-docset-list',
          '.icube-settings-content-body .permission-approval-settings .permission-approval-settings-card'
        ].join(','));

        // Prefer whichever strategy returned more items
        const containerResults = [];
        const tableResults = [];
        const customResults = [];

        if (containerItems.length > 0) {
          for (let i = 0; i < containerItems.length; i++) {
            const el = containerItems[i];
            const r = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            if (r.width <= 0 || r.height <= 0
              || style.visibility === 'hidden'
              || style.display === 'none') continue;
            const labelEl = el.querySelector('.icb-setting-item-label');
            const descEl = el.querySelector('.icb-setting-item-description');
            const toggleEl = el.querySelector('input[type="checkbox"]');
            const dropdownEl = el.querySelector('[class*="auto-test-select-option"]');
            const textInputEl = el.querySelector(${safeJsValue(TEXT_SETTING_CONTROL)});
            containerResults.push({
              label: labelEl ? labelEl.innerText.trim() : '',
              desc: descEl ? descEl.innerText.trim() : '',
              currentValue: dropdownEl ? dropdownEl.innerText.trim()
                : (textInputEl ? String(textInputEl.value ?? '') : ''),
              hasToggle: !!toggleEl && (!agent || !toggleEl.disabled),
              hasDropdown: !!dropdownEl,
              hasTextInput: !!textInputEl && (!agent || (!textInputEl.readOnly && !textInputEl.disabled)),
              toggleChecked: toggleEl ? toggleEl.checked : null,
              y: Math.round(r.y),
              visible: true
            });
          }
        }

        if (tableRows.length > 0) {
          for (let i = 0; i < tableRows.length; i++) {
            const rowRect = tableRows[i].getBoundingClientRect();
            const rowStyle = getComputedStyle(tableRows[i]);
            if (rowRect.width <= 0 || rowRect.height <= 0
              || rowStyle.visibility === 'hidden'
              || rowStyle.display === 'none') continue;
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
                  hasTextInput: false,
                  toggleChecked: null,
                  y: Math.round(cells[0].getBoundingClientRect().y),
                  visible: true
                });
              }
            }
          }
        }

        if (customItems.length > 0) {
          for (let i = 0; i < customItems.length; i++) {
            const el = customItems[i];
            const r = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            if (r.width <= 0 || r.height <= 0
              || style.visibility === 'hidden'
              || style.display === 'none') continue;
            const className = String(el.className || '');
            const text = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!text) continue;

            // The native permission page displays modes, but its radios and
            // configuration action are not writable setting controls.
            if (className.includes('permission-approval-settings-card')) {
              function visible(node) {
                if (!node) return false;
                const rect = node.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return false;
                for (let current = node; current; current = current.parentElement) {
                  const style = getComputedStyle(current);
                  if (style.visibility === 'hidden' || style.display === 'none') return false;
                }
                return true;
              }
              function read(node, selector) {
                const target = node.querySelector(selector);
                return visible(target) ? String(target.innerText || target.textContent || '').replace(/\\s+/g, ' ').trim() : '';
              }
              function addDisplay(node, label, desc, currentValue = '') {
                if (!label) return;
                customResults.push({
                  label, desc, currentValue,
                  hasToggle: false, hasDropdown: false, hasTextInput: false,
                  toggleChecked: null, y: Math.round(node.getBoundingClientRect().y), visible: true
                });
              }
              if (!visible(el)) continue;
              const modes = Array.from(el.querySelectorAll('.permission-approval-settings-mode-item')).filter(visible);
              const checked = modes.filter(mode => {
                const radio = mode.querySelector('.permission-approval-settings-mode-radio');
                return visible(radio) && radio.getAttribute('data-checked') === 'true';
              });
              const selected = checked.length === 1 ? checked[0] : null;
              addDisplay(el, read(el, '.permission-approval-settings-card-header-title'),
                selected ? read(selected, '.permission-approval-settings-mode-desc')
                  : read(el, '.permission-approval-settings-card-header-desc'),
                selected ? read(selected, '.permission-approval-settings-mode-label') : '');
              for (const mode of modes) {
                if (!visible(mode.querySelector('.permission-approval-settings-mode-action'))) continue;
                addDisplay(mode, read(mode, '.permission-approval-settings-mode-label'),
                  read(mode, '.permission-approval-settings-mode-desc'));
              }
              continue;
            }

            let label = text;
            let desc = '';
            let currentValue = '';
            if (className.includes('user-entitlement-credits-overview-card')) {
              label = '积分概览';
              desc = text;
            } else if (className.includes('user-entitlement-credits-item')) {
              label = String(el.querySelector('.user-entitlement-credits-item-title')?.textContent || text).trim();
              desc = String(el.querySelector('.user-entitlement-credits-item-expire')?.textContent || '').trim();
              currentValue = String(el.querySelector('.user-entitlement-credits-item-amount')?.textContent || '').trim();
            } else if (className.includes('codeIndex-list-item')) {
              const percentage = text.match(/\\d+(?:\\.\\d+)?%/);
              label = text.replace(/\\d+(?:\\.\\d+)?%/g, '').trim();
              currentValue = percentage ? percentage[0] : '';
            } else if (className.includes('icd-docset-list')) {
              label = '文档集';
              desc = text;
            }

            customResults.push({
              label,
              desc,
              currentValue,
              hasToggle: false,
              hasDropdown: false,
              hasTextInput: false,
              toggleChecked: null,
              y: Math.round(r.y),
              visible: true
            });
          }
        }

        // Use whichever strategy has more items (more content = the right section).
        const candidates = [
          { type: 'standard', items: containerResults },
          { type: 'model-table', items: tableResults },
          { type: 'custom', items: customResults }
        ].sort((a, b) => b.items.length - a.items.length);
        const chosen = candidates[0].items;
        const strategy = candidates[0].type;

        if (chosen.length === 0) {
          const emptyModels = root.querySelectorAll('.icube-settings-container .custom-model-no-data');
          const emptyModelVisible = Array.from(emptyModels).some(el => {
            const r = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return r.width > 0 && r.height > 0
              && style.visibility !== 'hidden' && style.display !== 'none';
          });
          return { count: 0, items: [], type: emptyModelVisible ? 'model-table' : 'none' };
        }
        return { count: chosen.length, items: chosen, type: strategy };
      }`, [agent]
    ) || { count: 0, items: [], type: 'none' };
  } catch {
    parsed = { count: 0, items: [], type: 'none' };
  }
  return parsed;
}

async function _readSettingsContent(client, waitMs = 8000, agent = false) {
  const parsed = await _inspectSettingsContent(client, agent);

  if (parsed.count > 0) {
    return { sections: [], items: parsed.items };
  }

  // Wait for every supported content shape after a loading snapshot. Explicit
  // empty-model UI is already readable and does not need standard setting rows.
  if (parsed.type !== 'model-table') {
    const waitedItems = await _waitForContent(client, waitMs, agent);
    return { sections: [], items: waitedItems };
  }

  return { sections: [], items: [] };
}

/**
 * Find a setting item by label text and click its dropdown (if it has one).
 * Then select the option matching `value`.
 *
 * Bind the exact labelled row's combobox to its aria-controls portal.
 * Current-value text under other triggers is never an option candidate.
 */
async function _openSettingsDropdown(client, labelText, agent) {
  const point = await evaluateJSON(client, `(labelText, agent) => {
    function visible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 4 || r.height <= 4) return false;
      for (let node = el; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
      }
      return true;
    }
    ${MATCH_SETTING_ROWS}
    const root = agent ? document.querySelector(${safeJsValue(AGENT_SETTINGS_BODY)}) : document;
    const rows = matchingRows(root, labelText);
    if (agent && rows.length !== 1) return null;
    for (const row of rows) {
      const trigger = row.querySelector('button[role="combobox"], [role="combobox"]');
      if (!visible(trigger) || trigger.disabled || trigger.getAttribute('aria-disabled') === 'true') return null;
      const controlsId = trigger.getAttribute('aria-controls');
      if (!controlsId) return null;
      if (agent) trigger.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = trigger.getBoundingClientRect();
      return { controlsId, x: r.left + r.width / 2, y: r.top + r.height / 2,
        alreadyOpen: trigger.getAttribute('aria-expanded') === 'true' };
    }
    return null;
  }`, [labelText, agent]);
  if (!point) return null;
  if (!point.alreadyOpen) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1
    });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1
    });
    if (!agent) await sleep(300);
  }
  return point.controlsId;
}

async function _settingsDropdownOptions(client, controlsId) {
  return evaluateJSON(client, `(controlsId) => {
    const portal = document.getElementById(controlsId);
    if (!portal || portal.getAttribute('role') !== 'listbox') return [];
    const pr = portal.getBoundingClientRect();
    const ps = getComputedStyle(portal);
    if (pr.width <= 4 || pr.height <= 4 || ps.display === 'none' || ps.visibility === 'hidden') return [];
    return Array.from(portal.querySelectorAll('[role="option"]')).flatMap(option => {
      const r = option.getBoundingClientRect();
      const style = getComputedStyle(option);
      const label = String(option.innerText || option.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!label || r.width <= 4 || r.height <= 4 || style.visibility === 'hidden' || style.display === 'none'
        || option.getAttribute('aria-disabled') === 'true' || option.getAttribute('data-disabled') !== null) return [];
      return [{ label, x: r.left + r.width / 2, y: r.top + r.height / 2 }];
    });
  }`, [controlsId]);
}

async function _readSettingsDropdownOptions(client, controlsId, agent) {
  const read = () => _settingsDropdownOptions(client, controlsId);
  if (!agent) return read();
  return await _waitForAgentSettingsUi(read, options => options.length > 0) || [];
}

async function _agentDropdownSelected(client, labelText, value, controlsId) {
  return evaluate(client, `(labelText, value, controlsId) => {
    ${VISIBLE_ELEMENT}
    ${MATCH_SETTING_ROWS}
    const rows = matchingRows(document.querySelector(${safeJsValue(AGENT_SETTINGS_BODY)}), labelText);
    if (rows.length !== 1) return false;
    const trigger = rows[0].querySelector('[role="combobox"]');
    const selected = rows[0].querySelector('[class*="auto-test-select-option"]');
    return visible(trigger) && trigger.getAttribute('aria-expanded') === 'false'
      && !visible(document.getElementById(controlsId))
      && String(selected?.innerText || selected?.textContent || '').trim() === value;
  }`, [labelText, value, controlsId]);
}

async function _closeSettingsDropdown(client, controlsId) {
  const open = await evaluate(client, `(controlsId) => {
    const portal = document.getElementById(controlsId);
    if (!portal) return false;
    const r = portal.getBoundingClientRect();
    const style = getComputedStyle(portal);
    return r.width > 4 && r.height > 4 && style.display !== 'none' && style.visibility !== 'hidden';
  }`, [controlsId]);
  if (!open) return;
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27
  });
}

async function _setDropdown(client, labelText, value, agent) {
  const controlsId = await _openSettingsDropdown(client, labelText, agent);
  if (!controlsId) return 'item not found: ' + labelText;
  try {
    const options = await _readSettingsDropdownOptions(client, controlsId, agent);
    const matches = options.filter(option => option.label === value);
    const match = agent && matches.length !== 1 ? null : matches[0];
    if (!match) return 'option not found: ' + value;
    // Radix ignores the first pointerup after opening until the pointer moves.
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: match.x, y: match.y, button: 'none', buttons: 0
    });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: match.x, y: match.y, button: 'left', buttons: 1, clickCount: 1
    });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: match.x, y: match.y, button: 'left', buttons: 0, clickCount: 1
    });
    if (agent) {
      const applied = await _waitForAgentSettingsUi(
        () => _agentDropdownSelected(client, labelText, match.label, controlsId), Boolean
      );
      if (!applied) return 'selection not confirmed: ' + match.label;
    } else {
      await sleep(400);
    }
    return 'selected: ' + match.label;
  } finally {
    await _closeSettingsDropdown(client, controlsId);
  }
}

async function _listDropdownOptions(client, labelText, agent) {
  const controlsId = await _openSettingsDropdown(client, labelText, agent);
  if (!controlsId) return [];
  try {
    const options = await _readSettingsDropdownOptions(client, controlsId, agent);
    return [...new Set(options.map(option => option.label))];
  } finally {
    await _closeSettingsDropdown(client, controlsId);
  }
}

function normalizeSettingItem(item) {
  let controlType = 'display';
  if (item.hasToggle) controlType = 'toggle';
  else if (item.hasDropdown) controlType = 'option';
  else if (item.hasTextInput) controlType = 'text';
  return { ...item, controlType };
}

async function _agentSettingControl(client, label, type, action, targetChecked = null) {
  const selector = type === 'toggle' ? 'input[type="checkbox"]' : TEXT_SETTING_CONTROL;
  return evaluate(client, `(label, selector, action, targetChecked) => {
    ${VISIBLE_ELEMENT}
    ${MATCH_SETTING_ROWS}
    const root = document.querySelector(${safeJsValue(AGENT_SETTINGS_BODY)});
    const rows = matchingRows(root, label);
    if (rows.length !== 1) return 'setting row not found or ambiguous';
    const row = rows[0];
    const controls = Array.from(row.querySelectorAll(selector)).filter(el =>
      !el.disabled && !el.readOnly && (selector === 'input[type="checkbox"]' || visible(el)));
    if (controls.length !== 1) return 'writable control not found or ambiguous';
    const control = controls[0];
    if (action === 'toggle') {
      if (control.checked === targetChecked) return 'already in desired state: ' + control.checked;
      const labels = Array.from(control.labels || []).filter(el => row.contains(el) && visible(el));
      const clickable = labels.length === 1 ? labels[0] : (labels.length === 0 && visible(control) ? control : null);
      if (!clickable) return 'visible toggle control not found or ambiguous';
      clickable.click();
      return 'toggled';
    }
    if (action === 'checked') return control.checked;
    if (action === 'focus') {
      control.focus();
      control.select();
      return document.activeElement === control;
    }
    if (document.activeElement !== control) return false;
    control.blur();
    return true;
  }`, [label, selector, action, targetChecked]);
}

async function _setAgentToggle(client, label, checked) {
  const outcome = await _agentSettingControl(client, label, 'toggle', 'toggle', checked);
  if (outcome !== 'toggled') return outcome;
  const actual = await _waitForAgentSettingsUi(() => _agentSettingControl(client, label, 'toggle', 'checked'),
    value => value === checked);
  return actual === checked ? `toggled to: ${actual}` : `toggle not applied: expected ${checked}`;
}

async function _typeIntoAgentInput(client, label, text) {
  const focused = await _agentSettingControl(client, label, 'text', 'focus');
  if (focused !== true) return typeof focused === 'string' ? focused : `input not focused: ${label}`;
  let blurred;
  try {
    if (text) await client.send('Input.insertText', { text });
    else {
      const key = { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 };
      await client.send('Input.dispatchKeyEvent', { ...key, type: 'keyDown' });
      await client.send('Input.dispatchKeyEvent', { ...key, type: 'keyUp' });
    }
  } finally {
    blurred = await _agentSettingControl(client, label, 'text', 'blur');
  }
  if (blurred !== true) return `input commit not confirmed: ${label}`;
  return `typed: ${text}`;
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
          return 'toggled';
        }
        return 'already in desired state: ' + toggleEl.checked;
      }
      return 'label not found';
    }`,
    [labelText, !!checked]
  );
  await sleep(400);
  if (toggleOutcome === 'toggled') {
    const actualChecked = await evaluate(client, `(labelText) => {
      for (const label of document.querySelectorAll('.icb-setting-item-label')) {
        if (String(label.innerText || label.textContent || '').trim() !== labelText) continue;
        const input = label.closest('.icb-setting-item-container')?.querySelector('input[type="checkbox"]');
        return input ? input.checked : null;
      }
      return null;
    }`, [labelText]);
    if (actualChecked !== !!checked) return 'toggle not applied: expected ' + !!checked + ', observed ' + actualChecked;
    return 'toggled to: ' + actualChecked;
  }
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
  constructor(client, config, options = {}) {
    this.client = client;
    this.config = config || {};
    this._ensureVisibleWindow = typeof options.ensureVisibleWindow === 'function'
      ? options.ensureVisibleWindow : async () => {};
    this._agentSettings = false;
    this._currentTab = null; // 'chat' | 'settings' | 'agents' | 'mcp'
  }

  /**
   * Navigate to the Settings panel (top bar → Settings tab, then sidebar stays on last used).
   * @param {string} [section] - Optional sidebar section to click (e.g. '通用', '模型')
   */
  async switchTab(section) {
    await this._ensureVisibleWindow();
    await _ensureClickHelper(this.client);

    const settingsOpen = await evaluate(
      this.client,
      `() => {
        if (document.location?.pathname.endsWith('/solo/solo-lite.html')) return 'agent';
        const soloTab = document.querySelector('.icube-solo-mode-tab-item.active');
        if (soloTab) {
          return String(soloTab.innerText || soloTab.textContent || '').trim() === '设置';
        }
        const editorTab = document.querySelector('.tab.active');
        if (editorTab) {
          const label = String(
            editorTab.getAttribute('aria-label')
              || editorTab.querySelector?.('.tab-label')?.getAttribute('aria-label')
              || editorTab.innerText
              || editorTab.textContent
              || ''
          ).trim();
          return editorTab.getAttribute('data-resource-name') === 'icube-settings'
            || /^设置(?:[,，]|$)/.test(label);
        }
        const sidebar = document.querySelector('.icube-settings-sidebar-container, [class*="settings-sidebar"]');
        return !!(sidebar && sidebar.offsetParent !== null);
      }`
    );

    this._agentSettings = settingsOpen === 'agent';
    if (this._agentSettings) {
      const state = await _agentSettingsUi(this.client);
      if (!state.open) await _goToAgentSettings(this.client);
      else if (!state.active && !await _waitForAgentSettingsUi(
        () => _agentSettingsUi(this.client), value => Boolean(value.active)
      )) {
        throw TraeCNAutomationError.selectorNotFound('Agent settings sidebar', ['.settings-sidebar-menu-item.menu-item2.active']);
      }
    } else if (!settingsOpen) {
      await _goToSettingsTab(this.client);
      await sleep(1500);
    }

    this._currentTab = 'settings';

    // Navigate to section using sidebar item clicker (correct method)
    if (section) {
      const clickResult = this._agentSettings
        ? await _clickAgentSettingsSection(this.client, section)
        : await _clickSidebarItem(this.client, section);
      if (!String(clickResult).startsWith('clicked:')) {
        throw TraeCNAutomationError.settingsSectionNotActivated(section, clickResult);
      }
      if (!this._agentSettings) await sleep(1200);
    }

    return { tab: 'settings', section: section || null };
  }

  async listSections() {
    await this.switchTab();
    return this._settingsSections();
  }

  async _settingsSections() {
    if (this._agentSettings) {
      const state = await _agentSettingsUi(this.client);
      if (!state.active) throw TraeCNAutomationError.settingsContentUnavailable('Agent sidebar');
      return state.sections;
    }
    const discovered = await _listSettingsSidebarSections(this.client);
    return discovered.length > 0 ? discovered : SETTINGS_SECTIONS.slice();
  }

  async listOptions(label) {
    await this._ensureVisibleWindow();
    return _listDropdownOptions(this.client, label, this._agentSettings);
  }

  /**
   * Read the current settings section content.
   * @returns {{ sections: Array, items: Array, raw: Object }}
   */
  async getContent() {
    if (!this._agentSettings) await sleep(2000);
    const data = await _readSettingsContent(this.client, undefined, this._agentSettings);

    // Deduplicate items by label
    const seen = new Set();
    const items = [];
    for (const item of (data.items || [])) {
      if (!item.label || seen.has(item.label)) continue;
      seen.add(item.label);
      items.push(normalizeSettingItem(item));
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

    await this.switchTab();

    const sections = await this._settingsSections();

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
        clickResult = this._agentSettings
          ? await _clickAgentSettingsSection(this.client, section)
          : await _clickSidebarItem(this.client, section, sectionPerSectionWaitMs);
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

      if (!this._agentSettings) await sleep(sectionPostClickSleepMs);

      let data;
      try {
        data = await _readSettingsContent(this.client, sectionPerSectionWaitMs, this._agentSettings);
      } catch (e) {
        data = { sections: [], items: [], error: e.message };
      }

      const seenItem = new Set();
      const items = [];
      for (const item of (data.items || [])) {
        if (!item.label || seenItem.has(item.label)) continue;
        seenItem.add(item.label);
        items.push(normalizeSettingItem(item));
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
    await this._ensureVisibleWindow();
    return _setDropdown(this.client, label, value, this._agentSettings);
  }

  /**
   * Set a toggle switch.
   * @param {string} label - Exact label text
   * @param {boolean} checked - true = on, false = off
   */
  async setToggle(label, checked) {
    await this._ensureVisibleWindow();
    if (this._agentSettings) return _setAgentToggle(this.client, label, checked);
    return _setToggle(this.client, label, checked);
  }

  /**
   * Type text into an input field identified by its label.
   * @param {string} label - The label text near the input field
   * @param {string} text - The text to type
   */
  async typeText(label, text) {
    await this._ensureVisibleWindow();
    if (this._agentSettings) return _typeIntoAgentInput(this.client, label, text);
    await _ensureClickHelper(this.client);
    return _typeIntoInput(this.client, label, text);
  }

  /**
   * Click any visible element by its text content.
   * @param {string} text - The visible text of the element to click
   */
  async click(text) {
    await this._ensureVisibleWindow();
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
    await this._ensureVisibleWindow();
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
        if (!this._agentSettings) await sleep(1500);
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
    const closePoint = await evaluate(this.client, `() => {
      if (document.location?.pathname.endsWith('/solo/solo-lite.html')) return 'agent';
      function visible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }
      const solo = document.querySelector('.icube-solo-mode-tab-item.active[data-tab-key="solo_settings"]');
      const ide = document.querySelector('.tab.active[data-resource-name="icube-settings"]');
      const tab = visible(solo) ? solo : (visible(ide) ? ide : null);
      const close = tab === solo
        ? tab?.querySelector('.icube-solo-mode-tab-close-half')
        : tab?.querySelector('.tab-actions .action-label.codicon-icube-SmallClose[aria-label^="关闭"]');
      if (!close) return null;
      const r = close.getBoundingClientRect();
      const style = getComputedStyle(close);
      if (r.width <= 0 || r.height <= 0
        || style.visibility === 'hidden' || style.display === 'none') return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }`);
    if (closePoint === 'agent') {
      const before = await _agentSettingsUi(this.client);
      if (!before.open) return 'not found';
      if (!await _agentSettingsUi(this.client, 'back')) return 'not found';
      const after = await _waitForAgentSettingsUi(() => _agentSettingsUi(this.client), state => !state.open);
      if (!after) return 'settings still visible';
      this._currentTab = 'chat';
      return 'clicked: 返回应用';
    }
    if (closePoint) {
      await this.client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: closePoint.x, y: closePoint.y, button: 'left', clickCount: 1
      });
      await this.client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: closePoint.x, y: closePoint.y, button: 'left', clickCount: 1
      });
      await sleep(800);
      if (!await this._settingsSurfaceHidden()) return 'settings still visible';
      this._currentTab = 'chat';
      return 'closed: 设置';
    }
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
    if (result.ok) {
      if (!await this._settingsSurfaceHidden()) return 'settings still visible';
      this._currentTab = 'chat';
      return 'clicked: 编辑器';
    }
    if (result.reason === 'not_found') return 'not found';
    return result.reason || 'unknown';
  }

  async _settingsSurfaceHidden() {
    return evaluate(this.client, `() => {
      const roots = [
        document.querySelector('.icube-solo-mode-tab-item.active[data-tab-key="solo_settings"]'),
        document.querySelector('.tab.active[data-resource-name="icube-settings"]'),
        ...document.querySelectorAll('.icube-settings-container, .icb-settings-container, .part.solo_settings, .icube-settings-content-body')
      ];
      return !roots.some(el => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
    }`);
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
