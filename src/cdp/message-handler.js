'use strict';

/**
 * MessageHandler — handles message typing, sending, and generation stopping.
 * Extracted from DomDriver to isolate message-interaction responsibility.
 */

const { TraeCNAutomationError } = require('./errors');
const { safeJsValue, sleep } = require('../shared/utils');

class MessageHandler {
  constructor(client, config, domHelper, dialogHandler) {
    this.client = client;
    this.config = config;
    this.domHelper = domHelper;
    this.dialogHandler = dialogHandler;
    this._pendingUserTask = '';
  }

  get pendingUserTask() {
    return this._pendingUserTask;
  }

  set pendingUserTask(value) {
    this._pendingUserTask = value;
  }

  async typeMessage(text) {
    const composer = await this.domHelper.findComposer();
    if (!composer) {
      throw TraeCNAutomationError.selectorNotFound('composer', this.config.composerSelectors);
    }

    const nodeId = composer.nodeId;
    const outerHTML = await this.domHelper.getOuterHTML(nodeId);

    if (outerHTML.includes('contenteditable') || outerHTML.includes('textarea')) {
      await this.domHelper.setContentEditableText(nodeId, text);
    } else {
      await this.domHelper.setInputValue(nodeId, text);
    }

    await sleep(this.config.postActionDelayMs);
  }

  async sendMessage(text) {
    const existingReviewGate = await this.dialogHandler.checkTaskReviewGate();
    if (existingReviewGate.awaitingReview && existingReviewGate.reviewCount !== 0) {
      const gateResolution = await this.dialogHandler.resolveTaskReviewGate('keep_all');
      if (!gateResolution.success) {
        throw new Error(`Task review gate blocked message send: ${gateResolution.reason || gateResolution.error || 'unknown'}`);
      }
      await sleep(this.config.postActionDelayMs * 2);
    }

    const normalizedExpected = String(text || '').replace(/\s+/g, ' ').trim();
    this._pendingUserTask = normalizedExpected;
    const focusResult = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var el = document.querySelector('.chat-input-v2-input-box-editable');
          if (!el) return { ok: false, reason: 'no composer' };
          el.focus();
          return { ok: true };
        })()
      `,
      returnByValue: true
    });
    const focusInfo = focusResult.result?.value || {};
    if (!focusInfo.ok) {
      throw new Error(`Failed to focus composer: ${focusInfo.reason || 'unknown'}`);
    }

    await this.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4 });
    await this.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
    await this.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await this.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await sleep(100);
    await this.client.send('Input.insertText', { text });
    await sleep(100);

    let inputResult = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var el = document.querySelector('.chat-input-v2-input-box-editable');
          var value = el ? (el.innerText || el.textContent || '').trim() : '';
          var normalized = value.replace(/\\s+/g, ' ').trim();
          return {
            ok: normalized === ${safeJsValue(normalizedExpected)},
            text: value,
            normalized: normalized
          };
        })()
      `,
      returnByValue: true
    });

    let inputInfo = inputResult.result?.value || {};
    if (!inputInfo.ok) {
      await this.typeMessage(text);
      inputResult = await this.client.send('Runtime.evaluate', {
        expression: `
          (function() {
            var el = document.querySelector('.chat-input-v2-input-box-editable');
            var value = el ? (el.innerText || el.textContent || '').trim() : '';
            var normalized = value.replace(/\\s+/g, ' ').trim();
            return {
              ok: normalized === ${safeJsValue(normalizedExpected)},
              text: value,
              normalized: normalized
            };
          })()
        `,
        returnByValue: true
      });
      inputInfo = inputResult.result?.value || {};
    }
    if (!inputInfo.ok) {
      throw new Error(`Failed to set composer text: ${inputInfo.normalized || inputInfo.text || 'unknown'}`);
    }
    await sleep(this.config.postActionDelayMs * 2);

    if (this.config.sendTrigger === 'button') {
      const sendBtn = await this.domHelper.findSendButton();
      if (sendBtn && sendBtn.nodeId) {
        await this.client.send('Runtime.evaluate', {
          expression: `
            (function() {
              var btn = document.querySelector('button.chat-input-v2-send-button');
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
      } else {
        await this.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 2 });
        await this.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 2 });
      }
    } else {
      await this.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 2 });
      await this.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 2 });
    }
    await sleep(this.config.postActionDelayMs);
  }

  async stopGeneration() {
    if (!this.client || typeof this.client.send !== 'function') {
      return { success: false, reason: 'no_cdp_client' };
    }
    const result = await this.client.send('Runtime.evaluate', {
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
    await sleep(Math.max(this.config.postActionDelayMs * 2, 500));
    return result.result?.value || { success: false, reason: 'no_result' };
  }

  async switchAgent(agentName) {
    const targetName = agentName.replace(/^@/, '').trim();

    await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var trigger = document.querySelector('.chat-input-selected-agent-title-inner');
          if (!trigger) return 'no trigger';
          var rect = trigger.getBoundingClientRect();
          trigger.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true, cancelable: true, composed: true,
            clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2
          }));
          trigger.click();
          return 'opened agent popup';
        })()
      `,
      returnByValue: true
    });
    await sleep(800);

    const found = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var target = '${targetName}';
          var items = document.querySelectorAll('.agent-popup-item');
          for (var i = 0; i < items.length; i++) {
            var text = items[i].textContent.trim();
            if (text.includes(target) || text.includes(target.replace(/ /g, ''))) {
              items[i].dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, cancelable: true}));
              items[i].click();
              return 'switched to: ' + text.substring(0, 30);
            }
          }
          return 'agent not found: ' + target + ' (items: ' + items.length + ')';
        })()
      `,
      returnByValue: true
    });
    await sleep(1500);
    return found.result?.value || 'unknown';
  }
}

module.exports = { MessageHandler };
