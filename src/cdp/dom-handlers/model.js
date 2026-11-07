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
const CORE_MODEL_TRIGGER = 'button.core-model-select-trigger[role="combobox"]';

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
        var coreTrigger = (${readCoreTrigger.toString()})(document, ${safeJsValue(CORE_MODEL_TRIGGER)});
        if (coreTrigger) return coreTrigger.current || '';
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

// Serialized into Runtime.evaluate and called before any legacy picker probe.
function readCoreTrigger(document, selector) {
  const triggers = Array.from(document.querySelectorAll(selector)).filter(el => el.matches?.(selector));
  if (triggers.length === 0) return null;
  const visible = triggers.filter(el => {
    const rect = el.getBoundingClientRect();
    return rect.width > 4 && rect.height > 4;
  });
  if (visible.length !== 1) return { core: true, disabled: true };
  const trigger = visible[0];
  const rect = trigger.getBoundingClientRect();
  return {
    core: true,
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
    current: (trigger.innerText || trigger.textContent || '').replace(/\s+/g, ' ').trim(),
    expanded: trigger.getAttribute('aria-expanded') === 'true',
    controls: trigger.getAttribute('aria-controls'),
    disabled: trigger.disabled || trigger.getAttribute('aria-disabled') === 'true'
  };
}

async function readCorePicker(driver, controls, selection = null) {
  const result = await driver.client.send('Runtime.evaluate', {
    expression: `
      (() => {
        const controls = ${safeJsValue(controls)};
        const trigger = (${readCoreTrigger.toString()})(document, ${safeJsValue(CORE_MODEL_TRIGGER)});
        if (!trigger?.expanded || trigger.controls !== controls) return null;

        const portal = document.getElementById(controls);
        if (portal?.getAttribute('role') !== 'listbox') return { expanded: true };
        const textOf = el => (el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
        const autoSwitches = Array.from(portal.querySelectorAll('.core-auto-mode-switch input[role="switch"]'));
        const autoSwitch = autoSwitches.length === 1 ? autoSwitches[0] : null;
        const autoName = autoSwitch ? textOf(portal.querySelector('.core-auto-mode-switch-label')) : '';
        const manualModelsHidden = autoSwitch?.checked === true
          && !portal.querySelector('.core-model-select-model-list');
        const labels = Array.from(portal.querySelectorAll('.core-model-select-model-item-name'))
          .filter(el => el.getClientRects().length)
          .map(el => ({ name: textOf(el), row: el.closest('.core-model-select-model-item[role="option"]') }))
          .filter(item => item.name);
        const models = labels.map(item => item.name);
        const request = ${safeJsValue(selection)};
        const snapshot = { expanded: true, autoName, models, manualModelsHidden };
        if (!request) return snapshot;

        const matches = request.auto
          ? autoSwitches.filter(el => el.getAttribute('aria-label') === 'Auto')
          : labels.filter(item => item.name === request.name).map(item => item.row);
        snapshot.matchCount = matches.length;
        if (matches.length !== 1 || !matches[0]) return snapshot;

        const choice = matches[0];
        if (request.auto) snapshot.autoChecked = choice.checked === true;
        snapshot.disabled = choice.disabled || choice.getAttribute('aria-disabled') === 'true'
          || choice.hasAttribute('data-disabled');
        if (snapshot.disabled) return snapshot;
        const clickable = request.auto ? choice.closest('label') || choice : choice;
        const rect = clickable.getBoundingClientRect();
        if (rect.width > 4 && rect.height > 4) {
          const x = rect.x + rect.width / 2;
          const y = rect.y + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          if (hit && clickable.contains(hit)) snapshot.point = { x, y };
        }
        return snapshot;
      })()
    `,
    returnByValue: true
  });
  return result.result?.value || null;
}

async function clickCorePickerPoint(driver, point, move = true) {
  if (move) await driver.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, buttons: 0 });
  for (const type of ['mousePressed', 'mouseReleased']) {
    await driver.client.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  }
}

async function withCorePicker(driver, trigger, selection, read) {
  const openedHere = !trigger.expanded;
  let snapshot;
  try {
    if (openedHere) await clickCorePickerPoint(driver, { x: trigger.x, y: trigger.y });

    for (let attempt = 0; attempt < 8; attempt++) {
      if (attempt > 0) await sleep(100);
      snapshot = await readCorePicker(driver, trigger.controls, selection);
      if (snapshot?.manualModelsHidden || snapshot?.models?.length || (selection?.auto && snapshot?.autoName)) break;
    }
    return await read(snapshot);
  } finally {
    if (openedHere && (await readCorePicker(driver, trigger.controls))?.expanded) {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await driver.client.send('Input.dispatchKeyEvent', {
          type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 53
        });
      }
    }
  }
}

async function listCoreModels(driver, current, trigger) {
  if (!trigger.controls || trigger.disabled) return { current, models: [] };
  return withCorePicker(driver, trigger, null, snapshot => {
    const models = [snapshot?.autoName, ...(snapshot?.models || [])].filter(Boolean);
    return {
      current,
      models: [...new Set(models)],
      ...(snapshot?.manualModelsHidden ? { manualModelsHidden: true } : {})
    };
  });
}

async function listModels(driver) {
  const current = await driver.getCurrentModel();
  const triggerResult = await driver.client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var coreTrigger = (${readCoreTrigger.toString()})(document, ${safeJsValue(CORE_MODEL_TRIGGER)});
        if (coreTrigger) return coreTrigger;
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
  if (trigger?.core) return listCoreModels(driver, current, trigger);
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
    .replace(/^\s*Auto Mode\s*$/i, 'Auto')
    .replace(/\s*Beta\s*/ig, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

function isAutoModel(name) {
  return /^Auto(?: Mode)?$/i.test(name);
}

function alreadySelected(requestedModel, current) {
  return {
    success: true,
    model: current,
    requestedModel,
    previousModel: current,
    alreadySelected: true,
    switchResult: 'already selected'
  };
}

async function switchCoreModel(driver, requestedModel, beforeModel, trigger) {
  const selection = { name: requestedModel, auto: isAutoModel(requestedModel) };
  const resultBase = { requestedModel, previousModel: beforeModel };
  const fail = (code, error, model = beforeModel) => ({
    ...resultBase, success: false, model, code, switchResult: code, error
  });
  if (!trigger.controls || trigger.disabled) {
    return fail('MODEL_PICKER_UNAVAILABLE', 'The native Trae CN model picker is unavailable.');
  }

  return withCorePicker(driver, trigger, selection, async snapshot => {
    if (!snapshot?.expanded) {
      return fail('MODEL_PICKER_UNAVAILABLE', 'The native Trae CN model picker did not open.');
    }
    if (snapshot.manualModelsHidden && !selection.auto) {
      return fail('MANUAL_MODELS_HIDDEN', 'Auto is active. Turn it off in Trae CN to show manual models.');
    }
    if (snapshot?.matchCount > 1) {
      return fail('MODEL_LABEL_AMBIGUOUS', `More than one native option is named "${requestedModel}".`);
    }
    if (!snapshot?.matchCount) {
      return fail('MODEL_NOT_FOUND', `The native picker did not offer "${requestedModel}".`);
    }
    let clicked = false;
    if (!snapshot.autoChecked) {
      if (!snapshot.point) {
        return fail('MODEL_PICKER_UNAVAILABLE', `The native option "${requestedModel}" is not clickable.`);
      }
      await driver.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...snapshot.point, buttons: 0 });
      const refreshed = await readCorePicker(driver, trigger.controls, selection);
      if (!refreshed?.autoChecked) {
        const point = refreshed?.point;
        if (!point || point.x !== snapshot.point.x || point.y !== snapshot.point.y) {
          return fail('MODEL_PICKER_UNAVAILABLE', `The native option "${requestedModel}" changed before selection.`);
        }
        await clickCorePickerPoint(driver, point, false);
        clicked = true;
      }
    }

    let currentModel = beforeModel;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (attempt > 0) await sleep(100);
      const response = await driver.client.send('Runtime.evaluate', {
        expression: `(${readCoreTrigger.toString()})(document, ${safeJsValue(CORE_MODEL_TRIGGER)})`,
        returnByValue: true
      });
      currentModel = response.result?.value?.current || currentModel;
      if (selection.auto ? isAutoModel(currentModel) : currentModel === requestedModel) {
        return {
          ...resultBase,
          success: true,
          model: currentModel,
          ...(clicked ? { switchResult: `clicked: ${currentModel}` }
            : { alreadySelected: true, switchResult: 'already selected' })
        };
      }
    }

    return fail('MODEL_CHANGE_UNVERIFIED', `Model did not change to ${requestedModel}.`, currentModel);
  });
}

async function switchModel(driver, modelName) {
  const requestedModel = String(modelName || '').trim();
  const normalizedRequested = _normalizeModelName(requestedModel);
  const beforeModel = await driver.getCurrentModel();
  if (beforeModel && (beforeModel === requestedModel || (isAutoModel(beforeModel) && isAutoModel(requestedModel)))) {
    return alreadySelected(requestedModel, beforeModel);
  }

  const busyCheck = await driver.client.send('Runtime.evaluate', {
    expression: `(() => {
      var coreTrigger = (${readCoreTrigger.toString()})(document, ${safeJsValue(CORE_MODEL_TRIGGER)});
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
        return { busy: true, reason: 'generating', coreTrigger };
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
        return { busy: true, reason: 'generating', coreTrigger };
      }
      var trigger = document.querySelector('.chat-model-label');
      if (trigger) {
        var triggerArea = trigger.closest('[class*=chat-input], [class*=input]') || trigger.parentElement;
        if (visible(triggerArea) && textOf(triggerArea).includes('\\u751f\\u6210\\u4e2d')) {
          return { busy: true, reason: 'generating', coreTrigger };
        }
      }
      return { busy: false, coreTrigger };
    })()`,
    returnByValue: true
  });
  const busyInfo = busyCheck.result?.value;
  if (typeof busyInfo?.busy !== 'boolean') {
    return {
      success: false,
      requestedModel,
      previousModel: beforeModel,
      code: 'MODEL_PICKER_UNAVAILABLE',
      error: 'Trae CN model controls could not be verified.'
    };
  }
  if (!busyInfo.coreTrigger && normalizedRequested && _normalizeModelName(beforeModel) === normalizedRequested) {
    return alreadySelected(requestedModel, beforeModel);
  }
  if (busyInfo && busyInfo.busy) {
    return {
      success: false,
      requestedModel,
      previousModel: beforeModel,
      switchResult: 'model_switch_blocked: ' + busyInfo.reason,
      error: busyInfo.reason
    };
  }
  if (busyInfo?.coreTrigger) return switchCoreModel(driver, requestedModel, beforeModel, busyInfo.coreTrigger);

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
