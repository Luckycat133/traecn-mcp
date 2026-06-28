'use strict';

/**
 * review-gate handlers.
 *
 * Moved verbatim from src/cdp/dom-driver.js. Each method is now an
 * exported function with signature `function method(driver, ...args)`
 * taking the DomDriver instance as `driver`. Behavior is preserved 1:1.
 *
 * Covers: detection and resolution of the "全部保留 / 全部撤销" review
 * gate that Trae CN raises after applying AI edits. Resolution walks
 * through mouse → keyboard → synthetic-event fallback strategies
 * before clicking each "保留" button individually.
 *
 * The DomDriver retains thin delegating shims so existing
 * dom-driver.test.js cases that call `driver.checkTaskReviewGate()`
 * and `driver.resolveTaskReviewGate()` continue to work unchanged.
 */

const { sleep, safeJsValue } = require('../../shared/utils');

async function checkTaskReviewGate(driver) {
  try {
    const result = await driver.client.send('Runtime.evaluate', {
      expression: `
        (() => {
          const controls = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"]'));
          const visibleControls = controls
            .filter(el => el && el.offsetParent !== null)
            .map(el => {
              const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
              const rect = el.getBoundingClientRect();
              return {
                text,
                className: el.className || '',
                aria: el.getAttribute('aria-label') || '',
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2,
                width: rect.width,
                height: rect.height
              };
            })
            .filter(item => item.text);

          const keepAll = visibleControls.find(item => item.text === '全部保留' || /^Keep All$/i.test(item.text));
          const revertAll = visibleControls.find(item => item.text === '全部撤销' || /^Discard All$/i.test(item.text));
          const bodyText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
          const reviewCountMatch = bodyText.match(/(\\d+)\\s*个文件待审查/);
          const taskCompleted = bodyText.includes('任务完成') || bodyText.includes('Task completed');
          const waitingToSend = bodyText.includes('等待发送');
          const newChat = document.querySelector('[aria-label="新建会话"]');
          const newChatDisabled = newChat ? /disabled/.test(newChat.className || '') : null;

          return {
            awaitingReview: !!(keepAll || revertAll),
            taskCompleted,
            waitingToSend,
            reviewCount: reviewCountMatch ? Number(reviewCountMatch[1]) : null,
            keepAll: keepAll || null,
            revertAll: revertAll || null,
            newChatDisabled,
            visibleButtons: visibleControls
              .filter(item => /保留|撤销|审查|Review|Keep|Discard/.test(item.text))
              .slice(0, 10)
          };
        })()
      `,
      returnByValue: true
    });
    return result.result?.value || {
      awaitingReview: false,
      taskCompleted: false,
      waitingToSend: false,
      reviewCount: null,
      keepAll: null,
      revertAll: null,
      newChatDisabled: null,
      visibleButtons: []
    };
  } catch (e) {
    return {
      awaitingReview: false,
      taskCompleted: false,
      waitingToSend: false,
      reviewCount: null,
      keepAll: null,
      revertAll: null,
      newChatDisabled: null,
      visibleButtons: [],
      error: e.message
    };
  }
}

async function resolveTaskReviewGate(driver, preferredAction = 'keep_all') {
  const gate = await driver.checkTaskReviewGate();
  if (!gate.awaitingReview) {
    return { success: false, action: preferredAction, reason: 'no_review_gate' };
  }

  const target = ['discard_all', 'revert_all'].includes(preferredAction) ? gate.revertAll : gate.keepAll;
  if (!target) {
    return { success: false, action: preferredAction, reason: 'target_button_not_found', gate };
  }

  try {
    const waitForResolution = async () => {
      for (let attempt = 0; attempt < 12; attempt++) {
        await sleep(Math.max(driver.config.postActionDelayMs, 250));
        const after = await driver.checkTaskReviewGate();
        if (!after.awaitingReview || after.newChatDisabled === false) {
          return {
            success: true,
            action: preferredAction,
            reviewCount: gate.reviewCount,
            buttonText: target.text,
            newChatDisabled: after.newChatDisabled
          };
        }
      }
      return null;
    };

    await driver.client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: target.x,
      y: target.y,
      button: 'left',
      clickCount: 1
    });
    await driver.client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: target.x,
      y: target.y,
      button: 'left',
      clickCount: 1
    });

    const mouseResolution = await waitForResolution();
    if (mouseResolution) return mouseResolution;

    await driver.client.send('Runtime.evaluate', {
      expression: `
        (() => {
          const buttons = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"]'));
          const target = buttons.find(el => (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ') === ${safeJsValue(target.text)});
          if (!target) return { ok: false };
          target.focus();
          return { ok: true };
        })()
      `,
      returnByValue: true
    });
    await driver.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13
    });
    await driver.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13
    });

    const keyboardResolution = await waitForResolution();
    if (keyboardResolution) return keyboardResolution;

    await driver.client.send('Runtime.evaluate', {
      expression: `
        (() => {
          const controls = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], .icd-btn, .icube-btn'));
          const target = controls.find(el => {
            const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
            const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            const style = window.getComputedStyle(el);
            return text === ${safeJsValue(target.text)}
              && rect && rect.width > 0 && rect.height > 0
              && style.display !== 'none'
              && style.visibility !== 'hidden';
          });
          if (!target) return { ok: false, reason: 'target_not_found' };
          target.scrollIntoView({ block: 'center', inline: 'center' });
          target.focus();
          const rect = target.getBoundingClientRect();
          const opts = {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: rect.x + rect.width / 2,
            clientY: rect.y + rect.height / 2,
            button: 0,
            buttons: 1
          };
          for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            const Ctor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
            target.dispatchEvent(new Ctor(type, opts));
          }
          return { ok: true };
        })()
      `,
      returnByValue: true
    });

    const syntheticResolution = await waitForResolution();
    if (syntheticResolution) return syntheticResolution;

    if (['keep_all', 'keep'].includes(preferredAction)) {
      const individualResult = await driver.client.send('Runtime.evaluate', {
        expression: `
          (async () => {
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            let clicked = 0;
            for (let attempt = 0; attempt < 20; attempt++) {
              const buttons = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], .monaco-button, .icube-btn'));
              const keep = buttons.find(el => {
                const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
                const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
                return text === '保留' && rect && rect.width > 0 && rect.height > 0;
              });
              if (!keep) break;
              keep.click();
              clicked++;
              await sleep(250);
            }
            return { clicked };
          })()
        `,
        awaitPromise: true,
        returnByValue: true
      });
      const individualResolution = await waitForResolution();
      if (individualResolution) {
        individualResolution.individualClicks = individualResult.result?.value?.clicked || 0;
        return individualResolution;
      }
    }

    const finalGate = await driver.checkTaskReviewGate();
    return {
      success: false,
      action: preferredAction,
      reason: 'review_gate_persisted',
      gate: finalGate,
      buttonText: target.text
    };
  } catch (e) {
    return { success: false, action: preferredAction, reason: 'error', error: e.message };
  }
}

module.exports = {
  checkTaskReviewGate,
  resolveTaskReviewGate
};