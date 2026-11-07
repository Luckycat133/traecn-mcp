'use strict';

/**
 * RecoveryHelper — owns reconnect / replay / snapshot-apply logic for the
 * delegated task queue.
 *
 * Responsibilities:
 *   - Persist and hydrate the active queue through the shared TaskStore.
 *   - Hydrate `taskQueue` on startup, skipping when the mock
 *     bridge is enabled and rewriting any non-submitted `executing` tasks
 *     back to `queued`.
 *   - Push per-task state into the global history store (syncHistoryMirror).
 *   - Background polling timer (start / stop / hasBackgroundPolling). The
 *     probe-loop body lives on Gateway and is supplied as a callback.
 *   - Resume any approval-required tasks after a dialog answer.
 *
 * The class owns the `_pollingTimer` handle, but exposes only methods.
 */

const { isGenericQueueProbeTask } = require('../shared/utils');
const { TaskStore } = require('./task-store');

class RecoveryHelper {
  constructor({
    logger = console,
    persistencePath = null,
    taskHistoryStore = null,
    isMockBridge = () => false,
    isTerminalStatus = () => false,
    isCancellationConfirmed = () => false,
    isTaskFinalizationConfirmed = () => false,
    taskStore = null,
  } = {}) {
    this.logger = logger;
    this.taskHistoryStore = taskHistoryStore;
    this.isMockBridge = typeof isMockBridge === 'function' ? isMockBridge : () => Boolean(isMockBridge);
    this.isTerminalStatus = typeof isTerminalStatus === 'function' ? isTerminalStatus : () => Boolean(isTerminalStatus);
    this.isCancellationConfirmed = typeof isCancellationConfirmed === 'function'
      ? isCancellationConfirmed : () => false;
    this.isTaskFinalizationConfirmed = typeof isTaskFinalizationConfirmed === 'function'
      ? isTaskFinalizationConfirmed : () => false;
    this._pollingTimer = null;
    this.taskStore = taskStore || new TaskStore({
      logger,
      persistencePath,
      isTerminalStatus,
    });
  }

  // ── persistence ────────────────────────────────────────────────────────

  /**
   * Where the active queue is serialized to disk. Honours the
   * TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH env var, falling back to the
   * per-OS application-data dir. Returns null when persistence is disabled.
   */
  resolvePersistencePath(configuredPath = '') {
    return this.taskStore.resolvePersistencePath(configuredPath);
  }

  get persistencePath() {
    return this.taskStore.persistencePath;
  }

  set persistencePath(value) {
    this.taskStore.setPersistencePath(value);
  }

  /**
   * Serialize every non-terminal task from `taskQueue` to disk.
   *
   * `taskQueue` is the gateway-owned Map; we accept it as an argument so
   * the service stays decoupled from any specific Gateway instance.
   */
  persist(taskQueue) {
    // Carry the parent's confirmed completion in the same snapshot that
    // removes it. History and events can be delayed or deliberately trimmed.
    for (const task of taskQueue?.values() || []) {
      if (!task.workflowParentTaskId) continue;
      const parent = taskQueue.get(task.workflowParentTaskId);
      if (parent?.status === 'done' && !parent.statePersistencePending && !parent.cancelPersistencePending) {
        task.workflowParentCompleted = true;
      }
    }
    return this.taskStore.persist(taskQueue);
  }

  /**
   * Push the task into the global history store. No-op when the store is
   * missing or the task lacks an id.
   */
  syncHistoryMirror(task) {
    if (!task || !task.taskId || !this.taskHistoryStore || typeof this.taskHistoryStore.ensureTask !== 'function') {
      return;
    }
    const existingMetadata = typeof this.taskHistoryStore.getTask === 'function'
      ? this.taskHistoryStore.getTask(task.taskId)?.metadata : null;
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
    const effectiveStatus = task.cancelPersistencePending?.previousStatus
      || task.statePersistencePending?.previousStatus || task.status;
    const status = historyStatusMap[effectiveStatus] || effectiveStatus || 'running';
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
        ...(existingMetadata && typeof existingMetadata === 'object' && !Array.isArray(existingMetadata) ? existingMetadata : {}),
        ...(task.metadata && typeof task.metadata === 'object' && !Array.isArray(task.metadata) ? task.metadata : {}),
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
        soloChat: task.soloChat || null,
        ...(typeof task.nextTaskId === 'string' && task.nextTaskId.trim() ? { nextTaskId: task.nextTaskId } : {}),
        ...(typeof task.workflowParentTaskId === 'string' && task.workflowParentTaskId.trim()
          ? { workflowParentTaskId: task.workflowParentTaskId } : {})
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
    if (this.isMockBridge()) {
      this.logger.warn('[QueuePersistence] Skipping active queue restore while mock bridge is enabled');
      return 0;
    }
    try {
      const snapshot = this.taskStore.load();
      if (!snapshot) return 0;
      const tasks = snapshot.tasks;
      const now = Date.now();
      let restored = 0;
      let skippedQueueProbes = 0;
      let skippedInvalidTasks = 0;
      let confirmedCheckpoints = 0;
      for (const item of tasks) {
        const pendingState = item?.statePersistencePending?.status === item?.status
          && ['queued', 'executing', 'approval_required', 'awaiting_review'].includes(item?.statePersistencePending?.previousStatus);
        const pendingCancellation = item?.status === 'cancelled'
          && ['queued', 'executing', 'approval_required', 'awaiting_review'].includes(item.cancelPersistencePending?.previousStatus);
        if (!item || !item.taskId || (this.isTerminalStatus(item.status) && !pendingCancellation && !pendingState)) {
          skippedInvalidTasks++;
          continue;
        }
        const pendingNativeStop = pendingCancellation && item.cancelRequested === true
          && item.cancelPersistencePending.previousStatus === 'executing' && item.submittedToTrae === true
          && !Object.prototype.hasOwnProperty.call(item, 'stopResult');
        if (pendingCancellation && !pendingNativeStop && this.isCancellationConfirmed(item.taskId)) {
          const confirmedTask = { ...item };
          delete confirmedTask.cancelPersistencePending;
          delete confirmedTask.statePersistencePending;
          this.syncHistoryMirror(confirmedTask);
          skippedInvalidTasks++;
          continue;
        }
        let confirmedState = null;
        if (pendingState && !pendingNativeStop
          && this.isTaskFinalizationConfirmed(item.taskId, item.status, item.interactionRequestId)) {
          confirmedState = { ...item };
          delete confirmedState.statePersistencePending;
          this.syncHistoryMirror(confirmedState);
          if (this.isTerminalStatus(item.status)) {
            skippedInvalidTasks++;
            continue;
          }
          confirmedCheckpoints++;
        }
        if (isGenericQueueProbeTask(item.task)) {
          skippedQueueProbes++;
          continue;
        }
        const task = { ...(confirmedState || item) };
        if (pendingNativeStop) {
          task.cancelPersistencePending = { ...task.cancelPersistencePending, verifyNativeIdentity: true };
        }
        // Upgrade earlier snapshots while their completion evidence still
        // exists, then retain it independently of history/event retention.
        if (task.workflowParentTaskId && task.workflowParentCompleted !== true
          && (this.isTaskFinalizationConfirmed(task.workflowParentTaskId, 'done')
            || this.taskHistoryStore?.getTask(task.workflowParentTaskId)?.status === 'completed')) {
          task.workflowParentCompleted = true;
          confirmedCheckpoints++;
        }
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
      if (skippedQueueProbes > 0) {
        this.logger.warn(`[QueuePersistence] Dropped ${skippedQueueProbes} generic queue-probe task(s) from active queue restore`);
      }
      if (snapshot.needsRewrite || skippedQueueProbes > 0 || skippedInvalidTasks > 0 || confirmedCheckpoints > 0) {
        this.taskStore.persist(taskQueue);
      }
      return restored;
    } catch (err) {
      this.logger.error('[QueuePersistence] Failed to restore active queue:', err.message);
      return 0;
    }
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
  startBackgroundPolling({ runProbe, intervalMs = 15000, setIntervalImpl, _clearIntervalImpl } = {}) {
    if (!runProbe) throw new Error('RecoveryHelper.startBackgroundPolling requires a runProbe() callback');
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
    else clearInterval(this._pollingTimer);
    this._pollingTimer = null;
  }

  hasBackgroundPolling() {
    return Boolean(this._pollingTimer);
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
}

module.exports = { RecoveryHelper };
