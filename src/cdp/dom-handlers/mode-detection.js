'use strict';

/**
 * mode-detection handlers.
 *
 * Moved verbatim from src/cdp/dom-driver.js. Each method is now an
 * exported function with signature `function method(driver, ...args)`
 * taking the DomDriver instance as `driver`. Behavior is preserved 1:1.
 *
 * Covers: SOLO/IDE mode detection + element finders (composer, send
 * button, response region) + mode tab switching. The mode cache lives
 * on the driver (`driver._cachedMode`, `driver._cachedModeTs`,
 * `driver._modeCacheTtl`).
 *
 * The DomDriver retains thin delegating shims so existing
 * dom-driver.test.js cases that call `driver.detectMode()`,
 * `driver.switchMode()`, etc. continue to work unchanged.
 *
 * Sidecar captures (sidebar/panel text, IDE state extraction) live in
 * panel-capture.js; that module re-uses the same driver instance.
 */

const dom = require('../browser-dom');

const { sleep, safeJsValue } = require('../../shared/utils');

async function detectMode(driver) {
  const now = Date.now();
  if (driver._cachedMode && now - driver._cachedModeTs < driver._modeCacheTtl) {
    return driver._cachedMode;
  }

  const safeIdeSels = driver.config.ideIndicatorSelectors.map(s => require('../../shared/utils').safeJsValue(s));

  const result = await driver.client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var indicators = [];

        // SOLO indicators: sidebar
        var soloSidebar = document.querySelector('.soloaisidebar');
        var sidebarVisible = soloSidebar && soloSidebar.offsetParent !== null;
        if (sidebarVisible) {
          indicators.push('sidebar');
        }

        // IDE indicators: monaco workbench / editor / terminal
        var sels = [${safeIdeSels.join(', ')}];
        for (var i = 0; i < sels.length; i++) {
          var el = document.querySelector(sels[i]);
          if (el && el.offsetParent !== null) {
            indicators.push('ide-' + sels[i].replace(/[^a-zA-Z0-9-]/g, ''));
            break;
          }
        }

        var mode = 'solo';
        var confidence = 0.5;
        if (sidebarVisible) {
          mode = 'solo';
          confidence = 0.9;
        } else if (indicators.length > 0) {
          // If sidebar is absent but IDE elements present → IDE
          mode = 'ide';
          confidence = 0.8;
        } else {
          // Fallback: check if the mode tabs show which is active
          var tabs = document.querySelectorAll('.icube-mode-tab-item');
          for (var j = 0; j < tabs.length; j++) {
            var cls = tabs[j].className || '';
            var txt = (tabs[j].textContent || '').trim();
            if (cls.indexOf('active') > -1 || cls.indexOf('selected') > -1) {
              if (txt.toLowerCase().indexOf('ide') > -1) { mode = 'ide'; confidence = 0.7; }
              else { mode = 'solo'; confidence = 0.7; }
              indicators.push('active-tab-' + txt.toLowerCase());
              break;
            }
          }
        }

        return {
          mode: mode,
          confidence: confidence,
          indicators: indicators
        };
      })()
    `,
    returnByValue: true
  });

  const detection = result.result?.value || { mode: 'solo', confidence: 0.5, indicators: [] };
  driver._cachedMode = detection;
  driver._cachedModeTs = now;
  return detection;
}

/**
 * Invalidate mode cache so next detectMode() re-evaluates from scratch.
 */
function _invalidateModeCache(driver) {
  driver._cachedMode = null;
  driver._cachedModeTs = 0;
}

async function findComposer(driver) {
  return dom.findFirstMatching(driver.client, driver.config.composerSelectors);
}

async function findSendButton(driver) {
  return dom.findFirstMatching(driver.client, driver.config.sendButtonSelectors);
}

async function findResponseRegion(driver) {
  const region = await dom.findFirstMatching(driver.client, driver.config.responseSelectors);
  if (region) return region;
  return dom.findFirstMatching(driver.client, driver.config.activitySelectors);
}

async function _findVisibleElementRuntime(driver, selectors, options = {}) {
  const { safeJsValue } = require('../../shared/utils');
  if (!driver.client || typeof driver.client.send !== 'function') return null;
  const safeSelectors = safeJsValue(Array.isArray(selectors) ? selectors : []);
  const allowDisabled = options.allowDisabled === true;
  try {
    const result = await driver.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var selectors = ${safeSelectors};
          function visible(el) {
            if (!el) return false;
            var rect = el.getBoundingClientRect();
            var style = window.getComputedStyle(el);
            return !!(rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none');
          }
          for (var i = 0; i < selectors.length; i++) {
            var el = document.querySelector(selectors[i]);
            if (!visible(el)) continue;
            var className = String(el.className || '');
            var disabled = !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || /(?:^|\\s)disabled(?:\\s|$)/.test(className));
            if (disabled && !${allowDisabled ? 'true' : 'false'}) continue;
            return {
              matchedSelector: selectors[i],
              visible: true,
              disabled: disabled,
              text: (el.innerText || el.textContent || '').trim().slice(0, 120)
            };
          }
          return null;
        })()
      `,
      returnByValue: true
    });
    return result.result?.value || null;
  } catch {
    return null;
  }
}

/**
 * Find new chat button — tries SOLO selectors first, falls back to IDE selectors.
 */
async function findNewChatButton(driver) {
  const soloBtn = await dom.findFirstMatching(driver.client, driver.config.newChatSelectors);
  if (soloBtn) return soloBtn;
  return dom.findFirstMatching(driver.client, driver.config.ideNewChatSelectors);
}

/**
 * Find mode tabs by selector; uses text matching to avoid false positives
 * from elements that match the selector but aren't mode tabs (e.g., editor tabs).
 */
async function findModeTabs(driver) {
  const results = [];
  for (const selector of driver.config.modeTabSelectors) {
    const nodeIds = await dom.querySelectorAll(driver.client, selector);
    for (const nodeId of nodeIds) {
      const text = await dom.getInnerText(driver.client, nodeId);
      const trimmed = (text || '').trim();
      // Skip elements that likely aren't mode tabs (no SOLO/IDE/编辑器 keyword)
      if (trimmed && results.every(r => r.nodeId !== nodeId)) {
        results.push({ nodeId, selector, text: trimmed });
      }
    }
  }
  return results;
}

/**
 * Mode-aware switchMode.
 * Finds mode tabs by text content (not hardcoded index), clicks the matching tab,
 * waits for UI to re-render, and verifies the switch.
 *
 * @param {'solo'|'ide'} mode - Target mode.
 * @returns {Promise<{success: boolean, previousMode?: string, currentMode?: string}>}
 */
async function switchMode(driver, mode) {
  // Detect current mode first
  _invalidateModeCache(driver);
  const currentModeInfo = await detectMode(driver);

  const modeLower = mode.toLowerCase();
  if (currentModeInfo.mode === modeLower) {
    return { success: true, previousMode: currentModeInfo.mode, currentMode: modeLower, alreadyInMode: true };
  }

  // Find mode tabs and match by text content
  const modeTabs = await findModeTabs(driver);

  // Filter: only consider tabs that are actually mode switch tabs
  // by checking for known mode keywords
  const relevantTabs = modeTabs.filter(t => {
    const lower = t.text.toLowerCase();
    return lower.includes('solo') || lower.includes('ide') || lower.includes('编辑器');
  });

  // Find the target tab by text keyword
  const targetTextKeywords = modeLower === 'solo' ? ['solo', '编辑器'] : ['ide'];
  const target = relevantTabs.find(t => {
    const lower = t.text.toLowerCase();
    return targetTextKeywords.some(k => lower.includes(k));
  });

  if (!target) {
    // Fallback: look for the non-active tab (toggle logic)
    const activeTab = relevantTabs.find(t => {
      return currentModeInfo.indicators.some(i => i.includes(t.text.toLowerCase()));
    });
    const otherTab = relevantTabs.find(t => {
      if (!activeTab) return t.text.toLowerCase().includes(modeLower);
      return t.nodeId !== activeTab.nodeId;
    });

    if (otherTab) {
      const safeModeLower = safeJsValue(modeLower);
      await driver.client.send('Runtime.evaluate', {
        expression: `
          (function() {
            var items = document.querySelectorAll('.icube-mode-tab-item, [class*="icube-mode-tab-item"], [class*="mode-tab"]');
            for (var i = 0; i < items.length; i++) {
              var t = items[i].textContent.trim().toLowerCase();
              if (t.indexOf(${safeModeLower}) > -1) {
                items[i].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                return 'clicked by text match';
              }
            }
            return 'target tab not found';
          })()
        `,
        returnByValue: true
      });
      await sleep(driver.config.modeSwitchWaitMs);
    } else {
      return { success: false, previousMode: currentModeInfo.mode, error: 'Target mode tab not found' };
    }
  } else {
    // Click the target tab using its nodeId
    await driver.client.send('DOM.focus', { nodeId: target.nodeId });
    await driver.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var items = document.querySelectorAll('.icube-mode-tab-item');
          for (var i = 0; i < items.length; i++) {
            var t = items[i].textContent.trim().toLowerCase();
            if (t.indexOf('${modeLower}') > -1) {
              items[i].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              return 'clicked tab: ' + items[i].textContent.trim();
            }
          }
          return 'tab click attempted';
        })()
      `,
      returnByValue: true
    });
    await sleep(driver.config.modeSwitchWaitMs);
  }

  // Wait for UI to re-render and verify the switch
  _invalidateModeCache(driver);
  const maxWait = driver.config.modeSwitchWaitMs + 3000;
  const pollStart = Date.now();
  let switchedToMode = null;

  while (Date.now() - pollStart < maxWait) {
    const verifyInfo = await detectMode(driver);
    if (verifyInfo.mode === modeLower) {
      switchedToMode = verifyInfo.mode;
      break;
    }
    await sleep(300);
  }

  if (switchedToMode === modeLower) {
    return { success: true, previousMode: currentModeInfo.mode, currentMode: modeLower };
  }

  return { success: false, previousMode: currentModeInfo.mode, currentMode: currentModeInfo.mode, error: 'mode switch verification timed out' };
}

module.exports = {
  detectMode,
  _invalidateModeCache,
  findComposer,
  findSendButton,
  findResponseRegion,
  _findVisibleElementRuntime,
  findNewChatButton,
  findModeTabs,
  switchMode
};