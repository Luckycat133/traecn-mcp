'use strict';

const http = require('http');
const { TraeCNAutomationError } = require('./errors');
const { CDPClient } = require('./client');
const dom = require('./browser-dom');
const { SettingsDriver } = require('./settings-driver');
const { getEnvWithFallback, parseSelectors, sleep, escapeJsString } = require('../shared/utils');

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

function getConfig() {
  return {
    composerSelectors: parseSelectors(
      getEnvWithFallback('TRAECN_COMPOSER_SELECTORS', 'TRAE_COMPOSER_SELECTORS'),
      DEFAULT_COMPOSER_SELECTORS
    ),
    sendButtonSelectors: parseSelectors(
      getEnvWithFallback('TRAECN_SEND_BUTTON_SELECTORS', 'TRAE_SEND_BUTTON_SELECTORS'),
      DEFAULT_SEND_BUTTON_SELECTORS
    ),
    responseSelectors: parseSelectors(
      getEnvWithFallback('TRAECN_RESPONSE_SELECTORS', 'TRAE_RESPONSE_SELECTORS'),
      DEFAULT_RESPONSE_SELECTORS
    ),
    activitySelectors: parseSelectors(
      getEnvWithFallback('TRAECN_ACTIVITY_SELECTORS', 'TRAE_ACTIVITY_SELECTORS'),
      DEFAULT_ACTIVITY_SELECTORS
    ),
    newChatSelectors: parseSelectors(
      getEnvWithFallback('TRAECN_NEW_CHAT_SELECTORS', 'TRAE_NEW_CHAT_SELECTORS'),
      DEFAULT_NEW_CHAT_SELECTORS
    ),
    modeTabSelectors: parseSelectors(
      getEnvWithFallback('TRAECN_MODE_TAB_SELECTORS', 'TRAE_MODE_TAB_SELECTORS'),
      DEFAULT_MODE_TAB_SELECTORS
    ),
    sendTrigger: getEnvWithFallback('TRAECN_SEND_TRIGGER', 'TRAE_SEND_TRIGGER', 'button'),
    pollIntervalMs: parseInt(getEnvWithFallback('TRAECN_RESPONSE_POLL_INTERVAL_MS', 'TRAE_RESPONSE_POLL_INTERVAL_MS', '350'), 10),
    idleMs: parseInt(getEnvWithFallback('TRAECN_RESPONSE_IDLE_MS', 'TRAE_RESPONSE_IDLE_MS', '1200'), 10),
    timeoutMs: parseInt(getEnvWithFallback('TRAECN_RESPONSE_TIMEOUT_MS', 'TRAE_RESPONSE_TIMEOUT_MS', '30000'), 10),
    postActionDelayMs: parseInt(getEnvWithFallback('TRAECN_POST_ACTION_DELAY_MS', 'TRAE_POST_ACTION_DELAY_MS', '350'), 10),
    sessionPrepareTimeoutMs: parseInt(getEnvWithFallback('TRAECN_SESSION_PREPARE_TIMEOUT_MS', 'TRAE_SESSION_PREPARE_TIMEOUT_MS', '5000'), 10),
    queuePollIntervalMs: parseInt(getEnvWithFallback('TRAECN_QUEUE_POLL_INTERVAL_MS', 'TRAE_QUEUE_POLL_INTERVAL_MS', '15000'), 10),
    queueWaitTimeoutMs: parseInt(getEnvWithFallback('TRAECN_QUEUE_WAIT_TIMEOUT_MS', 'TRAE_QUEUE_WAIT_TIMEOUT_MS', '600000'), 10)
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

function isTruncationSignal(text) {
  if (!text) return false;
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
    await this.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
    await this.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
    await sleep(50);
    await this.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
    await this.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
    await sleep(100);

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
      await sleep(30);
    }
    await sleep(this.config.postActionDelayMs);

    const primaryComposer = escapeJsString(this.config.composerSelectors[0] || '.chat-input-v2-input-box-editable');
    const verifyResult = await this.client.send('Runtime.evaluate', {
      expression: `document.querySelector('${primaryComposer}')?.textContent || ''`,
      returnByValue: true
    });
    const currentText = (verifyResult.result?.value || '').trim();

    if (currentText !== text.trim()) {
      const escaped = escapeJsString(text);
      await this.client.send('Runtime.evaluate', {
        expression: `
          (function() {
            var el = document.querySelector('${primaryComposer}');
            if (!el) return;
            el.innerText = '${escaped}';
            el.dispatchEvent(new InputEvent('input', {bubbles: true, cancelable: true}));
          })()
        `,
        returnByValue: true
      });
      await sleep(this.config.postActionDelayMs * 2);
    }

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
    let initialText = null;
    let inQueueSince = null;
    let truncationSince = null;
    const truncationTimeout = 20000;

    while (Date.now() - startTime < this.config.timeoutMs) {
      let responseRegion;
      try {
        responseRegion = await this.findResponseRegion();
      } catch(e) {
        await sleep(pollInterval);
        continue;
      }
      let currentText = '';
      if (responseRegion) {
        try {
          currentText = await dom.getInnerText(this.client, responseRegion.nodeId);
          currentText = sanitizeActivityText(currentText);
          if (initialText === null) initialText = currentText;
        } catch(e) {
          await sleep(pollInterval);
          continue;
        }
      }

      if (warmingUp) {
        if (currentText !== initialText) {
          lastText = currentText;
          stableCount = 0;
        }
        if (Date.now() - startTime >= warmupMs) {
          warmingUp = false;
          lastText = currentText;
        }
        await sleep(pollInterval);
        continue;
      }

      const isQueued = currentText && (
        currentText.includes('排队') ||
        currentText.includes('等待') ||
        currentText.includes('队列') ||
        currentText.includes('等待中')
      );

      if (isQueued) {
        if (!inQueueSince) inQueueSince = Date.now();
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
        lastText = currentText;
        await sleep(queuePollInterval);
        continue;
      }

      inQueueSince = null;

      const truncationSignal = isTruncationSignal(currentText);
      if (truncationSignal) {
        if (!truncationSince) truncationSince = Date.now();
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

      truncationSince = null;

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

    const responseSel1 = escapeJsString(this.config.responseSelectors[0] || "[data-role='assistant']");
    const responseSel2 = escapeJsString(this.config.responseSelectors[1] || '.agent-plan-items');
    await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var el = document.querySelector('${responseSel1}');
          if (el) el.textContent = '';
          var items = document.querySelectorAll('${responseSel2}');
          for (var i = 0; i < items.length; i++) items[i].textContent = '';
        })()
      `,
      returnByValue: true
    });
    await sleep(200);

    const queueWaitTimeoutMs = this.config.queueWaitTimeoutMs || 600000;
    const queuePollIntervalMs = this.config.queuePollIntervalMs || 15000;
    const maxQueueRetries = Math.ceil(queueWaitTimeoutMs / queuePollIntervalMs);
    for (let attempt = 0; attempt < maxQueueRetries; attempt++) {
      const status = await this.checkQueueStatus();
      if (!status.queued) break;
      await sleep(queuePollIntervalMs);
    }

    await this.sendMessage(task);
    const response = await this.collectResponse();

    if (response.timedOut && !response.text) {
      throw TraeCNAutomationError.responseTimeout(this.config.timeoutMs);
    }

    return response;
  }

  async newChat() {
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'n', code: 'KeyN', modifiers: 256
    });
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'n', code: 'KeyN', modifiers: 256
    });
    await sleep(2000);
    return true;
  }

  async switchMode(mode) {
    const tabs = await this.findModeTabs();
    const modeLower = mode.toLowerCase();
    const target = tabs.find(t => t.text.toLowerCase().includes(modeLower));

    if (target) {
      const tabIndex = target.text.toLowerCase().includes('solo') ? 0 : 1;
      const modeTabSel = escapeJsString(this.config.modeTabSelectors[0] || '.icube-mode-tab-item');
      await this.client.send('Runtime.evaluate', {
        expression: `
          (function() {
            var tabs = document.querySelectorAll('${modeTabSel}');
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

  static KNOWN_MODELS = [
    'Doubao-Seed-2.0-Code', 'Doubao-Seed-1.8', 'Doubao-Seed-Code',
    'MiniMax-M2.7', 'MiniMax-M2.5',
    'GLM-5.1', 'GLM-5V-Turbo', 'GLM-5',
    'DeepSeek-V3.1-Terminus', 'Kimi-K2.5', 'Qwen3.6-Plus', 'Qwen3.5-Plus'
  ];

  async checkQueueStatus(timeoutMs = 5000) {
    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('checkQueueStatus timeout')), timeoutMs)
      );
      const result = await Promise.race([
        this._checkQueueStatusRaw(),
        timeoutPromise
      ]);
      return result;
    } catch (e) {
      return { queued: false };
    }
  }

  async _checkQueueStatusRaw() {
    const triggerResult = await this.client.send('Runtime.evaluate', {
        expression: `
          (function() {
            const trigger = document.querySelector('.icd-model-select-trigger');
            if (!trigger) return { found: false };
            const isDisabled = trigger.disabled ||
                              trigger.getAttribute('aria-disabled') === 'true';
            const wrapper = trigger.closest('.ai-model-select') ||
                          trigger.closest('[class*="ai-model-select"]');
            const hasDisabledClass = wrapper ?
              /ai-model-select-disabled|model-select-disabled/.test(wrapper.className) : false;
            const sendBtn = document.querySelector('.chat-input-v2-send-button');
            const sendDisabled = sendBtn ?
              (sendBtn.disabled || /disabled/.test(sendBtn.className)) : false;
            const currentModel = trigger.textContent?.replace(/\\s+/g, ' ').trim() || '';
            return {
              found: true,
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

      if (info.found && (info.isDisabled || info.hasDisabledClass)) {
        return {
          queued: true,
          position: null,
          message: `Model "${info.currentModel}" is currently unavailable (queued/busy). Model selector disabled: ${info.isDisabled}, wrapper disabled class: ${info.hasDisabledClass}`
        };
      }

      return { queued: false };
  }

  async switchModel(modelName) {
    const MODEL_SELECTOR = '.icd-model-select-trigger';

    await this.client.send('Runtime.evaluate', {
      expression: `document.querySelector('${MODEL_SELECTOR}')?.focus()`,
      returnByValue: true
    });
    await sleep(100);
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', modifiers: 0
    });
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', modifiers: 0
    });
    await sleep(500);

    const escaped = escapeJsString(modelName);
    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var items = document.querySelectorAll('.icube-model-select-portal-model-item');
          if (!items.length) return 'no model items found';
          var targetName = '${escaped}';
          for (var i = 0; i < items.length; i++) {
            var nameEl = items[i].querySelector('.icube-model-select-portal-model-item-inner-wrapper');
            var name = nameEl ? nameEl.textContent.replace(/\\s+/g, ' ').trim() : '';
            if (name === targetName || name.startsWith(targetName + 'Beta') || name.startsWith(targetName + ' ')) {
              items[i].click();
              return 'clicked: ' + name + ' at index ' + i;
            }
          }
          var normalizedTarget = targetName.replace(/\\s*Beta\\s*/i, '');
          for (var i = 0; i < items.length; i++) {
            var nameEl = items[i].querySelector('.icube-model-select-portal-model-item-inner-wrapper');
            var name = nameEl ? nameEl.textContent.replace(/\\s+/g, ' ').trim().replace(/\\s*Beta\\s*/i, '') : '';
            if (name === normalizedTarget) {
              items[i].click();
              return 'clicked (normalized): ' + items[i].querySelector('.icube-model-select-portal-model-item-inner-wrapper').textContent.trim() + ' at index ' + i;
            }
          }
          for (var i = 0; i < items.length; i++) {
            var nameEl = items[i].querySelector('.icube-model-select-portal-model-item-inner-wrapper');
            var name = nameEl ? nameEl.textContent.replace(/\\s+/g, ' ').trim() : '';
            var cleanName = name.replace(/Beta/i, '').trim();
            if (cleanName === targetName) {
              items[i].click();
              return 'clicked (partial): ' + name + ' at index ' + i;
            }
          }
          return 'model not found: ' + targetName + ', available: ' + [].map.call(items, function(el) {
            var n = el.querySelector('.icube-model-select-portal-model-item-inner-wrapper');
            return n ? n.textContent.replace(/\\s+/g, ' ').trim() : '';
          }).join(', ');
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

  get settings() {
    if (!this._settingsDriver) {
      this._settingsDriver = new SettingsDriver(this.client, this.config);
    }
    return this._settingsDriver;
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
  DEFAULT_MODE_TAB_SELECTORS,
  SettingsDriver
};
