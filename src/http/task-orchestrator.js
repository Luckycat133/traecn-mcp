'use strict';

const { isGenericQueueProbeTask } = require('../shared/utils');
const { TraeCNAutomationError } = require('../cdp/errors');

/**
 * Owns construction and durable acceptance of a background task.
 *
 * Gateway remains responsible for HTTP and TraeCN lifecycle concerns; this
 * boundary owns the acceptance transaction:
 *
 *   validate -> create history identity -> build candidate -> persist -> mirror
 *
 * All normalisation and persistence dependencies are injected so the same
 * transaction can be exercised without a live browser or process-global
 * state.
 */
class TaskOrchestrator {
  constructor({
    taskHistoryStore,
    taskQueue,
    taskQueueService,
    getDriverConfig = () => ({}),
    normalizeFollowupTasks = (items) => (Array.isArray(items) ? items : []),
    normalizeCompletionChecks = () => ({ requiredFiles: [], requiredText: [] }),
    hasCompletionChecks = (checks) => Boolean(checks),
    normalizeFallbackModels = (items) => (Array.isArray(items) ? items : []),
    modelProbeIntervalMs = (value) => Number(value) || 60000,
    normalizeAutoApproveDialog = (value) => value || null,
    normalizeSoloChatTarget = (value) => value || null,
    syncTaskHistoryMirror = () => {},
    now = () => Date.now(),
    isGenericQueueProbeTask: isQueueProbe = isGenericQueueProbeTask,
    taskStoreUnavailable = (health) => TraeCNAutomationError.taskStoreUnavailable(health),
  } = {}) {
    this.taskHistoryStore = taskHistoryStore;
    this.taskQueue = taskQueue || new Map();
    this.taskQueueService = taskQueueService;
    this.getDriverConfig = typeof getDriverConfig === 'function' ? getDriverConfig : () => ({});
    this.normalizeFollowupTasks = normalizeFollowupTasks;
    this.normalizeCompletionChecks = normalizeCompletionChecks;
    this.hasCompletionChecks = hasCompletionChecks;
    this.normalizeFallbackModels = normalizeFallbackModels;
    this.modelProbeIntervalMs = modelProbeIntervalMs;
    this.normalizeAutoApproveDialog = normalizeAutoApproveDialog;
    this.normalizeSoloChatTarget = normalizeSoloChatTarget;
    this.syncTaskHistoryMirror = syncTaskHistoryMirror;
    this.now = now;
    this.isGenericQueueProbeTask = isQueueProbe;
    this.taskStoreUnavailable = taskStoreUnavailable;
  }

  createQueuedTask(body = {}, queueStatus = {}) {
    if (this.isGenericQueueProbeTask(body && body.task)) {
      throw TraeCNAutomationError.invalidInput(
        'task',
        '[generic queue probe]',
        'generic_queue_probe_task_rejected'
      );
    }

    const reviewRequired = body.reviewRequired === true;
    const autoContinue = body.autoContinue === true;
    const followupTasks = this.normalizeFollowupTasks(body.followupTasks);
    const completionChecks = this.normalizeCompletionChecks(body.completionChecks || body);
    const fallbackModels = this.normalizeFallbackModels(
      body.fallbackModels,
      body.autoModelFallback === true
    );
    const modelProbeIntervalMs = this.modelProbeIntervalMs(body.modelProbeIntervalMs);
    const autoApproveDialog = this.normalizeAutoApproveDialog(body.autoApproveDialog);
    const projectPath =
      typeof body.projectPath === 'string' && body.projectPath.trim()
        ? body.projectPath.trim()
        : null;
    const historyTaskId = this.taskHistoryStore.createTask(null, body.task, {
      metadata: {
        source: 'delegate_async',
        projectPath,
        reviewRequired,
        autoContinue,
        followupCount: followupTasks.length,
        notifyUrl: body.notifyUrl || null,
        autoApproveDialog,
        fallbackModels,
      },
    });

    const driverConfig = this.getDriverConfig() || {};
    const perTaskTimeoutMs = driverConfig.queuePerTaskTimeoutMs || 600000;
    const explicitQueueMaxWaitMs = Number(
      body.maxQueueWaitMs ?? body.queueMaxWaitMs ?? driverConfig.queueMaxWaitMs
    );
    const queueMaxWaitMs =
      Number.isFinite(explicitQueueMaxWaitMs) && explicitQueueMaxWaitMs > 0
        ? explicitQueueMaxWaitMs
        : null;
    const now = this.now();
    const task = {
      taskId: historyTaskId,
      sessionId:
        typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : null,
      idempotencyKey:
        typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
          ? body.idempotencyKey.trim()
          : null,
      chatId: body.chatId || null,
      soloChat: this.normalizeSoloChatTarget(
        body.soloChat ||
          body.soloChatTarget || {
            index: body.soloChatIndex,
            titleIncludes: body.soloChatTitleIncludes,
            textIncludes: body.soloChatTextIncludes,
          }
      ),
      task: body.task,
      projectPath,
      desiredModel: typeof body.desiredModel === 'string' ? body.desiredModel : null,
      desiredMode:
        body.desiredMode === 'solo' || body.desiredMode === 'ide' ? body.desiredMode : null,
      newConversation: body.newConversation !== false,
      status: 'queued',
      createdAt: now,
      deadline: queueMaxWaitMs ? now + Math.min(perTaskTimeoutMs, queueMaxWaitMs) : null,
      maxDeadline: queueMaxWaitMs ? now + queueMaxWaitMs : null,
      timeoutExtensions: 0,
      attempts: 0,
      includeProcessText: body.includeProcessText === true,
      reviewRequired,
      autoContinue,
      followupTasks,
      completionChecks,
      autoApproveDialog,
      notifyUrl: typeof body.notifyUrl === 'string' ? body.notifyUrl : null,
      submittedToTrae: false,
      submittedAt: null,
      queueState: queueStatus.running ? 'running' : 'queued',
      queuePosition: queueStatus.queuePosition || queueStatus.position || null,
      currentModel: queueStatus.currentModel || null,
      queueEstimatedWait: queueStatus.queueEstimatedWait || null,
      queueMessage: queueStatus.queueMessage || queueStatus.message || null,
      fallbackModels,
      modelProbeIntervalMs,
      lastModelProbeAt: null,
      nextModelProbeAt: fallbackModels.length > 0 ? now : null,
      modelProbeResults: [],
      result: null,
      error: null,
      reviewDecision: null,
      reviewNotes: null,
      nextTaskId: null,
    };

    this.taskHistoryStore.recordStep(historyTaskId, 'queued', {
      details: {
        queueState: task.queueState,
        queuePosition: queueStatus.queuePosition || queueStatus.position || null,
        queueMessage: task.queueMessage,
        fallbackModels,
        reviewRequired,
        autoContinue,
        autoApproveDialog,
        completionChecks: this.hasCompletionChecks(completionChecks),
        followupCount: followupTasks.length,
      },
    });

    this.taskQueue.set(historyTaskId, task);
    if (!this.taskQueueService || typeof this.taskQueueService.persist !== 'function') {
      this.taskQueue.delete(historyTaskId);
      const error = this.taskStoreUnavailable({ taskStoreWritable: false });
      if (typeof this.taskHistoryStore.failTask === 'function') {
        this.taskHistoryStore.failTask(historyTaskId, error);
      }
      throw error;
    }

    let persisted;
    try {
      persisted = this.taskQueueService.persist(this.taskQueue);
    } catch (error) {
      this.taskQueue.delete(historyTaskId);
      if (typeof this.taskHistoryStore.failTask === 'function') {
        this.taskHistoryStore.failTask(historyTaskId, error);
      }
      throw error;
    }

    if (!persisted) {
      this.taskQueue.delete(historyTaskId);
      const health =
        typeof this.taskQueueService.getPersistenceHealth === 'function'
          ? this.taskQueueService.getPersistenceHealth()
          : {};
      const error = this.taskStoreUnavailable(health);
      if (typeof this.taskHistoryStore.failTask === 'function') {
        this.taskHistoryStore.failTask(historyTaskId, error);
      }
      throw error;
    }

    this.syncTaskHistoryMirror(task);
    return task;
  }
}

module.exports = { TaskOrchestrator };
