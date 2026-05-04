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

          var items = Array.from(sidebar.querySelectorAll('div')).filter(function(el) {
            var text = el.textContent.trim();
            var w = el.getBoundingClientRect().width;
            var h = el.getBoundingClientRect().height;
            return w > 100 && w < 350 && h > 30 && h < 120 && text.length > 5 && !text.includes('\u65b0\u4efb\u52a1');
          });
          if (items.length > 0) {
            var latest = items[items.length - 1];
            var text = latest.textContent.trim();
            if (text === ${safeSkipText}) return null;
            return {
              text: text,
              inProgress: text.includes('\u8fdb\u884c\u4e2d'),
              isComplete: text.includes('\u4efb\u52a1\u5b8c\u6210'),
              hasResponse: text.length > 15 && !text.includes('\u8fdb\u884c\u4e2d') && !text.includes('\u65b0\u4efb\u52a1')
            };
          }

          return null;
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
    const escapedText = escapeJsString(text);

    await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var el = document.querySelector('.chat-input-v2-input-box-editable');
          if (!el) return 'no composer';
          el.focus();
          document.execCommand('selectAll');
          document.execCommand('delete');
          document.execCommand('insertText', false, '${escapedText}');
          el.dispatchEvent(new InputEvent('input', {bubbles: true, cancelable: true, composed: true}));
          return 'inserted: ' + el.textContent.trim();
        })()
      `,
      returnByValue: true
    });
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
                return {
                  found: true,
                  title: titleEl.textContent ? titleEl.textContent.trim().substring(0, 200) : 'Approval Required',
                  buttons: buttonTexts.slice(0, 5),
                  type: el.className || 'modal'
                };
              }
            }
            
            var bodyText = document.body.textContent || '';
            var approvalPatterns = ['\\u9700\\u8981\\u60a8\\u6388\\u6743', '\\u9700\\u8981\\u60a8\\u7684\\u6279\\u51c6', '\\u662f\\u5426\\u5141\\u8bb8', 'Do you want to proceed', 'requires your confirmation'];
            for (var j = 0; j < approvalPatterns.length; j++) {
              if (bodyText.includes(approvalPatterns[j])) {
                return { found: true, title: approvalPatterns[j], buttons: [], type: 'text-pattern' };
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
          buttons: dialog.buttons || []
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
    const queueWaitTimeout = this.config.queueWaitTimeoutMs || 600000;
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

        const isQueued = currentText && (
          currentText.includes('\u6392\u961f') ||
          currentText.includes('\u7b49\u5f85') ||
          currentText.includes('\u961f\u5217') ||
          currentText.includes('\u7b49\u5f85\u4e2d')
        );

        if (isQueued) {
          if (!inQueueSince) inQueueSince = Date.now();
          if (Date.now() - inQueueSince > queueWaitTimeout) {
            cleanup();
            return { text: currentText, stable: false, elapsedMs: Date.now() - startTime, queued: true, queueElapsedMs: Date.now() - inQueueSince, timedOut: true };
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

      // Clear SOLO response elements
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

      // Capture sidebar baseline
      const beforeSidebar = await this._captureSidebarText();
      this._lastTaskText = beforeSidebar;
    } else {
      // IDE mode: no sidebar toggle needed.
      // Clear IDE chat panel response elements
      const ideSels = this.config.ideResponseSelectors.map(s => escapeJsString(s));
      if (ideSels.length > 0) {
        await this.client.send('Runtime.evaluate', {
          expression: `
            (function() {
              var sels = [${ideSels.map(s => "'" + s + "'").join(', ')}];
              for (var i = 0; i < sels.length; i++) {
                var els = document.querySelectorAll(sels[i]);
                for (var j = 0; j < els.length; j++) {
                  els[j].textContent = '';
                }
              }
              return 'cleared ' + ideSels.length + ' selectors';
            })()
          `,
          returnByValue: true
        });
        await sleep(200);
      }

      // Capture IDE chat panel baseline
      const beforePanel = await this._captureIdePanelText();
      this._lastTaskText = beforePanel;
    }

    // Capture pre-send body text for diffing in collectResponse()
    const beforeBody = await this._captureBodyText();
    this._preSendSnapshot = beforeBody;

    const dialogBefore = await this.checkForApprovalDialog();
    if (dialogBefore.needsApproval) {
      return { text: '', stable: false, elapsedMs: 0, needsApproval: true, question: dialogBefore.question, dialogType: dialogBefore.dialogType };
    }

    await this.sendMessage(task);
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
    const safeModelTrigger = safeJsValue(MODEL_TRIGGER);

    const busyCheck = await this.client.send('Runtime.evaluate', {
      expression: `(() => {
        var body = document.body?.textContent || '';
        if (body.includes('AI \\u751f\\u6210\\u4e2d\\uff0c\\u65e0\\u6cd5\\u5207\\u6362')) {
          return { busy: true, reason: 'generating' };
        }
        var trigger = document.querySelector('.icd-model-select-trigger');
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
      return 'model_switch_blocked: ' + busyInfo.reason;
    }

    const portalState = await this.client.send('Runtime.evaluate', {
      expression: `(() => {
        var items = document.querySelectorAll('.icube-model-select-portal-model-item');
        return { itemsFound: items.length, portalOpen: items.length > 0 };
      })()`,
      returnByValue: true
    });
    const ps = portalState.result?.value || { itemsFound: 0, portalOpen: false };

    if (!ps.portalOpen) {
      await this.client.send('Runtime.evaluate', {
        expression: `
          (() => {
            var trigger = document.querySelector(${safeModelTrigger});
            if (!trigger) return 'no trigger found';
            var rect = trigger.getBoundingClientRect();
            trigger.dispatchEvent(new PointerEvent('pointerdown', {
              bubbles: true, cancelable: true, composed: true,
              clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2,
              button: 0, buttons: 1, pointerType: 'mouse'
            });
            trigger.click();
            return 'portal opened via pointerdown+click';
          })()
        `,
        returnByValue: true
      });
      await this._waitForExpression(
        'document.querySelectorAll(".icube-model-select-portal-model-item").length>0',
        3000, 150
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
              toggleEl.dispatchEvent(new PointerEvent('pointerdown', {
                bubbles: true, cancelable: true, composed: true,
                clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2,
                button: 0, buttons: 1, pointerType: 'mouse'
              });
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

    const CLICK_WITH_POINTERDOWN = `(function(el) {
      var rect = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, composed: true,
        clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2,
        button: 0, buttons: 1, pointerType: 'mouse'
      }));
      el.click();
    })`;

    const escaped = escapeJsString(modelName);
    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var targetName = '${escaped}';

          var pollStarted = Date.now();
          var items = null;
          while (Date.now() - pollStarted < 3000) {
            items = document.querySelectorAll('.icube-model-select-portal-model-item');
            if (items && items.length > 0) break;
          }
          items = document.querySelectorAll('.icube-model-select-portal-model-item');
          if (!items || !items.length) return 'no model items found';

          var clickEl = ${CLICK_WITH_POINTERDOWN};

          for (var i = 0; i < items.length; i++) {
            var nameEl = items[i].querySelector('.icube-model-select-portal-model-item-inner-wrapper');
            var name = nameEl ? nameEl.textContent.replace(/\\s+/g, ' ').trim() : '';
            if (name === targetName || name === targetName + 'Beta' || name.startsWith(targetName + ' ') || name.startsWith(targetName + 'Beta') || name === targetName.replace(/Beta\\s*/i, '') + 'Beta') {
              clickEl(items[i]);
              return 'clicked: ' + name + ' at index ' + i;
            }
          }

          var normalizedTarget = targetName.replace(/\\s*Beta\\s*/i, '').trim();
          for (var i = 0; i < items.length; i++) {
            var nameEl = items[i].querySelector('.icube-model-select-portal-model-item-inner-wrapper');
            var name = nameEl ? nameEl.textContent.replace(/\\s+/g, ' ').trim().replace(/\\s*Beta\\s*/i, '').trim() : '';
            if (name === normalizedTarget) {
              clickEl(items[i]);
              return 'clicked (normalized): ' + items[i].querySelector('.icube-model-select-portal-model-item-inner-wrapper').textContent.trim() + ' at index ' + i;
            }
          }

          for (var i = 0; i < items.length; i++) {
            var nameEl = items[i].querySelector('.icube-model-select-portal-model-item-inner-wrapper');
            var name = nameEl ? nameEl.textContent.replace(/\\s+/g, ' ').trim() : '';
            var cleanName = name.replace(/Beta/i, '').trim();
            if (cleanName === targetName || cleanName === targetName.replace(/Beta\\s*/i, '').trim()) {
              clickEl(items[i]);
              return 'clicked (partial): ' + name + ' at index ' + i;
            }
          }

          for (var i = 0; i < items.length; i++) {
            var nameEl = items[i].querySelector('.icube-model-select-portal-model-item-inner-wrapper');
            var name = nameEl ? nameEl.textContent.replace(/\\s+/g, ' ').trim() : '';
            name = name.replace(/Beta/i, '').trim();
            var cleanTarget = targetName.replace(/Beta/i, '').trim();
            if (cleanTarget.startsWith(name) || name.startsWith(cleanTarget)) {
              clickEl(items[i]);
              return 'clicked (substring): ' + name + ' at index ' + i;
            }
          }

          for (var i = 0; i < items.length; i++) {
            var nameEl = items[i].querySelector('.icube-model-select-portal-model-item-inner-wrapper');
            var name = nameEl ? nameEl.textContent.replace(/\\s+/g, ' ').trim() : '';
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
