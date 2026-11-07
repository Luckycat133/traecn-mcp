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

async function getWorkspaceContext(driver) {
  const result = await driver.client.send('Runtime.evaluate', {
    expression: `(() => {
      var title = String(document.title || '').trim();
      var rootPath = null;
      try {
        var context = typeof window !== 'undefined' && window.vscode && window.vscode.context;
        var configuration = context && typeof context.configuration === 'function' && context.configuration();
        var uri = configuration && configuration.workspace && configuration.workspace.uri;
        if (uri && uri.scheme === 'file' && !uri.authority &&
            typeof uri.path === 'string' && uri.path.startsWith('/')) {
          rootPath = uri.path;
        }
      } catch {
        // Older/preloading windows may not expose the native configuration yet.
      }
      var explorer = document.querySelector('.explorer-folders-view, .explorer-viewlet');
      var firstRow = explorer && explorer.querySelector('[role="treeitem"][aria-level="1"]');
      var resource = firstRow && firstRow.querySelector('.explorer-item[aria-label]');
      var childName = firstRow ? String(firstRow.getAttribute('aria-label') || '').trim() : '';
      var resourceLabel = resource ? String(resource.getAttribute('aria-label') || '').trim() : '';
      if (!rootPath && resourceLabel && childName) {
        var slashSuffix = '/' + childName;
        var backslashSuffix = '\\\\' + childName;
        if (resourceLabel.endsWith(slashSuffix)) {
          rootPath = resourceLabel.slice(0, -slashSuffix.length);
        } else if (resourceLabel.endsWith(backslashSuffix)) {
          rootPath = resourceLabel.slice(0, -backslashSuffix.length);
        }
      }
      return {
        title: title,
        folderName: null,
        rootPath: rootPath,
        hasExplorer: !!explorer
      };
    })()`,
    returnByValue: true
  });
  const value = result.result?.value || { title: '', folderName: null, rootPath: null, hasExplorer: false };
  const title = String(value.title || '').trim();
  const observedPath = String(value.rootPath || '').trim();
  const rootPath = /^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\)/.test(observedPath) ? observedPath : null;
  const rootName = rootPath ? rootPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() : null;
  // Prefer the native single-folder URI, then the Explorer resource identity.
  // The title may include an editor and cannot establish an absolute path.
  const titleName = title.split(/\s+—\s+/).pop().trim();
  const folderName = rootName || String(value.folderName || '').trim() || titleName;
  return {
    ...value,
    title,
    folderName: rootName || (folderName && !/^Trae\s*CN$/i.test(folderName) ? folderName : null),
    rootPath
  };
}

async function _captureSidebarText(driver) {
  try {
    const result = await driver.client.send('Runtime.evaluate', {
      expression: `(() => {
        var s = document.querySelector('.soloaisidebar, .task-list-panel');
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
            if (el && el.offsetParent !== null && el !== document.body && el !== document.documentElement
              && !/(?:^|\\s)monaco-workbench(?:\\s|$)/.test(String(el.className || ''))) {
              var text = (el.innerText || el.textContent || '').trim();
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
        var sidebarEl = document.querySelector('.soloaisidebar, .task-list-panel');
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
        var sidebarEl = document.querySelector('.soloaisidebar, .task-list-panel');
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
        var sidebar = document.querySelector('.soloaisidebar, .task-list-panel');
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
 * Query the chat panel or the standalone Agent's latest turn for task state.
 */
async function _queryIdeTaskPanel(driver, skipText, options = {}) {
  const safePanelSels = driver.config.ideTaskPanelSelectors.map(s => safeJsValue(s));
  const standalone = driver.traeAdapter?.environment?.target?.workspaceKind === 'agent';

  const result = await driver.client.send('Runtime.evaluate', {
    expression: `
      (function() {
        var standalone = ${standalone};
        var sels = [${safePanelSels.join(', ')}];
        var panel = null;
        var sessionId = '';
        if (standalone) {
          var selected = document.querySelectorAll('.task-list-panel .taskItem.taskItemSelected');
          if (selected.length === 1) {
            var row = selected[0].closest('.task-list-row-wrapper[data-session-id]');
            sessionId = (row?.getAttribute('data-session-id') || '').trim();
          }
          var latestTurns = Array.from(document.querySelectorAll('.turn.turn--last')).filter(function(el) {
            return el.offsetParent !== null;
          });
          if (latestTurns.length !== 1) return { structuredPanel: true, turns: [], sessionId: sessionId };
          panel = latestTurns[0];
        } else {
          for (var i = 0; i < sels.length; i++) {
            var el = document.querySelector(sels[i]);
            if (el && el.offsetParent !== null && el !== document.body && el !== document.documentElement
              && !/(?:^|\\s)monaco-workbench(?:\\s|$)/.test(String(el.className || ''))) {
              panel = el;
              break;
            }
          }
        }
        if (!panel) return null;

        var fullText = (panel.innerText || panel.textContent || '').trim();
        var structuredPanel = /(?:^|\\s)virtualized-message-list-view__virtuoso(?:\\s|$)/.test(String(panel.className || ''));
        var turnSource = panel;
        if (structuredPanel) {
          var currentTurns = Array.from(panel.querySelectorAll('.turn')).filter(function(el) {
            return el.offsetParent !== null;
          });
          if (currentTurns.length) turnSource = currentTurns[currentTurns.length - 1];
        }
        var messageSelectors = standalone
          ? '.turn__user-message[data-role="user"], .turn__agent-message'
          : 'section.chat-turn, section[class*="chat-turn"], .chat-message, .agent-message, [class*="chat-message"], .turn__agent-message, [data-role="user"], [data-role="assistant"]';
        var turns = Array.from(turnSource.querySelectorAll(messageSelectors)).filter(function(el) {
          return el && el.offsetParent !== null && (!standalone || el.closest('.turn') === panel);
        }).map(function(el) {
          var className = (el.className || '').toString();
          var structuredTask = /(?:^|\\s)turn__agent-message(?:\\s|$)/.test(className);
          var userBodies = standalone && el.getAttribute('data-role') === 'user'
            ? Array.from(el.querySelectorAll('.user-message__text-content')).filter(function(body) { return body.offsetParent !== null; })
            : [];
          var summaries = Array.from(el.querySelectorAll('.core-finish-card__summary .markdown-renderer'))
            .filter(function(summary) { return summary.offsetParent !== null; })
            .map(function(summary) { return (summary.innerText || summary.textContent || '').trim(); })
            .filter(Boolean);
          var finalText = summaries.length ? summaries[summaries.length - 1] : '';
          var interrupted = Array.from(el.querySelectorAll('.latest-assistant-bar .status-text'))
            .some(function(status) {
              return status.offsetParent !== null
                && !status.closest('.markdown-renderer, .chat-markdown, pre, code')
                && (status.innerText || status.textContent || '').trim() === '手动终止输出';
            });
          return {
            className: className + ' ' + (el.getAttribute('data-role') || ''),
            ariaLabel: (el.getAttribute('aria-label') || '').toString(),
            text: ((el.innerText || el.textContent || '').trim() || ''),
            nativeUserText: userBodies.length === 1 ? (userBodies[0].innerText || userBodies[0].textContent || '').trim() : '',
            finalText: finalText,
            taskComplete: structuredTask ? !!finalText : null,
            interrupted: interrupted
          };
        }).filter(function(turn) {
          return !!turn.text;
        });

        var completeIndicator = Array.from(panel.querySelectorAll(
          '.latest-assistant-bar .status-text, [class*="latest-assistant-bar"] [class*="status-text"]'
        )).some(function(el) {
          return /\u4efb\u52a1\u5b8c\u6210|Task completed/i.test((el.innerText || el.textContent || '').trim());
        });
        var runningIndicator = Array.from((standalone ? document : panel).querySelectorAll(
          '.codicon-stop-circle, [class*="stop-circle"], .run-command-inline-header__status-label, [class*="status-label"]'
        )).some(function(el) {
          if (!el || el.offsetParent === null || !el.getBoundingClientRect) return false;
          if (standalone && el.closest('.turn') && !panel.contains(el)) return false;
          var rect = el.getBoundingClientRect();
          if (rect.width <= 4 || rect.height <= 4) return false;
          var text = (el.innerText || el.textContent || '').trim();
          var cls = String(el.className || '');
          return /stop-circle/i.test(cls) || /\u547d\u4ee4(?:\u8fd0\u884c|\u6267\u884c)\u4e2d|\u6b63\u5728\u6267\u884c|running/i.test(text);
        });

        return {
          fullText: fullText,
          turns: turns,
          standalone: standalone,
          sessionId: sessionId,
          structuredPanel: standalone || structuredPanel,
          taskComplete: completeIndicator && !runningIndicator,
          taskInProgress: runningIndicator
        };
      })()
    `,
    returnByValue: true
  });

  const panelState = result.result?.value;
  if (!standalone) return _extractLatestIdeAssistantState(panelState, skipText, options);
  const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
  const userMessages = (panelState?.turns || []).filter(turn => turn.className.split(/\s+/).includes('turn__user-message'));
  const expectedTask = normalize(options.expectedTask);
  const latestUser = userMessages.length === 1 ? userMessages[0] : null;
  const latestUserText = normalize(expectedTask ? latestUser?.nativeUserText : latestUser?.nativeUserText || latestUser?.text);
  const expectedSessionId = typeof options.expectedSessionId === 'string' ? options.expectedSessionId.trim() : '';
  const pendingUserText = normalize(driver._pendingUserTask);
  const matchedUser = expectedTask ? latestUserText === expectedTask : Boolean(pendingUserText && latestUserText.includes(pendingUserText));
  const nativeOwnershipPending = Boolean((expectedSessionId && panelState?.sessionId !== expectedSessionId)
    || (expectedTask && !matchedUser));
  if (!nativeOwnershipPending && (expectedTask || !pendingUserText || !latestUserText || matchedUser)) {
    const state = _extractLatestIdeAssistantState(panelState, matchedUser ? '' : skipText, options);
    if (state) {
      return {
        ...state,
        standalone: true,
        matchedUser,
        ...(state.nativeFinalReply && expectedSessionId && expectedTask
          ? { nativeTurnOwnership: { sessionId: panelState.sessionId, taskText: latestUserText } }
          : {})
      };
    }
  }
  return {
    text: '', inProgress: true, isComplete: false, hasResponse: false, awaitingAssistant: true, standalone: true,
    nativeOwnershipPending
  };
}

function _extractLatestIdeAssistantState(panelState, skipText, options = {}) {
  if (!panelState) return null;

  const turns = Array.isArray(panelState.turns) ? panelState.turns : [];
  const fullText = String(panelState.fullText || '').trim();
  const normalizedSkip = String(skipText || '').replace(/\s+/g, ' ').trim();
  if (!turns.length) {
    if (panelState.structuredPanel) {
      return { text: '', inProgress: true, isComplete: false, hasResponse: false, awaitingAssistant: true };
    }
    if (!fullText || (normalizedSkip && fullText.replace(/\s+/g, ' ').trim() === normalizedSkip)) {
      return null;
    }
    return {
      text: fullText.slice(0, 500),
      inProgress: panelState.taskInProgress === true,
      isComplete: panelState.taskInProgress !== true && (panelState.taskComplete === true || fullText.includes('任务完成') || fullText.includes('已完成')),
      hasResponse: panelState.taskInProgress !== true && fullText.length > 20
    };
  }

  const normalizedTurns = turns
    .map(turn => ({
      className: String(turn.className || ''),
      ariaLabel: String(turn.ariaLabel || ''),
      text: String(turn.text || '').trim(),
      finalText: String(turn.finalText || '').trim(),
      taskComplete: typeof turn.taskComplete === 'boolean' ? turn.taskComplete : null,
      interrupted: turn.interrupted === true
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
  const latestText = String(
    options.detailLevel === 'trace'
      ? latestAssistant?.text
      : (latestAssistant?.finalText || latestAssistant?.text)
  ).trim();
  const normalizedLatest = latestText.replace(/\s+/g, ' ').trim();
  if (!latestText || (normalizedSkip && normalizedLatest === normalizedSkip)) {
    return null;
  }
  if (latestAssistant.interrupted) {
    return {
      text: latestAssistant.text,
      inProgress: false,
      isComplete: false,
      hasResponse: false,
      interrupted: true
    };
  }

  const latestLower = normalizedLatest.toLowerCase();
  const hasTaskCompletionState = typeof latestAssistant.taskComplete === 'boolean';
  const structurallyComplete = (hasTaskCompletionState ? latestAssistant.taskComplete : panelState.taskComplete) === true
    && panelState.taskInProgress !== true;
  const structurallyInProgress = panelState.taskInProgress === true
    || (hasTaskCompletionState && !latestAssistant.taskComplete);
  const percentageProgress = `${fullText} ${latestText}`.match(/(?:\u4efb\u52a1\u5b8c\u6210|completed?)\s*[:：]?\s*(\d{1,3})\s*%/i);
  const hasIncompletePercentage = Boolean(!structurallyComplete && percentageProgress && Number(percentageProgress[1]) < 100);
  const inProgress = (
    structurallyInProgress ||
    (!structurallyComplete && (
      hasIncompletePercentage ||
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
    ))
  );
  const isComplete = (
    structurallyComplete || (!hasTaskCompletionState && !hasIncompletePercentage && (
      latestText.includes('任务完成') ||
      latestText.includes('已完成') ||
      fullText.includes('任务完成')
    ))
  );

  return {
    text: latestText,
    inProgress,
    isComplete: isComplete || (latestText.includes('完成') && !inProgress),
    hasResponse: (structurallyComplete && !!latestAssistant.finalText) || (!inProgress && latestText.length > 20),
    ...(panelState.standalone && structurallyComplete && latestAssistant.finalText ? { nativeFinalReply: true } : {}),
    // Keep the process and final summary from this one assistant snapshot.
    // Completion collection decides when they can be persisted for the task.
    ...(structurallyComplete && latestAssistant.finalText
      ? { traceText: latestAssistant.text } : {})
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
async function _queryTaskSource(driver, skipText, options = {}) {
  if (driver.traeAdapter?.environment?.target?.workspaceKind === 'agent') {
    return _queryIdeTaskPanel(driver, skipText, options);
  }
  const modeInfo = await driver.detectMode();
  if (modeInfo.mode === 'solo') {
    const soloMessage = await driver.client.send('Runtime.evaluate', {
      expression: `(() => {
        const sidebar = document.querySelector('.soloaisidebar, .task-list-panel');
        const composer = document.querySelector('.chat-input-v2-input-box-editable, [class*="input-box"]');
        const soloTopLevelTurns = Array.from(document.querySelectorAll('.chat-turn'))
          .filter(el => el.offsetParent !== null && !(sidebar && sidebar.contains(el)) && !(composer && composer.contains(el)))
          .map(el => {
            const finalBlocks = Array.from(el.querySelectorAll('.chat-markdown'))
              .filter(block => block.offsetParent !== null && !block.parentElement?.closest('.chat-markdown'))
              .map(block => (block.innerText || block.textContent || '').trim())
              .filter(text => text.length > 20);
            const interrupted = Array.from(el.querySelectorAll('.latest-assistant-bar .status-text'))
              .some(status => status.offsetParent !== null
                && !status.closest('.markdown-renderer, .chat-markdown, pre, code')
                && (status.innerText || status.textContent || '').trim() === '手动终止输出');
            return {
              className: [el.className || '', el.getAttribute('data-role') || ''].join(' '),
              ariaLabel: el.getAttribute('aria-label') || '',
              text: (el.innerText || el.textContent || '').trim(),
              finalText: finalBlocks[finalBlocks.length - 1] || '',
              interrupted
            };
          })
          .filter(turn => turn.text);
        if (!soloTopLevelTurns.length) return null;
        const fullText = soloTopLevelTurns.map(turn => turn.text).join('\\n');
        const latestText = soloTopLevelTurns[soloTopLevelTurns.length - 1].text;
        const runningIndicator = Array.from(document.querySelectorAll('.codicon-stop-circle, [class*="stop-circle"]'))
          .some(el => el.offsetParent !== null);
        return {
          soloTopLevelTurns: true,
          fullText,
          turns: soloTopLevelTurns,
          taskComplete: !runningIndicator && /任务完成|Task completed/i.test(latestText),
          taskInProgress: runningIndicator
        };
      })()`,
      returnByValue: true
    });
    if (soloMessage.result?.value?.soloTopLevelTurns === true) {
      const soloState = _extractLatestIdeAssistantState(soloMessage.result.value, skipText, options);
      if (soloState) return soloState;
    }
    const panelState = await _queryIdeTaskPanel(driver, skipText, options);
    if (panelState) return panelState;
    return _queryTaskSidebar(driver, skipText);
  }
  return _queryIdeTaskPanel(driver, skipText, options);
}

async function findTaskResponse(driver, options = {}) {
  const skipText = driver._lastTaskText;

  const taskResult = await driver._queryTaskSource(skipText, options);
  if (taskResult) return taskResult;

  // SOLO fallback: sidebar full-text scan for task blocks
  const modeInfo = await driver.detectMode();
  if (modeInfo.mode === 'solo') {
    const safeSkipText = safeJsValue(skipText);
    const result = await driver.client.send('Runtime.evaluate', {
      expression: `
        (() => {
          let sidebar = document.querySelector('.soloaisidebar, .task-list-panel');
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
  getWorkspaceContext,
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
