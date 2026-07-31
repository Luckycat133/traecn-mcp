'use strict';

/**
 * messaging handlers.
 *
 * Moved verbatim from src/cdp/dom-driver.js. Each method is now an
 * exported function with signature `function method(driver, ...args)`
 * taking the DomDriver instance as `driver`. Behavior is preserved 1:1.
 *
 * Covers: send/typing flow + delegation orchestration + new-chat +
 * review-gate resolution + agent switching. Response-collection /
 * response-text cleanup helpers live in response-collection.js and are
 * exposed via the driver.
 *
 * The DomDriver retains thin delegating shims so existing
 * dom-driver.test.js cases that call `driver.typeMessage()`,
 * `driver.sendMessage()`, `driver.stopGeneration()`,
 * `driver.newChat()`, `driver._waitForExpression()`,
 * `driver.delegate()`, `driver.checkTaskReviewGate()`,
 * `driver.resolveTaskReviewGate()` continue to work unchanged.
 */

const dom = require('../browser-dom');
const { TraeCNAutomationError } = require('../errors');
const { sleep, safeJsValue } = require('../../shared/utils');

function jsStringLiteral(value) {
  return JSON.stringify(String(value || ''))
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function buildComposerSelectorList(driver) {
  const selectors = driver.config.composerSelectors || ['.chat-input-v2-input-box-editable'];
  return JSON.stringify(selectors);
}

function buildSendButtonSelectorList(driver) {
  const selectors = driver.config.sendButtonSelectors || ['button.chat-input-v2-send-button'];
  return JSON.stringify(selectors);
}

function runtimeValue(result, fallbackReason = 'no runtime value') {
  if (result && result.result && Object.prototype.hasOwnProperty.call(result.result, 'value')) {
    return result.result.value || {};
  }
  const exception = result && result.exceptionDetails;
  if (exception) {
    return {
      ok: false,
      reason: exception.text || exception.exception?.description || fallbackReason
    };
  }
  return { ok: false, reason: fallbackReason };
}

function composerFailureReason(inputInfo) {
  if (!inputInfo) return 'unknown';
  if (inputInfo.reason) return inputInfo.reason;
  if (inputInfo.normalized) return inputInfo.normalized;
  if (inputInfo.text) return inputInfo.text;
  return 'unknown';
}

async function typeMessage(driver, text) {
  const composer = await driver.findComposer();
  if (!composer) {
    throw TraeCNAutomationError.selectorNotFound('composer', driver.config.composerSelectors);
  }

  const nodeId = composer.nodeId;
  const outerHTML = await dom.getOuterHTML(driver.client, nodeId);

  if (outerHTML.includes('contenteditable') || outerHTML.includes('textarea')) {
    await dom.setContentEditableText(driver.client, nodeId, text);
  } else {
    await dom.setInputValue(driver.client, nodeId, text);
  }

  await sleep(driver.config.postActionDelayMs);
}

async function sendMessage(driver, text) {
  const existingReviewGate = await driver.checkTaskReviewGate();
  if (existingReviewGate.awaitingReview && existingReviewGate.reviewCount !== 0) {
    const gateResolution = await driver.resolveTaskReviewGate('keep_all');
    if (!gateResolution.success) {
      throw TraeCNAutomationError.reviewGateBlocked(`message send blocked: ${gateResolution.reason || gateResolution.error || 'unknown'}`);
    }
    await sleep(driver.config.postActionDelayMs * 2);
  }

  const normalizedExpected = String(text || '').replace(/\s+/g, ' ').trim();
  driver._pendingUserTask = normalizedExpected;
  const composerSels = buildComposerSelectorList(driver);
  const focusResult = await driver.client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var sels = ${composerSels};
        var el = null;
        for (var i = 0; i < sels.length; i++) {
          el = document.querySelector(sels[i]);
          if (el) break;
        }
        if (!el) return { ok: false, reason: 'no composer' };
        el.focus();
        return { ok: true };
      })()
    `,
    returnByValue: true
  });
  const focusInfo = runtimeValue(focusResult, 'composer focus produced no result');
  if (!focusInfo.ok) {
    throw TraeCNAutomationError.composerFocusFailed(focusInfo.reason || 'unknown');
  }

  await driver.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4 });
  await driver.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
  await driver.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await driver.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await sleep(100);
  await driver.client.send('Input.insertText', { text });
  await sleep(100);

  let inputResult = await driver.client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var sels = ${composerSels};
        var el = null;
        for (var si = 0; si < sels.length; si++) {
          el = document.querySelector(sels[si]);
          if (el) break;
        }
        var value = el ? (el.innerText || el.textContent || '').trim() : '';
        var normalized = value.replace(/\\s+/g, ' ').trim();
        return {
          ok: normalized === ${jsStringLiteral(normalizedExpected)},
          text: value,
          normalized: normalized
        };
      })()
    `,
    returnByValue: true
  });

  let inputInfo = runtimeValue(inputResult, 'composer verification produced no result');
  if (!inputInfo.ok) {
    await driver.typeMessage(text);
    inputResult = await driver.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var sels = ${composerSels};
          var el = null;
          for (var si = 0; si < sels.length; si++) {
            el = document.querySelector(sels[si]);
            if (el) break;
          }
          var value = el ? (el.innerText || el.textContent || '').trim() : '';
          var normalized = value.replace(/\\s+/g, ' ').trim();
          return {
            ok: normalized === ${jsStringLiteral(normalizedExpected)},
            text: value,
            normalized: normalized
          };
        })()
      `,
      returnByValue: true
    });
    inputInfo = runtimeValue(inputResult, 'composer verification produced no result after fallback typing');
  }
  if (!inputInfo.ok) {
    throw TraeCNAutomationError.composerInputFailed(composerFailureReason(inputInfo));
  }
  await sleep(driver.config.postActionDelayMs * 2);

  if (driver.config.sendTrigger === 'button') {
    const sendBtn = await driver.findSendButton();
    if (sendBtn && sendBtn.nodeId) {
      const btnSels = buildSendButtonSelectorList(driver);
      const clickResult = await driver.client.send('Runtime.evaluate', {
        expression: `
          (function() {
            var sels = ${btnSels};
            var btn = null;
            for (var i = 0; i < sels.length; i++) {
              btn = document.querySelector(sels[i]);
              if (btn) break;
            }
            if (!btn) return 'no button';
            if (btn.classList.contains('disabled')) return 'button disabled: ' + btn.className;
            var rect = btn.getBoundingClientRect();
            var cx = rect.x + rect.width/2;
            var cy = rect.y + rect.height/2;
            btn.dispatchEvent(new MouseEvent('mousedown', {bubbles:true,cancelable:true,clientX:cx,clientY:cy}));
            btn.dispatchEvent(new MouseEvent('mouseup', {bubbles:true,cancelable:true,clientX:cx,clientY:cy}));
            btn.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true,clientX:cx,clientY:cy}));
            return 'send via mouse events';
          })()
        `,
        returnByValue: true
      });
      if (clickResult.result?.value === 'no button') {
        await driver.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 2 });
        await driver.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 2 });
      }
    } else {
      await driver.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 2 });
      await driver.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 2 });
    }
  } else {
    await driver.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 2 });
    await driver.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 2 });
  }
  await sleep(driver.config.postActionDelayMs);

  const submissionVisible = await driver._waitForExpression(
    `(function() {
      var expected = ${jsStringLiteral(normalizedExpected)};
      var sels = ${composerSels};
      var composer = null;
      for (var i = 0; i < sels.length; i++) {
        composer = document.querySelector(sels[i]);
        if (composer) break;
      }
      var composerText = composer ? (composer.innerText || composer.textContent || '').replace(/\\s+/g, ' ').trim() : '';
      var bodyText = (document.body && (document.body.innerText || document.body.textContent) || '').replace(/\\s+/g, ' ').trim();
      return composerText !== expected && bodyText.includes(expected);
    })()`,
    5000,
    200
  );
  if (!submissionVisible) {
    throw TraeCNAutomationError.sendFailed('message did not appear in the active conversation after submission');
  }
}

async function stopGeneration(driver) {
  if (!driver.client || typeof driver.client.send !== 'function') {
    return { success: false, reason: 'no_cdp_client' };
  }
  const result = await driver.client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var stopIcon = document.querySelector('.codicon-stop-circle,[class*="stop-circle"],[class*="stop"]');
        var button = stopIcon ? stopIcon.closest('button,[role="button"],.chat-input-v2-send-button') : null;
        if (!button) button = document.querySelector('button.chat-input-v2-send-button:not(.disabled), .chat-input-v2-send-button:not(.disabled)');
        if (!button) return { success: false, reason: 'stop_button_not_found' };
        var rect = button.getBoundingClientRect();
        var cx = rect.x + rect.width / 2;
        var cy = rect.y + rect.height / 2;
        button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, buttons: 1, pointerType: 'mouse' }));
        button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, buttons: 1, pointerType: 'mouse' }));
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
        if (typeof button.click === 'function') button.click();
        return { success: true, reason: 'clicked_stop_button' };
      })()
    `,
    returnByValue: true
  });
  await sleep(Math.max(driver.config.postActionDelayMs * 2, 500));
  return result.result?.value || { success: false, reason: 'no_result' };
}

async function switchAgent(driver, agentName) {
  const targetName = agentName.replace(/^@/, '').trim();
  const safeTargetName = JSON.stringify(targetName);

  // Open the agent selector popup
  await driver.client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var trigger = document.querySelector('.chat-input-selected-agent-title-inner');
        if (!trigger) return { success: false, error: 'no trigger' };
        var rect = trigger.getBoundingClientRect();
        trigger.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, composed: true,
          clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2
        }));
        trigger.click();
        return { success: true, action: 'opened agent popup' };
      })()
    `,
    returnByValue: true
  });
  await sleep(800);

  // Wait for popup and click target agent
  const found = await driver.client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var target = ${safeTargetName};
        var items = document.querySelectorAll('.agent-popup-item');
        for (var i = 0; i < items.length; i++) {
          var text = items[i].textContent.trim();
          if (text.includes(target) || text.includes(target.replace(/ /g, ''))) {
            items[i].dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, cancelable: true}));
            items[i].click();
            return { success: true, agentName: text.substring(0, 30) };
          }
        }
        return { success: false, error: 'agent not found', target: target, itemCount: items.length };
      })()
    `,
    returnByValue: true
  });
  await sleep(1500);
  const result = found.result?.value || { success: false, error: 'unknown' };
  return result;
}

/**
 * Mode-aware delegation.
 * - Detects current UI mode.
 * - SOLO: uses sidebar (toggles sidebar visibility), tracks task via sidebar.
 * - IDE: no sidebar toggle needed, tracks task via chat panel.
 */
async function delegate(driver, task, options = {}) {
  await driver.newChat();
  driver._invalidateModeCache();

  const modeInfo = await driver.detectMode();
  const isIdeMode = modeInfo.mode === 'ide';

  if (!isIdeMode) {
    // SOLO mode: ensure sidebar is visible for task tracking
    await driver.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var sidebar = document.querySelector('.soloaisidebar');
          if (!sidebar || sidebar.offsetHeight < 100) {
            document.body.focus();
            document.body.dispatchEvent(new KeyboardEvent('keydown', {
              key: 't', code: 'KeyT',
              ctrlKey: true, metaKey: true, bubbles: true
            }));
            return 'toggled sidebar';
          }
          return 'sidebar already visible';
        })()
      `,
      returnByValue: true
    });
    await sleep(500);

    // Capture sidebar baseline
    const beforeSidebar = await driver._captureSidebarText();
    driver._lastTaskText = beforeSidebar;
  } else {
    // Capture IDE chat panel baseline
    const beforePanel = await driver._captureIdePanelText();
    driver._lastTaskText = beforePanel;
  }

  // Switch agent if requested (e.g., "SOLO Coder", "Builder", "Chat")
  if (options.agent) {
    await driver.switchAgent(options.agent);
  }

  // Mode-aware command prefix.
  // SOLO mode: uses /slash commands (e.g., /plan, /spec, /review)
  //            These are understood by the SOLO agent task system.
  // IDE mode:  Trae CN IDE chat has no native /slash commands;
  //            translate mode to a natural language directive instead.
  let effectiveTask = task;
  if (options.mode) {
    const modeRaw = options.mode.startsWith('/') ? options.mode.slice(1) : options.mode;
    if (isIdeMode) {
      // IDE mode: use natural language prelude instead of /slash
      const modeHints = {
        plan: '请先制定详细的实施方案和计划，然后逐步执行：',
        spec: '请编写详细的技术规格说明和设计方案：',
        review: '请审查以下内容，指出问题、风险和改进建议：',
        fix: '请修复以下问题，确保代码正确运行：',
        test: '请编写全面的单元测试覆盖以下功能：',
        explain: '请解释以下代码的工作原理和各部分作用：'
      };
      const hint = modeHints[modeRaw];
      effectiveTask = hint ? (hint + ' ' + task) : task;
    } else {
      // SOLO mode: keep native /slash command
      effectiveTask = '/' + modeRaw + ' ' + task;
    }
  }

  // Capture pre-send body text for diffing in collectResponse()
  const beforeBody = await driver._captureBodyText();
  driver._preSendSnapshot = beforeBody;

  const dialogBefore = await driver.checkForApprovalDialog();
  if (dialogBefore.needsApproval) {
    return { text: '', stable: false, elapsedMs: 0, needsApproval: true, question: dialogBefore.question, dialogType: dialogBefore.dialogType };
  }

  await driver.sendMessage(effectiveTask);
  const response = await driver.collectResponse();

  if (response && response.text) {
    driver._lastTaskText = response.text;
  }
  driver._pendingUserTask = '';

  if (response.timedOut && !response.text) {
    throw TraeCNAutomationError.responseTimeout(driver.config.timeoutMs);
  }

  return response;
}

async function _waitForExpression(driver, expression, timeoutMs = 5000, pollMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await driver.client.send('Runtime.evaluate', {
      expression,
      returnByValue: true
    });
    if (result.result?.value) return true;
    await sleep(pollMs);
  }
  return false;
}

async function newChat(driver) {
  const existingReviewGate = await driver.checkTaskReviewGate();
  if (existingReviewGate.awaitingReview && existingReviewGate.reviewCount !== 0) {
    const gateResolution = await driver.resolveTaskReviewGate('keep_all');
    if (!gateResolution.success) {
      throw TraeCNAutomationError.reviewGateBlocked(`new chat blocked: ${gateResolution.reason || gateResolution.error || 'unknown'}`);
    }
    await sleep(driver.config.postActionDelayMs * 2);
  }

  const previousPanelText = await driver._captureIdePanelText();

  // Try keyboard shortcut first (works in both modes)
  await driver.client.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'n', code: 'KeyN', modifiers: 6
  });
  await driver.client.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'n', code: 'KeyN', modifiers: 6
  });

  const safeComposerSels = safeJsValue(driver.config.composerSelectors);
  const ready = await driver._waitForExpression(
    `(function(){var s=${safeComposerSels};for(var i=0;i<s.length;i++){var e=document.querySelector(s[i]);if(e&&e.getBoundingClientRect().width>20&&e.offsetParent!==null)return true;}return false;})()`,
    4000, 200
  );
  if (!ready) await sleep(2000);

  let panelChanged = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const panelText = await driver._captureIdePanelText();
    if (!previousPanelText || !panelText || panelText !== previousPanelText) {
      panelChanged = true;
      break;
    }
    await sleep(250);
  }

  if (!panelChanged) {
    const newChatButton = await driver.findNewChatButton();
    if (newChatButton && newChatButton.nodeId) {
      await dom.clickNode(driver.client, newChatButton.nodeId);
      await sleep(driver.config.postActionDelayMs * 2);
      for (let attempt = 0; attempt < 8; attempt++) {
        const panelText = await driver._captureIdePanelText();
        if (!previousPanelText || !panelText || panelText !== previousPanelText) {
          panelChanged = true;
          break;
        }
        await sleep(250);
      }
    }
  }

  if (!panelChanged && previousPanelText) {
    throw TraeCNAutomationError.freshChatFailed('existing task still active');
  }

  driver._lastTaskText = '';
  driver._pendingUserTask = '';
  driver._preSendSnapshot = '';
  return true;
}

module.exports = {
  typeMessage,
  sendMessage,
  stopGeneration,
  switchAgent,
  delegate,
  _waitForExpression,
  newChat
};
