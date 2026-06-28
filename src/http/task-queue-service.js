'use strict';

/**
 * TaskQueueService — thin orchestrator that composes three domain services.
 *
 * Owns:
 *   - QueueStateMachine — task lifecycle states + transitions (snapshot
 *     computation, recent-snapshot carry-over, result classification,
 *     per-task atomic claim, deadline extension, model-switch normalisation)
 *   - BatchExecutor — batch execution loop concerns (model-probe interval
 *     clamping, retry-mode decision, createQueuedTask factory hook)
 *   - RecoveryHelper — reconnect / replay / snapshot-apply logic (active
 *     queue persistence, history-mirror sync, background polling,
 *     approval-required resume)
 *
 * Each public method below is a thin delegator that forwards to the
 * appropriate domain service. The public surface is intentionally
 * preserved so gateway.js, the test suite, and downstream call sites
 * continue to work unchanged.
 */

const { QueueStateMachine } = require('./queue-state-machine');
const { BatchExecutor } = require('./batch-executor');
const { RecoveryHelper } = require('./recovery-helper');

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

    // Compose the three domain services.
    this.stateMachine = new QueueStateMachine({ logger });
    this.recoveryHelper = new RecoveryHelper({
      logger,
      persistencePath,
      taskHistoryStore,
      isMockBridge,
      isTerminalStatus,
    });
    this.batchExecutor = new BatchExecutor({
      logger,
      stateMachine: this.stateMachine,
    });

    // Mirror the persistence path so existing callers (tests + gateway)
    // that read `svc.persistencePath` keep working.
    this.persistencePath = this.recoveryHelper.persistencePath;

    // Mirror the lock map + polling timer for the same reason.
    this.taskLocks = this.stateMachine.taskLocks;
  }

  // ── persistence (RecoveryHelper) ──────────────────────────────────────

  resolvePersistencePath() { return this.recoveryHelper.resolvePersistencePath(); }
  persist(taskQueue) { return this.recoveryHelper.persist(taskQueue); }
  syncHistoryMirror(task) { return this.recoveryHelper.syncHistoryMirror(task); }
  restore(taskQueue) { return this.recoveryHelper.restore(taskQueue); }

  // ── per-task atomic claim (QueueStateMachine) ─────────────────────────

  tryAcquire(taskId) { return this.stateMachine.tryAcquire(taskId); }
  release(taskId) { return this.stateMachine.release(taskId); }

  // ── queue-snapshot helpers (QueueStateMachine) ───────────────────────

  getFlickerGraceMs() { return this.stateMachine.getFlickerGraceMs(); }
  hasRecentSubmittedSnapshot(task, now) { return this.stateMachine.hasRecentSubmittedSnapshot(task, now); }
  applyRecentSnapshot(status, taskQueue) { return this.stateMachine.applyRecentSnapshot(status, taskQueue); }
  getDetailsFromStatus(queueStatus, fallbackModel) { return this.stateMachine.getDetailsFromStatus(queueStatus, fallbackModel); }
  normalizeModelSwitchResult(switchResult) { return this.stateMachine.normalizeModelSwitchResult(switchResult); }

  // ── model-probe interval helper (BatchExecutor) ───────────────────────

  modelProbeIntervalMs(value) { return this.batchExecutor.modelProbeIntervalMs(value); }

  // ── result-classification helpers (QueueStateMachine) ────────────────

  isReviewableResult(result) { return this.stateMachine.isReviewableResult(result); }
  isSuccessfulResult(result) { return this.stateMachine.isSuccessfulResult(result); }
  looksLikeQueueNotice(text) { return this.stateMachine.looksLikeQueueNotice(text); }
  isQueuedTaskResult(result) { return this.stateMachine.isQueuedTaskResult(result); }
  isIncompleteReviewText(text) { return this.stateMachine.isIncompleteReviewText(text); }
  defaultQuestionDialogAnswer(result, action) { return this.stateMachine.defaultQuestionDialogAnswer(result, action); }

  // ── background polling (RecoveryHelper) ──────────────────────────────

  startBackgroundPolling(opts) { return this.recoveryHelper.startBackgroundPolling(opts); }
  stopBackgroundPolling(opts) { return this.recoveryHelper.stopBackgroundPolling(opts); }
  hasBackgroundPolling() { return this.recoveryHelper.hasBackgroundPolling(); }

  // ── result retry mode (BatchExecutor) ────────────────────────────────

  backgroundResultRetryMode(result, task) { return this.batchExecutor.backgroundResultRetryMode(result, task); }

  // ── approve-required resume helper (RecoveryHelper) ──────────────────

  resumeApprovalRequiredTasksAfterDialogAnswer(answer, taskQueue, opts) {
    return this.recoveryHelper.resumeApprovalRequiredTasksAfterDialogAnswer(answer, taskQueue, opts);
  }

  // ── task creation (BatchExecutor) ────────────────────────────────────

  createQueuedTask(body, queueStatus) { return this.batchExecutor.createQueuedTask(body, queueStatus); }

  // ── deadline / snapshot (QueueStateMachine) ──────────────────────────

  maybeExtendDeadline(task, queueStatus) { return this.stateMachine.maybeExtendDeadline(task, queueStatus); }
  updateSnapshot(task, queueStatus) { return this.stateMachine.updateSnapshot(task, queueStatus); }
}

module.exports = { TaskQueueService };