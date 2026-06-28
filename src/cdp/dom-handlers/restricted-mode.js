'use strict';

/**
 * restricted-mode handlers.
 *
 * Moved verbatim from src/cdp/dom-driver.js. Each method is now an
 * exported function with signature `function method(driver, ...args)`
 * taking the DomDriver instance as `driver`. Behavior is preserved 1:1.
 *
 * Covers: VS Code "受限模式 / Restricted Mode" workspace-trust detection
 * + the manage/trust click flow that gets the Trae CN page out of
 * restricted mode automatically.
 *
 * The DomDriver retains thin delegating shims so existing
 * dom-driver.test.js cases that call `driver.checkRestrictedMode()`,
 * `driver.clickRestrictedModeTrust()`, and
 * `driver._summarizeRestrictedModeState()` continue to work unchanged.
 */

const { sleep } = require('../../shared/utils');

function _summarizeRestrictedModeState(snapshot = {}) {
  const rawBody = String(snapshot.bodyText || '');
  const body = rawBody.trim();
  const bodyLower = body.toLowerCase();
  const buttonTexts = Array.isArray(snapshot.buttonTexts)
    ? snapshot.buttonTexts.map(text => String(text || '').trim()).filter(Boolean)
    : [];

  const hasAny = (haystack, needles) => needles.some(needle => haystack.includes(needle));
  const buttonMatches = (patterns) => buttonTexts.some(text => patterns.some(pattern => pattern.test(text)));

  const onWorkspaceTrustPage = hasAny(bodyLower, ['工作区信任', 'workspace trust']);
  const trustedCopyVisible = hasAny(bodyLower, [
    '你信任此文件夹',
    'you trust this folder',
    'all files in the current window are trusted'
  ]);
  const untrustButtonVisible = buttonMatches([/不信任/i, /don't trust/i, /stop trusting/i]);
  const trustButtonVisible = buttonMatches([/^信任$/, /^trust$/i, /信任此文件夹/, /trust this folder/i, /信任父级/, /trust parent/i]);
  const manageButtonVisible = buttonMatches([/^管理$/, /^manage$/i]);

  if (onWorkspaceTrustPage && (trustedCopyVisible || untrustButtonVisible)) {
    return {
      restricted: false,
      trusted: true,
      panelOpen: true,
      title: '工作区信任',
      trustButtonFound: false,
      trustButtonText: '',
      manageButtonFound: false,
      hasOverlay: snapshot.hasOverlay === true
    };
  }

  const hasRestrictedBanner = hasAny(bodyLower, [
    '受限模式',
    'restricted mode',
    '安全地浏览代码',
    'trust this folder',
    '信任此文件夹',
    '点击「信任」',
    '点击信任'
  ]);

  if (onWorkspaceTrustPage || hasRestrictedBanner) {
    const title = onWorkspaceTrustPage
      ? '工作区信任'
      : (snapshot.title || '受限模式');
    return {
      restricted: true,
      trusted: false,
      panelOpen: onWorkspaceTrustPage,
      title,
      trustButtonFound: trustButtonVisible,
      trustButtonText: trustButtonVisible
        ? buttonTexts.find(text => /^信任$|^trust$|信任此文件夹|trust this folder|信任父级|trust parent/i.test(text)) || ''
        : '',
      manageButtonFound: manageButtonVisible,
      hasOverlay: snapshot.hasOverlay === true
    };
  }

  return {
    restricted: false,
    trusted: false,
    panelOpen: false,
    trustButtonFound: false,
    trustButtonText: '',
    manageButtonFound: false,
    hasOverlay: snapshot.hasOverlay === true
  };
}

/**
 * Check for restricted mode and click the Trust button if found.
 * Returns the result of the operation.
 */
async function clickRestrictedModeTrust(driver) {
  try {
    const restrictedCheck = await driver.checkRestrictedMode();
    if (!restrictedCheck || !restrictedCheck.restricted) {
      if (restrictedCheck?.trusted) {
        return { success: true, action: 'already_trusted', panelOpen: restrictedCheck.panelOpen === true };
      }
      return { success: false, reason: 'no_restricted_mode_found' };
    }

    const openManage = async () => {
      const result = await driver.client.send('Runtime.evaluate', {
        expression: `
          (() => {
            const candidates = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], .monaco-button'));
            for (const el of candidates) {
              if (!el || el.offsetParent === null) continue;
              const text = (el.innerText || el.textContent || '').trim();
              if (!text) continue;
              if (!/管理|manage/i.test(text)) continue;
              const rect = el.getBoundingClientRect();
              el.dispatchEvent(new PointerEvent('pointerdown', {
                bubbles: true, cancelable: true, composed: true,
                clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                button: 0, buttons: 1, pointerType: 'mouse'
              }));
              el.dispatchEvent(new PointerEvent('pointerup', {
                bubbles: true, cancelable: true, composed: true,
                clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                button: 0, buttons: 1, pointerType: 'mouse'
              }));
              el.dispatchEvent(new MouseEvent('click', {
                bubbles: true, cancelable: true,
                clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2
              }));
              if (typeof el.click === 'function') el.click();
              return { clicked: true, text };
            }
            return { clicked: false };
          })()
        `,
        returnByValue: true
      });
      return result.result?.value || { clicked: false };
    };

    const clickTrustFromRestrictedPanel = async () => {
      const result = await driver.client.send('Runtime.evaluate', {
        expression: `
          (() => {
            const preferred = ['信任', 'Trust', '信任父级', 'Trust Parent'];
            const candidates = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], .monaco-button, .monaco-text-button, .quick-input-widget button'));
            for (const label of preferred) {
              for (const el of candidates) {
                if (!el || el.offsetParent === null) continue;
                const text = (el.innerText || el.textContent || '').trim();
                if (!text || text !== label) continue;
                const rect = el.getBoundingClientRect();
                if (rect.width < 12 || rect.height < 12) continue;
                el.dispatchEvent(new PointerEvent('pointerdown', {
                  bubbles: true, cancelable: true, composed: true,
                  clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                  button: 0, buttons: 1, pointerType: 'mouse'
                }));
                el.dispatchEvent(new PointerEvent('pointerup', {
                  bubbles: true, cancelable: true, composed: true,
                  clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                  button: 0, buttons: 1, pointerType: 'mouse'
                }));
                el.dispatchEvent(new MouseEvent('click', {
                  bubbles: true, cancelable: true,
                  clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2
                }));
                if (typeof el.click === 'function') el.click();
                return { clicked: true, text };
              }
            }
            return { clicked: false };
          })()
        `,
        returnByValue: true
      });
      return result.result?.value || { clicked: false };
    };

    if (restrictedCheck.trustButtonFound) {
      const approveResult = await driver.approveDialog('trust');
      if (approveResult.success) {
        await sleep(driver.config.postActionDelayMs * 2);
        return { success: true, action: 'trust_clicked', buttonText: approveResult.buttonText };
      }
    }

    if (restrictedCheck.manageButtonFound) {
      const manageResult = await openManage();
      if (manageResult.clicked) {
        for (let attempt = 0; attempt < 8; attempt++) {
          await sleep(Math.max(driver.config.postActionDelayMs, 200));
          const restrictedAfterManage = await driver.checkRestrictedMode();
          if (!restrictedAfterManage.restricted || restrictedAfterManage.trusted) {
            return {
              success: true,
              action: 'trust_clicked',
              buttonText: manageResult.text
            };
          }
        }
        const panelTrustResult = await clickTrustFromRestrictedPanel();
        if (panelTrustResult.clicked) {
          await sleep(driver.config.postActionDelayMs * 2);
          const restrictedAfter = await driver.checkRestrictedMode();
          if (!restrictedAfter.restricted || restrictedAfter.trusted) {
            return {
              success: true,
              action: 'trust_clicked',
              buttonText: panelTrustResult.text,
              manageButtonText: manageResult.text
            };
          }
        }

        const approveResult = await driver.approveDialog('trust');
        if (approveResult.success) {
          await sleep(driver.config.postActionDelayMs * 2);
          return {
            success: true,
            action: 'trust_clicked',
            buttonText: approveResult.buttonText,
            manageButtonText: manageResult.text
          };
        }
      }
    }

    return {
      success: false,
      reason: 'trust_button_not_found_or_click_failed',
      restrictedInfo: restrictedCheck,
      message: '受限模式已启用，请手动在Trae CN窗口中点击「信任」按钮'
    };
  } catch (e) {
    return { success: false, reason: 'error', error: e.message };
  }
}

async function checkRestrictedMode(driver) {
  try {
    const result = await driver.client.send('Runtime.evaluate', {
      expression: `
        (() => {
          const body = document.body ? (document.body.innerText || document.body.textContent || '') : '';
          const titleEl = document.querySelector('.monaco-dialog-title, [role="heading"], h1, h2, h3, .pane-header');
          const title = titleEl ? (titleEl.innerText || titleEl.textContent || '').trim() : '';
          const controls = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], .monaco-button, .monaco-text-button, [class*="button"], [class*="btn"]'));
          const buttonTexts = controls
            .filter(el => el && el.offsetParent !== null)
            .map(el => (el.innerText || el.textContent || '').trim())
            .filter(Boolean);
          const modals = document.querySelectorAll('[class*="modal"], [class*="dialog"], [class*="overlay"], [class*="mask"]');
          const hasOverlay = Array.from(modals).some(m => {
            const rect = m.getBoundingClientRect();
            return rect.width > 100 && rect.height > 50;
          });

          return {
            bodyText: body,
            title,
            buttonTexts,
            hasOverlay
          };
        })()
      `,
      returnByValue: true,
      timeout: 5000
    });

    return _summarizeRestrictedModeState(result.result?.value || {});
  } catch (err) {
    return { restricted: false, error: err.message };
  }
}

module.exports = {
  _summarizeRestrictedModeState,
  clickRestrictedModeTrust,
  checkRestrictedMode
};