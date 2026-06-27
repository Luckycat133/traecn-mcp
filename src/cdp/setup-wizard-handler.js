'use strict';

/**
 * SetupWizardHandler — handles the initial setup wizard flow.
 * Extracted from DomDriver to isolate setup-wizard responsibility.
 */

const { safeJsValue } = require('../shared/utils');
const { sleep } = require('../shared/utils');

class SetupWizardHandler {
  constructor(client, config, domHelper, modeDetector) {
    this.client = client;
    this.config = config;
    this.domHelper = domHelper;
    this.modeDetector = modeDetector;
  }

  async inspectSetupWizard() {
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `
          (() => {
            const url = String(location.href || '');
            const bodyText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
            const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'))
              .map((el, index) => {
                const text = (el.innerText || el.textContent || '').trim();
                const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
                const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
                const clickable = el.tagName === 'BUTTON' ||
                  el.tagName === 'A' ||
                  el.getAttribute('role') === 'button' ||
                  (style && style.cursor === 'pointer');
                return {
                  index,
                  text,
                  disabled: !!el.disabled,
                  visible: !!(el.offsetParent !== null && rect.width >= 12 && rect.height >= 12),
                  className: typeof el.className === 'string' ? el.className : '',
                  clickable
                };
              })
              .filter(item => (item.text || item.visible) && item.clickable);
            const isSetup = url.includes('/setup/setup.html');
            return {
              isSetup,
              url,
              text: bodyText.trim(),
              buttons
            };
          })()
        `,
        returnByValue: true
      });
      return result.result?.value || { isSetup: false, url: '', text: '', buttons: [] };
    } catch (err) {
      return { isSetup: false, error: err.message, url: '', text: '', buttons: [] };
    }
  }

  async completeSetupIfPresent(options = {}) {
    const maxSteps = Number.isFinite(options.maxSteps) ? options.maxSteps : 5;
    const delayMs = Number.isFinite(options.delayMs)
      ? options.delayMs
      : Math.max(this.config.postActionDelayMs * 2, 500);
    const preferredLabels = ['跳过', '开始', '下一步', '继续', '开始使用', '完成', '进入工作台'];
    let advanced = 0;

    await this.domHelper.ensureClickHelper();

    for (let step = 0; step < maxSteps; step++) {
      const snapshot = await this.inspectSetupWizard();
      if (!snapshot.isSetup) {
        if (this.modeDetector) this.modeDetector.invalidateCache();
        return {
          success: advanced > 0,
          completed: advanced > 0,
          steps: advanced,
          finalUrl: snapshot.url || ''
        };
      }

      const actionable = (snapshot.buttons || []).find((button) =>
        button.visible && !button.disabled && preferredLabels.includes(button.text)
      ) || null;

      if (!actionable) {
        return {
          success: false,
          completed: false,
          steps: advanced,
          reason: 'no_actionable_setup_button',
          snapshot
        };
      }

      const clickResult = await this.client.send('Runtime.evaluate', {
        expression: `window.__enhancedClick(${safeJsValue(actionable.text)})`,
        returnByValue: true
      });

      if (!clickResult.result?.value?.clicked) {
        return {
          success: false,
          completed: false,
          steps: advanced,
          reason: 'setup_click_failed',
          target: actionable.text
        };
      }

      advanced += 1;
      await sleep(delayMs);
    }

    const finalSnapshot = await this.inspectSetupWizard();
    if (!finalSnapshot.isSetup) {
      if (this.modeDetector) this.modeDetector.invalidateCache();
      return {
        success: advanced > 0,
        completed: true,
        steps: advanced,
        finalUrl: finalSnapshot.url || ''
      };
    }

    return {
      success: advanced > 0,
      completed: false,
      steps: advanced,
      reason: 'setup_max_steps_reached',
      snapshot: finalSnapshot
    };
  }
}

module.exports = { SetupWizardHandler };
