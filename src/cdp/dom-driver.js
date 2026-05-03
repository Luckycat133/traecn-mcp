'use strict';

const http = require('http');
const { TraeCNAutomationError } = require('./errors');
const { CDPClient } = require('./client');
const dom = require('./browser-dom');
const { SettingsDriver } = require('./settings-driver');
const { getEnvWithFallback, parseSelectors, parsePositiveInt, sleep, escapeJsString } = require('../shared/utils');

const DEFAULT_COMPOSER_SELECTORS = [
  '.chat-input-v2-input-box-editable',
  'textarea',
  "[contenteditable='true']",
  "input[type='text']",
  "[class*='chat-input']",
  "[class*='input-box']"
];

const DEFAULT_SEND_BUTTON_SELECTORS = [
  'button.chat-input-v2-send-button',
  "button[data-testid*='send']",
  "button[aria-label*='Send']",
  "button[aria-label*='发送']",
  "button[type='submit']",
  "[class*='send-button']",
  "[class*='send']"
];

const DEFAULT_RESPONSE_SELECTORS = [
  '.assistant-chat-turn-content',
  '.agent-plan-items.assistant-chat-turn-element',
  '.icd-open-folder-card-desc',
  "[data-message-author-role='assistant']",
  "[data-testid*='assistant']",
  "[data-role='assistant']",
  "[data-author='assistant']",
  '.assistant',
  "[class*='assistant-chat']"
];

const DEFAULT_ACTIVITY_SELECTORS = [
  '.chat-content-container',
  '.chat-list-wrapper',
  "[class*='activity']",
  "[class*='chat-content']"
];

const DEFAULT_NEW_CHAT_SELECTORS = [
  'a.codicon-icube-NewChat',
  "a[data-testid*='new-chat']",
  "button[data-testid*='new-chat']",
  "[aria-label*='New Chat']",
  "[aria-label*='新建对话']",
  "[class*='NewChat']",
  "[class*='new-task-button']",
  "[class*='new-task']"
];

const DEFAULT_MODE_TAB_SELECTORS = [
  '.icube-mode-tab-item',
  "[class*='icube-mode-tab-item']",
  "[data-testid*='mode-tab']",
  "[class*='mode-tab']"
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
    pollIntervalMs: parsePositiveInt(getEnvWithFallback('TRAECN_RESPONSE_POLL_INTERVAL_MS', 'TRAE_RESPONSE_POLL_INTERVAL_MS', '350'), 350),
    idleMs: parsePositiveInt(getEnvWithFallback('TRAECN_RESPONSE_IDLE_MS', 'TRAE_RESPONSE_IDLE_MS', '1200'), 1200),
    timeoutMs: parsePositiveInt(getEnvWithFallback('TRAECN_RESPONSE_TIMEOUT_MS', 'TRAE_RESPONSE_TIMEOUT_MS', '30000'), 30000),
    postActionDelayMs: parsePositiveInt(getEnvWithFallback('TRAECN_POST_ACTION_DELAY_MS', 'TRAE_POST_ACTION_DELAY_MS', '350'), 350),
    sessionPrepareTimeoutMs: parsePositiveInt(getEnvWithFallback('TRAECN_SESSION_PREPARE_TIMEOUT_MS', 'TRAE_SESSION_PREPARE_TIMEOUT_MS', '5000'), 5000),
    queuePollIntervalMs: parsePositiveInt(getEnvWithFallback('TRAECN_QUEUE_POLL_INTERVAL_MS', 'TRAE_QUEUE_POLL_INTERVAL_MS', '15000'), 15000),
    queueWaitTimeoutMs: parsePositiveInt(getEnvWithFallback('TRAECN_QUEUE_WAIT_TIMEOUT_MS', 'TRAE_QUEUE_WAIT_TIMEOUT_MS', '600000'), 600000)
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
    this._lastTaskText = '';
  }

  async _captureSidebarText() {
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `(() => {
          var s = document.querySelector('.soloaisidebar');
          return s ? s.textContent.trim() : '';
        })()`,
        returnByValue: true
      });
      return result.result?.value || '';
    } catch(e) {
      return '';
    }
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

  async findTaskResponse() {
    const skipText = this._lastTaskText;
    // Find the task panel container by looking for known text patterns.
    // Uses size-based heuristics then text-based fallbacks.
    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (() => {
          let sidebar = document.querySelector('.soloaisidebar');
          if (!sidebar) return null;

          // Strategy 1: Find visible task items by dimensions
          let items = Array.from(sidebar.querySelectorAll('div'))
            .filter(el => {
              let text = el.textContent.trim();
              let w = el.getBoundingClientRect().width;
              let h = el.getBoundingClientRect().height;
              return w > 100 && w < 350 && h > 30 && h < 120 &&
                     text.length > 5 &&
                     !text.includes('新任务');
            });

          if (items.length > 0) {
            let latest = items[items.length - 1];
            let text = latest.textContent.trim();
            // Skip stale text (same as previous response)
            if (text === skipText) return null;
            return {
              text: text,
              inProgress: text.includes('进行中'),
              isComplete: text.includes('任务完成'),
              hasResponse: text.length > 15 && !text.includes('进行中') && !text.includes('新任务')
            };
          }

          // Strategy 2: Sidebar collapsed - scan all text content
          let fullText = sidebar.textContent.trim();
          let taskMatch = fullText.match(/任务\\d+[^]*?(?=实时|$)/);
          if (taskMatch) {
            let taskText = taskMatch[0].trim();
            if (taskText.length > 5 && !taskText.includes('开始你的第一个任务') && taskText !== skipText) {
              return {
                text: taskText,
                inProgress: fullText.includes('进行中'),
                isComplete: fullText.includes('任务完成'),
                hasResponse: !fullText.includes('进行中') && !fullText.includes('新任务') && taskText.length > 10
              };
            }
          }

          // Strategy 3: Just return the sidebar text if it looks like a task
          // Strategy 3: Skip if same as previous
          if (fullText === skipText) return null;
          if (fullText.includes('任务') && fullText.length > 20) {
            let isProcessing = fullText.includes('进行中') || fullText.includes('生成中');
            return {
              text: fullText.slice(0, 300),
              inProgress: isProcessing,
              isComplete: fullText.includes('任务完成'),
              hasResponse: !isProcessing && fullText.length > 20 && !fullText.includes('新任务')
            };
          }

          return null;
        })()
      `,
      returnByValue: true
    });

    return result.result?.value || null;
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
    const escapedText = escapeJsString(text);

    // Focus composer and insert text via execCommand (works with Lexical editor)
    await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var el = document.querySelector('.chat-input-v2-input-box-editable');
          if (!el) return 'no composer';
          el.focus();
          // Select all and delete existing content
          document.execCommand('selectAll');
          document.execCommand('delete');
          // Insert text via execCommand (triggers Lexical properly)
          document.execCommand('insertText', false, '${escapedText}');
          // Also dispatch InputEvent as safety net
          el.dispatchEvent(new InputEvent('input', {bubbles: true, cancelable: true, composed: true}));
          return 'inserted: ' + el.textContent.trim();
        })()
      `,
      returnByValue: true
    });
    await sleep(this.config.postActionDelayMs * 2);

    // Send via configured trigger
    if (this.config.sendTrigger === 'button') {
      const sendBtn = await this.findSendButton();
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
              // Use mousedown+mouseup+click sequence (proven to work)
              btn.dispatchEvent(new MouseEvent('mousedown', {bubbles:true,cancelable:true,clientX:cx,clientY:cy}));
              btn.dispatchEvent(new MouseEvent('mouseup', {bubbles:true,cancelable:true,clientX:cx,clientY:cy}));
              btn.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true,clientX:cx,clientY:cy}));
              return 'send via mouse events';
            })()
          `,
          returnByValue: true
        });
      } else {
        // Fallback: Shift+Enter
        await this.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 2 });
        await this.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 2 });
      }
    } else {
      await this.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 2 });
      await this.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 2 });
    }
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
      // Try task-based response first (Trae CN task panel)
      const taskResponse = await this.findTaskResponse();
      if (taskResponse) {
        if (taskResponse.isComplete || (taskResponse.hasResponse && !taskResponse.inProgress)) {
          return { text: taskResponse.text, stable: true, elapsedMs: Date.now() - startTime };
        }
        if (taskResponse.inProgress) {
          await sleep(pollInterval * 2);
          continue;
        }
      }

      // Fallback: original chat-based response collection
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
    // Always create a new task for fresh context
    await this.newChat();

    // Ensure task sidebar is visible (toggle with Ctrl+Cmd+T)
    await this.client.send('Runtime.evaluate', {
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

    // Capture current sidebar state before sending to avoid picking up stale text
    const beforeSidebar = await this._captureSidebarText();
    this._lastTaskText = beforeSidebar;

    await this.sendMessage(task);
    const response = await this.collectResponse();

    // Update last task text so next call doesn't pick up stale content
    if (response && response.text) {
      this._lastTaskText = response.text;
    }

    if (response.timedOut && !response.text) {
      throw TraeCNAutomationError.responseTimeout(this.config.timeoutMs);
    }

    return response;
  }

  async newChat() {
    // Ctrl+Cmd+N (modifiers: 2=Ctrl + 4=Meta = 6)
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'n', code: 'KeyN', modifiers: 6
    });
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'n', code: 'KeyN', modifiers: 6
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
    let timeoutId;
    try {
      const timeoutPromise = new Promise((_, reject) =>
        { timeoutId = setTimeout(() => reject(new Error('checkQueueStatus timeout')), timeoutMs); }
      );
      const result = await Promise.race([
        this._checkQueueStatusRaw(),
        timeoutPromise
      ]);
      return result;
    } catch (e) {
      return { queued: false };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
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
    const MODEL_TRIGGER = '.icd-model-select-trigger';

    // Step 1: Check if AI is busy (prevents model switching)
    const busyCheck = await this.client.send('Runtime.evaluate', {
      expression: `(() => {
        var body = document.body?.textContent || '';
        if (body.includes('AI \u751f\u6210\u4e2d\uff0c\u65e0\u6cd5\u5207\u6362')) {
          return { busy: true, reason: 'generating' };
        }
        var trigger = document.querySelector('.icd-model-select-trigger');
        if (trigger) {
          var triggerArea = trigger.closest('[class*=input]') || trigger.parentElement;
          if (triggerArea && triggerArea.textContent.includes('\u751f\u6210\u4e2d')) {
            return { busy: true, reason: 'generating' };
          }
        }
        return { busy: false };
      })()`,
      returnByValue: true
    });
    const busyInfo = busyCheck.result?.value;
    if (busyInfo && busyInfo.busy) {
      return 'model_switch_blocked: ' + busyInfo.reason;
    }

    // Step 2: Check if portal is already open (avoid toggle-close on re-entry)
    const portalState = await this.client.send('Runtime.evaluate', {
      expression: `(() => {
        var items = document.querySelectorAll('.icube-model-select-portal-model-item');
        return { itemsFound: items.length, portalOpen: items.length > 0 };
      })()`,
      returnByValue: true
    });
    const ps = portalState.result?.value || { itemsFound: 0, portalOpen: false };

    if (!ps.portalOpen) {
      // Step 2a: Open model selector portal via pointerdown (Radix UI listens for pointerdown, not click)
      await this.client.send('Runtime.evaluate', {
        expression: `
          (() => {
            var trigger = document.querySelector('${MODEL_TRIGGER}');
            if (!trigger) return 'no trigger found';
            var rect = trigger.getBoundingClientRect();
            trigger.dispatchEvent(new PointerEvent('pointerdown', {
              bubbles: true, cancelable: true, composed: true,
              clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2,
              button: 0, buttons: 1, pointerType: 'mouse'
            }));
            // Also try click for non-Radix portals
            trigger.click();
            return 'portal opened via pointerdown+click';
          })()
        `,
        returnByValue: true
      });
      await sleep(800);
    }

    // Step 3: Check if Auto Mode is enabled and toggle it off (via pointerdown)
    await this.client.send('Runtime.evaluate', {
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
              toggleEl.dispatchEvent(new PointerEvent('pointerdown', {
                bubbles: true, cancelable: true, composed: true,
                clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2,
                button: 0, buttons: 1, pointerType: 'mouse'
              }));
              toggleEl.click();
            }
            return 'auto mode disabled';
          }
          return 'auto mode already off';
        })()
      `,
      returnByValue: true
    });
    await sleep(1000);

    // Helper: click an element via pointerdown (for Radix UI components)
    const CLICK_WITH_POINTERDOWN = `(function(el) {
      var rect = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, composed: true,
        clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2,
        button: 0, buttons: 1, pointerType: 'mouse'
      }));
      el.click();
    })`;

    // Step 4: Wait for model items (async portal rendering) and click target
    const escaped = escapeJsString(modelName);
    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var targetName = '${escaped}';

          // Wait for model items via polling (up to 3s)
          var pollStarted = Date.now();
          var items = null;
          while (Date.now() - pollStarted < 3000) {
            items = document.querySelectorAll('.icube-model-select-portal-model-item');
            if (items && items.length > 0) break;
          }
          items = document.querySelectorAll('.icube-model-select-portal-model-item');
          if (!items || !items.length) return 'no model items found';

          var clickEl = ${CLICK_WITH_POINTERDOWN};

          // Strategy 1: Exact match (including with Beta suffix)
          for (var i = 0; i < items.length; i++) {
            var nameEl = items[i].querySelector('.icube-model-select-portal-model-item-inner-wrapper');
            var name = nameEl ? nameEl.textContent.replace(/\s+/g, ' ').trim() : '';
            if (name === targetName || name === targetName + 'Beta' || name.startsWith(targetName + ' ') || name.startsWith(targetName + 'Beta') || name === targetName.replace(/Beta\\s*/i, '') + 'Beta') {
              clickEl(items[i]);
              return 'clicked: ' + name + ' at index ' + i;
            }
          }

          // Strategy 2: Strip Beta suffix then match
          var normalizedTarget = targetName.replace(/\s*Beta\s*/i, '').trim();
          for (var i = 0; i < items.length; i++) {
            var nameEl = items[i].querySelector('.icube-model-select-portal-model-item-inner-wrapper');
            var name = nameEl ? nameEl.textContent.replace(/\s+/g, ' ').trim().replace(/\s*Beta\s*/i, '').trim() : '';
            if (name === normalizedTarget) {
              clickEl(items[i]);
              return 'clicked (normalized): ' + items[i].querySelector('.icube-model-select-portal-model-item-inner-wrapper').textContent.trim() + ' at index ' + i;
            }
          }

          // Strategy 3: Remove Beta from name, compare with target
          for (var i = 0; i < items.length; i++) {
            var nameEl = items[i].querySelector('.icube-model-select-portal-model-item-inner-wrapper');
            var name = nameEl ? nameEl.textContent.replace(/\s+/g, ' ').trim() : '';
            var cleanName = name.replace(/Beta/i, '').trim();
            if (cleanName === targetName || cleanName === targetName.replace(/\\s*Beta/i, '').trim()) {
              clickEl(items[i]);
              return 'clicked (partial): ' + name + ' at index ' + i;
            }
          }

          // Strategy 4: Substring matching (for CSS-truncated names like "Qwen3.5-Plu" vs "Qwen3.5-Plus")
          for (var i = 0; i < items.length; i++) {
            var nameEl = items[i].querySelector('.icube-model-select-portal-model-item-inner-wrapper');
            var name = nameEl ? nameEl.textContent.replace(/\s+/g, ' ').trim() : '';
            name = name.replace(/Beta/i, '').trim();
            var cleanTarget = targetName.replace(/Beta/i, '').trim();
            // Check if one starts with the other (handles truncation in either direction)
            if (cleanTarget.startsWith(name) || name.startsWith(cleanTarget)) {
              clickEl(items[i]);
              return 'clicked (substring): ' + name + ' at index ' + i;
            }
          }

          // Strategy 5: Try without non-alphanum chars (handles edge truncations)
          for (var i = 0; i < items.length; i++) {
            var nameEl = items[i].querySelector('.icube-model-select-portal-model-item-inner-wrapper');
            var name = nameEl ? nameEl.textContent.replace(/\s+/g, ' ').trim() : '';
            name = name.replace(/Beta/i, '').trim();
            var simpleName = name.replace(/[^a-zA-Z0-9]/g, '');
            var simpleTarget = targetName.replace(/[^a-zA-Z0-9]/g, '');
            if (simpleName === simpleTarget || simpleName.startsWith(simpleTarget) || simpleTarget.startsWith(simpleName)) {
              clickEl(items[i]);
              return 'clicked (simple): ' + name + ' at index ' + i;
            }
          }

          return 'model not found: ' + targetName + ', available: ' + [].map.call(items, function(el) {
            var n = el.querySelector('.icube-model-select-portal-model-item-inner-wrapper');
            return n ? n.textContent.replace(/\s+/g, ' ').trim() : '';
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

  async checkRestrictedMode() {
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `
          (() => {
            const body = document.body ? document.body.textContent : '';

            // Check for Chinese restricted mode keywords
            const cnKeywords = ['受限模式', '信任此文件夹', '信任文件夹', '安全模式', '点击「信任」', '点击信任'];
            const hasCnKeyword = cnKeywords.some(k => body.includes(k));

            // Check for English restricted mode keywords
            const enKeywords = ['restricted mode', 'trust this folder', 'trust folder', 'click trust'];
            const hasEnKeyword = enKeywords.some(k => body.toLowerCase().includes(k));

            if (hasCnKeyword || hasEnKeyword) {
              // Try to find the dialog buttons
              let trustButtonFound = false;
              let manageButtonFound = false;
              let trustButtonText = '';

              // Check for common trust button patterns
              const allButtons = document.querySelectorAll('button, a[role="button"], [class*="button"], [class*="btn"]');
              for (const btn of allButtons) {
                const t = btn.textContent.trim();
                const lower = t.toLowerCase();
                if (lower.includes('信任') || lower.includes('trust') || lower.includes('打开')) {
                  trustButtonFound = true;
                  trustButtonText = t;
                }
                if (lower.includes('管理') || lower.includes('manage')) {
                  manageButtonFound = true;
                }
              }

              // Check for modal/dialog overlay
              const modals = document.querySelectorAll('[class*="modal"], [class*="dialog"], [class*="overlay"], [class*="mask"]');
              const hasOverlay = Array.from(modals).some(m => {
                const rect = m.getBoundingClientRect();
                return rect.width > 100 && rect.height > 50;
              });

              // Determine the title
              const titleMatch = body.match(/受限模式[^。\n]*/);
              const title = titleMatch ? titleMatch[0].trim() : (hasCnKeyword ? '受限模式' : 'Restricted Mode');

              return {
                restricted: true,
                title: title,
                trustButtonFound: trustButtonFound,
                trustButtonText: trustButtonText,
                manageButtonFound: manageButtonFound,
                hasOverlay: hasOverlay
              };
            }

            return { restricted: false };
          })()
        `,
        returnByValue: true,
        timeout: 5000
      });

      return result.result?.value || { restricted: false };
    } catch (err) {
      // If CDP communication fails, return false (don't block)
      return { restricted: false, error: err.message };
    }
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
