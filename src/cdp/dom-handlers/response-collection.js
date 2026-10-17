'use strict';

/**
 * response-collection handlers.
 *
 * Moved verbatim from src/cdp/dom-driver.js. Each method is now an
 * exported function with signature `function method(driver, ...args)`
 * taking the DomDriver instance as `driver`. Behavior is preserved 1:1.
 *
 * Covers: response-text cleanup helpers (final-report extraction,
 * completion-marker detection, role wrappers) and the polling/collect
 * loop that streams the assistant reply out of the page.
 *
 * The DomDriver retains thin delegating shims so existing
 * dom-driver.test.js cases that call `driver._pollResponseState()`
 * and `driver.collectResponse()` continue to work unchanged.
 */

const { sleep, safeJsValue } = require('../../shared/utils');
const { sanitizeActivityText, isTruncationSignal } = require('../driver-config');

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

function chooseReviewGateAction(state = {}) {
  if (state.modelError === true) return 'revert_all';
  const text = String(state.taskText || state.responseText || '').replace(/\s+/g, ' ').trim();
  const fatalFailure = [
    /\bfatal(?: error)?\b/i,
    /repository (?:is |may be )?corrupt(?:ed|ion)/i,
    /permission denied.{0,120}(?:writ|modif|apply)/i,
    /(?:could not|unable to) apply (?:the )?changes safely/i,
    /无法安全(?:应用|写入|保留)(?:这些)?(?:更改|修改)/i,
    /仓库(?:可能)?(?:已)?损坏/i
  ].some(pattern => pattern.test(text));
  return fatalFailure ? 'revert_all' : 'keep_all';
}

const FINAL_ASSISTANT_RESULT_MARKERS = [
  /(^|\n)[ \t]*完成总结(?=[ \t]*(?:[:：]|\n|$))/,
  /TRAECNclaw\s+Code\s+Review\s*[—-]\s*Findings\s+First/i,
  /Code\s+Review\s*[—-]\s*Findings\s+First/i,
  /(^|\n)\s*Findings\s*\(ordered\s+by\s+severity\)/i,
  /(^|\n)\s*1\.\s+Findings\b/i,
  /(^|\n)\s*Findings\s*[:：]/i,
  /(?:Thought\s*)?Bug\s+found\s*(?:\(|[:：]|\b)/i,
  /\bLikely\s+bug\s*[:：]/i
];

function findLastMarkerIndex(value, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  let lastIndex = -1;
  let match;
  while ((match = globalPattern.exec(value)) !== null) {
    lastIndex = match.index;
    if (match[0] && match[0].startsWith('\n')) {
      lastIndex += 1;
    }
    const bugFoundOffset = match[0] ? match[0].search(/Bug\s+found/i) : -1;
    if (bugFoundOffset > 0) {
      lastIndex += bugFoundOffset;
    }
    if (match[0] === '') {
      globalPattern.lastIndex += 1;
    }
  }
  return lastIndex;
}

function extractFinalAssistantResultText(text) {
  const value = String(text || '').trim();
  if (!value) return '';

  const lower = value.toLowerCase();
  const hasProcessTranscript = (
    value.length > 1000 ||
    value.includes('调用技能') ||
    value.includes('思考过程') ||
    value.includes('任务完成') ||
    lower.includes('thought') ||
    lower.includes('tool') ||
    lower.includes('review complete')
  );
  if (!hasProcessTranscript) return value;

  let markerIndex = -1;
  for (const marker of FINAL_ASSISTANT_RESULT_MARKERS) {
    const foundIndex = findLastMarkerIndex(value, marker);
    if (foundIndex < 0) continue;
    if (markerIndex < 0 || foundIndex > markerIndex + 80) {
      markerIndex = foundIndex;
    } else if (foundIndex >= markerIndex) {
      markerIndex = Math.min(markerIndex, foundIndex);
    }
  }

  if (markerIndex > 0) {
    return value.slice(markerIndex).trim();
  }
  return value;
}

function cleanAssistantResultText(text) {
  const value = extractFinalAssistantResultText(text);
  if (!value) return '';
  return value
    .replace(/^(Agent|Assistant)\s*(Thought|思考过程)\s*/i, '')
    .replace(/^(Agent|Assistant)\s+/i, '')
    .replace(/\s*(任务完成|Task completed)\s*$/i, '')
    .trim();
}

/**
 * Core polling method. Checks multiple response sources in priority order:
 * 1. Mode-specific response selectors (sidebar for SOLO, chat panel for IDE)
 * 2. Configured response selectors (generic fallback)
 * 3. Broad content area scan (heuristic-based)
 * 4. Body text diffing (last resort)
 */
async function _pollResponseState(driver) {
  const skipText = driver._lastTaskText;
  const safeResponseSelectors = driver.config.responseSelectors.map(s => safeJsValue(s));
  const safeActivitySelectors = driver.config.activitySelectors.map(s => safeJsValue(s));
  const safeIdeResponseSelectors = driver.config.ideResponseSelectors.map(s => safeJsValue(s));

  const modeInfo = await driver.detectMode();
  const isIdeMode = modeInfo.mode === 'ide';

  // Mode-specific task source (sidebar for SOLO, chat panel for IDE)
  const taskSourceResult = await driver._queryTaskSource(skipText);
  if (taskSourceResult?.interrupted === true) {
    return {
      taskComplete: false,
      taskText: taskSourceResult.text || '',
      taskInProgress: false,
      responseText: '',
      interrupted: true
    };
  }

  const result = await driver.client.send('Runtime.evaluate', {
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
    if (typeof taskSourceResult.traceText === 'string' && taskSourceResult.traceText.trim()) {
      state.traceText = taskSourceResult.traceText;
    }
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
    const contentScan = await driver._scanContentArea();
    if (contentScan && contentScan.areaFound && contentScan.text && contentScan.text.length > 20) {
      state.responseText = contentScan.text;
    }
  }

  if (!state.responseText || state.responseText.length < 10) {
    const bodyText = await driver._captureVisibleText();
    if (bodyText && bodyText.length > 20) {
      state.responseText = bodyText;
    }
  }

  return state;
}

/**
 * Mode-aware response collection.
 * In SOLO mode: reads sidebar + heuristics (existing logic).
 * In IDE mode: reads chat panel messages + body text diff.
 */
async function collectResponse(driver, options = {}) {
  const startTime = Date.now();
  const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false;
  const stoppedResult = text => ({ text: text || '', stable: false, cancelled: true, elapsedMs: Date.now() - startTime });
  const pause = async ms => {
    const deadline = Date.now() + ms;
    while (!shouldStop() && Date.now() < deadline) {
      await sleep(Math.min(250, deadline - Date.now()));
    }
  };
  if (shouldStop()) return stoppedResult('');
  const dialog = await driver.checkForApprovalDialog();
  if (shouldStop()) return stoppedResult('');
  if (dialog.needsApproval) {
    return {
      text: '',
      stable: false,
      elapsedMs: 0,
      needsApproval: true,
      question: dialog.question,
      dialogType: dialog.dialogType,
      buttons: dialog.buttons || [],
      options: dialog.options || [],
      approvalDecision: dialog.approvalDecision || null,
      commandRisk: dialog.commandRisk || null,
      riskReasons: dialog.riskReasons || [],
      command: dialog.command || null
    };
  }

  const modeInfo = await driver.detectMode();
  const isIdeMode = modeInfo.mode === 'ide';

  const warmupMs = 3000;
  const requiredStable = 2;
  const pollInterval = driver.config.pollIntervalMs || 350;
  const queuePollInterval = driver.config.queuePollIntervalMs || 15000;
  let stableCount = 0;
  let warmingUp = true;
  let lastText = '';
  let initialText = null;
  let inQueueSince = null;
  let truncationSince = null;
  const truncationTimeout = 20000;
  let hasCheckedInitialSnapshot = false;

  const streamingBuffer = [];
  let streamingGrowthFrames = 0;
  const STREAMING_GROWTH_THRESHOLD = 3;

  const logHandler = (params) => {
    if (params.entry && params.entry.type === 'log' && params.entry.text) {
      const text = params.entry.text.trim();
      if (text.length > 0 && text.length < 10000) {
        streamingBuffer.push(text);
      }
    }
  };

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

  let listenersRegistered = false;
  try {
    await driver.client.send('Log.enable', {});
    driver.client.on('Log.entryAdded', logHandler);
    driver.client.on('Runtime.consoleAPICalled', consoleHandler);
    listenersRegistered = true;
    await pause(50);
  } catch {
    // Log enable failed
  }

  const cleanup = () => {
    if (!listenersRegistered) return;
    try {
      driver.client.off('Log.entryAdded', logHandler);
      driver.client.off('Runtime.consoleAPICalled', consoleHandler);
      listenersRegistered = false;
    } catch {
      // Listener cleanup is best-effort across CDP client implementations.
    }
  };

  try {
    while (Date.now() - startTime < driver.config.timeoutMs) {
      if (shouldStop()) return stoppedResult(lastText);
      const state = await driver._pollResponseState();
      if (shouldStop()) return stoppedResult(lastText);
      if (state.interrupted === true) {
        return {
          text: cleanAssistantResultText(sanitizeActivityText(state.taskText || '')),
          stable: false,
          interrupted: true,
          error: 'Trae task output was interrupted before completion',
          elapsedMs: Date.now() - startTime
        };
      }
      if (state.awaitingAssistant) {
        lastText = '';
        stableCount = 0;
        await pause(pollInterval);
        continue;
      }
      const completionCandidate = cleanAssistantResultText(sanitizeActivityText(state.taskText || state.responseText || ''));
      const completionLooksStale = completionCandidate && (
        (driver._preSendSnapshot && driver._preSendSnapshot.includes(completionCandidate)) ||
        (driver._lastTaskText && driver._lastTaskText.includes(completionCandidate))
      );
      const hasTaskText = !!String(state.taskText || '').trim();
      const reviewGate = await driver.checkTaskReviewGate();
      if (shouldStop()) return stoppedResult(lastText);
      if (reviewGate.awaitingReview && !completionLooksStale && hasTaskText && state.taskComplete === true) {
        const gateResolution = await driver.resolveTaskReviewGate(chooseReviewGateAction(state));
        if (gateResolution?.success !== true) {
          cleanup();
          return {
            text: completionCandidate,
            stable: false,
            elapsedMs: Date.now() - startTime,
            timedOut: false,
            needsApproval: false,
            reviewGatePending: true
          };
        }
        await pause(Math.max(driver.config.postActionDelayMs * 2, 500));
        if (shouldStop()) return stoppedResult(lastText);
      }
      let currentText = cleanAssistantResultText(sanitizeActivityText(state.taskText || state.responseText || ''));
      // Periodic dialog check during streaming - detect dialogs that appear mid-execution
      const approvalCheckInterval = driver.config.approvalPollIntervalMs || 3000;
      if (driver._lastApprovalCheckAt === undefined || (Date.now() - driver._lastApprovalCheckAt) >= approvalCheckInterval) {
        const approvalDialog = await driver.checkForApprovalDialog();
        if (shouldStop()) return stoppedResult(lastText);
        driver._lastApprovalCheckAt = Date.now();
        if (approvalDialog.transient) {
          continue;
        }
        if (approvalDialog.needsApproval) {
          const approvalDuration = Date.now() - (driver._approvalDialogFirstSeenAt || Date.now());
          if (driver._approvalDialogFirstSeenAt === undefined) {
            driver._approvalDialogFirstSeenAt = Date.now();
          }
          const approvalTimeoutMs = driver.config.approvalTimeoutMs || 120000;
          if (approvalDuration >= approvalTimeoutMs) {
            driver._approvalDialogFirstSeenAt = undefined;
            driver._lastApprovalCheckAt = undefined;
            cleanup();
            return {
              text: currentText || '',
              stable: false,
              elapsedMs: Date.now() - startTime,
              needsApproval: true,
              question: approvalDialog.question,
              dialogType: approvalDialog.dialogType,
              approvalDecision: approvalDialog.approvalDecision || null,
              commandRisk: approvalDialog.commandRisk || null,
              riskReasons: approvalDialog.riskReasons || [],
              command: approvalDialog.command || null,
              approvalTimedOut: true
            };
          }
          driver._approvalDialogFirstSeenAt = undefined;
          driver._lastApprovalCheckAt = undefined;
          cleanup();
          return {
            text: currentText || '',
            stable: false,
            elapsedMs: Date.now() - startTime,
            needsApproval: true,
            question: approvalDialog.question,
            dialogType: approvalDialog.dialogType,
            buttons: approvalDialog.buttons,
            approvalDecision: approvalDialog.approvalDecision || null,
            commandRisk: approvalDialog.commandRisk || null,
            riskReasons: approvalDialog.riskReasons || [],
            command: approvalDialog.command || null
          };
        }
      }


      if (!completionLooksStale && hasTaskText && state.taskComplete === true) {
        const text = cleanAssistantResultText(sanitizeActivityText(state.taskText || ''));
        if (driver._isModelErrorResponseText(text)) {
          cleanup();
          return { text, stable: false, elapsedMs: Date.now() - startTime, modelError: true, error: 'Trae model request failed' };
        }
        if (text && !driver._isIncompleteResponseText(text)) {
          cleanup();
          return {
            text,
            stable: true,
            elapsedMs: Date.now() - startTime,
            ...(state.traceText ? { traceText: state.traceText } : {})
          };
        }
      }

      const pendingTask = String(driver._pendingUserTask || '').replace(/\s+/g, ' ').trim();
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
        await pause(pollInterval);
        continue;
      }

      if ((!currentText || currentText.length <= 10 || driver._isIncompleteResponseText(currentText)) && isIdeMode) {
        // IDE mode fallback: prefer the chat panel before any broad content
        // scan, otherwise editor text can be mistaken for the assistant reply.
        const panelText = await driver._captureIdePanelText();
        if (panelText) {
          currentText = cleanAssistantResultText(sanitizeActivityText(panelText));
        }
      }

      if ((!currentText || currentText.length <= 10 || driver._isIncompleteResponseText(currentText)) && !isIdeMode) {
        const contentScan = await driver._scanContentArea();
        if (contentScan && contentScan.areaFound && contentScan.text) {
          currentText = cleanAssistantResultText(sanitizeActivityText(contentScan.text));
        }
      }

      if (initialText === null && currentText) initialText = currentText;

      if (warmingUp) {
        if (currentText !== initialText) { lastText = currentText; stableCount = 0; }
        if (Date.now() - startTime >= warmupMs) { warmingUp = false; lastText = currentText; }
        await pause(pollInterval);
        continue;
      }

      if (!hasCheckedInitialSnapshot && driver._preSendSnapshot) {
        hasCheckedInitialSnapshot = true;
        if (currentText && driver._preSendSnapshot.includes(currentText)) {
          currentText = '';
        }
      }

      let queuePosition = null;
      const queueMatch = currentText && currentText.match(/排在第\s*(\d+)\s*位/);
      if (queueMatch) queuePosition = parseInt(queueMatch[1], 10);

      const isQueued = currentText && (
        queuePosition !== null ||
        currentText.includes('排队') ||
        currentText.includes('等待') ||
        currentText.includes('队列') ||
        currentText.includes('等待中')
      );

      if (isQueued) {
        if (!inQueueSince) inQueueSince = Date.now();
        // Wait indefinitely until queue clears - no timeout on queue
        // The point is to persist until the request goes through
        lastText = currentText; await pause(queuePollInterval); continue;
      }

      inQueueSince = null;

      if (isTruncationSignal(currentText)) {
        if (!truncationSince) truncationSince = Date.now();
        if (Date.now() - truncationSince > truncationTimeout) {
          cleanup();
          return { text: currentText, stable: false, elapsedMs: Date.now() - startTime, truncated: true, timedOut: false };
        }
        lastText = currentText; await pause(pollInterval); continue;
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
        if (stableCount >= effectiveRequiredStable && driver._isModelErrorResponseText(currentText)) {
          cleanup();
          return { text: currentText, stable: false, elapsedMs: Date.now() - startTime, modelError: true, error: 'Trae model request failed' };
        }
        if (stableCount >= effectiveRequiredStable && !driver._isIncompleteResponseText(currentText)) {
          cleanup();
          return { text: currentText, stable: true, elapsedMs: Date.now() - startTime };
        }
      } else {
        stableCount = 0;
      }
      lastText = currentText;
      await pause(pollInterval);
    }

    const finalText = lastText || (streamingBuffer.length > 0 ? streamingBuffer.join(' ') : '');
    driver._pendingUserTask = '';
    cleanup();
    return { text: finalText, stable: false, elapsedMs: Date.now() - startTime, timedOut: true };
  } catch (err) {
    driver._pendingUserTask = '';
    cleanup();
    throw err;
  } finally {
    cleanup();
  }
}

module.exports = {
  hasCompletionMarker,
  chooseReviewGateAction,
  extractFinalAssistantResultText,
  cleanAssistantResultText,
  _pollResponseState,
  collectResponse
};
