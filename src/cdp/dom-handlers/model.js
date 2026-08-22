'use strict';

/**
 * model handlers.
 *
 * Moved verbatim from src/cdp/dom-driver.js. Each method is now an
 * exported function with signature `function method(driver, ...args)`
 * taking the DomDriver instance as `driver`. Behavior is preserved 1:1.
 *
 * Covers: model switcher + queue detection + the static KNOWN_MODELS list.
 *
 * The DomDriver retains thin delegating shims so existing
 * dom-driver.test.js cases that call `driver.checkQueueStatus()`,
 * `driver.getCurrentModel()`, `driver.switchModel()`, and
 * `driver._normalizeModelName()` continue to work unchanged.
 */

const { sleep, safeJsValue } = require('../../shared/utils');
const { KNOWN_MODELS } = require('../../shared/models');

async function checkQueueStatus(driver, timeoutMs = 5000) {
  let timeoutId;
  try {
    const timeoutPromise = new Promise((_, reject) =>
      { timeoutId = setTimeout(() => reject(new Error('checkQueueStatus timeout')), timeoutMs); }
    );
    const result = await Promise.race([
      _checkQueueStatusRaw(driver),
      timeoutPromise
    ]);
    return result;
  } catch (e) {
    if (e.message === 'checkQueueStatus timeout') {
      return { queued: false, timedOut: true };
    }
    return { queued: false, error: e.message };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function _checkQueueStatusRaw(driver) {
  const triggerResult = await driver.client.send('Runtime.evaluate', {
    expression: `
      (function() {
        const sendBtn = document.querySelector('.chat-input-v2-send-button');
        const sendDisabled = sendBtn ?
          (sendBtn.disabled || /disabled/.test(sendBtn.className)) : false;
        const trigger = document.querySelector('.chat-model-label,[role="combobox"],[class*="model-select"],[class*="ai-model-select"]');
        const currentModel = trigger ? (trigger.textContent?.replace(/\\s+/g, ' ').trim() || '') : '';
        const queueCandidates = Array.from(document.querySelectorAll('div,span,p,section,[role="alert"],[class*="queue"],[class*="toast"],[class*="notice"]'))
          .map((el) => {
            const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!text || text.length > 240) return null;
            if (/\\[Queue\\]\\s*polling error/i.test(text)) return null;
            if (el.closest('.monaco-editor,.view-line,[class*="terminal"],[class*="xterm"],[class*="editor"]')) return null;
            const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
            const visible = !!(rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight && style && style.visibility !== 'hidden' && style.display !== 'none');
            if (!visible) return null;
            const queueSurface = el.getAttribute('role') === 'alert' ||
              /queue|toast|notice|alert/i.test(String(el.className || '')) ||
              !!el.closest('[role="alert"],[class*="queue"],[class*="toast"],[class*="notice"],[class*="alert"]');
            const positionMatch = text.match(/排在第\\s*(\\d+)\\s*位/);
            const notice = text.includes('排队提醒') ||
              text.includes('请求量较高') ||
              text.includes('当前使用人数较多') ||
              text.includes('模型繁忙') ||
              (queueSurface && (
                /\\b(model|request|server|service)\\b.{0,80}\\b(queue|queued|busy)\\b/i.test(text) ||
                /\\b(queue|queued|busy)\\b.{0,80}\\b(model|request|server|service)\\b/i.test(text)
              ));
            if (!positionMatch && !notice) return null;
            return { text, position: positionMatch ? Number(positionMatch[1]) : null, y: rect.top };
          })
          .filter(Boolean)
          .sort((a, b) => b.y - a.y);
        const queueNotice = queueCandidates[0] || null;
        if (queueNotice) {
          return {
            found: true,
            queued: true,
            position: queueNotice.position,
            message: queueNotice.position ? ('排在第 ' + queueNotice.position + ' 位') : queueNotice.text,
            sendDisabled,
            canSubmit: !sendDisabled,
            currentModel
          };
        }

        if (!trigger) return { found: false, queued: false };
        const isDisabled = trigger.disabled ||
                          trigger.getAttribute('aria-disabled') === 'true';
        const wrapper = trigger.closest('.ai-model-select') ||
                      trigger.closest('[class*="ai-model-select"]');
        const hasDisabledClass = wrapper ?
          /ai-model-select-disabled|model-select-disabled/.test(wrapper.className) : false;
        return {
          found: true,
          queued: false,
          isDisabled,
          hasDisabledClass,
          sendDisabled,
          currentModel
        };
      })()
    `,
    returnByValue: true
  });

  const info = triggerResult.result?.value || {};

  if (info.queued) {
    return {
      queued: true,
      position: info.position || null,
      message: info.message || 'Queue notice is visible',
      canSubmit: info.canSubmit === true,
      currentModel: info.currentModel || ''
    };
  }

  if (info.found && (info.isDisabled || info.hasDisabledClass)) {
    return {
      queued: true,
      position: null,
      message: `Model "${info.currentModel}" is currently unavailable (queued/busy). Model selector disabled: ${info.isDisabled}, wrapper disabled class: ${info.hasDisabledClass}`
    };
  }

  return { queued: false };
}

async function getCurrentModel(driver) {
  const result = await driver.client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var selectors = [
          '.icd-model-select-trigger-value-name',
          '.icd-model-select-trigger',
          '.chat-model-label',
          '.ai-model-select [role="combobox"]',
          '[role="combobox"]',
          '[class*="model-select"]',
          '[class*="ai-model-select"]'
        ];
        for (var i = 0; i < selectors.length; i++) {
          var els = document.querySelectorAll(selectors[i]);
          for (var j = 0; j < els.length; j++) {
            var el = els[j];
            var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            if (rect && (rect.width < 10 || rect.height < 10)) continue;
            var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
            if (text && /Seed|Doubao|MiniMax|GLM|DeepSeek|Kimi|Qwen|Auto Mode/i.test(text)) {
              return text.replace(/\\s*Beta\\s*/i, '').trim();
            }
          }
        }
        return '';
      })()
    `,
    returnByValue: true
  });
  return result.result?.value || '';
}

async function listModels(driver) {
  const current = await driver.getCurrentModel();
  const triggerResult = await driver.client.send('Runtime.evaluate', {
    expression: `
      (function() {
        function visible(el) {
          if (!el || !el.getBoundingClientRect) return false;
          var rect = el.getBoundingClientRect();
          return rect.width > 4 && rect.height > 4;
        }
        function textOf(el) {
          return (el && (el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').trim();
        }
        var triggers = Array.from(document.querySelectorAll(
          '.icd-model-select-trigger,.ai-model-select [role="combobox"],.chat-model-label,[role="combobox"],[class*="model-select"],[class*="ai-model-select"]'
        )).filter(visible);
        var trigger = triggers.find(function(el) {
          var className = String(el.className || '');
          var text = textOf(el);
          return /chat-model-label|icd-model-select-trigger|ai-model-select/i.test(className) ||
            /Seed|Doubao|MiniMax|GLM|DeepSeek|Kimi|Qwen|Auto Mode/i.test(text);
        }) || null;
        if (!trigger) return null;
        var rect = trigger.getBoundingClientRect();
        return {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          expanded: trigger.getAttribute('aria-expanded') === 'true'
        };
      })()
    `,
    returnByValue: true
  });
  const trigger = triggerResult.result?.value || null;
  const openedByList = Boolean(trigger && !trigger.expanded);

  async function clickTrigger() {
    await driver.client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: trigger.x,
      y: trigger.y,
      button: 'left',
      clickCount: 1
    });
    await driver.client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: trigger.x,
      y: trigger.y,
      button: 'left',
      clickCount: 1
    });
  }

  if (openedByList) {
    await clickTrigger();
    await sleep(200);
  }

  let value;
  try {
    const result = await driver.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          function visible(el) {
            if (!el || !el.getBoundingClientRect) return false;
            var rect = el.getBoundingClientRect();
            return rect.width > 4 && rect.height > 4;
          }
          function textOf(el) {
            return (el && (el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').trim();
          }
          var labels = Array.from(document.querySelectorAll(
            '.chat-modelPicker-item,.icube-model-select-portal-model-item,[role="option"],[class*="modelPicker"],[class*="model-picker"],[class*="model-item"]'
          ))
            .filter(visible)
            .map(function(el) {
              return textOf(el.querySelector(
                '.icube-model-select-portal-model-item-name,.chat-model-label,[class*="label"],[class*="name"]'
              ) || el);
            })
            .filter(function(text) {
              return text && text.length < 120;
            });
          return { models: Array.from(new Set(labels)) };
        })()
      `,
      returnByValue: true
    });
    value = { current, models: result.result?.value?.models || [] };
  } finally {
    if (openedByList) await clickTrigger();
  }

  return {
    current: value.current || '',
    models: Array.from(new Set((Array.isArray(value.models) ? value.models : [])
      .filter(model => !/^\d+(?:\.\d+)?x$/i.test(String(model || '').trim()))))
  };
}

function _normalizeModelName(name) {
  return String(name || '')
    .replace(/\s*Beta\s*/ig, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

async function switchModel(driver, modelName) {
  const requestedModel = String(modelName || '').trim();
  const normalizedRequested = _normalizeModelName(requestedModel);
  const beforeModel = await driver.getCurrentModel();
  if (_normalizeModelName(beforeModel) === normalizedRequested) {
    return {
      success: true,
      model: beforeModel,
      requestedModel,
      previousModel: beforeModel,
      alreadySelected: true,
      switchResult: 'already selected'
    };
  }

  const busyCheck = await driver.client.send('Runtime.evaluate', {
    expression: `(() => {
      function visible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        var rect = el.getBoundingClientRect();
        return rect.width > 4 && rect.height > 4;
      }
      function textOf(el) {
        return (el && (el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').trim();
      }
      var stopIcon = Array.from(document.querySelectorAll('.codicon-stop-circle,[class*="stop-circle"]'))
        .find(function(el) { return visible(el); });
      if (stopIcon) {
        return { busy: true, reason: 'generating' };
      }
      var stopButton = Array.from(document.querySelectorAll('button,[role="button"],.chat-input-v2-send-button'))
        .find(function(el) {
          if (!visible(el)) return false;
          var text = textOf(el);
          var label = el.getAttribute('aria-label') || el.getAttribute('title') || '';
          var className = String(el.className || '');
          return /\\u505c\\u6b62|stop/i.test(text + ' ' + label + ' ' + className) &&
            /chat-input|send|stop/i.test(className + ' ' + label);
        });
      if (stopButton) {
        return { busy: true, reason: 'generating' };
      }
      var trigger = document.querySelector('.chat-model-label');
      if (trigger) {
        var triggerArea = trigger.closest('[class*=chat-input], [class*=input]') || trigger.parentElement;
        if (visible(triggerArea) && textOf(triggerArea).includes('\\u751f\\u6210\\u4e2d')) {
          return { busy: true, reason: 'generating' };
        }
      }
      return { busy: false };
    })()`,
    returnByValue: true
  });
  const busyInfo = busyCheck.result?.value;
  if (busyInfo && busyInfo.busy) {
    return {
      success: false,
      requestedModel,
      previousModel: beforeModel,
      switchResult: 'model_switch_blocked: ' + busyInfo.reason,
      error: busyInfo.reason
    };
  }

  let openResult = 'not attempted';
  for (let retry = 0; retry < 3; retry++) {
    const itemsNow = await driver.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var all = Array.from(document.querySelectorAll('.chat-modelPicker-item,.icube-model-select-portal-model-item,[role="option"],[class*="modelPicker"],[class*="model-picker"],[class*="model-item"],[class*="model"][class*="item"]'));
          return all.filter(function(el) {
            var text = (el.innerText || el.textContent || '').trim();
            return /Seed|Doubao|MiniMax|GLM|DeepSeek|Kimi|Qwen|Auto Mode/i.test(text);
          }).length;
        })()
      `,
      returnByValue: true
    });
    const count = itemsNow.result?.value || 0;
    if (count > 0) break;

    const clicked = await driver.client.send('Runtime.evaluate', {
      expression: `
        (() => {
          var triggers = Array.from(document.querySelectorAll('.chat-model-label,[role="combobox"],[class*="model-select"],[class*="ai-model-select"]'));
          var trigger = triggers.find(function(el) {
            var text = (el.innerText || el.textContent || '').trim();
            var rect = el.getBoundingClientRect();
            return rect.width > 10 && rect.height > 10 && /Seed|Doubao|MiniMax|GLM|DeepSeek|Kimi|Qwen|Auto Mode/i.test(text);
          }) || triggers[0];
          if (!trigger) return 'no model trigger found';
          var rect = trigger.getBoundingClientRect();
          var pointerEvt = new PointerEvent('pointerdown', {
            bubbles: true, cancelable: true, composed: true,
            clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2,
            button: 0, buttons: 1, pointerType: 'mouse'
          });
          trigger.dispatchEvent(pointerEvt);
          trigger.dispatchEvent(new MouseEvent('mousedown', {bubbles:true,cancelable:true,clientX:rect.x + rect.width/2,clientY:rect.y + rect.height/2}));
          trigger.dispatchEvent(new MouseEvent('mouseup', {bubbles:true,cancelable:true,clientX:rect.x + rect.width/2,clientY:rect.y + rect.height/2}));
          trigger.click();
          return 'portal trigger clicked (attempt ' + (${retry + 1}) + ')';
        })()
      `,
      returnByValue: true
    });
    openResult = clicked.result?.value || openResult;

    const triggerRect = await driver.client.send('Runtime.evaluate', {
      expression: `
        (() => {
          var triggers = Array.from(document.querySelectorAll('.chat-model-label,[role="combobox"],[class*="model-select"],[class*="ai-model-select"]'));
          var trigger = triggers.find(function(el) {
            var text = (el.innerText || el.textContent || '').trim();
            var rect = el.getBoundingClientRect();
            return rect.width > 10 && rect.height > 10 && /Seed|Doubao|MiniMax|GLM|DeepSeek|Kimi|Qwen|Auto Mode/i.test(text);
          }) || triggers[0];
          if (!trigger) return null;
          var rect = trigger.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()
      `,
      returnByValue: true
    });
    const point = triggerRect.result?.value;
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      await driver.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await driver.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    }

    await driver._waitForExpression(
      '(function(){return Array.from(document.querySelectorAll(".chat-modelPicker-item,.icube-model-select-portal-model-item,[role=option],[class*=modelPicker],[class*=model-picker],[class*=model-item],[class*=model][class*=item]")).some(function(el){return /Seed|Doubao|MiniMax|GLM|DeepSeek|Kimi|Qwen|Auto Mode/i.test(el.innerText || el.textContent || "");});})()',
      5000, 150
    );
  }

  await driver.client.send('Runtime.evaluate', {
    expression: `
      (() => {
        var modeItem = document.querySelector('.icd-mode-select-mode-item');
        if (!modeItem) return 'no auto mode toggle (already manual mode)';
        var checkbox = modeItem.querySelector('input[type=checkbox]');
        if (!checkbox) return 'no checkbox';
        if (checkbox.checked) {
          var toggleEl = checkbox.parentElement;
          if (toggleEl) {
            var rect = toggleEl.getBoundingClientRect();
            var toggleEvt = new PointerEvent('pointerdown', {
              bubbles: true, cancelable: true, composed: true,
              clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2,
              button: 0, buttons: 1, pointerType: 'mouse'
            });
            toggleEl.dispatchEvent(toggleEvt);
            toggleEl.click();
          }
          return 'auto mode disabled';
        }
        return 'auto mode already off';
      })()
    `,
    returnByValue: true
  });
  await sleep(400);

  const result = await driver.client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var targetName = ${safeJsValue(requestedModel)};
        var normalizedTarget = targetName.replace(/\\s*Beta\\s*/ig, '').replace(/[^\\p{L}\\p{N}]/gu, '').toLowerCase();

        function normalize(value) {
          return String(value || '').replace(/\\s*Beta\\s*/ig, '').replace(/[^\\p{L}\\p{N}]/gu, '').toLowerCase();
        }

        function textOf(el) {
          return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        }

        function clickEl(el) {
          var rect = el.getBoundingClientRect();
          var x = rect.x + rect.width / 2;
          var y = rect.y + rect.height / 2;
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerType: 'mouse' }));
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
          if (typeof el.click === 'function') el.click();
        }

        var raw = Array.from(document.querySelectorAll(
          '.chat-modelPicker-item,.icube-model-select-portal-model-item,[role="option"],[class*="modelPicker"],[class*="model-picker"],[class*="model-item"],[class*="model"][class*="item"],[class*="select"] [class*="item"]'
        ));
        var items = raw
          .map(function(el) {
            var label = el.querySelector('.chat-model-label,[class*="label"],[class*="name"]');
            var text = textOf(label || el);
            return { el: el, text: text, norm: normalize(text) };
          })
          .filter(function(item) {
            return item.text && /Seed|Doubao|MiniMax|GLM|DeepSeek|Kimi|Qwen|Auto Mode/i.test(item.text);
          });

        if (!items || !items.length) return 'no model items found';

        for (var i = 0; i < items.length; i++) {
          if (items[i].norm === normalizedTarget) {
            clickEl(items[i].el);
            return 'clicked: ' + items[i].text + ' at index ' + i;
          }
        }

        for (var i = 0; i < items.length; i++) {
          if (items[i].norm.includes(normalizedTarget) || normalizedTarget.includes(items[i].norm)) {
            clickEl(items[i].el);
            return 'clicked (partial): ' + items[i].text + ' at index ' + i;
          }
        }

        return 'model not found: ' + targetName + ', available: ' + [].map.call(items, function(el) {
          return el.text;
        }).join(', ');
      })()
    `,
    returnByValue: true
  });

  await sleep(driver.config.postActionDelayMs);
  const switchResult = result.result?.value || 'unknown';
  const accessNotice = await driver.client.send('Runtime.evaluate', {
    expression: `(() => {
      var selectors = [
        '[role="alert"]', '[role="dialog"]',
        '[class*="toast"]', '[class*="notification"]', '[class*="notice"]',
        '[class*="tooltip"]', '[class*="popover"]', '[class*="modal"]'
      ];
      var candidates = Array.from(document.querySelectorAll(selectors.join(',')));
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        var rect = el.getBoundingClientRect();
        var style = getComputedStyle(el);
        if (rect.width <= 0 || rect.height <= 0
          || style.visibility === 'hidden' || style.display === 'none') continue;
        var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        var match = text.match(/仅\\s*会员[^。！!]{0,160}(?:可用|使用)/);
        if (match) return match[0];
      }
      return '';
    })()`,
    returnByValue: true
  });
  const accessError = String(accessNotice.result?.value || '').trim();
  if (accessError) {
    return {
      success: false,
      code: 'MODEL_ACCESS_DENIED',
      model: beforeModel,
      requestedModel,
      previousModel: beforeModel,
      switchResult,
      error: accessError
    };
  }
  let currentModel = '';
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(150);
    currentModel = await driver.getCurrentModel();
    if (_normalizeModelName(currentModel) === normalizedRequested) {
      return {
        success: true,
        model: currentModel,
        requestedModel,
        previousModel: beforeModel,
        switchResult
      };
    }
  }

  return {
    success: false,
    model: currentModel,
    requestedModel,
    previousModel: beforeModel,
    switchResult,
    openResult,
    error: `Model did not change to ${requestedModel}`
  };
}

module.exports = {
  KNOWN_MODELS,
  checkQueueStatus,
  _checkQueueStatusRaw,
  getCurrentModel,
  listModels,
  _normalizeModelName,
  switchModel
};
