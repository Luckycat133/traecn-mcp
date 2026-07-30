'use strict';

/**
 * QueueStateMachine — owns task lifecycle states and transitions for the
 * delegated task queue.
 *
 * Responsibilities:
 *   - Status enums and mapping rules (queue state -> task status, history
 *     status mapping, terminal-state checks).
 *   - Snapshot computation: build / update the per-task queue snapshot
 *     fields (queueState, queuePosition, lastQueueSeenAt, currentModel,
 *     queueEstimatedWait, queueMessage, queueCanSubmit).
 *   - Recent-snapshot carry-over (flicker grace) so callers that poll too
 *     quickly after submission still see a queued task.
 *   - Result-classification helpers (reviewable / successful / queue
 *     notice / queued-task-result / incomplete-review-text /
 *     default-question-dialog-answer) used by the orchestrator and the
 *     background poller.
 *   - Lock management helpers (tryAcquire / release).
 *   - Deadline extension while a queue is still active.
 *   - Model-switch normalisation (string sentinel or object -> uniform shape).
 *
 * The class is stateful in the sense that it holds the `taskLocks` Map,
 * but exposes only methods — internal state is not part of the public API.
 */

const { getEnvWithFallback, parsePositiveInt } = require('../shared/utils');

const DEFAULT_QUEUE_FLICKER_GRACE_MS = 45000;

class QueueStateMachine {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    // taskLocks is a Map<taskId, boolean>; tryAcquire returns true on first claim.
    this.taskLocks = new Map();
  }

  // ── per-task atomic claim ──────────────────────────────────────────────

  /**
   * Atomically claim a task id. Returns true on the first successful claim,
   * false if the id is already held. The caller MUST call `release(taskId)`
   * once the work is done (success or failure).
   */
  tryAcquire(taskId) {
    if (!taskId) return false;
    if (this.taskLocks.has(taskId)) return false;
    this.taskLocks.set(taskId, true);
    return true;
  }

  release(taskId) {
    if (taskId) this.taskLocks.delete(taskId);
  }

  // ── queue-snapshot helpers ─────────────────────────────────────────────

  getFlickerGraceMs() {
    const configured = getEnvWithFallback('TRAECN_QUEUE_FLICKER_GRACE_MS', 'TRAE_QUEUE_FLICKER_GRACE_MS', DEFAULT_QUEUE_FLICKER_GRACE_MS);
    return parsePositiveInt(configured, DEFAULT_QUEUE_FLICKER_GRACE_MS);
  }

  hasRecentSubmittedSnapshot(task, now = Date.now()) {
    if (!task || task.status !== 'executing' || task.submittedToTrae !== true) return false;
    if (task.queueState !== 'queued') return false;
    if (!task.lastQueueSeenAt) return false;
    return now - task.lastQueueSeenAt <= this.getFlickerGraceMs();
  }

  /**
   * If `taskQueue` contains a recently-submitted task that hasn't yet been
   * polled back into a fresh status, carry the snapshot over so callers
   * (e.g. /api/queue/status) still see "queued".
   */
  applyRecentSnapshot(status, taskQueue) {
    if (!taskQueue) return status;
    if (status.queued === true || status.running === true) return status;
    const task = Array.from(taskQueue.values()).find(candidate => this.hasRecentSubmittedSnapshot(candidate));
    if (!task) return status;
    const message = task.queueMessage || status.queueMessage || status.message || null;
    return {
      ...status,
      queued: true,
      running: false,
      canSubmit: false,
      currentModel: task.currentModel || status.currentModel || null,
      queuePosition: task.queuePosition || null,
      position: task.queuePosition || status.position || null,
      queueEstimatedWait: task.queueEstimatedWait || status.queueEstimatedWait || null,
      queueMessage: message,
      message,
      queueSnapshotSource: 'recent_submitted_task'
    };
  }

  /**
   * Compute the public queue-details block the handlers expose.
   */
  getDetailsFromStatus(queueStatus = {}, fallbackModel = null) {
    return {
      state: queueStatus.running ? 'running' : (queueStatus.queued ? 'queued' : 'ready'),
      currentModel: queueStatus.currentModel || fallbackModel || null,
      queuePosition: queueStatus.queuePosition || queueStatus.position || null,
      queueEstimatedWait: queueStatus.queueEstimatedWait || null,
      queueMessage: queueStatus.queueMessage || queueStatus.message || null,
      canSubmit: queueStatus.canSubmit === true
    };
  }

  /**
   * Normalise whatever the driver's `switchModel` returns into a uniform
   * `{ success, model?, error?, switchResult }` shape. The driver may
   * return a plain object or a string sentinel; both are accepted.
   */
  normalizeModelSwitchResult(switchResult) {
    return typeof switchResult === 'object' && switchResult !== null
      ? switchResult
      : {
          success: !String(switchResult || '').startsWith('model_switch_blocked') &&
            !String(switchResult || '').startsWith('no model items') &&
            !String(switchResult || '').startsWith('model not found'),
          switchResult
        };
  }

  // ── deadline extension while queue is active ───────────────────────────

  maybeExtendDeadline(task, queueStatus) {
    if (!task || !task.deadline || !task.maxDeadline) return false;
    const now = Date.now();
    if (now <= task.deadline) return false;
    const queueStillActive = queueStatus.queued === true || queueStatus.running === true;
    if (!queueStillActive) return false;
    if (now >= task.maxDeadline) return false;
    const extensionMs = 600000;
    task.deadline = Math.min(task.maxDeadline, now + extensionMs);
    task.timeoutExtensions = (task.timeoutExtensions || 0) + 1;
    return true;
  }

  updateSnapshot(task, queueStatus = {}) {
    const queueActive = queueStatus.running === true || queueStatus.queued === true;
    if (queueActive) {
      task.lastQueueSeenAt = Date.now();
    }

    const keepRecentQueue = !queueActive && this.hasRecentSubmittedSnapshot(task);
    task.queueState = queueStatus.running ? 'running' : (queueStatus.queued || keepRecentQueue ? 'queued' : 'ready');
    task.queuePosition = (queueActive || keepRecentQueue) ? (queueStatus.queuePosition || queueStatus.position || task.queuePosition || null) : null;
    task.currentModel = queueStatus.currentModel || task.currentModel || null;
    task.queueEstimatedWait = (queueActive || keepRecentQueue) ? (queueStatus.queueEstimatedWait || task.queueEstimatedWait || null) : null;
    task.queueMessage = (queueActive || keepRecentQueue) ? (queueStatus.queueMessage || queueStatus.message || task.queueMessage || null) : null;
    task.queueCanSubmit = keepRecentQueue ? false : queueStatus.canSubmit === true;
  }

  // ── result-classification helpers ──────────────────────────────────────
  //
  // These are pure functions: they don't touch Gateway state, they only
  // shape a `result` blob. They mirror the previous private methods so the
  // existing call sites in gateway.js can keep working.

  isReviewableResult(result) {
    if (!result || result.needsApproval) return false;
    if (result.timedOut || result.truncated || result.streaming || result.modelError) return false;
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    if (!text) return false;
    if (text.length < 80) return false;
    if (this._isWorkbenchChromeResultText(text)) return false;
    if (this._isFailedResultText(text)) return false;
    if (this.isIncompleteReviewText(text)) return false;
    if (/^solo\s*agent\s*思考中/i.test(text)) return false;
    if (/^调用技能[:：]/i.test(text)) return false;
    if (/^(i'll|i will)\s+start\b/i.test(text)) return false;
    if (/\blet me start\b/i.test(text)) return false;
    if (/^(thought|思考过程)\b/i.test(text)) return false;
    if (/^(好的|收到|明白|了解|我来|正在|开始|ok|okay|sure|got it|understood|alright)\b/i.test(text)) return false;
    return result.stable === true;
  }

  isSuccessfulResult(result) {
    if (!result || result.needsApproval) return false;
    if (result.timedOut || result.truncated || result.streaming || result.modelError) return false;
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    if (!this._hasMeaningfulResultText(text) || this._isWorkbenchChromeResultText(text) || this._isFailedResultText(text) || this.isIncompleteReviewText(text)) return false;
    return result.stable === true;
  }

  looksLikeQueueNotice(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return false;
    return [
      /排队提醒/,
      /当前模型请求量较高/,
      /排在第\s*\d+\s*位/,
      /升级权益.*速通/,
      /\bqueue\s+position\b/i,
      /\byou(?:'re| are)?\s+(?:still\s+)?in\s+(?:the\s+)?queue\b/i
    ].some(pattern => pattern.test(value));
  }

  isQueuedTaskResult(result) {
    if (!result || result.needsApproval || result.modelError) return false;
    if (result.queued === true) return true;
    const text = typeof result.text === 'string' ? result.text : '';
    return result.timedOut === true && result.stable !== true && this.looksLikeQueueNotice(text);
  }

  isIncompleteReviewText(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return true;
    const percentageProgress = value.match(/(?:\u4efb\u52a1\u5b8c\u6210|completed?)\s*[:：]?\s*(\d{1,3})\s*%/i);
    if (percentageProgress && Number(percentageProgress[1]) < 100) return true;
    const hasStructuredReportMarker = /^(?:TRAECNclaw\s+)?Code\s+Review\s*[—-]\s*Findings\s+First\b/i.test(value)
      || (/\b1\.\s*Findings\s*\(ordered by severity\)/i.test(value) && /\b(?:final verdict|review complete)\b/i.test(value));
    // 120 = minimum text length (chars) for a marker to count as a real
    // structured completion; shorter text is treated as incomplete /
    // placeholder. Same threshold semantics as BatchExecutor's
    // _hasStrongCompletionEvidence.
    if (hasStructuredReportMarker && value.length >= 120) return false;
    const hasCompletionMarker = /任务完成|所有测试通过|测试已通过|已完成。以下是|已完成，以下是|completed successfully|all tests pass(?:ed)?|delivery summary|final report/i.test(value);
    if (hasCompletionMarker && value.length >= 120) return false;
    return [
      /(?:^|\s)\d+\s*\/\s*\d+\s*已完成/i,
      /思考中[.。…]*/i,
      /\bthought\b/i,
      /\blet me (now )?(look|check|read|inspect|explore|review)\b/i,
      /调用技能[:：]/i
    ].some(pattern => pattern.test(value));
  }

  defaultQuestionDialogAnswer(result = {}, action = 'auto') {
    if (action && !['auto', 'trust', 'allow', 'confirm', 'approve'].includes(String(action).toLowerCase())) {
      return String(action).replace(/^answer:/i, '').trim();
    }
    const options = Array.isArray(result.options) ? result.options : [];
    const labels = options
      .map(option => typeof option === 'string' ? option : (option.label || option.description || ''))
      .filter(Boolean);
    return labels.find(label => /current|workspace|uncommitted|staged|工作区|未提交/i.test(label))
      || labels[0]
      || 'Current workspace changes';
  }

  // ── helpers used by isReviewableResult / isSuccessfulResult ────────────

  _hasMeaningfulResultText(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return false;
    if (/^(agent|assistant|thought|思考过程)$/i.test(value)) return false;
    return value.length >= 12 || /任务完成|findings|finding|p[0-3]|问题|风险|建议|结论|完成|done/i.test(value);
  }

  _isFailedResultText(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return false;
    return [
      '手动终止输出',
      '异常打断',
      '模型请求失败',
      '服务商错误',
      'manual stop',
      'manually stopped',
      'cancelled output',
      'generation stopped'
    ].some(pattern => value.toLowerCase().includes(pattern.toLowerCase()));
  }

  _isWorkbenchChromeResultText(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return false;
    const hasWorkbenchChrome = /^SOLO\s+IDE\s+搜索\b/i.test(value)
      || (value.includes('资源管理器 文件') && value.includes('TRAE 与 Agent 协作'))
      || (value.includes('Claude Code 与 AI 对话') && value.includes('Editor 内 AI 编码'))
      || (value.includes('历史记录') && value.includes('速通') && value.includes('main*'));
    if (!hasWorkbenchChrome) return false;
    const hasAssistantResultSignal = /TRAECNclaw\s+Code\s+Review|(^|\s)Findings[:\s]|任务完成|最终报告|final report|\bP[0-3]\b|问题[:：]|建议[:：]|测试通过|completed successfully/i.test(value);
    return !hasAssistantResultSignal;
  }
}

module.exports = { QueueStateMachine };
