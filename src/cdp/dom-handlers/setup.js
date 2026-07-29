'use strict';

/**
 * setup handlers.
 *
 * Moved verbatim from src/cdp/dom-driver.js. Each method is now an
 * exported function with signature `function method(driver, ...args)`
 * taking the DomDriver instance as `driver`. Behavior is preserved 1:1.
 *
 * Covers: setup wizard + workspace guide dismissal + the
 * `__enhancedClick` runtime helper that both flows share.
 *
 * The DomDriver retains thin delegating shims so existing
 * dom-driver.test.js cases that call `driver.inspectSetupWizard()`,
 * `driver.completeSetupIfPresent()`, `driver.inspectWorkspaceBlockers()`,
 * `driver.dismissWorkspaceGuideIfPresent()`, and `_ensureClickHelper()`
 * continue to work unchanged.
 */

const { sleep, safeJsValue } = require('../../shared/utils');

async function _ensureClickHelper(driver) {
  await driver.client.send('Runtime.evaluate', {
    expression: `(function() {
      if (window.__traeEnhancedClick_v1) return;
      var normalize = function(text) {
        return String(text || '').trim();
      };
      window.__traeEnhancedClick_v1 = function(targetText, normalizeText) {
        var normalizeFn = normalizeText
          ? function(text) { return String(text || '').replace(/\\s+/g, ' ').trim(); }
          : normalize;
        var candidates = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'));
        for (var i = 0; i < candidates.length; i++) {
          var el = candidates[i];
          var text = normalizeFn(el.innerText || el.textContent || '');
          if (text !== targetText) continue;
          var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
          var clickable = el.tagName === 'BUTTON' ||
            el.tagName === 'A' ||
            el.getAttribute('role') === 'button' ||
            (style && style.cursor === 'pointer');
          if (!clickable || el.disabled) continue;
          var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          if (!rect || rect.width < 12 || rect.height < 12) continue;
          var cx = rect.x + rect.width / 2;
          var cy = rect.y + rect.height / 2;
          el.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true, cancelable: true, composed: true,
            clientX: cx, clientY: cy, button: 0, buttons: 1, pointerType: 'mouse'
          }));
          el.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true, cancelable: true, composed: true,
            clientX: cx, clientY: cy, button: 0, buttons: 1, pointerType: 'mouse'
          }));
          el.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true, clientX: cx, clientY: cy
          }));
          if (typeof el.click === 'function') el.click();
          return { clicked: true, text: text };
        }
        return { clicked: false, text: targetText };
      };
    })()`,
    returnByValue: true
  });
}

async function inspectSetupWizard(driver) {
  try {
    const result = await driver.client.send('Runtime.evaluate', {
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

async function completeSetupIfPresent(driver, options = {}) {
  const maxSteps = Number.isFinite(options.maxSteps) ? options.maxSteps : 5;
  const delayMs = Number.isFinite(options.delayMs)
    ? options.delayMs
    : Math.max(driver.config.postActionDelayMs * 2, 500);
  const preferredLabels = ['跳过', '开始', '下一步', '继续', '开始使用', '完成', '进入工作台'];
  let advanced = 0;

  await driver._ensureClickHelper();

  for (let step = 0; step < maxSteps; step++) {
    const snapshot = await driver.inspectSetupWizard();
    if (!snapshot.isSetup) {
      driver._invalidateModeCache();
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

    const clickResult = await driver.client.send('Runtime.evaluate', {
      expression: `window.__traeEnhancedClick_v1(${safeJsValue(actionable.text)})`,
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

  const finalSnapshot = await driver.inspectSetupWizard();
  if (!finalSnapshot.isSetup) {
    driver._invalidateModeCache();
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

async function inspectWorkspaceBlockers(driver) {
  try {
    const result = await driver.client.send('Runtime.evaluate', {
      expression: `
        (() => {
          const normalize = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
          const controls = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'))
            .map((el) => {
              const text = normalize(el.innerText || el.textContent || '');
              if (!text) return null;
              const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0, x: 0, y: 0 };
              const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
              const visible = !!(el.offsetParent !== null && rect.width >= 12 && rect.height >= 12);
              if (!visible) return null;
              const clickable = el.tagName === 'BUTTON' ||
                el.tagName === 'A' ||
                el.getAttribute('role') === 'button' ||
                (style && style.cursor === 'pointer');
              if (!clickable) return null;
              return {
                text,
                className: typeof el.className === 'string' ? el.className : '',
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2
              };
            })
            .filter(Boolean);

          const bodyText = normalize(document.body ? (document.body.innerText || document.body.textContent || '') : '');
          const titleEls = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"], .monaco-dialog-title, [class*="title"], [class*="header"]'))
            .map((el) => normalize(el.innerText || el.textContent || ''))
            .filter(Boolean);
          const guideButtons = controls.filter((item) => /^(继续|下一步|开始使用|完成|知道了|跳过|关闭|稍后)$/i.test(item.text));
          const loginButton = controls.find((item) => /^(登录|登入|log in|login|sign in)$/i.test(item.text)) || null;
          const newTaskButton = controls.find((item) => /^(新建会话|新任务|new task|new chat)$/i.test(item.text)) || null;
          const guideVisible = guideButtons.length > 0 && (
            /solo beta|欢迎使用|快速开始|快捷键|选择主题|继续|开始使用|添加命令行|command line/i.test(bodyText) ||
            titleEls.some((text) => /solo beta|欢迎使用|快速开始|快捷键|选择主题/i.test(text))
          );

          return {
            bodyText,
            titles: titleEls.slice(0, 8),
            guideVisible,
            guideButtons: guideButtons.slice(0, 10),
            loginVisible: !!loginButton,
            loginButton,
            newTaskVisible: !!newTaskButton,
            newTaskButton,
            visibleControls: controls.slice(0, 30)
          };
        })()
      `,
      returnByValue: true
    });
    return result.result?.value || {
      bodyText: '',
      titles: [],
      guideVisible: false,
      guideButtons: [],
      loginVisible: false,
      loginButton: null,
      newTaskVisible: false,
      newTaskButton: null,
      visibleControls: []
    };
  } catch (err) {
    return {
      bodyText: '',
      titles: [],
      guideVisible: false,
      guideButtons: [],
      loginVisible: false,
      loginButton: null,
      newTaskVisible: false,
      newTaskButton: null,
      visibleControls: [],
      error: err.message
    };
  }
}

async function dismissWorkspaceGuideIfPresent(driver, options = {}) {
  const maxSteps = Number.isFinite(options.maxSteps) ? options.maxSteps : 4;
  const delayMs = Number.isFinite(options.delayMs)
    ? options.delayMs
    : Math.max(driver.config.postActionDelayMs, 300);
  const preferredLabels = ['继续', '下一步', '开始使用', '完成', '知道了', '跳过', '关闭', '稍后'];
  let dismissed = 0;

  await driver._ensureClickHelper();

  for (let step = 0; step < maxSteps; step++) {
    const blockers = await driver.inspectWorkspaceBlockers();
    if (!blockers.guideVisible) {
      return {
        success: dismissed > 0,
        dismissed,
        guideVisible: false,
        blockers
      };
    }

    const target = (blockers.guideButtons || []).find((button) => preferredLabels.includes(button.text));
    if (!target) {
      return {
        success: false,
        dismissed,
        guideVisible: true,
        reason: 'no_actionable_workspace_guide_button',
        blockers
      };
    }

    const clickResult = await driver.client.send('Runtime.evaluate', {
      expression: `window.__traeEnhancedClick_v1(${safeJsValue(target.text)}, true)`,
      returnByValue: true
    });

    if (!clickResult.result?.value?.clicked) {
      return {
        success: false,
        dismissed,
        guideVisible: true,
        reason: 'workspace_guide_click_failed',
        target: target.text
      };
    }

    dismissed += 1;
    await sleep(delayMs);
  }

  const blockers = await driver.inspectWorkspaceBlockers();
  return {
    success: dismissed > 0 && !blockers.guideVisible,
    dismissed,
    guideVisible: blockers.guideVisible,
    reason: blockers.guideVisible ? 'workspace_guide_max_steps_reached' : null,
    blockers
  };
}

module.exports = {
  _ensureClickHelper,
  inspectSetupWizard,
  completeSetupIfPresent,
  inspectWorkspaceBlockers,
  dismissWorkspaceGuideIfPresent
};