'use strict';

const http = require('http');
const { TraeCNAutomationError } = require('./errors');
const { CDPClient } = require('./client');
const dom = require('./browser-dom');

const DEFAULT_COMPOSER_SELECTORS = [
  '.chat-input-v2-input-box-editable',
  'textarea',
  "[contenteditable='true']",
  "input[type='text']"
];

const DEFAULT_SEND_BUTTON_SELECTORS = [
  'button.chat-input-v2-send-button',
  "button[data-testid*='send']",
  "button[aria-label*='Send']",
  "button[aria-label*='发送']",
  "button[type='submit']"
];

const DEFAULT_RESPONSE_SELECTORS = [
  '.assistant-chat-turn-content',
  '.agent-plan-items.assistant-chat-turn-element',
  '.icd-open-folder-card-desc',
  "[data-message-author-role='assistant']",
  "[data-testid*='assistant']",
  "[data-role='assistant']",
  "[data-author='assistant']",
  '.assistant'
];

const DEFAULT_ACTIVITY_SELECTORS = [
  '.chat-content-container',
  '.chat-list-wrapper'
];

const DEFAULT_NEW_CHAT_SELECTORS = [
  'a.codicon-icube-NewChat',
  "a[data-testid*='new-chat']",
  "button[data-testid*='new-chat']",
  "[aria-label*='New Chat']",
  "[aria-label*='新建对话']"
];

const DEFAULT_MODE_TAB_SELECTORS = [
  '.icube-mode-tab-item',
  "[class*='icube-mode-tab-item']",
  "[data-testid*='mode-tab']"
];

function _getEnvWithFallback(traecnKey, traeKey, defaultValue) {
  return process.env[traecnKey] || process.env[traeKey] || defaultValue;
}

function _parseSelectors(envValue, defaults) {
  if (envValue) {
    return envValue.split(',').map(s => s.trim()).filter(Boolean);
  }
  return defaults;
}

function getConfig() {
  return {
    composerSelectors: _parseSelectors(
      _getEnvWithFallback('TRAECN_COMPOSER_SELECTORS', 'TRAE_COMPOSER_SELECTORS'),
      DEFAULT_COMPOSER_SELECTORS
    ),
    sendButtonSelectors: _parseSelectors(
      _getEnvWithFallback('TRAECN_SEND_BUTTON_SELECTORS', 'TRAE_SEND_BUTTON_SELECTORS'),
      DEFAULT_SEND_BUTTON_SELECTORS
    ),
    responseSelectors: _parseSelectors(
      _getEnvWithFallback('TRAECN_RESPONSE_SELECTORS', 'TRAE_RESPONSE_SELECTORS'),
      DEFAULT_RESPONSE_SELECTORS
    ),
    activitySelectors: _parseSelectors(
      _getEnvWithFallback('TRAECN_ACTIVITY_SELECTORS', 'TRAE_ACTIVITY_SELECTORS'),
      DEFAULT_ACTIVITY_SELECTORS
    ),
    newChatSelectors: _parseSelectors(
      _getEnvWithFallback('TRAECN_NEW_CHAT_SELECTORS', 'TRAE_NEW_CHAT_SELECTORS'),
      DEFAULT_NEW_CHAT_SELECTORS
    ),
    modeTabSelectors: _parseSelectors(
      _getEnvWithFallback('TRAECN_MODE_TAB_SELECTORS', 'TRAE_MODE_TAB_SELECTORS'),
      DEFAULT_MODE_TAB_SELECTORS
    ),
    sendTrigger: _getEnvWithFallback('TRAECN_SEND_TRIGGER', 'TRAE_SEND_TRIGGER', 'button'),
    pollIntervalMs: parseInt(_getEnvWithFallback('TRAECN_RESPONSE_POLL_INTERVAL_MS', 'TRAE_RESPONSE_POLL_INTERVAL_MS', '350'), 10),
    idleMs: parseInt(_getEnvWithFallback('TRAECN_RESPONSE_IDLE_MS', 'TRAE_RESPONSE_IDLE_MS', '1200'), 10),
    timeoutMs: parseInt(_getEnvWithFallback('TRAECN_RESPONSE_TIMEOUT_MS', 'TRAE_RESPONSE_TIMEOUT_MS', '30000'), 10),
    postActionDelayMs: parseInt(_getEnvWithFallback('TRAECN_POST_ACTION_DELAY_MS', 'TRAE_POST_ACTION_DELAY_MS', '350'), 10),
    sessionPrepareTimeoutMs: parseInt(_getEnvWithFallback('TRAECN_SESSION_PREPARE_TIMEOUT_MS', 'TRAE_SESSION_PREPARE_TIMEOUT_MS', '5000'), 10),
    queuePollIntervalMs: parseInt(_getEnvWithFallback('TRAECN_QUEUE_POLL_INTERVAL_MS', 'TRAE_QUEUE_POLL_INTERVAL_MS', '15000'), 10),
    queueWaitTimeoutMs: parseInt(_getEnvWithFallback('TRAECN_QUEUE_WAIT_TIMEOUT_MS', 'TRAE_QUEUE_WAIT_TIMEOUT_MS', '600000'), 10)
  };
}

function sanitizeActivityText(text) {
  if (!text) return '';
  return text
    .replace(/正在思考…/g, '')
    .replace(/思考中…/g, '')
    .replace(/Generating…/g, '')
    .replace(/Thinking…/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detects if text represents a truncation/abort signal rather than real content.
 * "Builder手动终止输出" = AI generated content but manually truncated by user
 * vs actual AI response content.
 */
function isTruncationSignal(text) {
  if (!text) return false;
  // These patterns indicate truncation or empty response
  const truncatePatterns = [
    'Builder手动终止输出',
    '手动终止输出',
    '输出已终止',
    '生成已停止',
    '等待中...',
    '等待中…',
    '排队提醒',
    '正在分析问题...',
    '正在分析问题…'
  ];
  return truncatePatterns.some(p => text.includes(p));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class DomDriver {
  constructor(client, config) {
    this.client = client;
    this.config = config || getConfig();
  }

  async findComposer() {
    return dom.findFirstMatching(this.client, this.config.composerSelectors);
  }

  async findSendButton() {
    return dom.findFirstMatching(this.client, this.config.sendButtonSelectors);
  }

  async findResponseRegion() {
    // Try response selectors first; fall back to activity container if none found
    const region = await dom.findFirstMatching(this.client, this.config.responseSelectors);
    if (region) return region;
    return dom.findFirstMatching(this.client, this.config.activitySelectors);
  }

  async findNewChatButton() {
    return dom.findFirstMatching(this.client, this.config.newChatSelectors);
  }

  async findModeTabs() {
    const results = [];
    for (const selector of this.config.modeTabSelectors) {
      const nodeIds = await dom.querySelectorAll(this.client, selector);
      for (const nodeId of nodeIds) {
        const text = await dom.getInnerText(this.client, nodeId);
        results.push({ nodeId, selector, text: (text || '').trim() });
      }
    }
    return results;
  }

  async typeMessage(text) {
    const composer = await this.findComposer();
    if (!composer) {
      throw TraeCNAutomationError.selectorNotFound('composer', this.config.composerSelectors);
    }

    const nodeId = composer.nodeId;
    const outerHTML = await dom.getOuterHTML(this.client, nodeId);

    if (outerHTML.includes('contenteditable') || outerHTML.includes('textarea')) {
      await dom.setContentEditableText(this.client, nodeId, text);
    } else {
      await dom.setInputValue(this.client, nodeId, text);
    }

    await sleep(this.config.postActionDelayMs);
  }

  async sendMessage(text) {
    // CRITICAL: Clear the editor first by selecting all and deleting
    // After a delegate call, the SOLO Coder response stays in the DOM.
    // If we don't clear, Ctrl+A selects the old response instead of user input.
    await this.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
    await this.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
    await sleep(50);
    await this.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
    await this.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
    await sleep(100);

    // Now type the actual message character by character
    for (const char of text) {
      if (char === '\n') {
        await this.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
        await this.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
      } else {
        await this.client.send('Input.dispatchKeyEvent', {
          type: 'keyDown', key: char, code: 'Key' + char.toUpperCase()
        });
        await this.client.send('Input.dispatchKeyEvent', {
          type: 'keyUp', key: char, code: 'Key' + char.toUpperCase()
        });
      }
      await sleep(30); // Allow Lexical to process each keystroke
    }
    await sleep(this.config.postActionDelayMs);

    // Verify: check if text was inserted via keyboard
    const verifyResult = await this.client.send('Runtime.evaluate', {
      expression: `document.querySelector('.chat-input-v2-input-box-editable')?.textContent || ''`,
      returnByValue: true
    });
    const currentText = (verifyResult.result?.value || '').trim();

    // If keyboard typing didn't work, use innerText as fallback
    if (currentText !== text.trim()) {
      const escaped = text.replace(/'/g, "\\'");
      await this.client.send('Runtime.evaluate', {
        expression: `
          (function() {
            var el = document.querySelector('.chat-input-v2-input-box-editable');
            if (!el) return;
            el.innerText = '${escaped}';
            el.dispatchEvent(new InputEvent('input', {bubbles: true, cancelable: true}));
          })()
        `,
        returnByValue: true
      });
      await sleep(this.config.postActionDelayMs * 2);
    }

    // Submit via Ctrl+Enter
    await this.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 2 });
    await this.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 2 });
    await sleep(this.config.postActionDelayMs);
  }

  async collectResponse() {
    const startTime = Date.now();
    const warmupMs = 3000;
    const requiredStable = 2;
    const pollInterval = this.config.pollIntervalMs || 350;
    const queuePollInterval = this.config.queuePollIntervalMs || 15000;
    const queueWaitTimeout = this.config.queueWaitTimeoutMs || 600000;
    let stableCount = 0;
    let warmingUp = true;
    let lastText = '';
    let initialText = null; // Track what the response region said before we started
    let inQueueSince = null;
    let truncationSince = null;
    const truncationTimeout = 20000; // Wait max 20s for content beyond truncation signal

    while (Date.now() - startTime < this.config.timeoutMs) {
      let responseRegion;
      try {
        responseRegion = await this.findResponseRegion();
      } catch(e) {
        // Response region not found yet, wait and retry
        await sleep(pollInterval);
        continue;
      }
      let currentText = '';
      if (responseRegion) {
        try {
          currentText = await dom.getInnerText(this.client, responseRegion.nodeId);
          currentText = sanitizeActivityText(currentText);
          // Capture initial text once, before new conversation response arrives
          if (initialText === null) initialText = currentText;
        } catch(e) {
          // NodeId became stale — force re-resolve on next iteration
          // Keep lastText to maintain truncation/queue tracking
          await sleep(pollInterval);
          continue;
        }
      }

      if (warmingUp) {
        // If content changed from initial text, SOLO Coder started generating new response
        if (currentText !== initialText) {
          lastText = currentText;
          stableCount = 0;
          // Keep warmingUp true until the content stabilizes as new content
        }
        if (Date.now() - startTime >= warmupMs) {
          warmingUp = false;
          lastText = currentText;
        }
        await sleep(pollInterval);
        continue;
      }

      // Detect queue state
      const isQueued = currentText && (
        currentText.includes('排队') ||
        currentText.includes('等待') ||
        currentText.includes('队列') ||
        currentText.includes('等待中')
      );

      if (isQueued) {
        // Track how long we've been in queue
        if (!inQueueSince) inQueueSince = Date.now();

        // Check if we've exceeded queue wait timeout
        if (Date.now() - inQueueSince > queueWaitTimeout) {
          return {
            text: currentText,
            stable: false,
            elapsedMs: Date.now() - startTime,
            queued: true,
            queueElapsedMs: Date.now() - inQueueSince,
            timedOut: true
          };
        }

        // Still in queue, wait for next check at longer interval
        lastText = currentText;
        await sleep(queuePollInterval);
        continue;
      }

      // Not in queue — reset queue tracking
      inQueueSince = null;

      // If truncation/abort signal detected, don't treat as stable — keep polling
      const truncationSignal = isTruncationSignal(currentText);
      if (truncationSignal) {
        if (!truncationSince) truncationSince = Date.now();
        // If only seeing truncation signal for too long, return it as final
        if (Date.now() - truncationSince > truncationTimeout) {
          return {
            text: currentText,
            stable: false,
            elapsedMs: Date.now() - startTime,
            truncated: true,
            timedOut: false
          };
        }
        lastText = currentText;
        await sleep(pollInterval);
        continue;
      }

      // Real content — reset truncation tracker
      truncationSince = null;

      // Consider response stable if text is unchanged AND has meaningful length
      const isStable = currentText && currentText === lastText && currentText.length >= 4;
      if (isStable) {
        stableCount++;
        if (stableCount >= requiredStable) {
          return { text: currentText, stable: true, elapsedMs: Date.now() - startTime };
        }
      } else {
        stableCount = 0;
      }
      lastText = currentText;
      await sleep(pollInterval);
    }
    return { text: lastText, stable: false, elapsedMs: Date.now() - startTime, timedOut: true };
  }

  async delegate(task, options = {}) {
    await this.newChat();

    // IMPORTANT: Clear response region before sending new task.
    // After newChat(), the SOLO Coder response from the PREVIOUS conversation
    // may still be visible in the DOM. If we don't clear it, collectResponse
    // will use the old response as initialText and incorrectly return it as stable.
    await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var el = document.querySelector('[data-role="assistant"]');
          if (el) el.textContent = '';
          var items = document.querySelectorAll('.agent-plan-items');
          for (var i = 0; i < items.length; i++) items[i].textContent = '';
        })()
      `,
      returnByValue: true
    });
    await sleep(200);

    await this.sendMessage(task);
    const response = await this.collectResponse();

    if (response.timedOut && !response.text) {
      throw TraeCNAutomationError.responseTimeout(this.config.timeoutMs);
    }

    return response;
  }

  async newChat() {
    // Use Cmd+N keyboard shortcut — more reliable than DOM click for SOLO Coder webview
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'n', code: 'KeyN', modifiers: 256 // Cmd modifier
    });
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'n', code: 'KeyN', modifiers: 256
    });
    // Wait for SOLO Coder webview to fully load the new conversation
    await sleep(2000);
    return true;
  }

  async switchMode(mode) {
    const tabs = await this.findModeTabs();
    const modeLower = mode.toLowerCase();
    const target = tabs.find(t => t.text.toLowerCase().includes(modeLower));

    if (target) {
      // Use dispatchEvent instead of .click() — .click() doesn't reach SOLO Coder webview
      // Map text to index: SOLO=tabs[0], IDE=tabs[1]
      const tabIndex = target.text.toLowerCase().includes('solo') ? 0 : 1;
      await this.client.send('Runtime.evaluate', {
        expression: `
          (function() {
            var tabs = document.querySelectorAll('.icube-mode-tab-item');
            if (tabs[${tabIndex}]) {
              tabs[${tabIndex}].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              return 'clicked: ' + tabs[${tabIndex}].textContent?.trim();
            }
            return 'tab not found';
          })()
        `,
        returnByValue: true
      });
      await sleep(this.config.postActionDelayMs);
      return true;
    }
    return false;
  }

  async switchModel(modelName) {
    const MODEL_SELECTOR = '.icd-model-select-trigger';

    // Check if dropdown is already open
    const isOpen = await this.client.send('Runtime.evaluate', {
      expression: `document.querySelector('${MODEL_SELECTOR}')?.getAttribute('aria-expanded') === 'true'`,
      returnByValue: true
    });

    if (!isOpen.result?.value) {
      // Open dropdown via keyboard (click alone doesn't open this control)
      await this.client.send('Runtime.evaluate', {
        expression: `document.querySelector('${MODEL_SELECTOR}')?.focus()`,
        returnByValue: true
      });
      await this.client.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', modifiers: 4
      });
      await this.client.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', modifiers: 4
      });
      await sleep(600);
    }

    // Now find and click the target model option — use TreeWalker for reliable traversal
    const escaped = modelName.replace(/'/g, "\\'");
    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var listbox = document.querySelector('[role="listbox"]');
          if (!listbox) return 'no listbox';
          // TreeWalker is more reliable than querySelectorAll for nested elements
          var walker = document.createTreeWalker(listbox, NodeFilter.SHOW_TEXT, null);
          var node;
          while (node = walker.nextNode()) {
            if (node.textContent?.trim() === '${escaped}') {
              var el = node.parentElement;
              while (el && el !== listbox) {
                var cls = el.className || '';
                if (cls.includes('model-item') || cls.includes('select-item')) {
                  el.click();
                  return 'selected: ${escaped}';
                }
                el = el.parentElement;
              }
            }
          }
          // Fallback: try all elements
          var allEls = listbox.querySelectorAll('*');
          for (var el of allEls) {
            if (el.textContent?.trim() === '${escaped}' && el.offsetParent !== null) {
              el.click();
              return 'selected (fallback): ${escaped}';
            }
          }
          return 'model not found: ${escaped}';
        })()
      `,
      returnByValue: true
    });
    await sleep(this.config.postActionDelayMs);
    return result.result?.value || 'unknown';
  }

  async checkReadiness() {
    const composer = await this.findComposer();
    const sendBtn = await this.findSendButton();
    const response = await this.findResponseRegion();

    return {
      ready: !!(composer && sendBtn),
      composer: composer ? { matchedSelector: composer.matchedSelector } : null,
      sendButton: sendBtn ? { matchedSelector: sendBtn.matchedSelector } : null,
      responseRegion: response ? { matchedSelector: response.matchedSelector } : null
    };
  }
}

module.exports = {
  DomDriver,
  getConfig,
  sanitizeActivityText,
  DEFAULT_COMPOSER_SELECTORS,
  DEFAULT_SEND_BUTTON_SELECTORS,
  DEFAULT_RESPONSE_SELECTORS,
  DEFAULT_ACTIVITY_SELECTORS,
  DEFAULT_NEW_CHAT_SELECTORS,
  DEFAULT_MODE_TAB_SELECTORS
};
