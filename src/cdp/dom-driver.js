'use strict';

const http = require('http');
const { TraeCNAutomationError } = require('./errors');
const { CDPClient } = require('./client');
const dom = require('./browser-dom');
const { SettingsDriver } = require('./settings-driver');
const { sleep, escapeJsString, safeJsValue } = require('../shared/utils');
const {
  DEFAULT_COMPOSER_SELECTORS, DEFAULT_SEND_BUTTON_SELECTORS,
  DEFAULT_RESPONSE_SELECTORS, DEFAULT_ACTIVITY_SELECTORS,
  DEFAULT_NEW_CHAT_SELECTORS, DEFAULT_MODE_TAB_SELECTORS,
  getConfig, sanitizeActivityText, isTruncationSignal
} = require('./driver-config');

function hasCompletionMarker(text) {
  if (!text) return false;
  const markers = [
    '任务完成',
    'Task completed',
    '已完成',
    '完成',
    'Done.',
    'All done',
    'finished',
    'finalized'
  ];
  return markers.some(m => text.includes(m));
}

class DomDriver {
  constructor(client, config) {
    this.client = client;
    this.config = config || getConfig();
    this._lastTaskText = '';
    this._preSendSnapshot = ''; // body text snapshot before sending task
    this._cachedMode = null;    // cached mode detection result
    this._cachedModeTs = 0;
    this._modeCacheTtl = 5000;  // re-detect after 5s
  }

  // ── Mode detection ─────────────────────────────────────────────────────

  /**
   * Detect the current UI mode (solo or ide) by checking for distinctive
   * DOM elements. Uses a short cache to avoid excessive re-evaluation.
   *
   * @returns {Promise<{mode: 'solo'|'ide', confidence: number, indicators: string[]}>}
   */
  async detectMode() {
    const now = Date.now();
    if (this._cachedMode && now - this._cachedModeTs < this._modeCacheTtl) {
      return this._cachedMode;
    }

    const safeSoloSels = this.config.soloIndicatorSelectors.map(s => safeJsValue(s));
    const safeIdeSels = this.config.ideIndicatorSelectors.map(s => safeJsValue(s));

    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var indicators = [];

          // SOLO indicators: sidebar
          var soloSidebar = document.querySelector('.soloaisidebar');
          var sidebarVisible = soloSidebar && soloSidebar.offsetParent !== null;
          if (sidebarVisible) {
            indicators.push('sidebar');
          }

          // IDE indicators: monaco workbench / editor / terminal
          var sels = [${safeIdeSels.join(', ')}];
          for (var i = 0; i < sels.length; i++) {
            var el = document.querySelector(sels[i]);
            if (el && el.offsetParent !== null) {
              indicators.push('ide-' + sels[i].replace(/[^a-zA-Z0-9-]/g, ''));
              break;
            }
          }

          var mode = 'solo';
          var confidence = 0.5;
          if (sidebarVisible) {
            mode = 'solo';
            confidence = 0.9;
          } else if (indicators.length > 0) {
            // If sidebar is absent but IDE elements present → IDE
            mode = 'ide';
            confidence = 0.8;
          } else {
            // Fallback: check if the mode tabs show which is active
            var tabs = document.querySelectorAll('.icube-mode-tab-item');
            for (var j = 0; j < tabs.length; j++) {
              var cls = tabs[j].className || '';
              var txt = (tabs[j].textContent || '').trim();
              if (cls.indexOf('active') > -1 || cls.indexOf('selected') > -1) {
                if (txt.toLowerCase().indexOf('ide') > -1) { mode = 'ide'; confidence = 0.7; }
                else { mode = 'solo'; confidence = 0.7; }
                indicators.push('active-tab-' + txt.toLowerCase());
                break;
              }
            }
          }

          return {
            mode: mode,
            confidence: confidence,
            indicators: indicators
          };
        })()
      `,
      returnByValue: true
    });

    const detection = result.result?.value || { mode: 'solo', confidence: 0.5, indicators: [] };
    this._cachedMode = detection;
    this._cachedModeTs = now;
    return detection;
  }

  /**
   * Invalidate mode cache so next detectMode() re-evaluates from scratch.
   */
  _invalidateModeCache() {
    this._cachedMode = null;
    this._cachedModeTs = 0;
  }

  // ── Sidebar / panel text capture ───────────────────────────────────────

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

  /**
   * Capture text from the IDE chat panel (used instead of sidebar in IDE mode).
   */
  async _captureIdePanelText() {
    const safeSels = this.config.ideTaskPanelSelectors.map(s => safeJsValue(s));
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `
          (function() {
            var sels = [${safeSels.join(', ')}];
            for (var i = 0; i < sels.length; i++) {
              var el = document.querySelector(sels[i]);
              if (el && el.offsetParent !== null) {
                var text = el.textContent.trim();
                if (text.length > 10) return text;
              }
            }
            return '';
          })()
        `,
        returnByValue: true
      });
      return result.result?.value || '';
    } catch(e) {
      return '';
    }
  }

  /**
   * Capture all visible text in the main content area (excluding sidebar & composer).
   */
  async _captureVisibleText() {
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `(() => {
          var bodyText = document.body ? document.body.innerText || document.body.textContent || '' : '';
          if (!bodyText) return '';
          var sidebarText = '';
          var sidebarEl = document.querySelector('.soloaisidebar');
          if (sidebarEl) sidebarText = sidebarEl.innerText || sidebarEl.textContent || '';
          var composerText = '';
          var composerEl = document.querySelector('.chat-input-v2-input-box-editable, [class*="input-box"]');
          if (composerEl) composerText = composerEl.innerText || composerEl.textContent || '';
          var panels = document.querySelectorAll('[class*="panel"], [class*="content"], [class*="chat"], [class*="solo"]');
          var panelTexts = [];
          for (var i = 0; i < panels.length; i++) {
            var p = panels[i];
            var rect = p.getBoundingClientRect ? p.getBoundingClientRect() : null;
            if (!rect) continue;
            if (rect.width < 50 || rect.height < 50) continue;
            if (sidebarEl && (p === sidebarEl || sidebarEl.contains(p))) continue;
            if (composerEl && (p === composerEl || composerEl.contains(p))) continue;
            if (rect.height > 1000 || rect.y < 0) continue;
            var t = (p.innerText || p.textContent || '').trim();
            if (t.length > 10 && !panelTexts.includes(t)) {
              panelTexts.push(t);
            }
          }
          var mainText = bodyText;
          if (sidebarText) mainText = mainText.replace(sidebarText, '');
          if (composerText) mainText = mainText.replace(composerText, '');
          mainText = mainText.trim();
          var panelText = panelTexts.join('\n---\n');
          return panelText || mainText || '';
        })()`,
        returnByValue: true
      });
      return result.result?.value || '';
    } catch(e) {
      return '';
    }
  }

  /**
   * Capture document.body innerText as a broad snapshot for text diffing.
   */
  async _captureBodyText() {
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `(() => {
          var body = document.body;
          if (!body) return '';
          return body.innerText || body.textContent || '';
        })()`,
        returnByValue: true
      });
      return result.result?.value || '';
    } catch(e) {
      return '';
    }
  }

  /**
   * Scan only the content area for text-containing elements.
   */
  async _scanContentArea() {
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `(() => {
          var contentAreas = [];
          var allDivs = document.querySelectorAll('div');
          var composerEl = document.querySelector('.chat-input-v2-input-box-editable, [class*="input-box"]');
          var sidebarEl = document.querySelector('.soloaisidebar');
          for (var i = 0; i < allDivs.length; i++) {
            var d = allDivs[i];
            var rect = d.getBoundingClientRect ? d.getBoundingClientRect() : null;
            if (!rect) continue;
            if (rect.width < 100 || rect.height < 60) continue;
            if (composerEl && rect.y > (composerEl.getBoundingClientRect ? composerEl.getBoundingClientRect().y - 10 : 0)) continue;
            if (sidebarEl && sidebarEl.contains(d)) continue;
            if (composerEl && composerEl.contains(d)) continue;
            var text = (d.innerText || d.textContent || '').trim();
            if (text.length > 20 && !/^[\\s\\n]+$/.test(text)) {
              contentAreas.push({ text: text, width: rect.width, height: rect.height, y: rect.y });
            }
          }
          contentAreas.sort(function(a, b) {
            if (a.width * a.height !== b.width * b.height) return (b.width * b.height) - (a.width * a.height);
            return a.y - b.y;
          });
          if (contentAreas.length > 0) {
            var best = contentAreas[0];
            return { text: best.text, areaFound: true };
          }
          return { text: '', areaFound: false };
        })()`,
        returnByValue: true
      });
      return result.result?.value || { text: '', areaFound: false };
    } catch(e) {
      return { text: '', areaFound: false };
    }
  }

  // ── Task sidebar / panel querying ──────────────────────────────────────

  /**
   * Query the SOLO sidebar for task state.
   * Only meaningful in SOLO mode — returns null in IDE mode.
   */
  async _queryTaskSidebar(skipText) {
    const safeSkipText = safeJsValue(skipText);
    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var sidebar = document.querySelector('.soloaisidebar');
          if (!sidebar) return null;

          // Find task items using the actual task item class \u800c\u975e generic divs
          var taskItems = sidebar.querySelectorAll('[class*="task-item"]');
          if (!taskItems || !taskItems.length) return null;

          // Filter: skip tasks that are interrupted/stopped
          var activeItems = [];
          for (var i = 0; i < taskItems.length; i++) {
            var item = taskItems[i];
            var fullText = item.textContent.trim();

            // Skip interrupted tasks
            if (fullText.includes('\u4efb\u52a1\u4e2d\u65ad')) continue;

            // Skip if it\'s just the new-task button (has hotkey hint)
            if (fullText.includes('\u65b0\u4efb\u52a1') && fullText.length < 15) continue;

            // Check status: must be \"\u8fdb\u884c\u4e2d\" (in progress) or have meaningful response content
            var hasContent = fullText.length > 10;
            var isInProgress = fullText.includes('\u8fdb\u884c\u4e2d');

            activeItems.push({
              el: item,
              text: fullText,
              inProgress: isInProgress,
              hasContent: hasContent
            });
          }

          if (activeItems.length === 0) return null;

          // Take the LAST active item (most recent task)
          var latest = activeItems[activeItems.length - 1];
          var text = latest.text;

          // Skip if text matches the baseline captured before sending
          if (text === ${safeSkipText}) return null;

          // Skip if text hasn\'t actually changed from whats in the skipText
          // (handles case where skipText contains the old task text as substring)
          if (${safeSkipText} && ${safeSkipText}.indexOf(text) >= 0 && text.length <= ${safeSkipText}.length) return null;

          return {
            text: text,
            inProgress: latest.inProgress,
            isComplete: text.includes('\u4efb\u52a1\u5b8c\u6210'),
            hasResponse: latest.hasContent && !latest.inProgress
          };
        })()
      `,
      returnByValue: true
    });

    return result.result?.value || null;
  }

  /**
   * Query the IDE chat panel for task state.
   * Used instead of _queryTaskSidebar() in IDE mode.
   */
  async _queryIdeTaskPanel(skipText) {
    const safeSkipText = safeJsValue(skipText);
    const safePanelSels = this.config.ideTaskPanelSelectors.map(s => safeJsValue(s));

    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var sels = [${safePanelSels.join(', ')}];
          var panel = null;
          for (var i = 0; i < sels.length; i++) {
            var el = document.querySelector(sels[i]);
            if (el && el.offsetParent !== null) {
              panel = el;
              break;
            }
          }
          if (!panel) return null;

          var fullText = panel.textContent.trim();
          if (fullText === ${safeSkipText}) return null;

          // Look for the last assistant/agent message
          var messages = panel.querySelectorAll(
            '.chat-message, .agent-message, [class*="chat-message"], [class*="agent-message"], ' +
            '[class*="assistant-chat-turn"], .chat-turn'
          );
          var latestText = '';
          if (messages.length > 0) {
            var lastMsg = messages[messages.length - 1];
            latestText = lastMsg.textContent.trim();
          }

          var inProgress = fullText.includes('\u8fdb\u884c\u4e2d') || fullText.includes('\u6b63\u5728\u601d\u8003');
          var isComplete = fullText.includes('\u4efb\u52a1\u5b8c\u6210') || fullText.includes('\u5df2\u5b8c\u6210');

          return {
            text: latestText || fullText.slice(0, 500),
            inProgress: inProgress,
            isComplete: isComplete || fullText.includes('\u5b8c\u6210') && !inProgress,
            hasResponse: !inProgress && (latestText.length > 20 || fullText.length > 20)
          };
        })()
      `,
      returnByValue: true
    });

    return result.result?.value || null;
  }

  /**
   * Mode-aware version: tries sidebar in SOLO mode, chat panel in IDE mode.
   */
  async _queryTaskSource(skipText) {
    const modeInfo = await this.detectMode();
    if (modeInfo.mode === 'solo') {
      return this._queryTaskSidebar(skipText);
    }
    return this._queryIdeTaskPanel(skipText);
  }

  async findTaskResponse() {
    const skipText = this._lastTaskText;

    // Try mode-specific task source first
    const taskResult = await this._queryTaskSource(skipText);
    if (taskResult) return taskResult;

    // SOLO fallback: sidebar full-text scan for task blocks
    const modeInfo = await this.detectMode();
    if (modeInfo.mode === 'solo') {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `
          (() => {
            let sidebar = document.querySelector('.soloaisidebar');
            if (!sidebar) return null;

            let fullText = sidebar.textContent.trim();
            let taskMatch = fullText.match(/\u4efb\u52a1\\d+[^]*?(?=\u5b9e\u65f6|$)/);
            if (taskMatch) {
              let taskText = taskMatch[0].trim();
              if (taskText.length > 5 && !taskText.includes('\u5f00\u59cb\u4f60\u7684\u7b2c\u4e00\u4e2a\u4efb\u52a1') && taskText !== skipText) {
                return {
                  text: taskText,
                  inProgress: fullText.includes('\u8fdb\u884c\u4e2d'),
                  isComplete: fullText.includes('\u4efb\u52a1\u5b8c\u6210'),
                  hasResponse: !fullText.includes('\u8fdb\u884c\u4e2d') && !fullText.includes('\u65b0\u4efb\u52a1') && taskText.length > 10
                };
              }
            }

            if (fullText === skipText) return null;
            if (fullText.includes('\u4efb\u52a1') && fullText.length > 20) {
              let isProcessing = fullText.includes('\u8fdb\u884c\u4e2d') || fullText.includes('\u751f\u6210\u4e2d');
              return {
                text: fullText.slice(0, 300),
                inProgress: isProcessing,
                isComplete: fullText.includes('\u4efb\u52a1\u5b8c\u6210'),
                hasResponse: !isProcessing && fullText.length > 20 && !fullText.includes('\u65b0\u4efb\u52a1')
              };
            }

            return null;
          })()
        `,
        returnByValue: true
      });
      return result.result?.value || null;
    }

    return null;
  }

  // ── Element finders ────────────────────────────────────────────────────

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

  /**
   * Find new chat button — tries SOLO selectors first, falls back to IDE selectors.
   */
  async findNewChatButton() {
    const soloBtn = await dom.findFirstMatching(this.client, this.config.newChatSelectors);
    if (soloBtn) return soloBtn;
    return dom.findFirstMatching(this.client, this.config.ideNewChatSelectors);
  }

  /**
   * Find mode tabs by selector; uses text matching to avoid false positives
   * from elements that match the selector but aren't mode tabs (e.g., editor tabs).
   */
  async findModeTabs() {
    const results = [];
    for (const selector of this.config.modeTabSelectors) {
      const nodeIds = await dom.querySelectorAll(this.client, selector);
      for (const nodeId of nodeIds) {
        const text = await dom.getInnerText(this.client, nodeId);
        const trimmed = (text || '').trim();
        // Skip elements that likely aren't mode tabs (no SOLO/IDE/编辑器 keyword)
        if (trimmed && results.every(r => r.nodeId !== nodeId)) {
          results.push({ nodeId, selector, text: trimmed });
        }
      }
    }
    return results;
  }

  // ── Message UX ─────────────────────────────────────────────────────────

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

    const inputResult = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var el = document.querySelector('.chat-input-v2-input-box-editable');
          var value = el ? (el.innerText || el.textContent || '').trim() : '';
          return { ok: value === ${safeJsValue(String(text).trim())}, text: value };
        })()
      `,
      returnByValue: true
    });
    const inputInfo = inputResult.result?.value || {};
    if (!inputInfo.ok) {
      throw new Error(`Failed to set composer text: ${inputInfo.text || 'unknown'}`);
    }
    await sleep(this.config.postActionDelayMs * 2);

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

  // ── Core polling ───────────────────────────────────────────────────────

  /**
   * Core polling method. Checks multiple response sources in priority order:
   * 1. Mode-specific response selectors (sidebar for SOLO, chat panel for IDE)
   * 2. Configured response selectors (generic fallback)
   * 3. Broad content area scan (heuristic-based)
   * 4. Body text diffing (last resort)
   */
  async _pollResponseState() {
    const skipText = this._lastTaskText;
    const safeSkipText = safeJsValue(skipText);
    const safeResponseSelectors = this.config.responseSelectors.map(s => safeJsValue(s));
    const safeActivitySelectors = this.config.activitySelectors.map(s => safeJsValue(s));
    const safeIdeResponseSelectors = this.config.ideResponseSelectors.map(s => safeJsValue(s));

    const modeInfo = await this.detectMode();
    const isIdeMode = modeInfo.mode === 'ide';

    // Mode-specific task source (sidebar for SOLO, chat panel for IDE)
    const taskSourceResult = await this._queryTaskSource(skipText);

    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var result = { taskComplete: false, taskText: '', taskInProgress: false, responseText: '' };

          ${isIdeMode ? `
          // IDE mode: try IDE response selectors first
          var ideSels = [${safeIdeResponseSelectors.join(', ')}];
          for (var i = 0; i < ideSels.length; i++) {
            var el = document.querySelector(ideSels[i]);
            if (el && el.textContent.trim() && el.textContent.trim().length > 10) {
              result.responseText = el.textContent.trim();
              break;
            }
          }
          ` : ''}

          // Layer 1: Try configured response selectors
          if (!result.responseText) {
            var selectors = [${safeResponseSelectors.join(', ')}];
            for (var i = 0; i < selectors.length; i++) {
              var el = document.querySelector(selectors[i]);
              if (el && el.textContent.trim()) {
                result.responseText = el.textContent.trim();
                break;
              }
            }
          }

          // Layer 2: Try activity selectors
          if (!result.responseText) {
            var actSels = [${safeActivitySelectors.join(', ')}];
            for (var j = 0; j < actSels.length; j++) {
              var actEl = document.querySelector(actSels[j]);
              if (actEl && actEl.textContent.trim()) {
                result.responseText = actEl.textContent.trim();
                break;
              }
            }
          }

          // Layer 3: Heuristic scan - find any large text-containing element
          if (!result.responseText) {
            var allElements = document.querySelectorAll('div, p, pre, code, article, section');
            var best = null;
            var bestScore = 0;
            for (var k = 0; k < allElements.length; k++) {
              var el = allElements[k];
              var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
              if (!rect) continue;
              if (rect.width < 10 || rect.height < 10) continue;
              if (document.querySelector('.soloaisidebar') && document.querySelector('.soloaisidebar').contains(el)) continue;
              var text = (el.textContent || '').trim();
              if (text.length < 30) continue;
              var score = text.length;
              if (rect.width > 300) score += 50;
              if (rect.y < 50) score -= 100;
              if (text.includes('function') || text.includes('import')) score += 100;
              if (text.indexOf('##') >= 0 || text.indexOf('*') >= 0) score += 30;
              if (text.indexOf('<') >= 0 && text.indexOf('>') >= 0) score += 200;
              if (score > bestScore) {
                bestScore = score;
                best = text;
              }
            }
            if (best && bestScore > 50) {
              result.responseText = best;
            }
          }

          // Layer 4: Full body text scan as last resort
          if (!result.responseText || result.responseText.length < 20) {
            var body = document.body;
            if (body) {
              var bodyText = (body.innerText || body.textContent || '').trim();
              var sidebar = document.querySelector('.soloaisidebar');
              if (sidebar) {
                var sidebarText = sidebar.innerText || sidebar.textContent || '';
                bodyText = bodyText.replace(sidebarText, '').trim();
              }
              if (bodyText.length > 50) {
                result.responseText = bodyText.slice(0, 5000);
              }
            }
          }

          return result;
        })()
      `,
      returnByValue: true
    });

    const state = result.result?.value || { taskComplete: false, taskText: '', taskInProgress: false, responseText: '' };

    // Merge mode-specific task source result
    if (taskSourceResult && taskSourceResult.text) {
      state.taskText = taskSourceResult.text;
      state.taskInProgress = taskSourceResult.inProgress;
      state.taskComplete = taskSourceResult.isComplete;
    }

    if (!state.responseText || state.responseText.length < 20) {
      const contentScan = await this._scanContentArea();
      if (contentScan && contentScan.areaFound && contentScan.text && contentScan.text.length > 20) {
        state.responseText = contentScan.text;
      }
    }

    if (!state.responseText || state.responseText.length < 10) {
      const bodyText = await this._captureVisibleText();
      if (bodyText && bodyText.length > 20) {
        state.responseText = bodyText;
      }
    }

    return state;
  }

  async checkForApprovalDialog() {
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `
          (function() {
            var indicators = [
              document.querySelector('[role="dialog"]'),
              document.querySelector('[role="alertdialog"]'),
              document.querySelector('.modal'),
              document.querySelector('.modal-overlay'),
              document.querySelector('[class*="dialog"]'),
              document.querySelector('button[aria-label*="\\u6279\\u51c6"]'),
              document.querySelector('button[aria-label*="Approve"]'),
              document.querySelector('button[aria-label*="\\u5141\\u8bb8"]'),
              document.querySelector('button[aria-label*="Allow"]'),
              document.querySelector('button[class*="approve"]'),
              document.querySelector('.ipc-overlay'),
              document.querySelector('.monaco-dialog'),
              document.querySelector('[aria-label*="\\u9700\\u8981\\u786e\\u8ba4"]')
            ];
            
            for (var i = 0; i < indicators.length; i++) {
              var el = indicators[i];
              if (el && el.offsetParent !== null && el.getBoundingClientRect().width > 0) {
                var titleEl = el.querySelector('[class*="title"]') || el.querySelector('[role="heading"]') || el;
                var buttons = el.querySelectorAll('button');
                var buttonTexts = [];
                buttons.forEach(function(b) { buttonTexts.push(b.textContent.trim()); });
                var fullText = (titleEl.textContent || '').trim().substring(0, 200);
                // Detect if this is a command execution approval dialog
                var cmdKeywords = ['执行', '运行', '命令', 'command'];
                var isCmdExec = false;
                for (var p = 0; p < cmdKeywords.length; p++) {
                  if (fullText.toLowerCase().includes(cmdKeywords[p].toLowerCase())) {
                    isCmdExec = true; break;
                  }
                }
                return {
                  found: true,
                  title: fullText,
                  buttons: buttonTexts.slice(0, 5),
                  type: el.className || 'modal',
                  isCommandExec: isCmdExec
                };
              }
            }
            
            var bodyText = document.body.textContent || '';
            var approvalPatterns = ['\\u9700\\u8981\\u60a8\\u6388\\u6743', '\\u9700\\u8981\\u60a8\\u7684\\u6279\\u51c6', '\\u662f\\u5426\\u5141\\u8bb8', 'Do you want to proceed', 'requires your confirmation'];
            for (var j = 0; j < approvalPatterns.length; j++) {
              if (bodyText.includes(approvalPatterns[j])) {
                return { found: true, title: approvalPatterns[j], buttons: [], type: 'text-pattern', isCommandExec: false };
              }
            }
            
            return { found: false };
          })()
        `,
        returnByValue: true
      });
      
      const dialog = result.result?.value;
      if (dialog && dialog.found) {
        return {
          needsApproval: true,
          question: dialog.title || 'Trae\\u9700\\u8981\\u60a8\\u786e\\u8ba4',
          dialogType: dialog.type || 'approval',
          buttons: dialog.buttons || [],
          isCommandExec: dialog.isCommandExec || false,
        };
      }
      return { needsApproval: false };
    } catch (e) {
      return { needsApproval: false, error: e.message };
    }
  }

  /**
   * Mode-aware response collection.
   * In SOLO mode: reads sidebar + heuristics (existing logic).
   * In IDE mode: reads chat panel messages + body text diff.
   */
  async collectResponse() {
    const dialog = await this.checkForApprovalDialog();
    if (dialog.needsApproval) {
      return { text: '', stable: false, elapsedMs: 0, needsApproval: true, question: dialog.question, dialogType: dialog.dialogType };
    }

    const modeInfo = await this.detectMode();
    const isIdeMode = modeInfo.mode === 'ide';

    const startTime = Date.now();
    const warmupMs = 3000;
    const requiredStable = 2;
    const pollInterval = this.config.pollIntervalMs || 350;
    const queuePollInterval = this.config.queuePollIntervalMs || 15000;
    const queueWaitTimeout = this.config.queueWaitTimeoutMs || 60000;
    let stableCount = 0;
    let warmingUp = true;
    let lastText = '';
    let initialText = null;
    let inQueueSince = null;
    let truncationSince = null;
    const truncationTimeout = 20000;
    let hasCheckedInitialSnapshot = false;

    let streamingBuffer = [];
    let streamingGrowthFrames = 0;
    const STREAMING_GROWTH_THRESHOLD = 3;

    try {
      await this.client.send('Log.enable', {});
      const logHandler = (params) => {
        if (params.entry && params.entry.type === 'log' && params.entry.text) {
          const text = params.entry.text.trim();
          if (text.length > 0 && text.length < 10000) {
            streamingBuffer.push(text);
          }
        }
      };
      this.client.on('Log.entryAdded', logHandler);

      const consoleHandler = (params) => {
        if (params.type === 'log' || params.type === 'debug') {
          const args = params.args || [];
          for (const arg of args) {
            if (arg.value && typeof arg.value === 'string') {
              const text = arg.value.trim();
              if (text.length > 0 && text.length < 10000) {
                streamingBuffer.push(text);
              }
            }
          }
        }
      };
      this.client.on('Runtime.consoleAPICalled', consoleHandler);

      await sleep(50);
    } catch (err) {
      // Log enable failed
    }

    const cleanup = () => {
      try {
        this.client.off('Log.entryAdded', () => {});
        this.client.off('Runtime.consoleAPICalled', () => {});
      } catch (_) {}
    };

    try {
      while (Date.now() - startTime < this.config.timeoutMs) {
        const state = await this._pollResponseState();
        // Periodic dialog check during streaming - detect dialogs that appear mid-execution
        const approvalCheckInterval = this.config.approvalPollIntervalMs || 3000;
        if (this._lastApprovalCheckAt === undefined || (Date.now() - this._lastApprovalCheckAt) >= approvalCheckInterval) {
          const approvalDialog = await this.checkForApprovalDialog();
          this._lastApprovalCheckAt = Date.now();
          if (approvalDialog.needsApproval) {
            // Auto-approve command execution dialogs (e.g., "\u6279\u51c6\u6267\u884c\u547d\u4ee4")
            // Questions (dialog without command keywords) still get forwarded to the caller.
            if (approvalDialog.isCommandExec) {
              this._approvalDialogFirstSeenAt = undefined;
              this._lastApprovalCheckAt = undefined;
              const approveResult = await this.approveDialog('trust');
              if (approveResult.success) {
                await sleep(500);
                continue;
              }
            }

            const approvalDuration = Date.now() - (this._approvalDialogFirstSeenAt || Date.now());
            if (this._approvalDialogFirstSeenAt === undefined) {
              this._approvalDialogFirstSeenAt = Date.now();
            }
            const approvalTimeoutMs = this.config.approvalTimeoutMs || 120000;
            if (approvalDuration >= approvalTimeoutMs) {
              this._approvalDialogFirstSeenAt = undefined;
              this._lastApprovalCheckAt = undefined;
              cleanup();
              return {
                text: currentText || '',
                stable: false,
                elapsedMs: Date.now() - startTime,
                needsApproval: true,
                question: approvalDialog.question,
                dialogType: approvalDialog.dialogType,
                approvalTimedOut: true
              };
            }
            this._approvalDialogFirstSeenAt = undefined;
            this._lastApprovalCheckAt = undefined;
            cleanup();
            return {
              text: currentText || '',
              stable: false,
              elapsedMs: Date.now() - startTime,
              needsApproval: true,
              question: approvalDialog.question,
              dialogType: approvalDialog.dialogType,
              buttons: approvalDialog.buttons
            };
          }
        }


        if (state.taskComplete || (state.taskText && !state.taskInProgress)) {
          const text = state.taskText || state.responseText;
          if (text) { cleanup(); return { text, stable: true, elapsedMs: Date.now() - startTime }; }
        }

        let currentText = sanitizeActivityText(state.responseText || '');

        if (!currentText || currentText.length < 5) {
          const contentScan = await this._scanContentArea();
          if (contentScan && contentScan.areaFound && contentScan.text) {
            currentText = sanitizeActivityText(contentScan.text);
          }
        }

        if (!currentText || currentText.length < 5 && isIdeMode) {
          // IDE mode fallback: try capturing the full chat panel text
          const panelText = await this._captureIdePanelText();
          if (panelText) {
            currentText = sanitizeActivityText(panelText);
          }
        }

        if (initialText === null && currentText) initialText = currentText;

        if (warmingUp) {
          if (currentText !== initialText) { lastText = currentText; stableCount = 0; }
          if (Date.now() - startTime >= warmupMs) { warmingUp = false; lastText = currentText; }
          await sleep(pollInterval);
          continue;
        }

        if (!hasCheckedInitialSnapshot && this._preSendSnapshot) {
          hasCheckedInitialSnapshot = true;
          if (currentText && this._preSendSnapshot.includes(currentText)) {
            currentText = '';
          }
        }

        var queuePosition = null;
        var queueMatch = currentText && currentText.match(/\u6392\u5728\u7b2c\s*(\d+)\s*\u4f4d/);
        if (queueMatch) queuePosition = parseInt(queueMatch[1], 10);

        const isQueued = currentText && (
          queuePosition !== null ||
          currentText.includes('\u6392\u961f') ||
          currentText.includes('\u7b49\u5f85') ||
          currentText.includes('\u961f\u5217') ||
          currentText.includes('\u7b49\u5f85\u4e2d')
        );

        if (isQueued) {
          if (!inQueueSince) inQueueSince = Date.now();
          // Wait indefinitely until queue clears - no timeout on queue
          // The point is to persist until the request goes through
          if (false && Date.now() - inQueueSince > queueWaitTimeout) {
            cleanup();
            return { text: currentText, stable: false, elapsedMs: Date.now() - startTime, queued: true, queuePosition: queuePosition, queueElapsedMs: Date.now() - inQueueSince, timedOut: true };
          }
          lastText = currentText; await sleep(queuePollInterval); continue;
        }

        inQueueSince = null;

        if (isTruncationSignal(currentText)) {
          if (!truncationSince) truncationSince = Date.now();
          if (Date.now() - truncationSince > truncationTimeout) {
            cleanup();
            return { text: currentText, stable: false, elapsedMs: Date.now() - startTime, truncated: true, timedOut: false };
          }
          lastText = currentText; await sleep(pollInterval); continue;
        }

        truncationSince = null;

        const endMarkerDetected = hasCompletionMarker(currentText);
        const effectiveRequiredStable = endMarkerDetected ? 1 : requiredStable;

        const isGrowing = currentText && lastText &&
          currentText.startsWith(lastText) &&
          currentText.length > lastText.length;

        if (isGrowing) {
          streamingGrowthFrames++;
          if (streamingGrowthFrames >= STREAMING_GROWTH_THRESHOLD && currentText.length >= 50) {
            cleanup();
            return {
              text: currentText,
              stable: false,
              streaming: true,
              elapsedMs: Date.now() - startTime
            };
          }
        } else {
          streamingGrowthFrames = 0;
        }

        const isStable = currentText && currentText === lastText && currentText.length >= 1;
        if (isStable) {
          stableCount++;
          if (stableCount >= effectiveRequiredStable) {
            cleanup();
            return { text: currentText, stable: true, elapsedMs: Date.now() - startTime };
          }
        } else {
          stableCount = 0;
        }
        lastText = currentText;
        await sleep(pollInterval);
      }

      const finalText = lastText || (streamingBuffer.length > 0 ? streamingBuffer.join(' ') : '');
      cleanup();
      return { text: finalText, stable: false, elapsedMs: Date.now() - startTime, timedOut: true };
    } catch (err) {
      cleanup();
      throw err;
    }
  }

  // ── Delegation ─────────────────────────────────────────────────────────


  /**
   * Approve / dismiss a detected dialog by clicking the matching button.
   * @param {string} action - 'trust' | 'allow' | 'confirm' | 'approve' | 'deny' | 'cancel' | 'dismiss'
   * @returns {Promise<{success: boolean, action: string, buttonClicked?: string, error?: string}>}
   */
  async approveDialog(action) {
    try {
      const dialog = await this.checkForApprovalDialog();
      if (!dialog.needsApproval) {
        return { success: false, action, error: 'No dialog found to approve' };
      }

      const targetLabels = this._getButtonLabelsForAction(action);

      const result = await this.client.send('Runtime.evaluate', {
        expression: `
          (function() {
            var targetLabels = ${JSON.stringify(targetLabels)};

            // Find all clickable elements in visible dialogs
            var dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, .modal-overlay, [class*="dialog"], [class*="overlay"], .monaco-dialog');
            var buttonsToSearch = [];

            if (dialogs.length > 0) {
              for (var d = 0; d < dialogs.length; d++) {
                if (dialogs[d].offsetParent === null) continue;
                var btns = dialogs[d].querySelectorAll('button, a[role="button"], [class*="button"], [class*="btn"]');
                for (var b = 0; b < btns.length; b++) {
                  buttonsToSearch.push(btns[b]);
                }
              }
            } else {
              // Fallback: search all buttons
              var allButtons = document.querySelectorAll('button, a[role="button"], [class*="button"], [class*="btn"]');
              for (var b = 0; b < allButtons.length; b++) {
                buttonsToSearch.push(allButtons[b]);
              }
            }

            // First pass: exact match
            for (var b = 0; b < buttonsToSearch.length; b++) {
              var btn = buttonsToSearch[b];
              if (btn.offsetParent === null) continue;
              var text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
              for (var t = 0; t < targetLabels.length; t++) {
                if (text === targetLabels[t].toLowerCase() || text.includes(targetLabels[t].toLowerCase())) {
                  var rect = btn.getBoundingClientRect();
                  btn.dispatchEvent(new PointerEvent('pointerdown', {
                    bubbles: true, cancelable: true, composed: true,
                    clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                    button: 0, buttons: 1, pointerType: 'mouse'
                  }));
                  btn.dispatchEvent(new PointerEvent('pointerup', {
                    bubbles: true, cancelable: true, composed: true,
                    clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                    button: 0, buttons: 1, pointerType: 'mouse'
                  }));
                  btn.dispatchEvent(new MouseEvent('click', {
                    bubbles: true, cancelable: true,
                    clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2
                  }));
                  btn.click();
                  return { clicked: true, buttonText: (btn.innerText || btn.textContent || '').trim() };
                }
              }
            }

            // Second pass: partial match
            for (var b = 0; b < buttonsToSearch.length; b++) {
              var btn = buttonsToSearch[b];
              if (btn.offsetParent === null) continue;
              var text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
              for (var t = 0; t < targetLabels.length; t++) {
                if (text.includes(targetLabels[t].toLowerCase()) || targetLabels[t].toLowerCase().includes(text)) {
                  var rect = btn.getBoundingClientRect();
                  btn.dispatchEvent(new PointerEvent('pointerdown', {
                    bubbles: true, cancelable: true, composed: true,
                    clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                    button: 0, buttons: 1, pointerType: 'mouse'
                  }));
                  btn.dispatchEvent(new PointerEvent('pointerup', {
                    bubbles: true, cancelable: true, composed: true,
                    clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                    button: 0, buttons: 1, pointerType: 'mouse'
                  }));
                  btn.dispatchEvent(new MouseEvent('click', {
                    bubbles: true, cancelable: true,
                    clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2
                  }));
                  btn.click();
                  return { clicked: true, buttonText: (btn.innerText || btn.textContent || '').trim() };
                }
              }
            }

            return { clicked: false, error: 'No matching button found', searchedLabels: targetLabels };
          })()
        `,
        returnByValue: true
      });

      const clickResult = result.result?.value || {};
      if (clickResult.clicked) {
        await sleep(this.config.postActionDelayMs);
        return {
          success: true,
          action,
          buttonClicked: clickResult.buttonText
        };
      }

      return {
        success: false,
        action,
        error: clickResult.error || 'Failed to click button',
        searchedLabels: clickResult.searchedLabels
      };
    } catch (e) {
      return { success: false, action, error: e.message };
    }
  }

  /**
   * Map an approve action to the list of button label patterns to search for.
   * Supports CN and EN labels.
   */
  _getButtonLabelsForAction(action) {
    switch (action) {
      case 'trust':
        return ['信任', 'Trust', '信任此文件夹', '信任文件夹', '打开'];
      case 'allow':
        return ['允许', 'Allow', '批准', 'Approve', '允许此操作'];
      case 'confirm':
        return ['确认', 'Confirm', '确定', 'OK', '确认执行', '运行'];
      case 'approve':
        return ['批准', 'Approve', '允许', 'Allow', '确认', 'Confirm', '信任', 'Trust'];
      case 'deny':
        return ['拒绝', 'Deny', '不允许', '禁止', '拒绝此操作'];
      case 'cancel':
        return ['取消', 'Cancel', '关闭', 'Close', 'Dismiss'];
      case 'dismiss':
        return ['取消', 'Cancel', '关闭', 'Close', 'Dismiss', '不'];
      default:
        return ['确认', 'Confirm', '允许', 'Allow', '批准', 'Approve', '信任', 'Trust', '确定', 'OK'];
    }
  }

  /**
   * Check for restricted mode and click the Trust button if found.
   * Returns the result of the operation.
   */
  async clickRestrictedModeTrust() {
    try {
      const restrictedCheck = await this.checkRestrictedMode();
      if (!restrictedCheck || !restrictedCheck.restricted) {
        return { success: false, reason: 'no_restricted_mode_found' };
      }

      if (restrictedCheck.trustButtonFound) {
        const approveResult = await this.approveDialog('trust');
        if (approveResult.success) {
          await sleep(this.config.postActionDelayMs * 2);
          return { success: true, action: 'trust_clicked', buttonText: approveResult.buttonText };
        }
      }

      return {
        success: false,
        reason: 'trust_button_not_found_or_click_failed',
        restrictedInfo: restrictedCheck,
        message: '受限模式已启用，请手动在Trae CN窗口中点击「信任」按钮'
      };
    } catch (e) {
      return { success: false, reason: 'error', error: e.message };
    }
  }

  async switchAgent(agentName) {
    const targetName = agentName.replace(/^@/, '').trim();

    // Open the agent selector popup
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

    // Wait for popup and click target agent
    const found = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var target = '${targetName}';
          var items = document.querySelectorAll('.agent-popup-item');
          for (var i = 0; i < items.length; i++) {
            var text = items[i].textContent.trim();
            // Match agent name (may have suffix like "SOLO Only")
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

  /**
   * Mode-aware delegation.
   * - Detects current UI mode.
   * - SOLO: uses sidebar (toggles sidebar visibility), tracks task via sidebar.
   * - IDE: no sidebar toggle needed, tracks task via chat panel.
   */
  async delegate(task, options = {}) {
    await this.newChat();
    this._invalidateModeCache();

    const modeInfo = await this.detectMode();
    const isIdeMode = modeInfo.mode === 'ide';

    if (!isIdeMode) {
      // SOLO mode: ensure sidebar is visible for task tracking
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

      // Capture sidebar baseline
      const beforeSidebar = await this._captureSidebarText();
      this._lastTaskText = beforeSidebar;
    } else {
      // Capture IDE chat panel baseline
      const beforePanel = await this._captureIdePanelText();
      this._lastTaskText = beforePanel;
    }

    // Switch agent if requested (e.g., "SOLO Coder", "Builder", "Chat")
    if (options.agent) {
      await this.switchAgent(options.agent);
    }

    // Mode-aware command prefix.
    // SOLO mode: uses /slash commands (e.g., /plan, /spec, /review)
    //            These are understood by the SOLO agent task system.
    // IDE mode:  Trae CN IDE chat has no native /slash commands;
    //            translate mode to a natural language directive instead.
    var effectiveTask = task;
    if (options.mode) {
      var modeRaw = options.mode.startsWith('/') ? options.mode.slice(1) : options.mode;
      if (isIdeMode) {
        // IDE mode: use natural language prelude instead of /slash
        var modeHints = {
          plan: '请先制定详细的实施方案和计划，然后逐步执行：',
          spec: '请编写详细的技术规格说明和设计方案：',
          review: '请审查以下内容，指出问题、风险和改进建议：',
          fix: '请修复以下问题，确保代码正确运行：',
          test: '请编写全面的单元测试覆盖以下功能：',
          explain: '请解释以下代码的工作原理和各部分作用：'
        };
        var hint = modeHints[modeRaw];
        effectiveTask = hint ? (hint + ' ' + task) : task;
      } else {
        // SOLO mode: keep native /slash command
        effectiveTask = '/' + modeRaw + ' ' + task;
      }
    }

    // Capture pre-send body text for diffing in collectResponse()
    const beforeBody = await this._captureBodyText();
    this._preSendSnapshot = beforeBody;

    const dialogBefore = await this.checkForApprovalDialog();
    if (dialogBefore.needsApproval) {
      return { text: '', stable: false, elapsedMs: 0, needsApproval: true, question: dialogBefore.question, dialogType: dialogBefore.dialogType };
    }

    await this.sendMessage(effectiveTask);
    const response = await this.collectResponse();

    if (response && response.text) {
      this._lastTaskText = response.text;
    }

    if (response.timedOut && !response.text) {
      throw TraeCNAutomationError.responseTimeout(this.config.timeoutMs);
    }

    return response;
  }

  async _waitForExpression(expression, timeoutMs = 5000, pollMs = 200) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = await this.client.send('Runtime.evaluate', {
        expression,
        returnByValue: true
      });
      if (result.result?.value) return true;
      await sleep(pollMs);
    }
    return false;
  }

  async newChat() {
    // Try keyboard shortcut first (works in both modes)
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'n', code: 'KeyN', modifiers: 6
    });
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'n', code: 'KeyN', modifiers: 6
    });

    // Clear pre-send snapshot on new chat
    this._preSendSnapshot = '';

    const safeComposerSels = safeJsValue(this.config.composerSelectors);
    const ready = await this._waitForExpression(
      `(function(){var s=${safeComposerSels};for(var i=0;i<s.length;i++){var e=document.querySelector(s[i]);if(e&&e.getBoundingClientRect().width>20&&e.offsetParent!==null)return true;}return false;})()`,
      4000, 200
    );
    if (!ready) await sleep(2000);
    return true;
  }

  /**
   * Mode-aware switchMode.
   * Finds mode tabs by text content (not hardcoded index), clicks the matching tab,
   * waits for UI to re-render, and verifies the switch.
   *
   * @param {'solo'|'ide'} mode - Target mode.
   * @returns {Promise<{success: boolean, previousMode?: string, currentMode?: string}>}
   */
  async switchMode(mode) {
    // Detect current mode first
    this._invalidateModeCache();
    const currentModeInfo = await this.detectMode();

    const modeLower = mode.toLowerCase();
    if (currentModeInfo.mode === modeLower) {
      return { success: true, previousMode: currentModeInfo.mode, currentMode: modeLower, alreadyInMode: true };
    }

    // Find mode tabs and match by text content
    const modeTabs = await this.findModeTabs();

    // Filter: only consider tabs that are actually mode switch tabs
    // by checking for known mode keywords
    const relevantTabs = modeTabs.filter(t => {
      const lower = t.text.toLowerCase();
      return lower.includes('solo') || lower.includes('ide') || lower.includes('编辑器');
    });

    // Find the target tab by text keyword
    const targetTextKeywords = modeLower === 'solo' ? ['solo', '编辑器'] : ['ide'];
    const target = relevantTabs.find(t => {
      const lower = t.text.toLowerCase();
      return targetTextKeywords.some(k => lower.includes(k));
    });

    if (!target) {
      // Fallback: look for the non-active tab (toggle logic)
      const activeTab = relevantTabs.find(t => {
        return currentModeInfo.indicators.some(i => i.includes(t.text.toLowerCase()));
      });
      const otherTab = relevantTabs.find(t => {
        if (!activeTab) return t.text.toLowerCase().includes(modeLower);
        return t.nodeId !== activeTab.nodeId;
      });

      if (otherTab) {
        await this.client.send('Runtime.evaluate', {
          expression: `
            (function() {
              var el = document.querySelector('[node-id="${otherTab.nodeId}"]');
              if (!el) {
                // Fallback: find by text content
                var items = document.querySelectorAll('.icube-mode-tab-item, [class*="icube-mode-tab-item"], [class*="mode-tab"]');
                for (var i = 0; i < items.length; i++) {
                  var t = items[i].textContent.trim().toLowerCase();
                  if (t.indexOf('${modeLower}') > -1) {
                    items[i].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    return 'clicked by text match';
                  }
                }
                return 'target tab not found';
              }
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              return 'clicked by node-id';
            })()
          `,
          returnByValue: true
        });
        await sleep(this.config.modeSwitchWaitMs);
      } else {
        return { success: false, previousMode: currentModeInfo.mode, error: 'Target mode tab not found' };
      }
    } else {
      // Click the target tab using its nodeId
      await this.client.send('DOM.focus', { nodeId: target.nodeId });
      await this.client.send('Runtime.evaluate', {
        expression: `
          (function() {
            var items = document.querySelectorAll('.icube-mode-tab-item');
            for (var i = 0; i < items.length; i++) {
              var t = items[i].textContent.trim().toLowerCase();
              if (t.indexOf('${modeLower}') > -1) {
                items[i].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                return 'clicked tab: ' + items[i].textContent.trim();
              }
            }
            return 'tab click attempted';
          })()
        `,
        returnByValue: true
      });
      await sleep(this.config.modeSwitchWaitMs);
    }

    // Wait for UI to re-render and verify the switch
    this._invalidateModeCache();
    const maxWait = this.config.modeSwitchWaitMs + 3000;
    const pollStart = Date.now();
    let switchedToMode = null;

    while (Date.now() - pollStart < maxWait) {
      const verifyInfo = await this.detectMode();
      if (verifyInfo.mode === modeLower) {
        switchedToMode = verifyInfo.mode;
        break;
      }
      await sleep(300);
    }

    if (switchedToMode === modeLower) {
      return { success: true, previousMode: currentModeInfo.mode, currentMode: modeLower };
    }

    return { success: true, previousMode: currentModeInfo.mode, currentMode: modeLower, verifyLimited: true };
  }

  // ── Model management ───────────────────────────────────────────────────

  static KNOWN_MODELS = [
    'Doubao-Seed-2.0-Code', 'Doubao-Seed-1.8', 'Doubao-Seed-Code',
    'MiniMax-M2.7', 'MiniMax-M2.5',
    'GLM-5.1', 'GLM-5V-Turbo', 'GLM-5',
    'DeepSeek-V4-Pro', 'DeepSeek-V4-Flash',
    'Kimi-K2.6', 'Kimi-K2.5',
    'Qwen3.6-Plus', 'Qwen3.5-Plus'
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
            const bodyText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
            const queueMatch = bodyText.match(/排在第\\s*(\\d+)\\s*位/);
            const queueNotice = bodyText.includes('排队提醒') || bodyText.includes('请求量较高') || bodyText.toLowerCase().includes('queue');
            if (queueMatch || queueNotice) {
              return {
                found: true,
                queued: true,
                position: queueMatch ? Number(queueMatch[1]) : null,
                message: queueMatch ? ('排在第 ' + queueMatch[1] + ' 位') : 'Queue notice is visible'
              };
            }

            const trigger = document.querySelector('.chat-model-label,[role="combobox"],[class*="model-select"],[class*="ai-model-select"]');
            if (!trigger) return { found: false, queued: false };
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
          message: info.message || 'Queue notice is visible'
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

  async getCurrentModel() {
    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var selectors = [
            '.chat-model-label',
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
              if (text && /Doubao|MiniMax|GLM|DeepSeek|Kimi|Qwen|Auto Mode/i.test(text)) {
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

  _normalizeModelName(name) {
    return String(name || '')
      .replace(/\s*Beta\s*/ig, '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .toLowerCase();
  }

  async switchModel(modelName) {
    const requestedModel = String(modelName || '').trim();
    const normalizedRequested = this._normalizeModelName(requestedModel);
    const beforeModel = await this.getCurrentModel();
    if (this._normalizeModelName(beforeModel) === normalizedRequested) {
      return {
        success: true,
        model: beforeModel,
        requestedModel,
        previousModel: beforeModel,
        alreadySelected: true,
        switchResult: 'already selected'
      };
    }

    const busyCheck = await this.client.send('Runtime.evaluate', {
      expression: `(() => {
        var body = document.body?.textContent || '';
        if (body.includes('AI \\u751f\\u6210\\u4e2d\\uff0c\\u65e0\\u6cd5\\u5207\\u6362')) {
          return { busy: true, reason: 'generating' };
        }
        var trigger = document.querySelector('.chat-model-label');
        if (trigger) {
          var triggerArea = trigger.closest('[class*=input]') || trigger.parentElement;
          if (triggerArea && triggerArea.textContent.includes('\\u751f\\u6210\\u4e2d')) {
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
      var itemsNow = await this.client.send('Runtime.evaluate', {
        expression: `
          (function() {
            var all = Array.from(document.querySelectorAll('.chat-modelPicker-item,.icube-model-select-portal-model-item,[role="option"],[class*="modelPicker"],[class*="model-picker"],[class*="model-item"],[class*="model"][class*="item"]'));
            return all.filter(function(el) {
              var text = (el.innerText || el.textContent || '').trim();
              return /Doubao|MiniMax|GLM|DeepSeek|Kimi|Qwen|Auto Mode/i.test(text);
            }).length;
          })()
        `,
        returnByValue: true
      });
      var count = itemsNow.result?.value || 0;
      if (count > 0) break;

      const clicked = await this.client.send('Runtime.evaluate', {
        expression: `
          (() => {
            var triggers = Array.from(document.querySelectorAll('.chat-model-label,[role="combobox"],[class*="model-select"],[class*="ai-model-select"]'));
            var trigger = triggers.find(function(el) {
              var text = (el.innerText || el.textContent || '').trim();
              var rect = el.getBoundingClientRect();
              return rect.width > 10 && rect.height > 10 && /Doubao|MiniMax|GLM|DeepSeek|Kimi|Qwen|Auto Mode/i.test(text);
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

      const triggerRect = await this.client.send('Runtime.evaluate', {
        expression: `
          (() => {
            var triggers = Array.from(document.querySelectorAll('.chat-model-label,[role="combobox"],[class*="model-select"],[class*="ai-model-select"]'));
            var trigger = triggers.find(function(el) {
              var text = (el.innerText || el.textContent || '').trim();
              var rect = el.getBoundingClientRect();
              return rect.width > 10 && rect.height > 10 && /Doubao|MiniMax|GLM|DeepSeek|Kimi|Qwen|Auto Mode/i.test(text);
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
        await this.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
        await this.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      }

      await this._waitForExpression(
        '(function(){return Array.from(document.querySelectorAll(".chat-modelPicker-item,.icube-model-select-portal-model-item,[role=option],[class*=modelPicker],[class*=model-picker],[class*=model-item],[class*=model][class*=item]")).some(function(el){return /Doubao|MiniMax|GLM|DeepSeek|Kimi|Qwen|Auto Mode/i.test(el.innerText || el.textContent || "");});})()',
        5000, 150
      );
    }

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

    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var targetName = ${safeJsValue(requestedModel)};
          var normalizedTarget = targetName.replace(/\\s*Beta\\s*/ig, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

          function normalize(value) {
            return String(value || '').replace(/\\s*Beta\\s*/ig, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
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
              return item.text && /Doubao|MiniMax|GLM|DeepSeek|Kimi|Qwen|Auto Mode/i.test(item.text);
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

    await sleep(this.config.postActionDelayMs);
    const switchResult = result.result?.value || 'unknown';
    let currentModel = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(150);
      currentModel = await this.getCurrentModel();
      if (this._normalizeModelName(currentModel) === normalizedRequested) {
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


  async checkReadiness() {
    const composer = await this.findComposer();
    const sendBtn = await this.findSendButton();
    const response = await this.findResponseRegion();

    // Include mode info
    let modeInfo = null;
    try {
      modeInfo = await this.detectMode();
    } catch(e) {
      modeInfo = { mode: 'unknown', confidence: 0, indicators: [] };
    }

    return {
      ready: !!(composer && sendBtn),
      composer: composer ? { matchedSelector: composer.matchedSelector } : null,
      sendButton: sendBtn ? { matchedSelector: sendBtn.matchedSelector } : null,
      responseRegion: response ? { matchedSelector: response.matchedSelector } : null,
      mode: modeInfo
    };
  }

  async checkRestrictedMode() {
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `
          (() => {
            const body = document.body ? document.body.textContent : '';

            const cnKeywords = ['\\u53d7\\u9650\\u6a21\\u5f0f', '\\u4fe1\\u4efb\\u6b64\\u6587\\u4ef6\\u5939', '\\u4fe1\\u4efb\\u6587\\u4ef6\\u5939', '\\u5b89\\u5168\\u6a21\\u5f0f', '\\u70b9\\u51fb\\u300c\\u4fe1\\u4efb\\u300d', '\\u70b9\\u51fb\\u4fe1\\u4efb'];
            const hasCnKeyword = cnKeywords.some(k => body.includes(k));

            const enKeywords = ['restricted mode', 'trust this folder', 'trust folder', 'click trust'];
            const hasEnKeyword = enKeywords.some(k => body.toLowerCase().includes(k));

            if (hasCnKeyword || hasEnKeyword) {
              let trustButtonFound = false;
              let manageButtonFound = false;
              let trustButtonText = '';

              const allButtons = document.querySelectorAll('button, a[role="button"], [class*="button"], [class*="btn"]');
              for (const btn of allButtons) {
                const t = btn.textContent.trim();
                const lower = t.toLowerCase();
                if (lower.includes('\\u4fe1\\u4efb') || lower.includes('trust') || lower.includes('\\u6253\\u5f00')) {
                  trustButtonFound = true;
                  trustButtonText = t;
                }
                if (lower.includes('\\u7ba1\\u7406') || lower.includes('manage')) {
                  manageButtonFound = true;
                }
              }

              const modals = document.querySelectorAll('[class*="modal"], [class*="dialog"], [class*="overlay"], [class*="mask"]');
              const hasOverlay = Array.from(modals).some(m => {
                const rect = m.getBoundingClientRect();
                return rect.width > 100 && rect.height > 50;
              });

              const titleMatch = body.match(/\\u53d7\\u9650\\u6a21\\u5f0f[^\\u3002\\n]*/);
              const title = titleMatch ? titleMatch[0].trim() : (hasCnKeyword ? '\\u53d7\\u9650\\u6a21\\u5f0f' : 'Restricted Mode');

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
