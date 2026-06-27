'use strict';

/**
 * ResponsePoller — polls for and collects assistant responses.
 * Extracted from DomDriver to isolate response-polling responsibility.
 */

const { safeJsValue, sleep } = require('../shared/utils');
const { sanitizeActivityText, isTruncationSignal } = require('./driver-config');
const { hasCompletionMarker, cleanAssistantResultText } = require('./dom-driver-utils');

class ResponsePoller {
  constructor(client, config, modeDetector, taskStateManager, dialogHandler, textExtractor, coordinator) {
    this.client = client;
    this.config = config;
    this.modeDetector = modeDetector;
    this.taskStateManager = taskStateManager;
    this.dialogHandler = dialogHandler;
    this.textExtractor = textExtractor;
    this.coordinator = coordinator;

    // Shared state (set by DomDriver coordinator)
    this._lastTaskText = '';
    this._pendingUserTask = '';
    this._preSendSnapshot = '';
    this._lastApprovalCheckAt = undefined;
    this._approvalDialogFirstSeenAt = undefined;
  }

  /**
   * Core polling method. Checks multiple response sources in priority order.
   */
  async _pollResponseState() {
    const skipText = this._lastTaskText;
    const safeResponseSelectors = this.config.responseSelectors.map(s => safeJsValue(s));
    const safeActivitySelectors = this.config.activitySelectors.map(s => safeJsValue(s));
    const safeIdeResponseSelectors = this.config.ideResponseSelectors.map(s => safeJsValue(s));

    const modeInfo = await this.modeDetector.detectMode();
    const isIdeMode = modeInfo.mode === 'ide';

    const taskSourceResult = await this.taskStateManager.queryTaskSource(skipText);

    const result = await this.client.send('Runtime.evaluate', {
      expression: `
        (function() {
          var result = { taskComplete: false, taskText: '', taskInProgress: false, responseText: '' };

          ${isIdeMode ? `
          var ideSels = [${safeIdeResponseSelectors.join(', ')}];
          for (var i = 0; i < ideSels.length; i++) {
            var el = document.querySelector(ideSels[i]);
            if (el && el.textContent.trim() && el.textContent.trim().length > 10) {
              result.responseText = el.textContent.trim();
              break;
            }
          }
          ` : ''}

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
      const contentScan = await this.textExtractor.scanContentArea();
      if (contentScan && contentScan.areaFound && contentScan.text && contentScan.text.length > 20) {
        state.responseText = contentScan.text;
      }
    }

    if (!state.responseText || state.responseText.length < 10) {
      const bodyText = await this.textExtractor.captureVisibleText();
      if (bodyText && bodyText.length > 20) {
        state.responseText = bodyText;
      }
    }

    return state;
  }

  /**
   * Mode-aware response collection.
   */
  async collectResponse() {
    const dialog = await this.coordinator.checkForApprovalDialog();
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

    const modeInfo = await this.coordinator.detectMode();
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
        const state = await this.coordinator._pollResponseState();
        if (state.awaitingAssistant) {
          lastText = '';
          stableCount = 0;
          await sleep(pollInterval);
          continue;
        }
        const reviewGate = await this.coordinator.checkTaskReviewGate();
        if (reviewGate.awaitingReview && reviewGate.taskCompleted) {
          const gateResolution = await this.coordinator.resolveTaskReviewGate('keep_all');
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
        const approvalCheckInterval = this.config.approvalPollIntervalMs || 3000;
        if (this._lastApprovalCheckAt === undefined || (Date.now() - this._lastApprovalCheckAt) >= approvalCheckInterval) {
          const approvalDialog = await this.coordinator.checkForApprovalDialog();
          this._lastApprovalCheckAt = Date.now();
          if (approvalDialog.needsApproval) {
            if (approvalDialog.isCommandExec) {
              this._approvalDialogFirstSeenAt = undefined;
              this._lastApprovalCheckAt = undefined;
              const approveResult = await this.coordinator.approveDialog('trust');
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
        if (!completionLooksStale && hasTaskText && state.taskComplete) {
          const text = cleanAssistantResultText(sanitizeActivityText(state.taskText || ''));
          if (this.coordinator._isModelErrorResponseText(text)) {
            cleanup();
            return { text, stable: false, elapsedMs: Date.now() - startTime, modelError: true, error: 'Trae model request failed' };
          }
          if (text && !this.coordinator._isIncompleteResponseText(text)) { cleanup(); return { text, stable: true, elapsedMs: Date.now() - startTime }; }
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

        if ((!currentText || currentText.length <= 10 || this.coordinator._isIncompleteResponseText(currentText)) && isIdeMode) {
          const panelText = await this.textExtractor.captureIdePanelText();
          if (panelText) {
            currentText = cleanAssistantResultText(sanitizeActivityText(panelText));
          }
        }

        if ((!currentText || currentText.length <= 10 || this.coordinator._isIncompleteResponseText(currentText)) && !isIdeMode) {
          const contentScan = await this.textExtractor.scanContentArea();
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
          if (stableCount >= effectiveRequiredStable && this.coordinator._isModelErrorResponseText(currentText)) {
            cleanup();
            return { text: currentText, stable: false, elapsedMs: Date.now() - startTime, modelError: true, error: 'Trae model request failed' };
          }
          if (stableCount >= effectiveRequiredStable && !this.coordinator._isIncompleteResponseText(currentText)) {
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
}

module.exports = { ResponsePoller };
