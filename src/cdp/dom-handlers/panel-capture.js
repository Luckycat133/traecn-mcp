'use strict';

/**
 * panel-capture handlers.
 *
 * Moved verbatim from src/cdp/dom-driver.js. Each method is now an
 * exported function with signature `function method(driver, ...args)`
 * taking the DomDriver instance as `driver`. Behavior is preserved 1:1.
 *
 * Covers: sidebar/panel text captures, content-area scans, task-state
 * queries (SOLO sidebar + IDE chat panel), and the response-text
 * analyzers (`_isIncompleteResponseText`, `_isModelErrorResponseText`).
 *
 * The DomDriver retains thin delegating shims so existing
 * dom-driver.test.js cases that call
 * `driver._extractLatestIdeAssistantState()`,
 * `driver._isIncompleteResponseText()`, and
 * `driver._isModelErrorResponseText()` continue to work unchanged.
 */

const { safeJsValue } = require('../../shared/utils');

async function _captureSidebarText(driver) {
  try {
    const result = await driver.client.send('Runtime.evaluate', {
      expression: `(() => {
        var s = document.querySelector('.soloaisidebar');
        return s ? s.textContent.trim() : '';
      })()`,
      returnByValue: true
    });
    return result.result?.value || '';
  } catch {
    return '';
  }
}

/**
 * Capture text from the IDE chat panel (used instead of sidebar in IDE mode).
 */
async function _captureIdePanelText(driver) {
  const safeSels = driver.config.ideTaskPanelSelectors.map(s => safeJsValue(s));
  try {
    const result = await driver.client.send('Runtime.evaluate', {
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
  } catch {
    return '';
  }
}

/**
 * Capture all visible text in the main content area (excluding sidebar & composer).
 */
async function _captureVisibleText(driver) {
  try {
    const result = await driver.client.send('Runtime.evaluate', {
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
  } catch {
    return '';
  }
}

/**
 * Capture document.body innerText as a broad snapshot for text diffing.
 */
async function _captureBodyText(driver) {
  try {
    const result = await driver.client.send('Runtime.evaluate', {
      expression: `(() => {
        var body = document.body;
        if (!body) return '';
        return body.innerText || body.textContent || '';
      })()`,
      returnByValue: true
    });
    return result.result?.value || '';
  } catch {
    return '';
  }
}

/**
 * Scan only the content area for text-containing elements.
 */
async function _scanContentArea(driver) {
  try {
    const result = await driver.client.send('Runtime.evaluate', {
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
  } catch {
    return { text: '', areaFound: false };
  }
}

/**
 * Query the SOLO sidebar for task state.
 * Only meaningful in SOLO mode — returns null in IDE mode.
 */
async function _queryTaskSidebar(driver, skipText) {
  const safeSkipText = safeJsValue(skipText);
  const result = await driver.client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var sidebar = document.querySelector('.soloaisidebar');
        if (!sidebar) return null;

        // Find task items using the actual task item class 而非 generic divs
        var taskItems = sidebar.querySelectorAll('[class*="task-item"]');
        if (!taskItems || !taskItems.length) return null;

        // Filter: skip tasks that are interrupted/stopped
        var activeItems = [];
        for (var i = 0; i < taskItems.length; i++) {
          var item = taskItems[i];
          var fullText = item.textContent.trim();

          // Skip interrupted tasks
          if (fullText.includes('任务中断')) continue;

          // Skip if it's just the new-task button (has hotkey hint)
          if (fullText.includes('新任务') && fullText.length < 15) continue;

          // Check status: must be "进行中" (in progress) or have meaningful response content
          var hasContent = fullText.length > 10;
          var isInProgress = fullText.includes('进行中') ||
            fullText.includes('思考中') ||
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

        // Skip if text hasn't actually changed from whats in the skipText
        if (${safeSkipText} && ${safeSkipText}.indexOf(text) >= 0 && text.length <= ${safeSkipText}.length) return null;

        // Normalize both texts for fuzzy comparison (strip timestamps, extra spaces)
        var normText = text.replace(/[\\d]{1,2}:[\\d]{2}/g, '').replace(/\\s+/g, ' ').trim();
        var normSkip = ${safeSkipText} ? ${safeSkipText}.replace(/[\\d]{1,2}:[\\d]{2}/g, '').replace(/\\s+/g, ' ').trim() : '';
        if (normText === normSkip) return null;

        return {
          text: text,
          inProgress: latest.inProgress,
          isComplete: text.includes('任务完成'),
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
async function _queryIdeTaskPanel(driver, skipText) {
  const safePanelSels = driver.config.ideTaskPanelSelectors.map(s => safeJsValue(s));

  const result = await driver.client.send('Runtime.evaluate', {
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

  return _extractLatestIdeAssistantState(result.result?.value, skipText);
}

function _extractLatestIdeAssistantState(panelState, skipText) {
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

function _isIncompleteResponseText(text) {
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

function _isModelErrorResponseText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return [
    '模型请求失败',
    '异常打断',
    'model request failed',
    'model service error',
    '服务商错误',
    '展开模型服务商错误信息',
    '今日对话额度已耗尽',
    '额度已耗尽',
    '额度重置'
  ].some(signal => normalized.toLowerCase().includes(signal.toLowerCase()));
}

/**
 * Mode-aware version: tries sidebar in SOLO mode, chat panel in IDE mode.
 */
async function _queryTaskSource(driver, skipText) {
  const modeInfo = await driver.detectMode();
  if (modeInfo.mode === 'solo') {
    return _queryTaskSidebar(driver, skipText);
  }
  return _queryIdeTaskPanel(driver, skipText);
}

async function findTaskResponse(driver) {
  const skipText = driver._lastTaskText;

  // Try mode-specific task source first
  const taskResult = await driver._queryTaskSource(skipText);
  if (taskResult) return taskResult;

  // SOLO fallback: sidebar full-text scan for task blocks
  const modeInfo = await driver.detectMode();
  if (modeInfo.mode === 'solo') {
    const safeSkipText = safeJsValue(skipText);
    const result = await driver.client.send('Runtime.evaluate', {
      expression: `
        (() => {
          let sidebar = document.querySelector('.soloaisidebar');
          if (!sidebar) return null;

          let fullText = sidebar.textContent.trim();
          let taskMatch = fullText.match(/任务\\d+[^]*?(?=实时|$)/);
          if (taskMatch) {
            let taskText = taskMatch[0].trim();
            if (taskText.length > 5 && !taskText.includes('开始你的第一个任务') && taskText !== ${safeSkipText}) {
              return {
                text: taskText,
                inProgress: fullText.includes('进行中') || fullText.includes('思考中') || !!sidebar.querySelector('.icd-loading, .agent-loading-dot, [class*="loading"]'),
                isComplete: fullText.includes('任务完成'),
                hasResponse: !fullText.includes('进行中') && !fullText.includes('新任务') && taskText.length > 10
              };
            }
          }

          if (fullText === ${safeSkipText}) return null;
          if (fullText.includes('任务') && fullText.length > 20) {
            let isProcessing = fullText.includes('进行中') || fullText.includes('生成中') || fullText.includes('思考中') || !!sidebar.querySelector('.icd-loading, .agent-loading-dot, [class*="loading"]');
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

  return null;
}

module.exports = {
  _captureSidebarText,
  _captureIdePanelText,
  _captureVisibleText,
  _captureBodyText,
  _scanContentArea,
  _queryTaskSidebar,
  _queryIdeTaskPanel,
  _extractLatestIdeAssistantState,
  _isIncompleteResponseText,
  _isModelErrorResponseText,
  _queryTaskSource,
  findTaskResponse
};