'use strict';

/**
 * RecoveryHelper — owns reconnect / replay / snapshot-apply logic for the
 * delegated task queue.
 *
 * Responsibilities:
 *   - Resolve the persistence path from env / OS defaults.
 *   - Serialize the active queue to disk via a promise chain so concurrent
 *     writes don't race (last writer wins, but the order is preserved).
 *   - Hydrate `taskQueue` from disk on startup, skipping when the mock
 *     bridge is enabled and rewriting any non-submitted `executing` tasks
 *     back to `queued`.
 *   - Push per-task state into the global history store (syncHistoryMirror).
 *   - Background polling timer (start / stop / hasBackgroundPolling). The
 *     probe-loop body lives on Gateway and is supplied as a callback.
 *   - Resume any approval-required tasks after a dialog answer.
 *
 * The class is stateful in the sense that it holds the `_persistChain`
 * promise and the `_pollingTimer` handle, but exposes only methods.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getEnvWithFallback } = require('../shared/utils');

class RecoveryHelper {
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
    this._pollingTimer = null;

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