'use strict';

const http = require('http');
const { TraeCNAutomationError } = require('./errors');
const { CDPClient } = require('./client');
const dom = require('./browser-dom');
const { SettingsDriver } = require('./settings-driver');
const { CommandPaletteDriver } = require('./command-palette-driver');
const { EditorDriver } = require('./editor-driver');
const { FileDriver } = require('./file-driver');
const { TerminalDriver } = require('./terminal-driver');
const { GitDriver } = require('./git-driver');
const { SearchDriver } = require('./search-driver');
const { DiagnosticsDriver } = require('./diagnostics-driver');
const { SnapshotDriver } = require('./snapshot-driver');
const { ExtensionDriver } = require('./extension-driver');
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

function cleanAssistantResultText(text) {
  let value = String(text || '').trim();
  if (!value) return '';
  return value
    .replace(/^(Agent|Assistant)\s*(Thought|思考过程)\s*/i, '')
    .replace(/^(Agent|Assistant)\s+/i, '')
    .replace(/\s*(任务完成|Task completed)\s*$/i, '')
    .trim();
}

const DIALOG_BUTTON_SELECTOR = [
  'button',
  'a[role="button"]',
  '[role="button"].monaco-button',
  '.monaco-button',
  '.monaco-text-button',
  '[role="button"]'
].join(', ');

class DomDriver {
  constructor(client, config) {
    this.client = client;
    this.config = config || getConfig();
    this._lastTaskText = '';
    this._pendingUserTask = '';
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

  /**
   * Inject `window.__enhancedClick` into the page so that repeated inline
   * click-dispatcher code can be replaced with a single function call.
   * The helper searches for the first matching clickable element by text
   * and dispatches PointerEvent → MouseEvent → el.click().
   *
   * @param {string} targetText  - exact text to match against element content
   * @param {boolean} [normalizeText=false] - collapse whitespace before comparing
   * @returns {{ clicked: boolean, text: string }}
   */
  async _ensureClickHelper() {
    await this.client.send('Runtime.evaluate', {
      expression: `(function() {
        if (window.__enhancedClick) return;
        var normalize = function(text) {
          return String(text || '').trim();
        };
        window.__enhancedClick = function(targetText, normalizeText) {
          var candidates = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'));
          if (normalizeText) {
            normalize = function(text) {
              return String(text || '').replace(/\\s+/g, ' ').trim();
            };
          }
          for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            var text = normalize(el.innerText || el.textContent || '');
            if (text !== targetText) continue;
            var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
            var clickable = el.tagName === 'BUTTON' ||
              el.tagName === 'A' ||
              el.getAttribute('role') === 'button' ||
              (style && style.cursor === 'pointer');
            if (!clickable || el.disabled) continue;
            var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            if (!rect || rect.width < 12 || rect.height < 12) continue;
            var cx = rect.x + rect.width / 2;
            var cy = rect.y + rect.height / 2;
            el.dispatchEvent(new PointerEvent('pointerdown', {
              bubbles: true, cancelable: true, composed: true,
              clientX: cx, clientY: cy, button: 0, buttons: 1, pointerType: 'mouse'
            }));
            el.dispatchEvent(new PointerEvent('pointerup', {
              bubbles: true, cancelable: true, composed: true,
              clientX: cx, clientY: cy, button: 0, buttons: 1, pointerType: 'mouse'
            }));
            el.dispatchEvent(new MouseEvent('click', {
              bubbles: true, cancelable: true, clientX: cx, clientY: cy
            }));
            if (typeof el.click === 'function') el.click();
            return { clicked: true, text: text };
          }
          return { clicked: false, text: targetText };
        };
      })()`,
      returnByValue: true
    });
  }

  async inspectSetupWizard() {
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `
          (() => {
            const url = String(location.href || '');
            const bodyText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
            const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'))
              .map((el, index) => {
                const text = (el.innerText || el.textContent || '').trim();
                const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
                const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
                const clickable = el.tagName === 'BUTTON' ||
                  el.tagName === 'A' ||
                  el.getAttribute('role') === 'button' ||
                  (style && style.cursor === 'pointer');
                return {
                  index,
                  text,
                  disabled: !!el.disabled,
                  visible: !!(el.offsetParent !== null && rect.width >= 12 && rect.height >= 12),
                  className: typeof el.className === 'string' ? el.className : '',
                  clickable
                };
              })
              .filter(item => (item.text || item.visible) && item.clickable);
            const isSetup = url.includes('/setup/setup.html');
            return {
              isSetup,
              url,
              text: bodyText.trim(),
              buttons
            };
          })()
        `,
        returnByValue: true
      });
      return result.result?.value || { isSetup: false, url: '', text: '', buttons: [] };
    } catch (err) {
      return { isSetup: false, error: err.message, url: '', text: '', buttons: [] };
    }
  }

  async completeSetupIfPresent(options = {}) {
    const maxSteps = Number.isFinite(options.maxSteps) ? options.maxSteps : 5;
    const delayMs = Number.isFinite(options.delayMs)
      ? options.delayMs
      : Math.max(this.config.postActionDelayMs * 2, 500);
    const preferredLabels = ['跳过', '开始', '下一步', '继续', '开始使用', '完成', '进入工作台'];
    let advanced = 0;

    await this._ensureClickHelper();

    for (let step = 0; step < maxSteps; step++) {
      const snapshot = await this.inspectSetupWizard();
      if (!snapshot.isSetup) {
        this._invalidateModeCache();
        return {
          success: advanced > 0,
          completed: advanced > 0,
          steps: advanced,
          finalUrl: snapshot.url || ''
        };
      }

      const actionable = (snapshot.buttons || []).find((button) =>
        button.visible && !button.disabled && preferredLabels.includes(button.text)
      ) || null;

      if (!actionable) {
        return {
          success: false,
          completed: false,
          steps: advanced,
          reason: 'no_actionable_setup_button',
          snapshot
        };
      }

      const clickResult = await this.client.send('Runtime.evaluate', {
        expression: `window.__enhancedClick(${safeJsValue(actionable.text)})`,
        returnByValue: true
      });

      if (!clickResult.result?.value?.clicked) {
        return {
          success: false,
          completed: false,
          steps: advanced,
          reason: 'setup_click_failed',
          target: actionable.text
        };
      }

      advanced += 1;
      await sleep(delayMs);
    }

    const finalSnapshot = await this.inspectSetupWizard();
    if (!finalSnapshot.isSetup) {
      this._invalidateModeCache();
      return {
        success: advanced > 0,
        completed: true,
        steps: advanced,
        finalUrl: finalSnapshot.url || ''
      };
    }

    return {
      success: advanced > 0,
      completed: false,
      steps: advanced,
      reason: 'setup_max_steps_reached',
      snapshot: finalSnapshot
    };
  }

  async inspectWorkspaceBlockers() {
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `
          (() => {
            const normalize = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
            const controls = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'))
              .map((el) => {
                const text = normalize(el.innerText || el.textContent || '');
                if (!text) return null;
                const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0, x: 0, y: 0 };
                const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
                const visible = !!(el.offsetParent !== null && rect.width >= 12 && rect.height >= 12);
                if (!visible) return null;
                const clickable = el.tagName === 'BUTTON' ||
                  el.tagName === 'A' ||
                  el.getAttribute('role') === 'button' ||
                  (style && style.cursor === 'pointer');
                if (!clickable) return null;
                return {
                  text,
                  className: typeof el.className === 'string' ? el.className : '',
                  x: rect.x + rect.width / 2,
                  y: rect.y + rect.height / 2
                };
              })
              .filter(Boolean);

            const bodyText = normalize(document.body ? (document.body.innerText || document.body.textContent || '') : '');
            const titleEls = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"], .monaco-dialog-title, [class*="title"], [class*="header"]'))
              .map((el) => normalize(el.innerText || el.textContent || ''))
              .filter(Boolean);
            const guideButtons = controls.filter((item) => /^(继续|下一步|开始使用|完成|知道了|跳过|关闭|稍后)$/i.test(item.text));
            const loginButton = controls.find((item) => /^(登录|登入|log in|login|sign in)$/i.test(item.text)) || null;
            const newTaskButton = controls.find((item) => /^(新建会话|新任务|new task|new chat)$/i.test(item.text)) || null;
            const guideVisible = guideButtons.length > 0 && (
              /solo beta|欢迎使用|快速开始|快捷键|选择主题|继续|开始使用|添加命令行|command line/i.test(bodyText) ||
              titleEls.some((text) => /solo beta|欢迎使用|快速开始|快捷键|选择主题/i.test(text))
            );

            return {
              bodyText,
              titles: titleEls.slice(0, 8),
              guideVisible,
              guideButtons: guideButtons.slice(0, 10),
              loginVisible: !!loginButton,
              loginButton,
              newTaskVisible: !!newTaskButton,
              newTaskButton,
              visibleControls: controls.slice(0, 30)
            };
          })()
        `,
        returnByValue: true
      });
      return result.result?.value || {
        bodyText: '',
        titles: [],
        guideVisible: false,
        guideButtons: [],
        loginVisible: false,
        loginButton: null,
        newTaskVisible: false,
        newTaskButton: null,
        visibleControls: []
      };
    } catch (err) {
      return {
        bodyText: '',
        titles: [],
        guideVisible: false,
        guideButtons: [],
        loginVisible: false,
        loginButton: null,
        newTaskVisible: false,
        newTaskButton: null,
        visibleControls: [],
        error: err.message
      };
    }
  }

  async dismissWorkspaceGuideIfPresent(options = {}) {
    const maxSteps = Number.isFinite(options.maxSteps) ? options.maxSteps : 4;
    const delayMs = Number.isFinite(options.delayMs)
      ? options.delayMs
      : Math.max(this.config.postActionDelayMs, 300);
    const preferredLabels = ['继续', '下一步', '开始使用', '完成', '知道了', '跳过', '关闭', '稍后'];
    let dismissed = 0;

    await this._ensureClickHelper();

    for (let step = 0; step < maxSteps; step++) {
      const blockers = await this.inspectWorkspaceBlockers();
      if (!blockers.guideVisible) {
        return {
          success: dismissed > 0,
          dismissed,
          guideVisible: false,
          blockers
        };
      }

      const target = (blockers.guideButtons || []).find((button) => preferredLabels.includes(button.text));
      if (!target) {
        return {
          success: false,
          dismissed,
          guideVisible: true,
          reason: 'no_actionable_workspace_guide_button',
          blockers
        };
      }

      const clickResult = await this.client.send('Runtime.evaluate', {
        expression: `window.__enhancedClick(${safeJsValue(target.text)}, true)`,
        returnByValue: true
      });

      if (!clickResult.result?.value?.clicked) {
        return {
          success: false,
          dismissed,
          guideVisible: true,
          reason: 'workspace_guide_click_failed',
          target: target.text
        };
      }

      dismissed += 1;
      await sleep(delayMs);
    }

    const blockers = await this.inspectWorkspaceBlockers();
    return {
      success: dismissed > 0 && !blockers.guideVisible,
      dismissed,
      guideVisible: blockers.guideVisible,
      reason: blockers.guideVisible ? 'workspace_guide_max_steps_reached' : null,
      blockers
    };
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
            var isInProgress = fullText.includes('\u8fdb\u884c\u4e2d') ||
              fullText.includes('\u601d\u8003\u4e2d') ||
              !!item.querySelector('.icd-loading, .agent-loading-dot, [class*="loading"]');

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

          var fullText = (panel.textContent || '').trim();
          var turns = Array.from(panel.querySelectorAll(
            'section.chat-turn, section[class*="chat-turn"], .chat-message, .agent-message, [class*="chat-message"]'
          )).filter(function(el) {
            return el && el.offsetParent !== null;
          }).map(function(el) {
            return {
              className: (el.className || '').toString(),
              ariaLabel: (el.getAttribute('aria-label') || '').toString(),
              text: ((el.innerText || el.textContent || '').trim() || '')
            };
          }).filter(function(turn) {
            return !!turn.text;
          });

          return {
            fullText: fullText,
            turns: turns
          };
        })()
      `,
      returnByValue: true
    });

    return this._extractLatestIdeAssistantState(result.result?.value, skipText);
  }

  _extractLatestIdeAssistantState(panelState, skipText) {
    if (!panelState) return null;

    const turns = Array.isArray(panelState.turns) ? panelState.turns : [];
    const fullText = String(panelState.fullText || '').trim();
    const normalizedSkip = String(skipText || '').replace(/\s+/g, ' ').trim();
    if (!turns.length) {
      if (!fullText || (normalizedSkip && fullText.replace(/\s+/g, ' ').trim() === normalizedSkip)) {
        return null;
      }
      return {
        text: fullText.slice(0, 500),
        inProgress: false,
        isComplete: fullText.includes('任务完成') || fullText.includes('已完成'),
        hasResponse: fullText.length > 20
      };
    }

    const normalizedTurns = turns
      .map(turn => ({
        className: String(turn.className || ''),
        ariaLabel: String(turn.ariaLabel || ''),
        text: String(turn.text || '').trim()
      }))
      .filter(turn => turn.text);

    let lastUserIdx = -1;
    for (let i = 0; i < normalizedTurns.length; i++) {
      const cls = normalizedTurns[i].className.toLowerCase();
      if (cls.includes('user')) lastUserIdx = i;
    }

    const assistantTurns = normalizedTurns.filter((turn, index) => {
      const cls = turn.className.toLowerCase();
      const aria = turn.ariaLabel.toLowerCase();
      let isAssistant = cls.includes('assistant') || cls.includes('agent') || aria.includes('assistant') || aria.includes('agent');
      if (!isAssistant && cls.includes('chat-turn')) {
        isAssistant = !cls.includes('user');
      }
      return isAssistant && index > lastUserIdx;
    });

    if (!assistantTurns.length && lastUserIdx >= 0) {
      return {
        text: '',
        inProgress: true,
        isComplete: false,
        hasResponse: false,
        awaitingAssistant: true,
        latestUserText: normalizedTurns[lastUserIdx].text
      };
    }

    const latestAssistant = assistantTurns.length ? assistantTurns[assistantTurns.length - 1] : normalizedTurns[normalizedTurns.length - 1];
    const latestText = String(latestAssistant?.text || '').trim();
    const normalizedLatest = latestText.replace(/\s+/g, ' ').trim();
    if (!latestText || (normalizedSkip && normalizedLatest === normalizedSkip)) {
      return null;
    }

    const latestLower = normalizedLatest.toLowerCase();
    const inProgress = (
      fullText.includes('进行中') ||
      fullText.includes('正在思考') ||
      fullText.includes('正在分析') ||
      latestText.includes('正在分析') ||
      latestText.includes('等待中') ||
      latestText.includes('排队') ||
      latestText.includes('思考过程') ||
      latestText.includes('...') ||
      latestText.includes('…') ||
      latestLower.includes('analy') ||
      latestLower.includes('processing') ||
      latestLower.includes('waiting') ||
      latestLower.includes('queue')
    );
    const isComplete = (
      latestText.includes('任务完成') ||
      latestText.includes('已完成') ||
      fullText.includes('任务完成')
    );

    return {
      text: latestText,
      inProgress,
      isComplete: isComplete || (latestText.includes('完成') && !inProgress),
      hasResponse: !inProgress && latestText.length > 20
    };
  }

  _isIncompleteResponseText(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return true;
    if (/^(agent|assistant|thought|思考过程)$/i.test(normalized)) return true;
    const lower = normalized.toLowerCase();
    if (/^solo\s*agent\s*思考中/i.test(normalized)) return true;
    const startupSignals = [
      "i'll start",
      'i will start',
      'start by',
      'invoking the relevant',
      'explore the project',
      '调用技能',
      '开始审查',
      '开始分析',
      '正在审查',
      '正在分析',
      '思考中',
      'solo agent思考中',
      'the user explicitly'
    ];
    const hasStartupSignal = startupSignals.some(signal => lower.includes(signal.toLowerCase()));
    const hasFindingSignal = /(^|\n)\s*(findings|finding|问题|风险|建议|结论|summary|审查结果|发现)[:：]/i.test(normalized)
      || /(^|\n)\s*[-*]?\s*\[?p[0-3]\]?/i.test(normalized);
    if (hasStartupSignal && !hasFindingSignal) return true;
    return false;
  }

  _isModelErrorResponseText(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return false;
    return [
      '模型请求失败',
      '异常打断',
      'model request failed',
      'model service error',
      '服务商错误',
      '展开模型服务商错误信息'
    ].some(signal => normalized.toLowerCase().includes(signal.toLowerCase()));
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
                  inProgress: fullText.includes('\u8fdb\u884c\u4e2d') || fullText.includes('\u601d\u8003\u4e2d') || !!sidebar.querySelector('.icd-loading, .agent-loading-dot, [class*="loading"]'),
                  isComplete: fullText.includes('\u4efb\u52a1\u5b8c\u6210'),
                  hasResponse: !fullText.includes('\u8fdb\u884c\u4e2d') && !fullText.includes('\u65b0\u4efb\u52a1') && taskText.length > 10
                };
              }
            }

            if (fullText === skipText) return null;
            if (fullText.includes('\u4efb\u52a1') && fullText.length > 20) {
              let isProcessing = fullText.includes('\u8fdb\u884c\u4e2d') || fullText.includes('\u751f\u6210\u4e2d') || fullText.includes('\u601d\u8003\u4e2d') || !!sidebar.querySelector('.icd-loading, .agent-loading-dot, [class*="loading"]');
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

  async _findVisibleElementRuntime(selectors, options = {}) {
    if (!this.client || typeof this.client.send !== 'function') return null;
    const safeSelectors = safeJsValue(Array.isArray(selectors) ? selectors : []);
    const allowDisabled = options.allowDisabled === true;
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `
          (function() {
            var selectors = ${safeSelectors};
            function visible(el) {
              if (!el) return false;
              var rect = el.getBoundingClientRect();
              var style = window.getComputedStyle(el);
              return !!(rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none');
            }
            for (var i = 0; i < selectors.length; i++) {
              var el = document.querySelector(selectors[i]);
              if (!visible(el)) continue;
              var className = String(el.className || '');
              var disabled = !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || /(?:^|\\s)disabled(?:\\s|$)/.test(className));
              if (disabled && !${allowDisabled ? 'true' : 'false'}) continue;
              return {
                matchedSelector: selectors[i],
                visible: true,
                disabled: disabled,
                text: (el.innerText || el.textContent || '').trim().slice(0, 120)
              };
            }
            return null;
          })()
        `,
        returnByValue: true
      });
      return result.result?.value || null;
    } catch (_) {
      return null;
    }
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

  async checkTaskReviewGate() {
    try {
      const result = await this.client.send('Runtime.evaluate', {
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

  async resolveTaskReviewGate(preferredAction = 'keep_all') {
    const gate = await this.checkTaskReviewGate();
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
          await sleep(Math.max(this.config.postActionDelayMs, 250));
          const after = await this.checkTaskReviewGate();
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

      await this.client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: target.x,
        y: target.y,
        button: 'left',
        clickCount: 1
      });
      await this.client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: target.x,
        y: target.y,
        button: 'left',
        clickCount: 1
      });

      const mouseResolution = await waitForResolution();
      if (mouseResolution) return mouseResolution;

      await this.client.send('Runtime.evaluate', {
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
      await this.client.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13
      });
      await this.client.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13
      });

      const keyboardResolution = await waitForResolution();
      if (keyboardResolution) return keyboardResolution;

      await this.client.send('Runtime.evaluate', {
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
        const individualResult = await this.client.send('Runtime.evaluate', {
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

      const finalGate = await this.checkTaskReviewGate();
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
    const existingReviewGate = await this.checkTaskReviewGate();
    if (existingReviewGate.awaitingReview && existingReviewGate.reviewCount !== 0) {
      const gateResolution = await this.resolveTaskReviewGate('keep_all');
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
    if (taskSourceResult && taskSourceResult.awaitingAssistant) {
      state.taskText = '';
      state.taskInProgress = true;
      state.taskComplete = false;
      state.responseText = '';
      state.awaitingAssistant = true;
      state.latestUserText = taskSourceResult.latestUserText || '';
      return state;
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
                var titleEl = el.querySelector('.monaco-dialog-title') || el.querySelector('[class*="title"]') || el.querySelector('[role="heading"]') || el;
                var buttons = el.querySelectorAll(${safeJsValue(DIALOG_BUTTON_SELECTOR)});
                var buttonTexts = [];
                buttons.forEach(function(b) {
                  if (!b || b.offsetParent === null) return;
                  var text = (b.innerText || b.textContent || '').trim();
                  if (!text) return;
                  if (!buttonTexts.includes(text)) buttonTexts.push(text);
                });
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
            
            var visibleReviewCards = document.querySelectorAll('.ask-user-question-card-container, [class*="ask-user-question-card"]');
            for (var vc = 0; vc < visibleReviewCards.length; vc++) {
              var visibleCard = visibleReviewCards[vc];
              if (!visibleCard || visibleCard.offsetParent === null) continue;
              var visibleRect = visibleCard.getBoundingClientRect();
              if (visibleRect.width < 100 || visibleRect.height < 40) continue;
              if (visibleRect.bottom < 0 || visibleRect.top > window.innerHeight) continue;
              var visibleCardText = visibleCard.textContent || '';
              var isReviewScopeCard = /What would you like me to review\\?|Review Scope|Latest commit changes|Uncommitted changes|Specific files or folder/i.test(visibleCardText);
              var isPendingQuestion = /\\u6b63\\u5728\\u7b49\\u5f85\\u4f60\\u7684\\u64cd\\u4f5c|Cancel|Next|\\u53d6\\u6d88|\\u4e0b\\u4e00\\u4e2a/i.test(visibleCardText);
              if (!isReviewScopeCard || !isPendingQuestion) continue;
              var visibleReviewButtons = [];
              var visibleOptions = [];
              var visibleReviewButtonNodes = visibleCard.querySelectorAll(${safeJsValue(`${DIALOG_BUTTON_SELECTOR}, [class*="button"], [class*="btn"], div, span`)});
              visibleReviewButtonNodes.forEach(function(b) {
                if (!b || b.offsetParent === null) return;
                var text = (b.innerText || b.textContent || '').trim();
                if (!text) return;
                if (/^(\\u53d6\\u6d88|\\u4e0b\\u4e00\\u4e2a|Cancel|Next)$/i.test(text) && !visibleReviewButtons.includes(text)) {
                  visibleReviewButtons.push(text);
                }
              });
              var knownLabels = [
                'Latest commit changes',
                'Uncommitted changes',
                'Current workspace changes',
                'Changes compared to a branch',
                'A specific MR/PR',
                'Specific files',
                'Specific files or folder',
                'Compare with a branch',
                '\\u5176\\u4ed6'
              ];
              var optionNodes = visibleCard.querySelectorAll('.ask-user-single-choice-item, .icd-checkbox-item-container, [class*="single-choice"], [class*="checkbox-item"], [role="radio"], [role="option"]');
              optionNodes.forEach(function(option) {
                if (!option || option.offsetParent === null) return;
                var rect = option.getBoundingClientRect();
                if (rect.width < 50 || rect.height < 20) return;
                var text = (option.innerText || option.textContent || '').replace(/\\s+/g, ' ').trim();
                if (!text) return;
                var label = '';
                for (var ko = 0; ko < knownLabels.length; ko++) {
                  if (text.includes(knownLabels[ko])) {
                    label = knownLabels[ko];
                    break;
                  }
                }
                if (!label) return;
                var description = text.replace(label, '').trim();
                if (!visibleOptions.some(function(item) { return item.label === label; })) {
                  visibleOptions.push({ label: label, description: description });
                }
              });
              var compactText = visibleCardText.replace(/\\s+/g, ' ').trim();
              var hits = [];
              knownLabels.forEach(function(label) {
                var idx = compactText.indexOf(label);
                if (idx >= 0) hits.push({ label: label, index: idx });
              });
              hits.sort(function(a, b) { return a.index - b.index; });
              var parsedOptions = [];
              for (var hi = 0; hi < hits.length; hi++) {
                var start = hits[hi].index + hits[hi].label.length;
                var end = hi + 1 < hits.length ? hits[hi + 1].index : compactText.length;
                var desc = compactText.slice(start, end)
                  .replace(/^(What would you like me to review\\?|Review scope|Review Scope|1\\/2|Cancel|Next|\\u53d6\\u6d88|\\u4e0b\\u4e00\\u4e2a|\\u6b63\\u5728\\u7b49\\u5f85\\u4f60\\u7684\\u64cd\\u4f5c)\\s*/i, '')
                  .replace(/\\s*(1\\/2|Review scope|Review Scope|Cancel|Next|\\u53d6\\u6d88|\\u4e0b\\u4e00\\u4e2a|\\u6b63\\u5728\\u7b49\\u5f85\\u4f60\\u7684\\u64cd\\u4f5c).*$/i, '')
                  .trim();
                if (!parsedOptions.some(function(item) { return item.label === hits[hi].label; })) {
                  parsedOptions.push({ label: hits[hi].label, description: desc });
                }
              }
              if (parsedOptions.length >= 2) {
                visibleOptions = parsedOptions;
              }
              return {
                found: true,
                title: 'Review Scope',
                buttons: visibleReviewButtons.slice(0, 5),
                options: visibleOptions.slice(0, 8),
                type: 'review_scope_question',
                isCommandExec: false,
                canAutoApprove: false
              };
            }

            var bodyText = document.body.textContent || '';
            var reviewScopePatterns = [
              'What would you like me to review?',
              'Review Scope',
              'Latest commit changes',
              'Uncommitted changes',
              'Specific files or folder',
              '\\u6b63\\u5728\\u7b49\\u5f85\\u4f60\\u7684\\u64cd\\u4f5c'
            ];
            var reviewScopeHits = 0;
            for (var r = 0; r < reviewScopePatterns.length; r++) {
              if (bodyText.includes(reviewScopePatterns[r])) reviewScopeHits++;
            }
            if (reviewScopeHits >= 2 && document.querySelector('.ask-user-question-card-status-pending')) {
              var reviewButtons = [];
              var reviewButtonNodes = document.querySelectorAll(${safeJsValue(DIALOG_BUTTON_SELECTOR)});
              reviewButtonNodes.forEach(function(b) {
                if (!b || b.offsetParent === null) return;
                var text = (b.innerText || b.textContent || '').trim();
                if (!text) return;
                if (/^(\\u53d6\\u6d88|\\u4e0b\\u4e00\\u4e2a|Cancel|Next)$/i.test(text) && !reviewButtons.includes(text)) {
                  reviewButtons.push(text);
                }
              });
              return {
                found: true,
                title: 'Review Scope',
                buttons: reviewButtons.slice(0, 5),
                type: 'review_scope_question',
                isCommandExec: false,
                canAutoApprove: false
              };
            }
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
          options: dialog.options || [],
          isCommandExec: dialog.isCommandExec || false,
          canAutoApprove: dialog.canAutoApprove === true,
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
      return {
        text: '',
        stable: false,
        elapsedMs: 0,
        needsApproval: true,
        question: dialog.question,
        dialogType: dialog.dialogType,
        buttons: dialog.buttons || [],
        options: dialog.options || []
      };
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
        if (state.awaitingAssistant) {
          lastText = '';
          stableCount = 0;
          await sleep(pollInterval);
          continue;
        }
        const reviewGate = await this.checkTaskReviewGate();
        if (reviewGate.awaitingReview && reviewGate.taskCompleted) {
          const gateResolution = await this.resolveTaskReviewGate('keep_all');
          if (gateResolution.success) {
            await sleep(Math.max(this.config.postActionDelayMs * 2, 500));
          }
        }
        const completionCandidate = cleanAssistantResultText(sanitizeActivityText(state.taskText || state.responseText || ''));
        const completionLooksStale = completionCandidate && (
          (this._preSendSnapshot && this._preSendSnapshot.includes(completionCandidate)) ||
          (this._lastTaskText && this._lastTaskText.includes(completionCandidate))
        );
        let currentText = cleanAssistantResultText(sanitizeActivityText(state.taskText || state.responseText || ''));
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


        const hasTaskText = !!String(state.taskText || '').trim();
        if (!completionLooksStale && hasTaskText && (state.taskComplete || !state.taskInProgress)) {
          const text = cleanAssistantResultText(sanitizeActivityText(state.taskText || ''));
          if (this._isModelErrorResponseText(text)) {
            cleanup();
            return { text, stable: false, elapsedMs: Date.now() - startTime, modelError: true, error: 'Trae model request failed' };
          }
          if (text && !this._isIncompleteResponseText(text)) { cleanup(); return { text, stable: true, elapsedMs: Date.now() - startTime }; }
        }

        const pendingTask = String(this._pendingUserTask || '').replace(/\s+/g, ' ').trim();
        const normalizedCurrent = String(currentText || '').replace(/\s+/g, ' ').trim();
        const currentLooksLikePromptEcho = pendingTask && normalizedCurrent && (
          normalizedCurrent === pendingTask ||
          normalizedCurrent.endsWith(pendingTask) ||
          (normalizedCurrent.includes(pendingTask) && normalizedCurrent.length <= pendingTask.length + 24)
        );
        if (currentLooksLikePromptEcho) {
          currentText = '';
        }

        if (state.taskInProgress) {
          lastText = currentText;
          stableCount = 0;
          await sleep(pollInterval);
          continue;
        }

        if ((!currentText || currentText.length <= 10 || this._isIncompleteResponseText(currentText)) && isIdeMode) {
          // IDE mode fallback: prefer the chat panel before any broad content
          // scan, otherwise editor text can be mistaken for the assistant reply.
          const panelText = await this._captureIdePanelText();
          if (panelText) {
            currentText = cleanAssistantResultText(sanitizeActivityText(panelText));
          }
        }

        if ((!currentText || currentText.length <= 10 || this._isIncompleteResponseText(currentText)) && !isIdeMode) {
          const contentScan = await this._scanContentArea();
          if (contentScan && contentScan.areaFound && contentScan.text) {
            currentText = cleanAssistantResultText(sanitizeActivityText(contentScan.text));
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
          if (stableCount >= effectiveRequiredStable && this._isModelErrorResponseText(currentText)) {
            cleanup();
            return { text: currentText, stable: false, elapsedMs: Date.now() - startTime, modelError: true, error: 'Trae model request failed' };
          }
          if (stableCount >= effectiveRequiredStable && !this._isIncompleteResponseText(currentText)) {
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
      this._pendingUserTask = '';
      cleanup();
      return { text: finalText, stable: false, elapsedMs: Date.now() - startTime, timedOut: true };
    } catch (err) {
      this._pendingUserTask = '';
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
            var action = ${JSON.stringify(action)};
            function isNegativeMatch(text) {
              if (!text) return false;
              if (action !== 'trust' && action !== 'approve') return false;
              return /不信任|deny|cancel|关闭|dismiss/i.test(text);
            }

            // Find all clickable elements in visible dialogs
            var dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, .modal-overlay, [class*="dialog"], [class*="overlay"], .monaco-dialog');
            var buttonsToSearch = [];

            if (dialogs.length > 0) {
              for (var d = 0; d < dialogs.length; d++) {
                if (dialogs[d].offsetParent === null) continue;
                var btns = dialogs[d].querySelectorAll(${safeJsValue(DIALOG_BUTTON_SELECTOR)});
                for (var b = 0; b < btns.length; b++) {
                  var btn = btns[b];
                  if (!btn || btn.offsetParent === null) continue;
                  var text = (btn.innerText || btn.textContent || '').trim();
                  var rect = btn.getBoundingClientRect();
                  if (!text || rect.width < 12 || rect.height < 12) continue;
                  buttonsToSearch.push(btn);
                }
              }
            } else {
              // Fallback: search all buttons
              var allButtons = document.querySelectorAll(${safeJsValue(DIALOG_BUTTON_SELECTOR)});
              for (var b = 0; b < allButtons.length; b++) {
                var fallbackBtn = allButtons[b];
                if (!fallbackBtn || fallbackBtn.offsetParent === null) continue;
                var fallbackText = (fallbackBtn.innerText || fallbackBtn.textContent || '').trim();
                var fallbackRect = fallbackBtn.getBoundingClientRect();
                if (!fallbackText || fallbackRect.width < 12 || fallbackRect.height < 12) continue;
                buttonsToSearch.push(fallbackBtn);
              }
            }

            var reviewCards = document.querySelectorAll('.ask-user-question-card-container, [class*="ask-user-question-card"]');
            for (var rc = 0; rc < reviewCards.length; rc++) {
              var card = reviewCards[rc];
              if (!card || card.offsetParent === null) continue;
              var cardText = card.textContent || '';
              if (!/Review Scope|What would you like me to review\\?|\\u6b63\\u5728\\u7b49\\u5f85\\u4f60\\u7684\\u64cd\\u4f5c/i.test(cardText)) continue;
              var cardNodes = card.querySelectorAll('button, [role="button"], [class*="button"], [class*="btn"], div, span');
              for (var cn = 0; cn < cardNodes.length; cn++) {
                var node = cardNodes[cn];
                if (!node || node.offsetParent === null) continue;
                var nodeText = (node.innerText || node.textContent || '').trim();
                if (!/^(\\u53d6\\u6d88|\\u4e0b\\u4e00\\u4e2a|Cancel|Next)$/i.test(nodeText)) continue;
                var clickable = node.closest('button, a[role="button"], [role="button"], .monaco-button, .monaco-text-button, [class*="button"], [class*="btn"]') || node;
                var nodeRect = clickable.getBoundingClientRect();
                if (nodeRect.width < 12 || nodeRect.height < 12) continue;
                if (!buttonsToSearch.includes(clickable)) buttonsToSearch.push(clickable);
              }
            }

            // First pass: exact match
            for (var b = 0; b < buttonsToSearch.length; b++) {
              var btn = buttonsToSearch[b];
              if (btn.offsetParent === null) continue;
              var text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
              if (isNegativeMatch(text)) continue;
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
              if (isNegativeMatch(text)) continue;
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
        const dialogAfter = await this.checkForApprovalDialog();
        if (dialogAfter.needsApproval) {
          return {
            success: false,
            action,
            buttonClicked: clickResult.buttonText,
            error: 'Dialog remained visible after click'
          };
        }
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

  async answerQuestionDialog(answer) {
    const selectedAnswer = String(answer || '').trim();
    if (!selectedAnswer) {
      return { success: false, action: 'answer', error: 'answer is required' };
    }

    const dialog = await this.checkForApprovalDialog();
    if (!dialog.needsApproval) {
      return { success: false, action: 'answer', answer: selectedAnswer, error: 'No question dialog found' };
    }

    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var answer = ${safeJsValue(selectedAnswer)};
          var aliases = [answer];
          if (/current|uncommitted|workspace|staged|\\u672a\\u63d0\\u4ea4|\\u5de5\\u4f5c\\u533a/i.test(answer)) {
            aliases.push('Current workspace changes', 'Uncommitted changes', 'Review uncommitted/staged changes in the workspace', 'Review any uncommitted or staged workspace changes');
          }
          if (/latest|commit|recent|\\u6700\\u8fd1|\\u63d0\\u4ea4/i.test(answer)) {
            aliases.push('Latest commit changes', 'Review only the changes in the most recent commit');
          }
          if (/specific|file|folder|path|\\u6587\\u4ef6|\\u76ee\\u5f55/i.test(answer)) {
            aliases.push('Specific files', 'Specific files or folder', 'Review specific file(s) in the project', 'Review a specific file, directory, or set of files');
          }
          if (/branch|compare|\\u5206\\u652f|\\u5bf9\\u6bd4/i.test(answer)) {
            aliases.push('Compare with a branch', 'Review changes compared to another branch');
          }
          if (/other|\\u5176\\u4ed6/i.test(answer)) {
            aliases.push('\\u5176\\u4ed6', 'Other');
          }

          function isVisible(el) {
            if (!el || el.offsetParent === null) return false;
            var rect = el.getBoundingClientRect();
            return rect.width >= 12 && rect.height >= 12 && rect.bottom >= 0 && rect.top <= window.innerHeight;
          }

          function clickElement(el) {
            var rect = el.getBoundingClientRect();
            var x = rect.x + rect.width / 2;
            var y = rect.y + rect.height / 2;
            el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerType: 'mouse' }));
            el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 0, pointerType: 'mouse' }));
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            if (typeof el.click === 'function') el.click();
          }

          var cards = document.querySelectorAll('.ask-user-question-card-container, [class*="ask-user-question-card"]');
          var targetCard = null;
          for (var c = 0; c < cards.length; c++) {
            if (!isVisible(cards[c])) continue;
            var cardText = cards[c].textContent || '';
            if (/What would you like me to review\\?|Review Scope|Latest commit changes|Uncommitted changes|Specific files or folder/i.test(cardText)) {
              targetCard = cards[c];
              break;
            }
          }
          if (!targetCard) return { success: false, error: 'No visible question card found' };

          var optionNodes = targetCard.querySelectorAll('.ask-user-single-choice-item, .icd-checkbox-item-container, [class*="single-choice"], [class*="checkbox-item"], [role="radio"], [role="option"], div');
          var selectedOption = null;
          var selectedText = '';
          for (var i = 0; i < optionNodes.length; i++) {
            var option = optionNodes[i];
            if (!isVisible(option)) continue;
            var text = (option.innerText || option.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!text) continue;
            for (var a = 0; a < aliases.length; a++) {
              var alias = String(aliases[a] || '').replace(/\\s+/g, ' ').trim();
              if (!alias) continue;
              if (text.toLowerCase().includes(alias.toLowerCase()) || alias.toLowerCase().includes(text.toLowerCase())) {
                selectedOption = option.closest('.ask-user-single-choice-item, .icd-checkbox-item-container, [role="radio"], [role="option"]') || option;
                selectedText = text;
                break;
              }
            }
            if (selectedOption) break;
          }
          if (!selectedOption) return { success: false, error: 'No matching answer option found', answer: answer };
          clickElement(selectedOption);

          var nextNodes = targetCard.querySelectorAll('button, [role="button"], [class*="button"], [class*="btn"], div, span');
          var nextButton = null;
          for (var n = 0; n < nextNodes.length; n++) {
            var node = nextNodes[n];
            if (!isVisible(node)) continue;
            var nodeText = (node.innerText || node.textContent || '').trim();
            if (/^(\\u4e0b\\u4e00\\u4e2a|Next)$/i.test(nodeText)) {
              nextButton = node.closest('button, a[role="button"], [role="button"], .monaco-button, .monaco-text-button, [class*="button"], [class*="btn"]') || node;
              break;
            }
          }
          if (!nextButton) return { success: false, error: 'No next button found', selectedOption: selectedText };
          clickElement(nextButton);
          return { success: true, selectedOption: selectedText, buttonClicked: (nextButton.innerText || nextButton.textContent || '').trim() };
        })()
      `,
      returnByValue: true
    });

    const answerResult = result.result?.value || {};
    if (!answerResult.success) {
      return { success: false, action: 'answer', answer: selectedAnswer, error: answerResult.error || 'Failed to answer question dialog' };
    }

    await sleep(this.config.postActionDelayMs);
    const dialogAfter = await this.checkForApprovalDialog();
    return {
      success: !dialogAfter.needsApproval,
      action: 'answer',
      answer: selectedAnswer,
      selectedOption: answerResult.selectedOption,
      buttonClicked: answerResult.buttonClicked,
      error: dialogAfter.needsApproval ? 'Question dialog remained visible after answering' : undefined
    };
  }

  /**
   * Map an approve action to the list of button label patterns to search for.
   * Supports CN and EN labels.
   */
  _getButtonLabelsForAction(action) {
    switch (action) {
      case 'trust':
        return ['是，我信任此作者', '信任此作者', '信任', 'Trust', '信任此文件夹', '信任文件夹', '打开'];
      case 'allow':
        return ['允许', 'Allow', '批准', 'Approve', '允许此操作'];
      case 'confirm':
        return ['确认', 'Confirm', '确定', 'OK', '确认执行', '运行'];
      case 'approve':
        return ['是，我信任此作者', '批准', 'Approve', '允许', 'Allow', '确认', 'Confirm', '信任', 'Trust'];
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

  _summarizeRestrictedModeState(snapshot = {}) {
    const rawBody = String(snapshot.bodyText || '');
    const body = rawBody.trim();
    const bodyLower = body.toLowerCase();
    const buttonTexts = Array.isArray(snapshot.buttonTexts)
      ? snapshot.buttonTexts.map(text => String(text || '').trim()).filter(Boolean)
      : [];

    const hasAny = (haystack, needles) => needles.some(needle => haystack.includes(needle));
    const buttonMatches = (patterns) => buttonTexts.some(text => patterns.some(pattern => pattern.test(text)));

    const onWorkspaceTrustPage = hasAny(bodyLower, ['工作区信任', 'workspace trust']);
    const trustedCopyVisible = hasAny(bodyLower, [
      '你信任此文件夹',
      'you trust this folder',
      'all files in the current window are trusted'
    ]);
    const untrustButtonVisible = buttonMatches([/不信任/i, /don't trust/i, /stop trusting/i]);
    const trustButtonVisible = buttonMatches([/^信任$/, /^trust$/i, /信任此文件夹/, /trust this folder/i, /信任父级/, /trust parent/i]);
    const manageButtonVisible = buttonMatches([/^管理$/, /^manage$/i]);

    if (onWorkspaceTrustPage && (trustedCopyVisible || untrustButtonVisible)) {
      return {
        restricted: false,
        trusted: true,
        panelOpen: true,
        title: '工作区信任',
        trustButtonFound: false,
        trustButtonText: '',
        manageButtonFound: false,
        hasOverlay: snapshot.hasOverlay === true
      };
    }

    const hasRestrictedBanner = hasAny(bodyLower, [
      '受限模式',
      'restricted mode',
      '安全地浏览代码',
      'trust this folder',
      '信任此文件夹',
      '点击「信任」',
      '点击信任'
    ]);

    if (onWorkspaceTrustPage || hasRestrictedBanner) {
      const title = onWorkspaceTrustPage
        ? '工作区信任'
        : (snapshot.title || '受限模式');
      return {
        restricted: true,
        trusted: false,
        panelOpen: onWorkspaceTrustPage,
        title,
        trustButtonFound: trustButtonVisible,
        trustButtonText: trustButtonVisible
          ? buttonTexts.find(text => /^信任$|^trust$|信任此文件夹|trust this folder|信任父级|trust parent/i.test(text)) || ''
          : '',
        manageButtonFound: manageButtonVisible,
        hasOverlay: snapshot.hasOverlay === true
      };
    }

    return {
      restricted: false,
      trusted: false,
      panelOpen: false,
      trustButtonFound: false,
      trustButtonText: '',
      manageButtonFound: false,
      hasOverlay: snapshot.hasOverlay === true
    };
  }

  /**
   * Check for restricted mode and click the Trust button if found.
   * Returns the result of the operation.
   */
  async clickRestrictedModeTrust() {
    try {
      const restrictedCheck = await this.checkRestrictedMode();
      if (!restrictedCheck || !restrictedCheck.restricted) {
        if (restrictedCheck?.trusted) {
          return { success: true, action: 'already_trusted', panelOpen: restrictedCheck.panelOpen === true };
        }
        return { success: false, reason: 'no_restricted_mode_found' };
      }

      const openManage = async () => {
        const result = await this.client.send('Runtime.evaluate', {
          expression: `
            (() => {
              const candidates = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], .monaco-button'));
              for (const el of candidates) {
                if (!el || el.offsetParent === null) continue;
                const text = (el.innerText || el.textContent || '').trim();
                if (!text) continue;
                if (!/管理|manage/i.test(text)) continue;
                const rect = el.getBoundingClientRect();
                el.dispatchEvent(new PointerEvent('pointerdown', {
                  bubbles: true, cancelable: true, composed: true,
                  clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                  button: 0, buttons: 1, pointerType: 'mouse'
                }));
                el.dispatchEvent(new PointerEvent('pointerup', {
                  bubbles: true, cancelable: true, composed: true,
                  clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                  button: 0, buttons: 1, pointerType: 'mouse'
                }));
                el.dispatchEvent(new MouseEvent('click', {
                  bubbles: true, cancelable: true,
                  clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2
                }));
                if (typeof el.click === 'function') el.click();
                return { clicked: true, text };
              }
              return { clicked: false };
            })()
          `,
          returnByValue: true
        });
        return result.result?.value || { clicked: false };
      };

      const clickTrustFromRestrictedPanel = async () => {
        const result = await this.client.send('Runtime.evaluate', {
          expression: `
            (() => {
              const preferred = ['信任', 'Trust', '信任父级', 'Trust Parent'];
              const candidates = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], .monaco-button, .monaco-text-button, .quick-input-widget button'));
              for (const label of preferred) {
                for (const el of candidates) {
                  if (!el || el.offsetParent === null) continue;
                  const text = (el.innerText || el.textContent || '').trim();
                  if (!text || text !== label) continue;
                  const rect = el.getBoundingClientRect();
                  if (rect.width < 12 || rect.height < 12) continue;
                  el.dispatchEvent(new PointerEvent('pointerdown', {
                    bubbles: true, cancelable: true, composed: true,
                    clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                    button: 0, buttons: 1, pointerType: 'mouse'
                  }));
                  el.dispatchEvent(new PointerEvent('pointerup', {
                    bubbles: true, cancelable: true, composed: true,
                    clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                    button: 0, buttons: 1, pointerType: 'mouse'
                  }));
                  el.dispatchEvent(new MouseEvent('click', {
                    bubbles: true, cancelable: true,
                    clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2
                  }));
                  if (typeof el.click === 'function') el.click();
                  return { clicked: true, text };
                }
              }
              return { clicked: false };
            })()
          `,
          returnByValue: true
        });
        return result.result?.value || { clicked: false };
      };

      if (restrictedCheck.trustButtonFound) {
        const approveResult = await this.approveDialog('trust');
        if (approveResult.success) {
          await sleep(this.config.postActionDelayMs * 2);
          return { success: true, action: 'trust_clicked', buttonText: approveResult.buttonText };
        }
      }

      if (restrictedCheck.manageButtonFound) {
        const manageResult = await openManage();
        if (manageResult.clicked) {
          for (let attempt = 0; attempt < 8; attempt++) {
            await sleep(Math.max(this.config.postActionDelayMs, 200));
            const restrictedAfterManage = await this.checkRestrictedMode();
            if (!restrictedAfterManage.restricted || restrictedAfterManage.trusted) {
              return {
                success: true,
                action: 'trust_clicked',
                buttonText: manageResult.text
              };
            }
          }
          const panelTrustResult = await clickTrustFromRestrictedPanel();
          if (panelTrustResult.clicked) {
            await sleep(this.config.postActionDelayMs * 2);
            const restrictedAfter = await this.checkRestrictedMode();
            if (!restrictedAfter.restricted || restrictedAfter.trusted) {
              return {
                success: true,
                action: 'trust_clicked',
                buttonText: panelTrustResult.text,
                manageButtonText: manageResult.text
              };
            }
          }

          const approveResult = await this.approveDialog('trust');
          if (approveResult.success) {
            await sleep(this.config.postActionDelayMs * 2);
            return {
              success: true,
              action: 'trust_clicked',
              buttonText: approveResult.buttonText,
              manageButtonText: manageResult.text
            };
          }
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
    this._pendingUserTask = '';

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
    const existingReviewGate = await this.checkTaskReviewGate();
    if (existingReviewGate.awaitingReview && existingReviewGate.reviewCount !== 0) {
      const gateResolution = await this.resolveTaskReviewGate('keep_all');
      if (!gateResolution.success) {
        throw new Error(`Task review gate blocked new chat: ${gateResolution.reason || gateResolution.error || 'unknown'}`);
      }
      await sleep(this.config.postActionDelayMs * 2);
    }

    const previousPanelText = await this._captureIdePanelText();

    // Try keyboard shortcut first (works in both modes)
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'n', code: 'KeyN', modifiers: 6
    });
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'n', code: 'KeyN', modifiers: 6
    });

    const safeComposerSels = safeJsValue(this.config.composerSelectors);
    const ready = await this._waitForExpression(
      `(function(){var s=${safeComposerSels};for(var i=0;i<s.length;i++){var e=document.querySelector(s[i]);if(e&&e.getBoundingClientRect().width>20&&e.offsetParent!==null)return true;}return false;})()`,
      4000, 200
    );
    if (!ready) await sleep(2000);

    let panelChanged = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const panelText = await this._captureIdePanelText();
      if (!previousPanelText || !panelText || panelText !== previousPanelText) {
        panelChanged = true;
        break;
      }
      await sleep(250);
    }

    if (!panelChanged) {
      const newChatButton = await this.findNewChatButton();
      if (newChatButton && newChatButton.nodeId) {
        await dom.clickNode(this.client, newChatButton.nodeId);
        await sleep(this.config.postActionDelayMs * 2);
        for (let attempt = 0; attempt < 8; attempt++) {
          const panelText = await this._captureIdePanelText();
          if (!previousPanelText || !panelText || panelText !== previousPanelText) {
            panelChanged = true;
            break;
          }
          await sleep(250);
        }
      }
    }

    if (!panelChanged && previousPanelText) {
      throw new Error('Failed to open a fresh chat while an existing task was still active');
    }

    this._lastTaskText = '';
    this._pendingUserTask = '';
    this._preSendSnapshot = '';
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
            const sendBtn = document.querySelector('.chat-input-v2-send-button');
            const sendDisabled = sendBtn ?
              (sendBtn.disabled || /disabled/.test(sendBtn.className)) : false;
            const trigger = document.querySelector('.chat-model-label,[role="combobox"],[class*="model-select"],[class*="ai-model-select"]');
            const currentModel = trigger ? (trigger.textContent?.replace(/\\s+/g, ' ').trim() || '') : '';
            const queueCandidates = Array.from(document.querySelectorAll('div,span,p,section,[role="alert"],[class*="queue"],[class*="toast"],[class*="notice"]'))
              .map((el) => {
                const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
                if (!text || text.length > 240) return null;
                const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
                const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
                const visible = !!(rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight && style && style.visibility !== 'hidden' && style.display !== 'none');
                if (!visible) return null;
                const positionMatch = text.match(/排在第\\s*(\\d+)\\s*位/);
                const notice = text.includes('排队提醒') ||
                  text.includes('请求量较高') ||
                  text.includes('当前使用人数较多') ||
                  text.includes('模型繁忙') ||
                  /\\b(queue|queued|busy)\\b/i.test(text);
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
    let composer = await this.findComposer();
    let sendBtn = await this.findSendButton();
    let response = await this.findResponseRegion();
    let workspaceGuide = null;
    let composerFallback = null;
    let sendBtnFallback = null;

    if (!(composer && sendBtn)) {
      workspaceGuide = await this.dismissWorkspaceGuideIfPresent();
      if (workspaceGuide.dismissed > 0 || workspaceGuide.success) {
        composer = await this.findComposer();
        sendBtn = await this.findSendButton();
        response = await this.findResponseRegion();
      }
    }

    if (!composer) {
      composerFallback = await this._findVisibleElementRuntime(this.config.composerSelectors, { allowDisabled: true });
    }
    if (!sendBtn) {
      sendBtnFallback = await this._findVisibleElementRuntime(this.config.sendButtonSelectors, { allowDisabled: true });
    }

    // Include mode info
    let modeInfo = null;
    try {
      modeInfo = await this.detectMode();
    } catch(e) {
      modeInfo = { mode: 'unknown', confidence: 0, indicators: [] };
    }

    const blockers = await this.inspectWorkspaceBlockers();
    const restricted = await this.checkRestrictedMode();
    const dialog = await this.checkForApprovalDialog();
    let blocker = null;
    const composerReady = !!(composer || composerFallback);
    const sendButtonReady = !!(sendBtn || sendBtnFallback);
    if (!(composerReady && sendButtonReady)) {
      if (dialog.needsApproval) blocker = 'approval_dialog';
      else if (restricted.restricted) blocker = 'trust_workspace';
      else if (blockers.guideVisible) blocker = 'workspace_guide';
      else if (blockers.loginVisible) blocker = 'login_required';
      else if (blockers.newTaskVisible) blocker = 'open_task_panel';
      else blocker = 'composer_unavailable';
    }

    return {
      ready: !!(composerReady && sendButtonReady),
      composer: composer ? { matchedSelector: composer.matchedSelector } : (composerFallback ? {
        matchedSelector: composerFallback.matchedSelector,
        runtimeFallback: true
      } : null),
      sendButton: sendBtn ? { matchedSelector: sendBtn.matchedSelector } : (sendBtnFallback ? {
        matchedSelector: sendBtnFallback.matchedSelector,
        runtimeFallback: true,
        disabled: sendBtnFallback.disabled === true
      } : null),
      responseRegion: response ? { matchedSelector: response.matchedSelector } : null,
      mode: modeInfo,
      blocker,
      workspaceGuide: workspaceGuide ? {
        success: workspaceGuide.success === true,
        dismissed: workspaceGuide.dismissed || 0,
        guideVisible: workspaceGuide.guideVisible === true,
        reason: workspaceGuide.reason || null
      } : null,
      blockers: {
        guideVisible: blockers.guideVisible === true,
        guideButtons: Array.isArray(blockers.guideButtons) ? blockers.guideButtons.map(item => item.text).slice(0, 6) : [],
        loginVisible: blockers.loginVisible === true,
        newTaskVisible: blockers.newTaskVisible === true
      }
    };
  }

  async checkRestrictedMode() {
    try {
      const result = await this.client.send('Runtime.evaluate', {
        expression: `
          (() => {
            const body = document.body ? (document.body.innerText || document.body.textContent || '') : '';
            const titleEl = document.querySelector('.monaco-dialog-title, [role="heading"], h1, h2, h3, .pane-header');
            const title = titleEl ? (titleEl.innerText || titleEl.textContent || '').trim() : '';
            const controls = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], .monaco-button, .monaco-text-button, [class*="button"], [class*="btn"]'));
            const buttonTexts = controls
              .filter(el => el && el.offsetParent !== null)
              .map(el => (el.innerText || el.textContent || '').trim())
              .filter(Boolean);
            const modals = document.querySelectorAll('[class*="modal"], [class*="dialog"], [class*="overlay"], [class*="mask"]');
            const hasOverlay = Array.from(modals).some(m => {
              const rect = m.getBoundingClientRect();
              return rect.width > 100 && rect.height > 50;
            });

            return {
              bodyText: body,
              title,
              buttonTexts,
              hasOverlay
            };
          })()
        `,
        returnByValue: true,
        timeout: 5000
      });

      return this._summarizeRestrictedModeState(result.result?.value || {});
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

  get palette() {
    if (!this._paletteDriver) {
      this._paletteDriver = new CommandPaletteDriver(this.client, this.config);
    }
    return this._paletteDriver;
  }

  get editor() {
    if (!this._editorDriver) {
      this._editorDriver = new EditorDriver(this.client, this.config, { palette: this.palette });
    }
    return this._editorDriver;
  }

  get file() {
    if (!this._fileDriver) {
      this._fileDriver = new FileDriver(this.client, this.config, { palette: this.palette });
    }
    return this._fileDriver;
  }

  get terminal() {
    if (!this._terminalDriver) {
      this._terminalDriver = new TerminalDriver(this.client, this.config, { palette: this.palette });
    }
    return this._terminalDriver;
  }

  get git() {
    if (!this._gitDriver) {
      this._gitDriver = new GitDriver(this.client, this.config, { palette: this.palette });
    }
    return this._gitDriver;
  }

  get search() {
    if (!this._searchDriver) {
      this._searchDriver = new SearchDriver(this.client, this.config, { palette: this.palette });
    }
    return this._searchDriver;
  }

  get diagnostics() {
    if (!this._diagnosticsDriver) {
      this._diagnosticsDriver = new DiagnosticsDriver(this.client, this.config, { palette: this.palette });
    }
    return this._diagnosticsDriver;
  }

  get snapshot() {
    if (!this._snapshotDriver) {
      this._snapshotDriver = new SnapshotDriver(this.client, this.config);
    }
    return this._snapshotDriver;
  }

  get extension() {
    if (!this._extensionDriver) {
      this._extensionDriver = new ExtensionDriver(this.client, this.config, { palette: this.palette });
    }
    return this._extensionDriver;
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
  SettingsDriver,
  CommandPaletteDriver,
  EditorDriver,
  FileDriver,
  TerminalDriver,
  GitDriver,
  SearchDriver,
  DiagnosticsDriver,
  SnapshotDriver,
  ExtensionDriver
};
