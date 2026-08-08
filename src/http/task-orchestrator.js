'use strict';

const crypto = require('crypto');
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
    isTerminalStatus = () => false,
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
    this.isTerminalStatus = typeof isTerminalStatus === 'function' ? isTerminalStatus : () => false;
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
      idempotencyFingerprint:
        typeof body.idempotencyFingerprint === 'string' && body.idempotencyFingerprint.trim()
          ? body.idempotencyFingerprint.trim()
          : this.fingerprintTaskRequest(body),
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

  fingerprintTaskRequest(input = {}) {
    const semantic = {
      task: typeof input.task === 'string' ? input.task : '',
      sessionId: typeof input.sessionId === 'string' && input.sessionId.trim()
        ? input.sessionId.trim()
        : null,
      projectPath: typeof input.projectPath === 'string' && input.projectPath.trim()
        ? input.projectPath.trim()
        : null,
      desiredModel: typeof input.desiredModel === 'string' && input.desiredModel.trim()
        ? input.desiredModel.trim()
        : null,
      desiredMode: input.desiredMode === 'solo' || input.desiredMode === 'ide'
        ? input.desiredMode
        : null,
      newConversation: input.newConversation !== false,
      chatId: input.chatId || null,
      soloChat: this.normalizeSoloChatTarget(input.soloChat || input.soloChatTarget || null),
      includeProcessText: input.includeProcessText === true,
      reviewRequired: input.reviewRequired === true,
      autoContinue: input.autoContinue === true,
      followupTasks: this.normalizeFollowupTasks(input.followupTasks),
      completionChecks: this.normalizeCompletionChecks(input.completionChecks || input),
      autoApproveDialog: this.normalizeAutoApproveDialog(input.autoApproveDialog),
      notifyUrl: typeof input.notifyUrl === 'string' ? input.notifyUrl : null,
      fallbackModels: this.normalizeFallbackModels(
        input.fallbackModels,
        input.autoModelFallback === true
      )
    };
    return crypto.createHash('sha256').update(canonicalJson(semantic)).digest('hex');
  }

  recordTerminalTask(task) {
    if (!task || !this.isTerminalStatus(task.status)) return true;
    if (!task.idempotencyKey) return true;
    if (!task.idempotencyFingerprint) {
      task.idempotencyFingerprint = this.fingerprintTaskRequest(task);
    }
    if (!this.taskQueueService || typeof this.taskQueueService.recordTerminalReplay !== 'function') {
      return false;
    }
    return this.taskQueueService.recordTerminalReplay(task, this.taskQueue);
  }

  /**
   * Resolve an idempotency-key replay against the active task queue.
   *
   * Returns `{ taskId, status, statusCode }` when an owned task matches the
   * key, or `null` when no owned task matches. Active ownership replays with
   * status 202, retained terminal ownership replays with its result and status
   * 200, and a semantic fingerprint mismatch reports status 409.
   *
   * This consolidates task-identity resolution in the same boundary that owns
   * acceptance, so restart, retry, and reconnect replays can be exercised
   * without the HTTP layer reaching into the queue directly.
   */
  resolveIdempotentTask(idempotencyKey, request = null) {
    if (!idempotencyKey || typeof idempotencyKey !== 'string') return null;
    const requestedFingerprint = typeof request === 'string'
      ? request
      : (request && typeof request === 'object' ? this.fingerprintTaskRequest(request) : null);
    const ownedTask = Array.from(this.taskQueue.values())
      .find(task => task && task.idempotencyKey === idempotencyKey);
    if (ownedTask) {
      if (requestedFingerprint && ownedTask.idempotencyFingerprint
        && requestedFingerprint !== ownedTask.idempotencyFingerprint) {
        return idempotencyConflict(ownedTask.taskId);
      }
      return {
        taskId: ownedTask.taskId,
        status: this.isTerminalStatus(ownedTask.status) ? ownedTask.status : 'accepted',
        statusCode: 202
      };
    }
    const replay = this.taskQueueService?.getTerminalReplay?.(idempotencyKey) || null;
    if (!replay) return null;
    if (requestedFingerprint && replay.fingerprint
      && requestedFingerprint !== replay.fingerprint) {
      return idempotencyConflict(replay.taskId);
    }
    return {
      taskId: replay.taskId,
      status: replay.status,
      result: replay.result ?? null,
      error: replay.error ?? null,
      terminal: true,
      statusCode: 200
    };
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function idempotencyConflict(taskId) {
  return {
    conflict: true,
    taskId,
    statusCode: 409,
    error: 'idempotency_key_conflict'
  };
}

module.exports = { TaskOrchestrator };
