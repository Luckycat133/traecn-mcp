'use strict';

/**
 * TaskQueueService — extracted from Gateway.
 *
 * Owns:
 *   - active-queue persistence (resolve path, persist, restore)
 *   - history-mirror sync (pushes task state into the global history store)
 *   - per-task atomic claim (`taskLocks` Map with tryAcquire)
 *   - serialized persist via a promise chain so concurrent updates don't
 *     race the file write
 *   - queue-snapshot helpers (create/update/extend, flicker grace, recent
 *     snapshot carry-over, model-switch normalisation)
 *   - result-classification helpers (reviewable, successful, queue notice,
 *     queued task, keep-submitted-waiting, default dialog answer,
 *     incomplete-review text)
 *   - background-polling timer with a per-task lock guard and the probe loop
 *     (the probe-loop body stays on Gateway; we expose it via callback so
 *     tests still exercise the same code path)
 *
 * Constructor takes dependencies explicitly; no `this.*` coupling to the
 * Gateway class. Methods that previously read state from `this.xxx` now
 * read from the corresponding property on `this` (the service instance) or
 * fall back to the injected dependencies.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getEnvWithFallback, parsePositiveInt } = require('../shared/utils');

const DEFAULT_MODEL_PROBE_INTERVAL_MS = 60000;
const DEFAULT_QUEUE_FLICKER_GRACE_MS = 45000;

class TaskQueueService {
  constructor({
    logger = console,
    persistencePath = null,
    taskHistoryStore = null,
    isMockBridge = () => false,
    isTerminalStatus = () => false,
  } = {}) {
    this.logger = logger;
    this.taskHistoryStore = taskHistoryStore;
    this.isMockBridge = typeof isMockBridge === 'function' ? isMockBridge : () => Boolean(isMockBridge);
    this.isTerminalStatus = typeof isTerminalStatus === 'function' ? isTerminalStatus : () => Boolean(isTerminalStatus);
    this._persistChain = Promise.resolve();
    // taskLocks is a Map<taskId, boolean>; tryAcquire returns true on first claim.
    this.taskLocks = new Map();

    // Resolve and stash the persistence path. If the caller already passed a
    // concrete string we honor it; otherwise we resolve from env / OS default.
    if (persistencePath) {
      this.persistencePath = persistencePath;
    } else {
      this.persistencePath = this.resolvePersistencePath();
    }
  }

  // ── persistence ────────────────────────────────────────────────────────

  /**
   * Where the active queue is serialized to disk. Honours the
   * TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH env var, falling back to the
   * per-OS application-data dir. Returns null when persistence is disabled.
   */
  resolvePersistencePath() {
    const configured = getEnvWithFallback(
      'TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH',
      'TRAE_ACTIVE_QUEUE_PERSISTENCE_PATH',
      ''
    );
    if (configured) return path.resolve(configured);

    if (process.platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support', 'TRAECNclaw', 'active-queue.json');
    }
    return path.join(os.homedir(), '.traecnclaw', 'active-queue.json');
  }

  /**
   * Serialize every non-terminal task from `taskQueue` to disk. The write
   * is serialized via `this._persistChain` so concurrent callers don't race
   * the file (last writer wins, but we guarantee the write completes in
   * call order).
   *
   * `taskQueue` is the gateway-owned Map; we accept it as an argument so
   * the service stays decoupled from any specific Gateway instance.
   */
  persist(taskQueue) {
    if (!this.persistencePath || !taskQueue) return;
    // Capture the snapshot eagerly so later mutations don't appear in this
    // write. The chain still guarantees serial ordering.
    const snapshot = Array.from(taskQueue.entries())
      .filter(([, task]) => !this.isTerminalStatus(task.status))
      .map(([taskId, task]) => ({ taskId, ...task }));

    this._persistChain = this._persistChain.then(() => this._writeToDisk(snapshot)).catch(err => {
      this.logger.error('[QueuePersistence] Failed to persist active queue:', err.message);
    });
    return this._persistChain;
  }

  async _writeToDisk(snapshot) {
    const dirPath = path.dirname(this.persistencePath);
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(this.persistencePath, JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      tasks: snapshot
    }, null, 2), 'utf8');
  }

  /**
   * Push the task into the global history store. No-op when the store is
   * missing or the task lacks an id.
   */
  syncHistoryMirror(task) {
    if (!task || !task.taskId || !this.taskHistoryStore || typeof this.taskHistoryStore.ensureTask !== 'function') {
      return;
    }
    const historyStatusMap = {
      queued: 'queued',
      executing: 'executing',
      awaiting_review: 'awaiting_review',
      approval_required: 'approval_required',
      done: 'completed',
      error: 'failed',
      queue_timeout: 'failed',
      review_rejected: 'cancelled',
      cancelled: 'cancelled'
    };
    const status = historyStatusMap[task.status] || task.status || 'running';
    const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
    const completedAt = isTerminal ? (task.completedAt || new Date().toISOString()) : null;
    const elapsedMs = task.createdAt ? Math.max(0, Date.now() - task.createdAt) : null;
    this.taskHistoryStore.ensureTask(task.taskId, task.task, {
      updateExisting: true,
      status,
      createdAtMs: task.createdAt,
      createdAt: new Date(task.createdAt).toISOString(),
      result: task.result || null,
      completedAt,
      elapsedMs,
      metadata: {
        source: 'delegate_async_restore',
        reviewRequired: task.reviewRequired === true,
        autoContinue: task.autoContinue === true,
        followupCount: Array.isArray(task.followupTasks) ? task.followupTasks.length : 0,
        notifyUrl: task.notifyUrl || null,
        autoApproveDialog: task.autoApproveDialog || null,
        queueState: task.queueState || null,
        currentModel: task.currentModel || null,
        fallbackModels: Array.isArray(task.fallbackModels) ? task.fallbackModels : [],
        lastModelProbeAt: task.lastModelProbeAt || null,
        submittedToTrae: task.submittedToTrae === true,
        submittedAt: task.submittedAt || null,
        soloChat: task.soloChat || null
      }
    });
  }

  /**
   * Hydrate `taskQueue` from disk. Restores submitted/executing/queued
   * tasks; flags the mock-bridge case so callers can skip restore during
   * test runs.
   *
   * Returns the number of tasks restored.
   */
  restore(taskQueue) {
    if (!this.persistencePath || !taskQueue) return 0;
    if (!fs.existsSync(this.persistencePath)) return 0;
    if (this.isMockBridge()) {
      this.logger.warn('[QueuePersistence] Skipping active queue restore while mock bridge is enabled');
      return 0;
    }
    try {
      const raw = fs.readFileSync(this.persistencePath, 'utf8');
      const parsed = JSON.parse(raw);
      const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      const now = Date.now();
      let restored = 0;
      for (const item of tasks) {
        if (!item || !item.taskId || this.isTerminalStatus(item.status)) continue;
        const task = { ...item };
        if (task.status === 'executing' && task.submittedToTrae !== true) {
          task.status = 'queued';
        }
        if (task.status === 'executing') {
          task.submittedToTrae = true;
        }
        if (!task.createdAt || Number.isNaN(task.createdAt)) {
          task.createdAt = now;
        }
        const perTaskTimeoutMs = task.deadline && task.createdAt
          ? Math.max(1000, task.deadline - task.createdAt)
          : null;
        if (!task.deadline) {
          task.deadline = null;
          task.maxDeadline = null;
        } else if (!task.maxDeadline) {
          task.maxDeadline = now + (perTaskTimeoutMs || 600000);
        }
        task.error = task.error || null;
        task.result = task.result || null;
        taskQueue.set(task.taskId, task);
        this.syncHistoryMirror(task);
        restored++;
      }
      return restored;
    } catch (err) {
      this.logger.error('[QueuePersistence] Failed to restore active queue:', err.message);
      return 0;
    }
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
    // The Gateway owns `driver.config.queueFlickerGraceMs`; the service
    // reads from env so callers can override without injecting the driver.
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

  // ── model-probe interval helper ────────────────────────────────────────

  modelProbeIntervalMs(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MODEL_PROBE_INTERVAL_MS;
    return Math.max(15000, Math.min(parsed, 10 * 60 * 1000));
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
    const hasStructuredReportMarker = /^(?:TRAECNclaw\s+)?Code\s+Review\s*[—-]\s*Findings\s+First\b/i.test(value)
      || (/\b1\.\s*Findings\s*\(ordered by severity\)/i.test(value) && /\b(?:final verdict|review complete)\b/i.test(value));
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

  // ── background polling ────────────────────────────────────────────────
  //
  // The polling body is intentionally kept on Gateway because it touches
  // many of the Gateway's async helpers. We expose start/stop so callers
  // can drive the timer, and the callback hooks the work-loop logic.

  /**
   * Start the background polling timer. `runProbe` is the callback that
   * does the per-iteration work (one full pass over the task queue).
   * `intervalMs` defaults to 15000 ms.
   *
   * Returns the underlying timer so callers can stop it themselves if
   * they want to bypass `stop()`.
   */
  startBackgroundPolling({ runProbe, intervalMs = 15000, setIntervalImpl, clearIntervalImpl } = {}) {
    if (!runProbe) throw new Error('TaskQueueService.startBackgroundPolling requires a runProbe() callback');
    this._pollingTimer = setIntervalImpl(runProbe, intervalMs);
    if (this._pollingTimer && typeof this._pollingTimer.unref === 'function') {
      this._pollingTimer.unref();
    }
    this.logger.log('[QueueService] Background polling started (interval=' + intervalMs + 'ms)');
    return this._pollingTimer;
  }

  /**
   * Stop the background polling timer. Safe to call multiple times.
   */
  stopBackgroundPolling({ clearIntervalImpl } = {}) {
    if (!this._pollingTimer) return;
    if (clearIntervalImpl) clearIntervalImpl(this._pollingTimer);
    this._pollingTimer = null;
  }

  hasBackgroundPolling() {
    return Boolean(this._pollingTimer);
  }

  // ── result retry mode (used by background poller + finalizer) ─────────

  /**
   * Decide whether a freshly-collected result warrants a retry, a re-collect,
   * or no action. Returns:
   *   - 'resubmit' → send the task again (driver returned a failed result)
   *   - 'collect'  → call collectResponse again (transient/timed out)
   *   - null       → no retry needed, proceed with finalize
   */
  backgroundResultRetryMode(result, task = null) {
    if (!result || result.needsApproval) return null;
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    if (result.modelError || this._isFailedResultText(text)) return 'resubmit';
    if (this._isEchoedTaskResult(result, task)) return 'collect';
    const needsWorkflowCheckpoint = task?.reviewRequired === true
      || task?.autoContinue === true
      || (Array.isArray(task?.followupTasks) && task.followupTasks.length > 0);
    if (needsWorkflowCheckpoint && !this._isReviewableTaskResult(result, task)) return 'collect';
    if (this._isSuccessfulTaskResult(result, task)) return null;
    if (result.timedOut || result.truncated || result.streaming || result.stable !== true || !this._hasMeaningfulResultText(text)) return 'collect';
    return null;
  }

  // Keep these two helpers inline because they're only used by
  // backgroundResultRetryMode — they used to live as private methods on
  // Gateway and only ever fed into the retry-mode decision.

  _isReviewableTaskResult(result, task = null) {
    if (!result || result.streaming || result.truncated || result.modelError) return false;
    if (result.reviewGatePending && result.stable !== true) return false;
    if (result.stable !== true && result.timedOut !== true) return false;
    return (this.isReviewableResult(result) || this._hasStrongCompletionEvidence(result?.text))
      && !this._isFailedResultText(result?.text || '')
      && !this._isEchoedTaskResult(result, task);
  }

  _isSuccessfulTaskResult(result, task = null) {
    if (!result || result.reviewGatePending || result.streaming || result.truncated || result.modelError) return false;
    if (result.stable !== true && result.timedOut !== true) return false;
    return (this.isSuccessfulResult(result) || this._hasStrongCompletionEvidence(result?.text))
      && !this._isFailedResultText(result?.text || '')
      && !this._isEchoedTaskResult(result, task);
  }

  _isEchoedTaskResult(result, task = null) {
    const text = typeof result?.text === 'string' ? result.text : '';
    const taskText = typeof task?.task === 'string' ? task.task : '';
    if (text.length < 40 || taskText.length < 40) return false;

    const normalize = value => String(value || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\p{L}\p{N}\s/._:-]+/gu, '')
      .trim();
    const normalizedText = normalize(text);
    const normalizedTask = normalize(taskText);
    if (normalizedText.length < 40 || normalizedTask.length < 40) return false;

    if (normalizedText.includes(normalizedTask) && normalizedText.length <= normalizedTask.length + 120) {
      return true;
    }

    const taskPrefix = normalizedTask.slice(0, Math.min(normalizedTask.length, 160));
    return normalizedText.includes(taskPrefix) && normalizedText.length <= normalizedTask.length * 1.25;
  }

  _hasStrongCompletionEvidence(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (value.length < 120) return false;
    return [
      /任务完成|完成总结|最终报告|final report|delivery summary|completed successfully/i,
      /(?:all|全部)\s+\d+\s+tests?\s+pass(?:ed)?/i,
      /all tests pass(?:ed)?|所有测试通过|测试已通过/i,
      /\d+\s*\/\s*\d+\s*已完成.*(?:final report|summary|总结|报告)/i,
      /(?:tests?|测试).{0,80}(?:pass(?:ed)?|通过|0\s+fail)/i
    ].some(pattern => pattern.test(value));
  }

  // ── approve-required resume helper ─────────────────────────────────────

  /**
   * Resume any queued tasks that were paused while waiting on a dialog
   * answer. Returns the list of resumed task ids so callers can log /
   * notify.
   *
   * `taskQueue` is the gateway-owned Map of pending tasks.
   * `matchesApproval` is a predicate (task, answer) => boolean.
   */
  resumeApprovalRequiredTasksAfterDialogAnswer(answer, taskQueue, { matchesApproval, onResume } = {}) {
    const resumedTaskIds = [];
    if (!taskQueue) return resumedTaskIds;
    const answeredAt = Date.now();
    const predicate = typeof matchesApproval === 'function'
      ? matchesApproval
      : (task) => task && task.status === 'approval_required';
    const handle = typeof onResume === 'function' ? onResume : () => {};

    for (const [taskId, task] of taskQueue) {
      if (!predicate(task, answer)) continue;
      resumedTaskIds.push(taskId);
      handle(taskId, task, answeredAt);
    }
    return resumedTaskIds;
  }

  // ── task creation (placeholder for the bigger migration in A4) ─────────
  //
  // The full `_createQueuedTask` body still lives on Gateway because it
  // touches many Gateway-only helpers (driver, history, persist, etc.).
  // We expose a no-op factory hook here so callers can stub it cleanly
  // in tests without hitting Gateway internals.

  createQueuedTask(body, queueStatus) {
    throw new Error('createQueuedTask must be supplied via the owning gateway; this is a marker for A2 only');
  }

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
}

module.exports = { TaskQueueService };