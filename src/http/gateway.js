'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const zlib = require('zlib');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const packageInfo = require('../../package.json');
const { discoverTarget, connectToTarget, resolveCDPEndpoint, fetchCDPTargets, describeCDPSurface } = require('../cdp/discovery');
const { DomDriver, getConfig } = require('../cdp/dom-driver');
const { SETTINGS_SECTIONS } = require('../cdp/settings-driver');
const { MockDriver } = require('../cdp/mock-driver');
const { DriverRouter, DRIVER_SPEC } = require('./driver-router');
const { TraeCNAutomationError } = require('../cdp/errors');
const { renderChatUI } = require('./chat-ui');
const { generateOpenAPISpec } = require('./openapi');
const { getEnvWithFallback, parsePositiveInt, sanitizeLog } = require('../shared/utils');
const { errorToHttpStatus, errorToBody } = require('./error-mapping');
const { ConfigManager } = require('../shared/config-manager');
const { getGlobalStore } = require('../shared/task-history');
const { buildCapabilities } = require('../shared/capabilities');
const { buildConfirmationPlan } = require('../shared/operation-confirmation');
const requestContext = require('../shared/request-context');
const { globalMetrics } = require('../shared/metrics');
const { listCommands } = require('../../integrations/openclaw-traecn-plugin/lib/command-set');
const { WebSocketHandler } = require('./websocket-handler');
const { findTraeCNBinary, isTraeCNRunning, restartTraeCNWithDebug, startTraeCN, getQuickstartConfig } = require('../config/quickstart');
const { CDPHealthWatcher } = require('../cdp/health-watcher');
const { DEFAULT_FALLBACK_MODELS } = require('../shared/models');

// Local alias so the existing call site (`_redactUrl(req.url)`) keeps working
// after the helpers moved to ./request-gate. The real implementation lives
// in request-gate.js; this is a one-line shim kept for readability.
const { redactUrl: _redactUrl } = require('./request-gate');
const { normalizeUrl, jsonResponse, htmlResponse, parseBody, secureCompare, RateLimiter, HttpError } = require('./request-gate');
const { TaskQueueService } = require('./task-queue-service');
const { TraeControl } = require('../cdp/trae-control');
const { ROUTES, matchRoute, resolveHandler } = require('./route-table');
const statusHandlers = require('./handlers/status');
const tasksHandlers = require('./handlers/tasks');
const delegateHandlers = require('./handlers/delegate');
const sessionsHandlers = require('./handlers/sessions');
const configHandlers = require('./handlers/config');
const dialogHandlers = require('./handlers/dialog');
const settingsHandlers = require('./handlers/settings');
const preflightHandlers = require('./handlers/preflight');
const soloChatHandlers = require('./handlers/solo-chat');
const traeControlHandlers = require('./handlers/trae-control');
const queueHandlers = require('./handlers/queue');
const taskActionsHandlers = require('./handlers/task-actions');
const batchHandlers = require('./handlers/batch');
const projectHandlers = require('./handlers/project');
const driverDispatchHandlers = require('./handlers/driver-dispatch');

// sanitizeLog is imported from ../shared/utils so audit-logger can share it.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_MODEL_PROBE_INTERVAL_MS = 60000;

const DEFAULT_QUEUE_FLICKER_GRACE_MS = 45000;

// Notify OpenClaw (Telegram gateway) when async task completes
async function notifyOpenClaw(chatId, message) {
  try {
    const openclawUrl = getEnvWithFallback('TRAECN_OPENCLAW_URL', 'TRAE_OPENCLAW_URL', 'http://127.0.0.1:18789/api/message/send');
    const body = JSON.stringify({ chatId, text: message });
    const res = await fetch(openclawUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000)
    });
    // Consume response body to free the connection
    if (res.ok) await res.text();
  } catch (e) {
    console.error('[Queue] notify failed:', e.message);
  }
}

function formatResult(result) {
  if (!result) return '✅ Trae 完成（无详情）';
  if (result.needsConfirmation || result.needsApproval) {
    return `🤖 Trae 需要确认:\n${result.question}\n\n输入你的决定继续。`;
  }
  if (result.error) {
    return `❌ Trae 出错: ${result.error}`;
  }
  const msg = result.text || result.message || '';
  return `✅ Trae 完成: ${msg.substring(0, 200)}`;
}

function formatReviewRequiredMessage(taskId, result, remainingFollowups = 0) {
  const preview = String(result?.text || '').trim().replace(/\s+/g, ' ').slice(0, 200);
  const suffix = remainingFollowups > 0 ? `\n后续待续任务: ${remainingFollowups}` : '';
  return `📝 Trae 已完成并等待审查:\nTask ID: ${taskId}\n预览: ${preview || '（无文本预览）'}${suffix}\n\n审查通过后再继续后续排队任务。`;
}

async function sendTaskWebhook(url, payload) {
  if (!url) return;
  const body = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...payload
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'TraeCNclaw-TaskWebhook/1.0'
    },
    body,
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) {
    throw TraeCNAutomationError.webhookFailed(url, response.status, response.statusText);
  }
  await response.text().catch(() => {});
}

class Gateway {
  constructor(options = {}) {
    // Initialize ConfigManager first — it owns all config sources
    // (file + env-var overrides) and exposes a unified getConfig().
    this.configManager = options.configManager || new ConfigManager({
      configFile: process.env.TRAECN_CONFIG_FILE,
      watchEnabled: process.env.TRAECN_CONFIG_WATCH === '1'
    });

    // Read all config from the manager; options override still wins for host/port.
    const config = this.configManager.getConfig();
    this.host = options.host || config.server.host;
    this.port = options.port !== undefined ? options.port : config.server.port;
    this.token = config.server.token;
    this.authHeader = config.server.authHeader;
    this.allowedOrigins = config.cors.allowedOrigins;
    this.debugEndpoints = config.features.debugEndpoints;
    this.mockBridge = config.features.mockBridge;
    this.enforceOperationConfirmation = config.features.enforceOperationConfirmation;

    this.rateLimiter = new RateLimiter(config.rateLimit.windowMs, config.rateLimit.maxRequests);

    this.taskHistoryStore = getGlobalStore();

    this.client = null;
    this.driver = null;
    this.server = null;
    this.wsHandler = null;
    this.sessions = new Map();
    this.idempotencyKeys = new Map();
    this.taskQueue = new Map();
    this.batchTasks = new Map();
    this.pollingTimer = null;
    this.isPolling = false;
    this.uiActionChain = Promise.resolve();
    this.taskLocks = new Set();
    this.activeTimers = new Set();
    this.autoStartTrae = config.traeControl.autoStart;
    this.traeRecoveryCooldownMs = config.traeControl.recoveryCooldownMs;
    this.traeRecoveryWaitMs = config.traeControl.recoveryWaitMs;
    this.lastTraeRecoveryAt = 0;
    this.autoRecover = config.autoRecover.enabled;
    this.autoRecoverProbeMs = config.autoRecover.probeIntervalMs;
    this.autoRecoverMax = config.autoRecover.maxRecoveries;
    this.autoRecoverProbeTimeoutMs = config.autoRecover.probeTimeoutMs;
    this.healthWatcher = new CDPHealthWatcher({
      gateway: this,
      enabled: this.autoRecover,
      probeIntervalMs: this.autoRecoverProbeMs,
      maxRecoveries: this.autoRecoverMax,
      probeTimeoutMs: this.autoRecoverProbeTimeoutMs,
      logger: console,
      label: 'Gateway'
    });
    this.traeControl = new TraeControl({
      configManager: this.configManager,
      isMockBridge: () => this.mockBridge,
      autoStartTrae: this.autoStartTrae,
      recoveryCooldownMs: this.traeRecoveryCooldownMs,
      recoveryWaitMs: this.traeRecoveryWaitMs,
      logger: console,
      setTimeoutImpl: (cb, delay) => this._setTimeout(cb, delay),
    });
    this.activeQueuePersistencePath = this._resolveActiveQueuePersistencePath(config.queue.persistencePath);
    this.taskQueueService = new TaskQueueService({
      logger: console,
      persistencePath: this.activeQueuePersistencePath,
      taskHistoryStore: this.taskHistoryStore,
      isMockBridge: () => this.mockBridge,
      isTerminalStatus: (status) => this._isTerminalTaskStatus(status),
    });
    this.taskQueueService.restore(this.taskQueue);

    this.configManager.on('configChanged', (data) => {
      this._applyConfigChanges(data.changes);
    });
  }

  _applyConfigChanges(changes) {
    const config = this.configManager.getConfig();
    const fullRefresh = Boolean(changes && (changes['*'] || (changes.previous && changes.next)));
    const changed = (section) => fullRefresh || Boolean(changes && changes[section]);

    // Rate limit — rebuild the limiter with new values.
    if (changed('rateLimit')) {
      this.rateLimiter = new RateLimiter(config.rateLimit.windowMs, config.rateLimit.maxRequests);
    }

    // CORS
    if (changed('cors')) {
      this.allowedOrigins = config.cors.allowedOrigins;
    }

    // Server auth
    if (changed('server')) {
      this.token = config.server.token;
      this.authHeader = config.server.authHeader;
    }

    // Trae control
    if (changed('traeControl')) {
      this.autoStartTrae = config.traeControl.autoStart;
      this.traeControl.autoStartTrae = config.traeControl.autoStart;
      this.traeRecoveryCooldownMs = config.traeControl.recoveryCooldownMs;
      this.traeControl.recoveryCooldownMs = config.traeControl.recoveryCooldownMs;
      this.traeRecoveryWaitMs = config.traeControl.recoveryWaitMs;
      this.traeControl.recoveryWaitMs = config.traeControl.recoveryWaitMs;
    }

    // Auto recover
    if (changed('autoRecover')) {
      this.autoRecover = config.autoRecover.enabled;
      this.healthWatcher.enabled = config.autoRecover.enabled;
      this.autoRecoverProbeMs = config.autoRecover.probeIntervalMs;
      this.healthWatcher.probeIntervalMs = config.autoRecover.probeIntervalMs;
      this.autoRecoverMax = config.autoRecover.maxRecoveries;
      this.healthWatcher.maxRecoveries = config.autoRecover.maxRecoveries;
      this.autoRecoverProbeTimeoutMs = config.autoRecover.probeTimeoutMs;
      this.healthWatcher.probeTimeoutMs = config.autoRecover.probeTimeoutMs;
    }

    // Feature flags
    if (changed('features')) {
      this.debugEndpoints = config.features.debugEndpoints;
      this.mockBridge = config.features.mockBridge;
      this.enforceOperationConfirmation = config.features.enforceOperationConfirmation;
    }

    if (changed('queue')) {
      const nextPath = this._resolveActiveQueuePersistencePath(config.queue.persistencePath);
      if (nextPath !== this.activeQueuePersistencePath) {
        this._persistActiveQueue();
        this.activeQueuePersistencePath = nextPath;
        this.taskQueueService.persistencePath = nextPath;
        if (this.taskQueueService.recoveryHelper) {
          this.taskQueueService.recoveryHelper.persistencePath = nextPath;
        }
      }
    }
  }

  _setTimeout(callback, delay) {
    const timer = setTimeout(() => {
      this.activeTimers.delete(timer);
      callback();
    }, delay);
    this.activeTimers.add(timer);
    return timer;
  }

  _clearTimeout(timer) {
    clearTimeout(timer);
    this.activeTimers.delete(timer);
  }

  async _withUiActionLock(action) {
    const previous = this.uiActionChain || Promise.resolve();
    let release;
    this.uiActionChain = new Promise(resolve => { release = resolve; });
    await previous.catch(() => {});
    try {
      return await action();
    } finally {
      release();
    }
  }

  _setInterval(callback, interval) {
    const timer = setInterval(callback, interval);
    this.activeTimers.add(timer);
    return timer;
  }

  _resolveActiveQueuePersistencePath(configuredPath) {
    // Prefer the path from config (already resolved by ConfigManager from
    // env vars or config file). Fall back to the OS-specific default.
    const configured = configuredPath || getEnvWithFallback(
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

  _persistActiveQueue() {
    if (!this.activeQueuePersistencePath) return;
    const activeTasks = Array.from(this.taskQueue.entries())
      .filter(([, task]) => !this._isTerminalTaskStatus(task.status))
      .map(([taskId, task]) => ({ taskId, ...task }));

    try {
      const dirPath = path.dirname(this.activeQueuePersistencePath);
      fs.mkdirSync(dirPath, { recursive: true });
      fs.writeFileSync(this.activeQueuePersistencePath, JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        tasks: activeTasks
      }, null, 2), 'utf8');
    } catch (err) {
      console.error('[QueuePersistence] Failed to persist active queue:', err.message);
    }
  }

  _syncTaskHistoryMirror(task) {
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

  _restoreActiveQueue() {
    if (!this.activeQueuePersistencePath || !fs.existsSync(this.activeQueuePersistencePath)) return;
    if (this.mockBridge) {
      console.warn('[QueuePersistence] Skipping active queue restore while mock bridge is enabled');
      return;
    }
    try {
      const raw = fs.readFileSync(this.activeQueuePersistencePath, 'utf8');
      const parsed = JSON.parse(raw);
      const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      const now = Date.now();
      for (const item of tasks) {
        if (!item || !item.taskId || this._isTerminalTaskStatus(item.status)) continue;
        const restored = { ...item };
        if (restored.status === 'executing' && restored.submittedToTrae !== true) {
          restored.status = 'queued';
        }
        if (restored.status === 'executing') {
          restored.submittedToTrae = true;
        }
        if (!restored.createdAt || Number.isNaN(restored.createdAt)) {
          restored.createdAt = now;
        }
        const perTaskTimeoutMs = restored.deadline && restored.createdAt
          ? Math.max(1000, restored.deadline - restored.createdAt)
          : null;
        if (!restored.deadline) {
          restored.deadline = null;
          restored.maxDeadline = null;
        } else if (!restored.maxDeadline) {
          restored.maxDeadline = now + (perTaskTimeoutMs || 600000);
        }
        restored.error = restored.error || null;
        restored.result = restored.result || null;
        this.taskQueue.set(restored.taskId, restored);
        this._syncTaskHistoryMirror(restored);
      }
    } catch (err) {
      console.error('[QueuePersistence] Failed to restore active queue:', err.message);
    }
  }

  async _attemptTraeRecovery(reason) {
    // Delegate to TraeControl but mirror `lastTraeRecoveryAt` on Gateway so
    // existing tests + observability that read this.lastTraeRecoveryAt keep
    // working unchanged.
    const result = await this.traeControl.attemptRecovery(reason);
    if (result || this.traeControl.lastRecoveryAt) {
      this.lastTraeRecoveryAt = this.traeControl.lastRecoveryAt;
    }
    return result;
  }

  _normalizeFollowupTasks(items) {
    if (!Array.isArray(items)) return [];
    return items
      .map(item => {
        if (typeof item === 'string') {
          return { task: item, reviewRequired: true };
        }
        if (!item || typeof item !== 'object' || typeof item.task !== 'string') return null;
        const completionChecks = this._normalizeCompletionChecks(item.completionChecks || item);
        const normalized = {
          task: item.task,
          reviewRequired: item.reviewRequired !== false,
          autoContinue: item.autoContinue === true,
          includeProcessText: item.includeProcessText === true
        };
        const autoApproveDialog = this._normalizeAutoApproveDialog(item.autoApproveDialog);
        if (autoApproveDialog !== null) normalized.autoApproveDialog = autoApproveDialog;
        if (this._hasCompletionChecks(completionChecks)) normalized.completionChecks = completionChecks;
        return normalized;
      })
      .filter(item => item && item.task && item.task.length <= 100000);
  }

  _normalizeAutoApproveDialog(value) {
    if (value === true) return 'auto';
    if (value === false || value === null || value === undefined || value === '') return null;
    if (typeof value === 'string') return value.trim() || null;
    return null;
  }

  _normalizeCompletionChecks(input = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const checks = source.completionChecks && typeof source.completionChecks === 'object'
      ? source.completionChecks
      : source;
    const requiredFiles = Array.isArray(checks.requiredFiles)
      ? checks.requiredFiles.filter(filePath => typeof filePath === 'string' && filePath.trim()).map(filePath => filePath.trim()).slice(0, 50)
      : [];
    const requiredText = Array.isArray(checks.requiredText)
      ? checks.requiredText.map(item => {
        if (!item || typeof item !== 'object' || typeof item.filePath !== 'string') return null;
        const includes = Array.isArray(item.includes) ? item.includes : [item.includes];
        const normalizedIncludes = includes.filter(value => typeof value === 'string' && value.length > 0).slice(0, 20);
        if (!item.filePath.trim() || normalizedIncludes.length === 0) return null;
        return { filePath: item.filePath.trim(), includes: normalizedIncludes };
      }).filter(Boolean).slice(0, 50)
      : [];
    return { requiredFiles, requiredText };
  }

  _hasCompletionChecks(checks) {
    return !!checks
      && ((Array.isArray(checks.requiredFiles) && checks.requiredFiles.length > 0)
        || (Array.isArray(checks.requiredText) && checks.requiredText.length > 0));
  }

  _resolveCompletionCheckPath(task, filePath) {
    if (path.isAbsolute(filePath)) return path.normalize(filePath);
    return path.resolve(task.projectPath || process.cwd(), filePath);
  }

  _validateCompletionChecks(task) {
    const checks = task?.completionChecks;
    if (!this._hasCompletionChecks(checks)) return { ok: true, missingFiles: [], missingText: [] };
    const missingFiles = [];
    const missingText = [];

    for (const filePath of checks.requiredFiles || []) {
      const resolved = this._resolveCompletionCheckPath(task, filePath);
      if (!fs.existsSync(resolved)) missingFiles.push(filePath);
    }

    for (const check of checks.requiredText || []) {
      const resolved = this._resolveCompletionCheckPath(task, check.filePath);
      let content = '';
      try {
        content = fs.readFileSync(resolved, 'utf8');
      } catch {
        missingText.push({ filePath: check.filePath, includes: check.includes });
        continue;
      }
      const absent = check.includes.filter(value => !content.includes(value));
      if (absent.length > 0) missingText.push({ filePath: check.filePath, includes: absent });
    }

    return { ok: missingFiles.length === 0 && missingText.length === 0, missingFiles, missingText };
  }

  _taskWithProjectContext(taskText, projectPath) {
    const task = String(taskText || '').trim();
    const path = typeof projectPath === 'string' ? projectPath.trim() : '';
    if (!path) return task;
    if (task.includes(`Project path: ${path}`) || task.includes(`项目路径：${path}`)) return task;
    return [
      `Project path: ${path}`,
      'Work only in this project path unless the user explicitly says otherwise.',
      '',
      task
    ].join('\n');
  }

  _normalizeFallbackModels(items, autoModelFallback = false) {
    const rawItems = Array.isArray(items)
      ? items
      : (typeof items === 'string' ? items.split(',') : []);
    const candidateItems = rawItems.length > 0
      ? rawItems
      : (autoModelFallback ? DEFAULT_FALLBACK_MODELS : []);
    const seen = new Set();
    return candidateItems
      .map(item => String(item || '').trim())
      .filter(item => item && item.length <= 120)
      .filter(item => {
        const key = item.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 12);
  }

  _modelProbeIntervalMs(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MODEL_PROBE_INTERVAL_MS;
    return Math.max(15000, Math.min(parsed, 10 * 60 * 1000));
  }

  _createQueuedTask(body, queueStatus = {}) {
    const reviewRequired = body.reviewRequired === true;
    const autoContinue = body.autoContinue === true;
    const followupTasks = this._normalizeFollowupTasks(body.followupTasks);
    const completionChecks = this._normalizeCompletionChecks(body.completionChecks || body);
    const fallbackModels = this._normalizeFallbackModels(body.fallbackModels, body.autoModelFallback === true);
    const modelProbeIntervalMs = this._modelProbeIntervalMs(body.modelProbeIntervalMs);
    const autoApproveDialog = this._normalizeAutoApproveDialog(body.autoApproveDialog);
    const projectPath = typeof body.projectPath === 'string' && body.projectPath.trim()
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
        fallbackModels
      }
    });
    const perTaskTimeoutMs = this.driver.config.queuePerTaskTimeoutMs || 600000;
    const explicitQueueMaxWaitMs = Number(body.maxQueueWaitMs ?? body.queueMaxWaitMs ?? this.driver.config.queueMaxWaitMs);
    const queueMaxWaitMs = Number.isFinite(explicitQueueMaxWaitMs) && explicitQueueMaxWaitMs > 0
      ? explicitQueueMaxWaitMs
      : null;
    const now = Date.now();
    const task = {
      taskId: historyTaskId,
      sessionId: typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : null,
      chatId: body.chatId || null,
      soloChat: this._normalizeSoloChatTarget(body.soloChat || body.soloChatTarget || {
        index: body.soloChatIndex,
        titleIncludes: body.soloChatTitleIncludes,
        textIncludes: body.soloChatTextIncludes
      }),
      task: body.task,
      projectPath,
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
      nextModelProbeAt: fallbackModels.length > 0 ? Date.now() : null,
      modelProbeResults: [],
      result: null,
      error: null,
      reviewDecision: null,
      reviewNotes: null,
      nextTaskId: null
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
        completionChecks: this._hasCompletionChecks(completionChecks),
        followupCount: followupTasks.length
      }
    });
    this.taskQueue.set(historyTaskId, task);
    this._syncTaskHistoryMirror(task);
    this._persistActiveQueue();
    return task;
  }

  _appendSessionMessage(sessionId, message = {}) {
    if (!sessionId) return false;
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = typeof message.content === 'string' ? message.content : '';
    if (!content && role === 'assistant') return false;
    session.messages.push({
      role,
      content,
      timestamp: new Date().toISOString(),
      ...(message.taskId ? { taskId: message.taskId } : {}),
      ...(message.status ? { status: message.status } : {})
    });
    return true;
  }

  _maybeExtendQueuedTaskDeadline(task, queueStatus = {}) {
    if (!task || !task.deadline || !task.maxDeadline) return false;
    const now = Date.now();
    if (now <= task.deadline) return false;
    const queueStillActive = queueStatus.queued === true || queueStatus.running === true;
    if (!queueStillActive) return false;
    if (now >= task.maxDeadline) return false;

    const extensionMs = this.driver.config.queueTimeoutExtensionMs || this.driver.config.queuePerTaskTimeoutMs || 600000;
    task.deadline = Math.min(task.maxDeadline, now + extensionMs);
    task.timeoutExtensions = (task.timeoutExtensions || 0) + 1;
    this.taskHistoryStore.recordStep(task.taskId, 'queue_extended', {
      details: {
        timeoutExtensions: task.timeoutExtensions,
        deadline: task.deadline,
        maxDeadline: task.maxDeadline,
        queueMessage: queueStatus.queueMessage || queueStatus.message || null
      }
    });
    return true;
  }

  _updateQueuedTaskSnapshot(task, queueStatus = {}) {
    const queueActive = queueStatus.running === true || queueStatus.queued === true;
    if (queueActive) {
      task.lastQueueSeenAt = Date.now();
    }

    const keepRecentQueue = !queueActive && this._hasRecentSubmittedQueueSnapshot(task);
    task.queueState = queueStatus.running ? 'running' : (queueStatus.queued || keepRecentQueue ? 'queued' : 'ready');
    task.queuePosition = (queueActive || keepRecentQueue) ? (queueStatus.queuePosition || queueStatus.position || task.queuePosition || null) : null;
    task.currentModel = queueStatus.currentModel || task.currentModel || null;
    task.queueEstimatedWait = (queueActive || keepRecentQueue) ? (queueStatus.queueEstimatedWait || task.queueEstimatedWait || null) : null;
    task.queueMessage = (queueActive || keepRecentQueue) ? (queueStatus.queueMessage || queueStatus.message || task.queueMessage || null) : null;
    task.queueCanSubmit = keepRecentQueue ? false : queueStatus.canSubmit === true;
  }

  _queueFlickerGraceMs() {
    // Driver runtime config takes precedence, then ConfigManager, then default.
    const configured = this.driver?.config?.queueFlickerGraceMs
      ?? this.configManager?.getConfig()?.queue?.flickerGraceMs
      ?? DEFAULT_QUEUE_FLICKER_GRACE_MS;
    return parsePositiveInt(configured, DEFAULT_QUEUE_FLICKER_GRACE_MS);
  }

  _hasRecentSubmittedQueueSnapshot(task, now = Date.now()) {
    if (!task || task.status !== 'executing' || task.submittedToTrae !== true) return false;
    if (task.queueState !== 'queued') return false;
    if (!task.lastQueueSeenAt) return false;
    return now - task.lastQueueSeenAt <= this._queueFlickerGraceMs();
  }

  _applyRecentQueueSnapshot(status = {}) {
    if (status.queued === true || status.running === true) return status;
    const task = Array.from(this.taskQueue.values())
      .find(candidate => this._hasRecentSubmittedQueueSnapshot(candidate));
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

  _queueDetailsFromStatus(queueStatus = {}, fallbackModel = null) {
    return {
      state: queueStatus.running ? 'running' : (queueStatus.queued ? 'queued' : 'ready'),
      currentModel: queueStatus.currentModel || fallbackModel || null,
      queuePosition: queueStatus.queuePosition || queueStatus.position || null,
      queueEstimatedWait: queueStatus.queueEstimatedWait || null,
      queueMessage: queueStatus.queueMessage || queueStatus.message || null,
      canSubmit: queueStatus.canSubmit === true
    };
  }

  _normalizeModelSwitchResult(switchResult) {
    return typeof switchResult === 'object' && switchResult !== null
      ? switchResult
      : {
          success: !String(switchResult || '').startsWith('model_switch_blocked') &&
            !String(switchResult || '').startsWith('no model items') &&
            !String(switchResult || '').startsWith('model not found'),
          switchResult
        };
  }

  async _probeFallbackModels(task, options = {}) {
    const models = this._normalizeFallbackModels(task?.fallbackModels, false);
    const now = Date.now();
    if (!task || models.length === 0) {
      return { attempted: false, ready: false, results: [], queueStatus: null };
    }
    if (task.nextModelProbeAt && now < task.nextModelProbeAt) {
      return { attempted: false, ready: false, results: task.modelProbeResults || [], queueStatus: null };
    }

    const results = [];
    let selectedQueueStatus = null;
    let selectedModel = null;
    for (const model of models) {
      const startedAt = Date.now();
      try {
        const switchResult = await this.driver.switchModel(model);
        const normalizedSwitch = this._normalizeModelSwitchResult(switchResult);
        if (!normalizedSwitch.success) {
          results.push({
            model,
            ok: false,
            error: normalizedSwitch.error || 'Model switch failed',
            switchResult: normalizedSwitch.switchResult || switchResult,
            elapsedMs: Date.now() - startedAt
          });
          continue;
        }
        const status = await this.driver.checkQueueStatus();
        const ready = status.running !== true && status.queued !== true;
        const probeResult = {
          model: normalizedSwitch.model || model,
          requestedModel: model,
          ok: true,
          ready,
          queued: status.queued === true,
          running: status.running === true,
          canSubmit: status.canSubmit === true,
          switchResult: normalizedSwitch.switchResult || switchResult,
          queueDetails: this._queueDetailsFromStatus(status, normalizedSwitch.model || model),
          elapsedMs: Date.now() - startedAt
        };
        results.push(probeResult);
        selectedQueueStatus = status;
        selectedModel = probeResult.model;
        if (ready) break;
      } catch (err) {
        results.push({
          model,
          ok: false,
          error: err.message,
          elapsedMs: Date.now() - startedAt
        });
      }
    }

    task.lastModelProbeAt = now;
    task.nextModelProbeAt = now + this._modelProbeIntervalMs(task.modelProbeIntervalMs);
    task.modelProbeResults = results;
    if (selectedModel) task.currentModel = selectedModel;
    if (selectedQueueStatus) this._updateQueuedTaskSnapshot(task, selectedQueueStatus);
    if (options.recordHistory !== false && this.taskHistoryStore && typeof this.taskHistoryStore.recordStep === 'function') {
      this.taskHistoryStore.recordStep(task.taskId, 'model_probe', {
        details: {
          attemptedModels: models,
          selectedModel,
          ready: selectedQueueStatus ? (selectedQueueStatus.running !== true && (selectedQueueStatus.queued !== true || selectedQueueStatus.canSubmit === true)) : false,
          results: results.map(result => ({
            model: result.model,
            ok: result.ok,
            ready: result.ready === true,
            queued: result.queued === true,
            running: result.running === true,
            canSubmit: result.canSubmit === true,
            error: result.error || null
          }))
        }
      });
    }
    return {
      attempted: true,
      ready: selectedQueueStatus ? (selectedQueueStatus.running !== true && selectedQueueStatus.queued !== true) : false,
      selectedModel,
      queueStatus: selectedQueueStatus,
      results
    };
  }

  async _refreshQueuedTaskSnapshot(task) {
    if (!task || task.status !== 'queued' || this.mockBridge) return;
    try {
      await this._ensureConnection();
      const queueStatus = await this.driver.checkQueueStatus();
      this._updateQueuedTaskSnapshot(task, queueStatus);
    } catch (err) {
      console.error('[TaskStatus] queue snapshot refresh failed:', err.message);
    }
  }

  async _refreshExecutingTaskSnapshot(task) {
    if (!task || task.status !== 'executing' || this.mockBridge) return;
    try {
      await this._ensureConnection();
      const queueStatus = await this.driver.checkQueueStatus();
      this._updateQueuedTaskSnapshot(task, queueStatus);
    } catch (err) {
      console.error('[TaskStatus] executing snapshot refresh failed:', err.message);
    }
  }

  async _emitTaskNotification(taskId, task, eventType, extra = {}) {
    if (this.wsHandler) {
      this.wsHandler.broadcastEvent(eventType, { taskId, status: task.status, ...extra });
    }

    if (task.chatId) {
      if (eventType === 'task.review_required') {
        await notifyOpenClaw(task.chatId, formatReviewRequiredMessage(taskId, task.result, task.followupTasks?.length || 0));
      } else if (eventType === 'task.approval_required') {
        await notifyOpenClaw(task.chatId, `🤖 Trae 需要处理受限模式或确认弹窗:\nTask ID: ${taskId}\n${task.result?.question || ''}`);
      } else if (eventType === 'task.completed') {
        await notifyOpenClaw(task.chatId, formatResult(task.result));
      } else if (eventType === 'task.error') {
        await notifyOpenClaw(task.chatId, '❌ Trae 出错: ' + (task.error || 'unknown error'));
      } else if (eventType === 'task.queue_timeout') {
        await notifyOpenClaw(task.chatId, '❌ Trae 排队超时（超过限制），请稍后重试或切换模型');
      }
    }

    if (task.notifyUrl) {
      try {
        await sendTaskWebhook(task.notifyUrl, {
          event: eventType,
          data: {
            taskId,
            status: task.status,
            reviewDecision: task.reviewDecision || null,
            nextTaskId: task.nextTaskId || null,
            result: task.result ? {
              text: task.result.text || '',
              stable: task.result.stable || false,
              elapsedMs: task.result.elapsedMs || 0,
              timedOut: task.result.timedOut || false,
              needsApproval: task.result.needsApproval || false,
              question: task.result.question || '',
              dialogType: task.result.dialogType || null,
              buttons: task.result.buttons || [],
              options: task.result.options || []
            } : null,
            error: task.error || null,
            followupCount: task.followupTasks?.length || 0,
            ...extra
          }
        });
      } catch (err) {
        console.error('[TaskNotify] webhook failed:', err.message);
      }
    }
  }

  async _recoverAwaitingReviewFromGate(task) {
    if (!this.driver || typeof this.driver.checkTaskReviewGate !== 'function') return null;
    try {
      const gate = await this.driver.checkTaskReviewGate();
      if (!gate.awaitingReview || !gate.taskCompleted) return null;

      let panelText = '';
      if (typeof this.driver._captureIdePanelText === 'function') {
        panelText = await this.driver._captureIdePanelText();
      }

      const text = panelText || 'Trae 已生成结果，但当前停在内部审查闸口，等待审查决定。';
      return {
        text,
        stable: true,
        elapsedMs: Date.now() - task.createdAt,
        timedOut: false,
        needsApproval: false,
        reviewGatePending: true
      };
    } catch (err) {
      console.error('[Queue] review gate recovery failed:', err.message);
      return null;
    }
  }

  _isReviewableResult(result) {
    if (!result || result.needsApproval) return false;
    if (result.timedOut || result.truncated || result.streaming || result.modelError) return false;
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    if (!text) return false;
    if (text.length < 80) return false;
    if (this._isWorkbenchChromeResultText(text)) return false;
    if (this._isFailedResultText(text)) return false;
    if (this._isIncompleteReviewText(text)) return false;
    if (/^solo\s*agent\s*思考中/i.test(text)) return false;
    if (/^调用技能[:：]/i.test(text)) return false;
    if (/^(i'll|i will)\s+start\b/i.test(text)) return false;
    if (/\blet me start\b/i.test(text)) return false;
    if (/^(thought|思考过程)\b/i.test(text)) return false;
    if (/^(好的|收到|明白|了解|我来|正在|开始|ok|okay|sure|got it|understood|alright)\b/i.test(text)) return false;
    return result.stable === true;
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

  _isReviewableTaskResult(result, task = null) {
    if (!result || result.streaming || result.truncated || result.modelError) return false;
    if (result.reviewGatePending && result.stable !== true) return false;
    if (result.stable !== true && result.timedOut !== true) return false;
    return (this._isReviewableResult(result) || this._hasStrongCompletionEvidence(result?.text))
      && !this._isFailedResultText(result?.text || '')
      && !this._isEchoedTaskResult(result, task);
  }

  _isSuccessfulTaskResult(result, task = null) {
    if (!result || result.reviewGatePending || result.streaming || result.truncated || result.modelError) return false;
    if (result.stable !== true && result.timedOut !== true) return false;
    return (this._isSuccessfulResult(result) || this._hasStrongCompletionEvidence(result?.text))
      && !this._isFailedResultText(result?.text || '')
      && !this._isEchoedTaskResult(result, task);
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

  _isSuccessfulResult(result) {
    if (!result || result.needsApproval) return false;
    if (result.timedOut || result.truncated || result.streaming || result.modelError) return false;
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    if (!this._hasMeaningfulResultText(text) || this._isWorkbenchChromeResultText(text) || this._isFailedResultText(text) || this._isIncompleteReviewText(text)) return false;
    return result.stable === true;
  }

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

  _parseQueuePositionFromText(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    const match = value.match(/排在第\s*(\d+)\s*位|queue\s*(?:position|#)?\s*:?\s*(\d+)/i);
    if (!match) return null;
    const parsed = Number(match[1] || match[2]);
    return Number.isFinite(parsed) ? parsed : null;
  }

  _looksLikeQueueNotice(text) {
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

  _isQueuedTaskResult(result) {
    if (!result || result.needsApproval || result.modelError) return false;
    if (result.queued === true) return true;
    const text = typeof result.text === 'string' ? result.text : '';
    return result.timedOut === true && result.stable !== true && this._looksLikeQueueNotice(text);
  }

  _keepSubmittedTaskWaitingInQueue(taskId, task, result = {}) {
    const text = typeof result.text === 'string' ? result.text : '';
    const queuePosition = result.queuePosition || this._parseQueuePositionFromText(text);
    task.status = 'executing';
    task.submittedToTrae = true;
    task.queueState = 'queued';
    task.queuePosition = queuePosition || task.queuePosition || null;
    task.queueEstimatedWait = result.queueEstimatedWait || task.queueEstimatedWait || null;
    task.queueMessage = result.queueMessage
      || (queuePosition ? `排在第 ${queuePosition} 位` : task.queueMessage)
      || 'Trae request is still queued';
    task.currentModel = result.currentModel || task.currentModel || null;
    task.queueCanSubmit = false;
    task.lastQueueSeenAt = Date.now();
    task.error = null;

    this.taskHistoryStore.recordStep(taskId, 'queue_wait_continues', {
      success: true,
      details: {
        queuePosition: task.queuePosition,
        queueMessage: task.queueMessage,
        currentModel: task.currentModel,
        elapsedMs: result.elapsedMs || null,
        timedOut: result.timedOut === true
      }
    });
    if (this.wsHandler) {
      this.wsHandler.notifyTaskStatusChange(taskId, task);
    }
    this._syncTaskHistoryMirror(task);
    this._persistActiveQueue();
  }

  _defaultQuestionDialogAnswer(result = {}, action = 'auto') {
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

  async _tryAutoApproveTaskDialog(taskId, task, result = {}) {
    const action = this._normalizeAutoApproveDialog(task.autoApproveDialog);
    if (!action || !this.driver) return false;

    let approvalResult;
    let selectedAction = action;
    try {
      const isQuestion = result.dialogType === 'review_scope_question'
        || /review scope|what would you like me to review/i.test(result.question || '');
      if (isQuestion && typeof this.driver.answerQuestionDialog === 'function') {
        selectedAction = 'answer';
        const answer = this._defaultQuestionDialogAnswer(result, action);
        approvalResult = await this.driver.answerQuestionDialog(answer);
      } else {
        const dialog = await this.driver.checkForApprovalDialog();
        if (!dialog.needsApproval) return false;
        selectedAction = action === 'auto'
          ? (dialog.canAutoApprove ? 'trust' : 'allow')
          : action;
        approvalResult = await this.driver.approveDialog(selectedAction);
      }
    } catch (err) {
      this.taskHistoryStore.recordStep(taskId, 'dialog_auto_approval_failed', {
        success: false,
        error: err.message,
        details: {
          action,
          dialogType: result.dialogType || null
        }
      });
      this._syncTaskHistoryMirror(task);
      this._persistActiveQueue();
      return false;
    }

    if (!approvalResult || approvalResult.success !== true) {
      this.taskHistoryStore.recordStep(taskId, 'dialog_auto_approval_failed', {
        success: false,
        error: approvalResult?.error || 'Dialog auto approval failed',
        details: {
          action: selectedAction,
          dialogType: result.dialogType || null,
          selectedOption: approvalResult?.selectedOption || null,
          buttonClicked: approvalResult?.buttonClicked || null
        }
      });
      this._syncTaskHistoryMirror(task);
      this._persistActiveQueue();
      return false;
    }

    task.status = 'executing';
    task.submittedToTrae = true;
    task.submittedAt = task.submittedAt || Date.now();
    task.queueState = 'running';
    task.queueMessage = 'dialog auto-approved; waiting for Trae result';
    task.error = null;
    task.result = null;
    task.answeredDialog = {
      action: selectedAction,
      autoApproveDialog: action,
      dialogType: result.dialogType || null,
      question: result.question || null,
      selectedOption: approvalResult.selectedOption || null,
      buttonClicked: approvalResult.buttonClicked || null,
      answeredAt: Date.now()
    };
    this.taskHistoryStore.recordStep(taskId, 'dialog_auto_approved', {
      success: true,
      details: task.answeredDialog
    });
    if (this.wsHandler) {
      this.wsHandler.notifyTaskStatusChange(taskId, task);
    }
    this._syncTaskHistoryMirror(task);
    this._persistActiveQueue();
    return true;
  }

  _isIncompleteReviewText(text) {
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

  async _finalizeBackgroundTask(taskId, task, status, payload = {}) {
    task.status = status;
    if (payload.result !== undefined) task.result = payload.result;
    if (payload.error !== undefined) task.error = payload.error;
    if (payload.reviewDecision !== undefined) task.reviewDecision = payload.reviewDecision;
    if (payload.reviewNotes !== undefined) task.reviewNotes = payload.reviewNotes;
    if (payload.nextTaskId !== undefined) task.nextTaskId = payload.nextTaskId;

    if (task.sessionId && !task.sessionResultRecorded && ['done', 'awaiting_review', 'approval_required', 'review_rejected', 'queue_timeout', 'error', 'cancelled'].includes(status)) {
      const resultText = typeof task.result?.text === 'string' ? task.result.text.trim() : '';
      const errorText = task.error ? `Error: ${task.error}` : '';
      const content = resultText || errorText || `Task ${status}`;
      if (this._appendSessionMessage(task.sessionId, {
        role: 'assistant',
        content,
        taskId,
        status
      })) {
        task.sessionResultRecorded = true;
      }
    }

    this.taskHistoryStore.recordStep(taskId, status, {
      success: status !== 'error' && status !== 'queue_timeout',
      error: task.error || null,
      details: {
        reviewDecision: task.reviewDecision || null,
        nextTaskId: task.nextTaskId || null
      }
    });

    if (status === 'done') {
      this.taskHistoryStore.completeTask(taskId, task.result, {
        elapsedMs: task.result?.elapsedMs || Date.now() - task.createdAt
      });
      await this._emitTaskNotification(taskId, task, 'task.completed');
    } else if (status === 'awaiting_review') {
      await this._emitTaskNotification(taskId, task, 'task.review_required', {
        remainingFollowups: task.followupTasks?.length || 0
      });
    } else if (status === 'approval_required') {
      await this._emitTaskNotification(taskId, task, 'task.approval_required');
    } else if (status === 'review_rejected') {
      this.taskHistoryStore.cancelTask(taskId);
      await this._emitTaskNotification(taskId, task, 'task.review_rejected');
    } else if (status === 'queue_timeout') {
      this.taskHistoryStore.failTask(taskId, task.error || 'Task exceeded queue wait timeout');
      await this._emitTaskNotification(taskId, task, 'task.queue_timeout');
    } else if (status === 'error') {
      this.taskHistoryStore.failTask(taskId, task.error || payload.error || 'Unknown error');
      await this._emitTaskNotification(taskId, task, 'task.error');
    } else if (status === 'cancelled') {
      this.taskHistoryStore.cancelTask(taskId);
    }

    if (this.wsHandler) {
      this.wsHandler.notifyTaskStatusChange(taskId, task);
    }
    this._syncTaskHistoryMirror(task);
    this._persistActiveQueue();
  }

  async _continueReviewedTask(taskId, task, decision, notes = '') {
    task.reviewDecision = decision;
    task.reviewNotes = notes;

    if (decision === 'reject') {
      await this._finalizeBackgroundTask(taskId, task, 'review_rejected', {
        reviewDecision: decision,
        reviewNotes: notes
      });
      return { taskId, status: task.status, reviewDecision: decision };
    }

    if (!task.followupTasks || task.followupTasks.length === 0) {
      await this._finalizeBackgroundTask(taskId, task, 'done', {
        result: task.result,
        reviewDecision: decision,
        reviewNotes: notes
      });
      return { taskId, status: task.status, reviewDecision: decision };
    }

    const [nextSpec, ...remainingFollowups] = task.followupTasks;
    const nextTask = this._createQueuedTask({
      task: nextSpec.task,
      projectPath: task.projectPath || null,
      includeProcessText: nextSpec.includeProcessText === true,
      reviewRequired: nextSpec.reviewRequired !== false,
      autoContinue: task.autoContinue === true || nextSpec.autoContinue === true,
      followupTasks: remainingFollowups,
      completionChecks: nextSpec.completionChecks,
      autoApproveDialog: nextSpec.autoApproveDialog || task.autoApproveDialog || null,
      notifyUrl: task.notifyUrl,
      chatId: task.chatId,
      soloChat: task.soloChat,
      fallbackModels: task.fallbackModels || [],
      modelProbeIntervalMs: task.modelProbeIntervalMs
    }, { queued: true, queueMessage: '等待上一审查通过后继续执行' });
    nextTask.queueState = 'workflow';

    await this._finalizeBackgroundTask(taskId, task, 'done', {
      result: task.result,
      reviewDecision: decision,
      reviewNotes: notes,
      nextTaskId: nextTask.taskId
    });
    this._ensureBackgroundPolling();
    return {
      taskId,
      status: 'continued',
      reviewDecision: decision,
      nextTaskId: nextTask.taskId,
      remainingFollowups: nextTask.followupTasks.length
    };
  }

  _clearInterval(timer) {
    clearInterval(timer);
    this.activeTimers.delete(timer);
  }

  _clearAllTimers() {
    for (const timer of this.activeTimers) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
  }

  _corsHeaders(req) {
    const origin = req.headers.origin;
    const allowed = this.allowedOrigins.split(',').map(o => o.trim()).filter(Boolean);
    if (!allowed.length) {
      if (origin && this._isSameGatewayOrigin(req, origin)) {
        return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
      }
      return {};
    }
    if (allowed.includes('*')) {
      return { 'Access-Control-Allow-Origin': '*' };
    }
    if (origin && allowed.includes(origin)) {
      return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
    }
    return {};
  }

  _json(req, res, data, statusCode = 200, headers = {}) {
    return jsonResponse(res, data, statusCode, { ...this._corsHeaders(req), ...headers }, req);
  }

  _html(req, res, html, statusCode = 200, headers = {}) {
    return htmlResponse(res, html, statusCode, { ...this._corsHeaders(req), ...headers });
  }

  _authenticate(req) {
    if (!this.token) return true;

    const authHeader = req.headers[this.authHeader.toLowerCase()] || '';
    if (authHeader.startsWith('Bearer ')) {
      return secureCompare(authHeader.slice(7), this.token);
    }

    const customToken = req.headers['x-traecn-token'];
    if (customToken) {
      return secureCompare(customToken, this.token);
    }

    return false;
  }

  _checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;

    const allowed = this.allowedOrigins.split(',').map(o => o.trim()).filter(Boolean);
    if (!allowed.length) return this._isSameGatewayOrigin(req, origin);
    return allowed.includes(origin) || allowed.includes('*');
  }

  _isSameGatewayOrigin(req, origin) {
    try {
      const parsed = new URL(origin);
      const host = String(req.headers.host || '').toLowerCase();
      if (!host) return false;
      return parsed.host.toLowerCase() === host;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the rate-limit identity for a request.
   *
   * Preference order:
   *   1. authKeyId populated on the request context (e.g. an authenticated
   *      API-key call) — this is the only stable identifier when a single
   *      client funnels traffic through a shared egress.
   *   2. IP address — works for unauthenticated traffic, but NAT / proxies
   *      collapse many real callers into one bucket.
   *   3. 'anonymous' as a final fallback (e.g. unix socket or missing peer).
   */
  _resolveRateLimitKey(req) {
    try {
      const authKeyId = requestContext.get('authKeyId');
      if (authKeyId && typeof authKeyId === 'string') {
        return `key:${authKeyId}`;
      }
    } catch { /* no active context — fall through */ }
    const ip = req?.socket?.remoteAddress;
    return ip ? `ip:${ip}` : 'anonymous';
  }

  _checkRateLimit(req) {
    const key = this._resolveRateLimitKey(req);
    return this.rateLimiter.check(key);
  }

  _checkIdempotency(req) {
    const key = req.headers['idempotency-key'];
    if (!key) return null;

    if (this.idempotencyKeys.has(key)) {
      return this.idempotencyKeys.get(key);
    }
    return null;
  }

  _storeIdempotency(key, response) {
    if (key) {
      this.idempotencyKeys.set(key, response);
      this._setTimeout(() => this.idempotencyKeys.delete(key), 300000);
    }
  }

  async _ensureConnection() {
    const closeCurrentConnection = async () => {
      if (!this.client) return;
      try {
        await this.client.close();
      } catch (e) {
        console.error('[Gateway] Error closing stale CDP client:', e.message);
      }
      this.client = null;
      this.driver = null;
      if (this.healthWatcher) this.healthWatcher.stop();
    };

    const connectFresh = async () => {
      try {
        const discovered = await discoverTarget();
        this.client = await connectToTarget(discovered, discovered.client);
        this.driver = new DomDriver(this.client);
        if (this.healthWatcher) this.healthWatcher.start(this.client);
        return discovered;
      } catch (err) {
        await closeCurrentConnection();
        const recovered = await this._attemptTraeRecovery(err);
        if (!recovered) throw err;
        const discovered = await discoverTarget();
        this.client = await connectToTarget(discovered, discovered.client);
        this.driver = new DomDriver(this.client);
        if (this.healthWatcher) this.healthWatcher.start(this.client);
        return discovered;
      }
    };

    if (this.mockBridge) {
      if (!this.driver) {
        this.driver = new MockDriver();
      }
      return;
    }

    if (!this.client || !this.client.isConnected || !this.driver) {
      await closeCurrentConnection();
      await connectFresh();
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      if (!this.client || !this.client.isConnected || !this.driver) {
        await closeCurrentConnection();
        await connectFresh();
      }

      let snapshot = null;
      try {
        snapshot = typeof this.driver.inspectSetupWizard === 'function'
          ? await this.driver.inspectSetupWizard()
          : null;
      } catch (e) {
        console.warn('[Gateway] Setup state probe failed:', e.message);
      }

      if (!snapshot?.isSetup) {
        return;
      }

      if (typeof this.driver.completeSetupIfPresent !== 'function') {
        return;
      }

      let setupResult = null;
      try {
        setupResult = await this.driver.completeSetupIfPresent();
      } catch (e) {
        console.warn('[Gateway] Setup auto-advance failed:', e.message);
        return;
      }

      if (!this.client || !this.client.isConnected) {
        await closeCurrentConnection();
        continue;
      }

      if (!setupResult || (setupResult.completed !== true && (setupResult.steps || 0) === 0)) {
        return;
      }
    }
  }

  async handleRequest(req, res) {
    // Resolve and pin a request id for this HTTP transaction. The header is
    // validated so attackers cannot inject log-poisoning characters; if the
    // header is missing/invalid we generate a fresh id.
    const requestId = this._resolveRequestId(req);
    req._requestId = requestId;
    req._requestStart = Date.now();
    try {
      res.setHeader('X-Request-ID', requestId);
    } catch {
      // res may already be destroyed; ignore.
    }

    // Wrap res.end so we record the final status code, duration, and payload
    // size once the response is fully written. This keeps the metrics
    // pipeline honest (it observes what actually went out the wire) and
    // survives early returns from handler code.
    this._instrumentResponseForMetrics(req, res);

    return requestContext.run({ requestId }, () => this._handleRequestImpl(req, res));
  }

  _instrumentResponseForMetrics(req, res) {
    if (res.__metricsInstrumented) return;
    res.__metricsInstrumented = true;
    const originalEnd = res.end.bind(res);
    res.end = (chunk, encoding, callback) => {
      try {
        const duration = Date.now() - (req._requestStart || Date.now());
        const statusCode = res.statusCode || 200;
        const responseSize = chunk ? Buffer.byteLength(chunk) : 0;
        globalMetrics.recordHttpRequest(
          req.method,
          req.url,
          statusCode,
          duration,
          parseInt(req.headers['content-length'] || '0', 10) || 0,
          responseSize
        );
      } catch (err) {
        // Never let metrics collection break the actual response.
        console.error('[Metrics] recordHttpRequest failed:', err.message);
      }
      return originalEnd(chunk, encoding, callback);
    };
  }

  _resolveRequestId(req) {
    const headerId = req.headers && req.headers['x-request-id'];
    if (typeof headerId === 'string' && REQUEST_ID_PATTERN.test(headerId)) {
      return headerId;
    }
    return requestContext.generateRequestId();
  }

  _finishRequestLog(req, res, statusCode) {
    const requestId = req._requestId || requestContext.getRequestId() || '-';
    const duration = Date.now() - (req._requestStart || Date.now());
    // Lightweight stdout-friendly breadcrumb. Full structured logs use logger.js.
    if (process.env.TRAECN_QUIET_LOG !== '1') {
      const stream = (statusCode >= 500) ? process.stderr : process.stdout;
      try {
        stream.write(
          `[Gateway] ${req.method} ${_redactUrl(req.url)} -> ${statusCode} [requestId=${requestId}] [duration=${duration}ms]\n`
        );
      } catch { /* ignore */ }
    }
  }

  async _handleRequestImpl(req, res) {
    let parsedUrl;
    const normalizedUrl = normalizeUrl(req.url);
    try {
      parsedUrl = new URL(normalizedUrl, `http://${req.headers.host}`);
    } catch(e) {
      this._finishRequestLog(req, res, 400);
      return this._json(req, res, { error: 'Invalid URL: ' + e.message }, 400);
    }
    req._normalizedUrl = normalizedUrl;
    const pathname = parsedUrl.pathname;
    const method = req.method;

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        ...this._corsHeaders(req),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-TraeCN-Token, Idempotency-Key, X-Request-ID',
        'Access-Control-Max-Age': '86400'
      });
      res.end();
      this._finishRequestLog(req, res, 204);
      return;
    }

    if (!this._checkOrigin(req)) {
      this._finishRequestLog(req, res, 403);
      return this._json(req, res, { error: 'Origin not allowed' }, 403);
    }

    // Single-source-of-truth route lookup. Public endpoints (requiresAuth: false)
    // are dispatched before the auth check to preserve the pre-refactor behavior
    // where public endpoints such as /api/status, /api/capabilities, /,
    // /openapi.json, /metrics, and /metrics.json bypassed authentication.
    const match = matchRoute(method, pathname);
    if (!match) {
      this._finishRequestLog(req, res, 404);
      return this._json(req, res, { error: 'Not found' }, 404);
    }

    const { route, params } = match;

    if (route.requiresAuth && !this._authenticate(req)) {
      this._finishRequestLog(req, res, 401);
      return this._json(req, res, { error: 'Unauthorized' }, 401);
    }

    if (route.requiresRateLimit && !this._checkRateLimit(req)) {
      this._finishRequestLog(req, res, 429);
      return this._json(req, res, { error: 'Rate limit exceeded' }, 429);
    }

    // Idempotency replay only applies to authenticated mutations; public
    // endpoints skip the idempotency cache so /metrics scrapes are cheap.
    if (route.requiresAuth) {
      const idempotencyResponse = this._checkIdempotency(req);
      if (idempotencyResponse) {
        this._finishRequestLog(req, res, idempotencyResponse.statusCode);
        return this._json(req, res, idempotencyResponse.data, idempotencyResponse.statusCode);
      }
    }

    if (route.debugOnly && !this.debugEndpoints) {
      this._finishRequestLog(req, res, 404);
      return this._json(req, res, { error: 'Not found' }, 404);
    }

    try {
      const handler = resolveHandler(this, route.handler);
      if (!handler) {
        this._finishRequestLog(req, res, 501);
        return this._json(req, res, { error: 'Handler not implemented' }, 501);
      }
      const positionalParams = (route.pathParams || []).map(name => params[name]);
      return await handler(req, res, ...positionalParams);
    } catch (err) {
      console.error('[Gateway] Error:', sanitizeLog({ message: err.message, code: err.code, name: err.name }));
      const statusCode = errorToHttpStatus(err);
      this._finishRequestLog(req, res, statusCode);
      return this._json(req, res, errorToBody(err), statusCode);
    }
  }

  // Thin wrappers for endpoints that the route table dispatches to but which
  // previously lived inline. Keeping them as named handlers lets the route
  // table refer to them by string and keeps handler signatures consistent.
  _handleCapabilities(req, res) {
    return this._json(req, res, buildCapabilities({ commands: listCommands() }));
  }

  _handleRoot(req, res) {
    return this._html(req, res, renderChatUI());
  }

  _handleOpenApiSpec(req, res) {
    return this._json(req, res, generateOpenAPISpec());
  }

  _handleTasksHistory(req, res) {
    return tasksHandlers.handleTasksHistory(req, res, this);
  }

  _handleTasksHistoryClear(req, res) {
    return tasksHandlers.handleTasksHistoryClear(req, res, this);
  }

  _handleGetTask(req, res, taskId) {
    return tasksHandlers.handleGetTask(req, res, this, taskId);
  }

  _handleTaskReplay(req, res, taskId) {
    return tasksHandlers.handleTaskReplay(req, res, this, taskId);
  }

  async _handleConfirmPlan(req, res) {
    const body = await parseBody(req);
    if (!body.command || typeof body.command !== 'string') {
      return this._json(req, res, { error: 'command is required' }, 400);
    }
    this._json(req, res, buildConfirmationPlan(body));
  }

  async _statusSnapshot() {
    let cdpVersion = null;
    let cdpReachable = false;
    let surface = null;

    try {
      const endpoint = await resolveCDPEndpoint();
      cdpVersion = endpoint.version;
      cdpReachable = true;
      try {
        surface = describeCDPSurface(await fetchCDPTargets(endpoint.host, endpoint.port));
      } catch (e) {
        // The targets endpoint is optional metadata; we still report
        // cdpReachable=true based on /json/version succeeding. Log so an
        // operator can spot broken WS URLs without losing the snapshot.
        console.warn('[Gateway] CDP target discovery failed:', e.message);
      }
    } catch (e) {
      // No CDP at all — this is the normal "TraeCN not running" state for a
      // fresh launch. Don't spam the log; use debug.
      if (process.env.DEBUG || process.env.TRAECN_DEBUG) {
        console.warn('[Gateway] CDP endpoint not reachable:', e.message);
      }
    }

    return {
      status: (this.mockBridge || (this.client && this.client.isConnected)) ? 'connected' : 'disconnected',
      service: 'traecn-cdp-http-bridge',
      version: packageInfo.version,
      mockBridge: this.mockBridge,
      cdpReachable,
      cdp: cdpVersion ? { browser: cdpVersion.Browser, protocolVersion: cdpVersion['Protocol-Version'] } : null,
      traeRunning: this.mockBridge ? null : isTraeCNRunning(),
      surface,
      uptime: process.uptime()
    };
  }

  async _probe(name, fn) {
    try {
      return { name, ok: true, value: await fn() };
    } catch (error) {
      return { name, ok: false, error: error.message, code: error.code || 'PROBE_FAILED' };
    }
  }

  _compactReadiness(readiness = {}) {
    return {
      ready: readiness.ready === true,
      mode: readiness.mode || null,
      blocker: readiness.blocker || null,
      currentModel: readiness.currentModel || null,
      composer: readiness.composer ? {
        selector: readiness.composer.matchedSelector || null,
        visible: readiness.composer.visible !== false
      } : null,
      sendButton: readiness.sendButton ? {
        selector: readiness.sendButton.matchedSelector || null,
        visible: readiness.sendButton.visible !== false,
        disabled: readiness.sendButton.disabled === true
      } : null,
      responseRegion: readiness.responseRegion ? {
        selector: readiness.responseRegion.matchedSelector || null,
        visible: readiness.responseRegion.visible !== false
      } : null,
      workspaceGuide: readiness.workspaceGuide ? {
        dismissed: readiness.workspaceGuide.dismissed || 0,
        guideVisible: readiness.workspaceGuide.guideVisible === true,
        reason: readiness.workspaceGuide.reason || null
      } : null,
      blockers: readiness.blockers ? {
        guideVisible: readiness.blockers.guideVisible === true,
        guideButtons: Array.isArray(readiness.blockers.guideButtons) ? readiness.blockers.guideButtons.slice(0, 6) : [],
        loginVisible: readiness.blockers.loginVisible === true,
        newTaskVisible: readiness.blockers.newTaskVisible === true
      } : null
    };
  }

  _compactQueue(queue = {}) {
    return {
      queued: queue.queued === true,
      running: queue.running === true,
      canSubmit: queue.canSubmit === true,
      currentModel: queue.currentModel || null,
      queuePosition: queue.queuePosition || queue.position || null,
      queueEstimatedWait: queue.queueEstimatedWait || null,
      message: queue.queueMessage || queue.message || null
    };
  }

  _compactDialog(dialog = {}) {
    return {
      hasDialog: dialog.hasDialog === true,
      dialogType: dialog.dialogType || null,
      question: dialog.question || null,
      buttonCount: Array.isArray(dialog.buttons) ? dialog.buttons.length : 0,
      buttons: Array.isArray(dialog.buttons) ? dialog.buttons.slice(0, 6) : [],
      canAutoApprove: dialog.canAutoApprove === true
    };
  }

  _isTerminalTaskStatus(status) {
    return ['done', 'error', 'cancelled', 'queue_timeout', 'review_rejected'].includes(status);
  }

  _queueRuntimeSummary() {
    const tasks = Array.from(this.taskQueue.values()).filter(task => !this._isTerminalTaskStatus(task.status));
    const batches = Array.from(this.batchTasks.values());
    const countByStatus = (items, getStatus) => items.reduce((acc, item) => {
      const status = getStatus(item) || 'unknown';
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});
    return {
      tasks: {
        total: tasks.length,
        byStatus: countByStatus(tasks, task => task.status)
      },
      batches: {
        total: batches.length,
        byStatus: countByStatus(batches, batch => batch.status)
      }
    };
  }

  _preflightNextAction({ connected, surface, readiness, queue, dialog, status }) {
    if (!connected) return status?.traeRunning ? 'restart_traecn_with_debug_existing_profile' : 'connect_traecn';
    if (surface?.kind === 'setup') return 'complete_setup_or_login';
    if (dialog?.hasDialog) return dialog.canAutoApprove ? 'approve_dialog' : 'inspect_dialog';
    if (readiness?.blocker === 'workspace_guide') return 'dismiss_workspace_guide';
    if (readiness?.blocker === 'login_required') return 'login_traecn';
    if (readiness?.blocker === 'trust_workspace') return 'approve_dialog';
    if (readiness?.blocker === 'open_task_panel') return 'open_task_panel';
    if (queue?.queued && queue?.canSubmit) return 'delegate_async';
    if (queue?.queued) return 'wait_queue_or_switch_model';
    if (queue?.running) return 'poll_or_wait';
    if (!readiness?.ready) return 'focus_or_login_traecn';
    return 'delegate_async';
  }

  async _handlePreflight(req, res) {
    const body = await parseBody(req);
    if (body.command !== undefined && typeof body.command !== 'string') {
      return this._json(req, res, { error: 'command must be a string' }, 400);
    }

    let status = await this._statusSnapshot();
    const connectionProbe = await this._probe('connection', async () => {
      await this._ensureConnection();
      return true;
    });

    const connected = connectionProbe.ok;
    if (connected) {
      status = await this._statusSnapshot();
    }
    const readinessProbe = connected
      ? await this._probe('readiness', () => this.driver.checkReadiness())
      : { name: 'readiness', ok: false, error: connectionProbe.error, code: connectionProbe.code };
    const queueProbe = connected
      ? await this._probe('queue', () => this.driver.checkQueueStatus())
      : { name: 'queue', ok: false, error: connectionProbe.error, code: connectionProbe.code };
    const dialogProbe = connected
      ? await this._probe('dialog', () => this.driver.checkForApprovalDialog())
      : { name: 'dialog', ok: false, error: connectionProbe.error, code: connectionProbe.code };

    const readiness = readinessProbe.ok ? this._compactReadiness(readinessProbe.value) : null;
    const queue = queueProbe.ok ? this._compactQueue(this._applyRecentQueueSnapshot(queueProbe.value)) : null;
    const dialog = dialogProbe.ok ? this._compactDialog({
      hasDialog: dialogProbe.value.needsApproval,
      dialogType: dialogProbe.value.dialogType,
      question: dialogProbe.value.question,
      buttons: dialogProbe.value.buttons,
      canAutoApprove: dialogProbe.value.canAutoApprove
    }) : null;
    const commandPlan = body.command
      ? buildConfirmationPlan({ command: body.command, params: body.params || {}, forceConfirm: body.forceConfirm === true })
      : null;
    const queueAllowsSubmit = !queue?.queued || queue?.canSubmit === true;
    const canDelegate = connected && readiness?.ready === true && queueAllowsSubmit && !queue?.running && !dialog?.hasDialog;
    const nextAction = this._preflightNextAction({ connected, surface: status.surface, readiness, queue, dialog, status });
    const commands = listCommands();

    this._json(req, res, {
      ok: connected,
      service: status.service,
      version: status.version,
      mockBridge: status.mockBridge,
      connected,
      cdpReachable: status.cdpReachable,
      surface: status.surface,
      ready: readiness?.ready === true,
      canDelegate,
      nextAction,
      tokenHint: commandPlan
        ? 'Use this single preflight result before executing the command; pass confirmationId only when commandPlan.requiresConfirmation is true.'
        : 'Use preflight before delegation to avoid separate status/readiness/queue/dialog calls.',
      status,
      readiness: readiness || { ok: false, error: readinessProbe.error, code: readinessProbe.code },
      queue: queue || { ok: false, error: queueProbe.error, code: queueProbe.code },
      dialog: dialog || { ok: false, error: dialogProbe.error, code: dialogProbe.code },
      localQueue: this._queueRuntimeSummary(),
      commandPlan,
      capabilities: {
        commandCount: commands.length,
        preferredFlow: ['preflight', 'delegate_async', 'task_status'],
        fullCatalog: '/api/capabilities',
        fullSchema: '/openapi.json'
      }
    });
  }

  _confirmationIdFrom(req, body = {}) {
    return body.confirmationId || req.headers['x-traecn-confirmation-id'] || '';
  }

  _confirmationFailure(req, body, command, params) {
    if (!this.enforceOperationConfirmation && body.requireConfirmation !== true) return null;
    const plan = buildConfirmationPlan({ command, params, forceConfirm: body.forceConfirm === true });
    if (!plan.requiresConfirmation) return null;
    if (this._confirmationIdFrom(req, body) === plan.confirmationId) return null;
    return {
      error: 'Operation confirmation required',
      code: 'OPERATION_CONFIRMATION_REQUIRED',
      plan
    };
  }

  async _handleStatus(req, res) {
    return statusHandlers.handleStatus(req, res, this);
  }

  _handleMetrics(req, res) {
    return statusHandlers.handleMetrics(req, res, this);
  }

  _handleMetricsJson(req, res) {
    return statusHandlers.handleMetricsJson(req, res, this);
  }

  async _handleReadiness(req, res) {
    return statusHandlers.handleReadiness(req, res, this);
  }

  /**
   * Push the latest live state from the gateway into the metrics gauges.
   * Scrapes should always see the current queue depth, CDP connection
   * status, and active session count — not whatever was true at startup.
   */
  _refreshMetricsGauges() {
    globalMetrics.setActiveSessions(this.sessions?.size || 0);
    globalMetrics.setActiveTasks(this._activeTaskCount());
    if (this.client && this.client.isConnected) {
      globalMetrics.setCdpConnection('connected');
    } else {
      globalMetrics.setCdpConnection('disconnected');
    }
    const queueSize = Array.from(this.taskQueue.values())
      .filter(task => !this._isTerminalTaskStatus(task.status)).length;
    globalMetrics.setQueueSize('tasks', queueSize);
    globalMetrics.setQueueSize('batches', this.batchTasks?.size || 0);
  }

  _activeTaskCount() {
    if (!this.taskQueue) return 0;
    let count = 0;
    for (const task of this.taskQueue.values()) {
      if (!this._isTerminalTaskStatus(task.status)) count++;
    }
    return count;
  }

  _handleGetConfig(req, res) {
    const config = this.configManager.getConfig();
    const auditLog = this.configManager.getAuditLog();
    this._json(req, res, {
      config: sanitizeLog(config),
      auditLog: sanitizeLog(auditLog.slice(-10))
    });
  }

  _handleGetConfigSchema(req, res) {
    const schema = this.configManager.getSchema();
    this._json(req, res, {
      schema,
      defaults: {
        logLevel: schema.logLevel.default,
        rateLimit: {
          windowMs: schema.rateLimit.windowMs.default,
          maxRequests: schema.rateLimit.maxRequests.default
        },
        timeout: {
          request: schema.timeout.request.default,
          response: schema.timeout.response.default
        },
        cors: {
          allowedOrigins: schema.cors.allowedOrigins.default,
          enabled: schema.cors.enabled.default
        },
        plugins: schema.plugins.default
      }
    });
  }

  async _handleUpdateConfig(req, res) {
    const body = await parseBody(req);
    try {
      const result = this.configManager.update(body);
      this._json(req, res, sanitizeLog(result));
    } catch (err) {
      if (err.name === 'ConfigValidationError') {
        this._json(req, res, {
          success: false,
          error: err.message,
          validationErrors: err.errors
        }, 400);
      } else {
        throw err;
      }
    }
  }

  async _handleResetConfig(req, res) {
    const result = this.configManager.reset();
    this._json(req, res, sanitizeLog(result));
  }

  _handleConfigDiff(req, res) {
    const parsedUrl = new URL(req._normalizedUrl || req.url, `http://${req.headers.host}`);
    const previousTimestamp = parsedUrl.searchParams.get('previous');

    let previousConfig;
    if (previousTimestamp) {
      const history = this.configManager.getHistory();
      const record = history.find(h => h.timestamp === previousTimestamp);
      previousConfig = record ? record.newConfig : null;
    } else {
      previousConfig = this.configManager.getSchema();
      previousConfig = {
        logLevel: previousConfig.logLevel.default,
        rateLimit: {
          windowMs: previousConfig.rateLimit.windowMs.default,
          maxRequests: previousConfig.rateLimit.maxRequests.default
        },
        timeout: {
          request: previousConfig.timeout.request.default,
          response: previousConfig.timeout.response.default
        },
        cors: {
          allowedOrigins: previousConfig.cors.allowedOrigins.default,
          enabled: previousConfig.cors.enabled.default
        },
        plugins: previousConfig.plugins.default
      };
    }

    const diff = this.configManager.getDiff(previousConfig);
    const history = this.configManager.getHistory();
    this._json(req, res, {
      diff: sanitizeLog(diff),
      history: sanitizeLog(history.slice(-20))
    });
  }

  async _handleCreateSession(req, res) {
    return sessionsHandlers.handleCreateSession(req, res, this);
  }

  _handleListSessions(req, res) {
    return sessionsHandlers.handleListSessions(req, res, this);
  }

  _handleGetSession(req, res, sessionId) {
    return sessionsHandlers.handleGetSession(req, res, this, sessionId);
  }

  async _handleDelegate(req, res, sessionId) {
    return sessionsHandlers.handleDelegate(req, res, this, sessionId);
  }

  async _handleNewChat(req, res) {
    return soloChatHandlers.handleNewChat(req, res, this);
  }

  async _handleListSoloChats(req, res) {
    return soloChatHandlers.handleListSoloChats(req, res, this);
  }

  async _handleSwitchSoloChat(req, res) {
    return soloChatHandlers.handleSwitchSoloChat(req, res, this);
  }

  async _handleDeleteSoloChats(req, res) {
    return soloChatHandlers.handleDeleteSoloChats(req, res, this);
  }

  async _handleCleanupForeignQueue(req, res) {
    return soloChatHandlers.handleCleanupForeignQueue(req, res, this);
  }

  _normalizeSoloChatTarget(value = {}) {
    if (!value || typeof value !== 'object') return null;
    const target = {};
    if (Number.isInteger(value.index)) target.index = value.index;
    if (typeof value.titleIncludes === 'string' && value.titleIncludes.trim()) {
      target.titleIncludes = value.titleIncludes.trim();
    }
    if (typeof value.textIncludes === 'string' && value.textIncludes.trim()) {
      target.textIncludes = value.textIncludes.trim();
    }
    if (typeof value.title === 'string' && value.title.trim() && !target.titleIncludes) {
      target.titleIncludes = value.title.trim();
    }
    if (typeof value.text === 'string' && value.text.trim() && !target.textIncludes) {
      target.textIncludes = value.text.trim();
    }
    if (Array.isArray(value.candidates)) {
      target.candidates = Array.from(new Set(value.candidates
        .filter(item => typeof item === 'string')
        .map(item => item.replace(/\s+/g, ' ').trim())
        .filter(item => item.length >= 3)))
        .slice(0, 8);
    }
    return Object.keys(target).length > 0 ? target : null;
  }

  _soloChatSwitchCriteria(soloChat) {
    const target = this._normalizeSoloChatTarget(soloChat);
    if (!target) return null;
    if (target.titleIncludes || target.textIncludes) {
      return {
        titleIncludes: target.titleIncludes,
        textIncludes: target.textIncludes
      };
    }
    return { index: target.index };
  }

  _soloChatCandidateTexts(...values) {
    const candidates = [];
    const genericTokens = new Set([
      'project', 'Project', 'path', 'Users', 'Shared', 'projects', 'Work',
      'only', 'unless', 'explicitly', 'otherwise', 'current', 'workspace',
      'TRAECNclaw'
    ]);
    const addCandidate = (value) => {
      const candidate = String(value || '').replace(/\s+/g, ' ').trim();
      if (candidate.length < 3 || candidate.length > 180) return;
      if (genericTokens.has(candidate)) return;
      candidates.push(candidate);
    };
    const add = (value) => {
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      addCandidate(text);
      const withoutState = text
        .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
        .replace(/\d{1,2}月\d{1,2}日/g, ' ')
        .replace(/任务完成|进行中|思考中|生成中|排队中|已完成/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      addCandidate(withoutState);
      for (const signal of text.match(/(?:src\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+\.js|settings\/read-all|readAll|read-all|TRAECN[A-Za-z0-9_:-]{6,})/g) || []) {
        addCandidate(signal);
      }
      for (const token of text.match(/[A-Za-z0-9_:-]{6,}/g) || []) {
        if (token.length >= 10 || /[_:-]/.test(token)) addCandidate(token);
      }
      const colonParts = text.split(/[：:]/).map(part => part.trim()).filter(part => part.length >= 3);
      colonParts.forEach(addCandidate);
    };
    values.forEach(add);
    return Array.from(new Set(candidates)).slice(0, 12);
  }

  _taskOwnershipSignals(task) {
    const values = [
      task?.task,
      task?.soloChat?.titleIncludes,
      task?.soloChat?.textIncludes,
      ...(Array.isArray(task?.soloChat?.candidates) ? task.soloChat.candidates : [])
    ];
    const signals = [];
    const add = (value, strong = false) => {
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      if (text.length < 6 || text.length > 180) return;
      signals.push({ text, strong });
    };
    for (const value of values) {
      const text = String(value || '');
      for (const token of text.match(/TRAECN[A-Za-z0-9_:-]{6,}/g) || []) {
        add(token, true);
      }
      for (const pathLike of text.match(/(?:src\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+\.js|settings\/read-all|readAll|read-all)/g) || []) {
        add(pathLike, false);
      }
    }
    return Array.from(new Map(signals.map(signal => [signal.text, signal])).values());
  }

  _resultBelongsToSubmittedTask(result, task) {
    if (!task || task.submittedToTrae !== true) return true;
    const text = String(result?.text || '');
    if (!text.trim()) return true;
    const signals = this._taskOwnershipSignals(task);
    const strongSignals = signals.filter(signal => signal.strong);
    const requiredSignals = strongSignals.length > 0 ? strongSignals : [];
    if (requiredSignals.length === 0) return true;
    return requiredSignals.some(signal => text.includes(signal.text));
  }

  _keepSubmittedTaskWaitingForOwnedResult(taskId, task, result, reason) {
    task.result = result;
    task.status = 'executing';
    task.submittedToTrae = true;
    task.queueState = task.queueState || 'running';
    task.queueMessage = reason || 'waiting for result from the submitted Solo chat';
    task.error = null;
    this.taskHistoryStore.recordStep(taskId, 'submitted_task_result_not_owned', {
      success: true,
      details: {
        reason,
        ownershipSignals: this._taskOwnershipSignals(task).map(signal => signal.text).slice(0, 8),
        resultPreview: String(result?.text || '').slice(0, 240)
      }
    });
    this._syncTaskHistoryMirror(task);
    this._persistActiveQueue();
    if (this.wsHandler) {
      this.wsHandler.notifyTaskStatusChange(taskId, task);
    }
  }

  async _switchToTaskSoloChat(task, action = 'operate') {
    if (!task?.soloChat) return { skipped: true, reason: 'no_solo_chat_target' };
    if (!this.driver || typeof this.driver.switchSoloChat !== 'function') {
      return { success: false, reason: 'driver_does_not_support_solo_chats' };
    }
    const criteriaList = [];
    const primary = this._soloChatSwitchCriteria(task.soloChat);
    if (primary) criteriaList.push(primary);
    for (const candidate of task.soloChat.candidates || []) {
      criteriaList.push({ titleIncludes: candidate });
      criteriaList.push({ textIncludes: candidate });
    }
    if (Number.isInteger(task.soloChat.index)) {
      criteriaList.push({ index: task.soloChat.index });
    }
    if (criteriaList.length === 0) return { skipped: true, reason: 'invalid_solo_chat_target' };
    let result = null;
    let criteria = null;
    for (const item of criteriaList) {
      criteria = item;
      result = await this.driver.switchSoloChat(item);
      if (result.success !== false) break;
    }
    this.taskHistoryStore.recordStep(task.taskId, 'solo_chat_switch', {
      success: result.success !== false,
      details: {
        action,
        criteria,
        result
      }
    });
    if (result.success === false) {
      throw TraeCNAutomationError.soloChatSwitchFailed(`action=${action}: ${result.reason || 'unknown'}`);
    }
    return result;
  }

  async _captureTaskSoloChat(task) {
    if (!task || !this.driver || typeof this.driver.getActiveSoloChat !== 'function') return null;
    const snapshot = await this.driver.getActiveSoloChat();
    const active = snapshot?.active || null;
    if (!active) return null;
    const candidates = this._soloChatCandidateTexts(task.task, active.title, active.text);
    const activeCandidates = this._soloChatCandidateTexts(active.title, active.text);
    const primary = activeCandidates[0] || candidates[0] || active.title || active.text;
    const soloChat = this._normalizeSoloChatTarget({
      titleIncludes: primary,
      textIncludes: primary,
      index: active.index,
      candidates
    });
    if (!soloChat) return null;
    task.soloChat = soloChat;
    this.taskHistoryStore.recordStep(task.taskId, 'solo_chat_captured', {
      success: true,
      details: {
        soloChat,
        active
      }
    });
    this._syncTaskHistoryMirror(task);
    this._persistActiveQueue();
    return soloChat;
  }

  async _handleSubmitSoloChatTask(req, res) {
    return soloChatHandlers.handleSubmitSoloChatTask(req, res, this);
  }

  async _handleStopGeneration(req, res) {
    return traeControlHandlers.handleStopGeneration(req, res, this);
  }

  async _handleRestartTraeDebug(req, res) {
    return traeControlHandlers.handleRestartTraeDebug(req, res, this);
  }

  async _handleReviewGateStatus(req, res) {
    return traeControlHandlers.handleReviewGateStatus(req, res, this);
  }

  async _handleReviewGateResolve(req, res) {
    return traeControlHandlers.handleReviewGateResolve(req, res, this);
  }

  async _handleDetectMode(req, res) {
    return traeControlHandlers.handleDetectMode(req, res, this);
  }

  async _handleSwitchMode(req, res) {
    return traeControlHandlers.handleSwitchMode(req, res, this);
  }

  async _handleSwitchModel(req, res) {
    return traeControlHandlers.handleSwitchModel(req, res, this);
  }

  async _handleQueueStatus(req, res) {
    return queueHandlers.handleQueueStatus(req, res, this);
  }

  async _handleOpenProject(req, res) {
    return projectHandlers.handleOpenProject(req, res, this);
  }

  async _handleUpdateSelf(req, res) {
    return projectHandlers.handleUpdateSelf(req, res, this);
  }

  async _handleSettingsReadAll(req, res) {
    await this._ensureConnection();
    const hardLimitMs = 35000;
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = this._setTimeout(
        () => reject(new Error('settings/read-all hard limit (' + hardLimitMs + 'ms)')),
        hardLimitMs
      );
    });
    try {
      const data = await Promise.race([
        this._withUiActionLock(() => this.driver.settings.readAll()),
        timeoutPromise
      ]);
      this._json(req, res, { sections: Object.keys(data || {}), data });
    } catch (e) {
      this._json(req, res, { error: e.message, sections: [], data: {} }, 504);
    } finally {
      if (timeoutId) this._clearTimeout(timeoutId);
    }
  }

  async _handleSettingsRead(req, res) {
    const parsedUrl = new URL(req._normalizedUrl || req.url, `http://${req.headers.host}`);
    const raw = parsedUrl.searchParams.get('section') || null;
    const SECTION_ALIASES = {
      general: '通用', account: '账号', accounts: '账号',
      agents: '智能体', mcp: 'MCP', flow: '对话流', dialog: '对话流',
      cue: 'CUE', model: '模型', models: '模型',
      context: '上下文', rules: '规则和技能', skills: '规则和技能',
      beta: 'Beta', about: '关于 TRAE'
    };
    const section = raw ? (SECTION_ALIASES[raw] || (() => {
      try { return decodeURIComponent(raw); } catch(e) { return raw; }
    })()) : null;

    await this._ensureConnection();

    const switchResult = await this.driver.settings.switchTab(section);

    let data;
    try {
      data = await this.driver.settings.getContent();
    } catch(e) {
      return this._json(req, res, { error: e.message }, 500);
    }

    this._json(req, res, { section: section || 'current', ...data });
  }

  async _handleSettingsSet(req, res) {
    const body = await parseBody(req);
    if (!body.label) {
      return this._json(req, res, { error: 'label is required' }, 400);
    }
    if (body.value === undefined || body.value === null) {
      return this._json(req, res, { error: 'value is required' }, 400);
    }
    const confirmationFailure = this._confirmationFailure(req, body, 'settings_set', {
      label: body.label,
      value: body.value,
      ...(body.section ? { section: body.section } : {})
    });
    if (confirmationFailure) return this._json(req, res, confirmationFailure, 409);

    await this._ensureConnection();

    // If section is specified, navigate there first
    if (body.section) {
      await this.driver.settings.switchTab(body.section);
    }

    const result = await this.driver.settings.set(body.label, body.value);
    this._json(req, res, { label: body.label, value: body.value, result });
  }

  async _handleSettingsSwitchTab(req, res) {
    const body = await parseBody(req);
    if (!body.section) {
      return this._json(req, res, { error: 'section is required' }, 400);
    }

    await this._ensureConnection();
    const result = await this.driver.settings.switchTab(body.section);
    this._json(req, res, result);
  }

  async _handleSettingsBackToChat(req, res) {
    await this._ensureConnection();
    const result = await this.driver.settings.backToChat();
    this._json(req, res, { result });
  }


  // ── Dialog / Approval handlers ──────────────────────────────────────────

  async _handleDialogApprove(req, res) {
    const body = await parseBody(req);
    const action = (body.action || 'auto').toLowerCase();

    const confirmationFailure = this._confirmationFailure(req, body, 'approve_dialog', { action });
    if (confirmationFailure) return this._json(req, res, confirmationFailure, 409);

    await this._ensureConnection();
    const currentDialog = await this.driver.checkForApprovalDialog();
    const currentRestricted = currentDialog.needsApproval ? null : await this.driver.checkRestrictedMode();

    if (action === 'trust' && currentRestricted?.restricted) {
      const restrictedResult = await this.driver.clickRestrictedModeTrust();
      return this._json(req, res, {
        success: restrictedResult.success,
        action,
        dialogType: 'restricted_mode_banner',
        buttonClicked: restrictedResult.buttonText || restrictedResult.manageButtonText,
        error: restrictedResult.error || restrictedResult.reason
      });
    }

    if (action === 'auto') {
      // Auto-detect the best action based on dialog type
      const dialog = currentDialog;
      if (!dialog.needsApproval) {
        if (currentRestricted?.restricted) {
          const restrictedResult = await this.driver.clickRestrictedModeTrust();
          return this._json(req, res, {
            success: restrictedResult.success,
            action: 'trust',
            dialogType: 'restricted_mode_banner',
            buttonClicked: restrictedResult.buttonText || restrictedResult.manageButtonText,
            error: restrictedResult.error || restrictedResult.reason
          });
        }
        return this._json(req, res, { success: false, error: 'No dialog found to approve' });
      }
      const autoAction = dialog.canAutoApprove ? 'trust' : 'allow';
      const result = await this.driver.approveDialog(autoAction);
      return this._json(req, res, {
        success: result.success,
        action: autoAction,
        dialogType: dialog.dialogType,
        buttonClicked: result.buttonClicked,
        error: result.error
      });
    }

    if (action === 'answer') {
      const answer = body.answer || body.option || body.value;
      if (!answer) {
        return this._json(req, res, { error: 'answer is required for dialog answer action' }, 400);
      }
      if (typeof this.driver.answerQuestionDialog !== 'function') {
        return this._json(req, res, { error: 'Driver does not support question dialog answers' }, 501);
      }
      const result = await this.driver.answerQuestionDialog(answer);
      const resumedTaskIds = result.success
        ? this._resumeApprovalRequiredTasksAfterDialogAnswer(answer, result)
        : [];
      return this._json(req, res, {
        success: result.success,
        action,
        answer,
        resumedTaskIds,
        selectedOption: result.selectedOption,
        buttonClicked: result.buttonClicked,
        error: result.error
      });
    }

    if (!['trust', 'allow', 'confirm', 'approve', 'deny', 'cancel', 'dismiss'].includes(action)) {
      return this._json(req, res, { error: 'Invalid action: ' + action }, 400);
    }

    let result = await this.driver.approveDialog(action);
    if (!result.success && action === 'trust') {
      const restrictedResult = await this.driver.clickRestrictedModeTrust();
      if (restrictedResult.success) {
        result = {
          success: true,
          action,
          buttonClicked: restrictedResult.buttonText || 'Manage -> Trust'
        };
      }
    }
    this._json(req, res, {
      success: result.success,
      action,
      buttonClicked: result.buttonClicked,
      error: result.error
    });
  }

  async _handleDialogDismiss(req, res) {
    const body = await parseBody(req);
    const confirmationFailure = this._confirmationFailure(req, body, 'dismiss_dialog', {});
    if (confirmationFailure) return this._json(req, res, confirmationFailure, 409);

    await this._ensureConnection();
    const result = await this.driver.approveDialog('dismiss');
    this._json(req, res, {
      success: result.success,
      action: 'dismiss',
      buttonClicked: result.buttonClicked,
      error: result.error
    });
  }

  async _handleDialogStatus(req, res) {
    await this._ensureConnection();
    let dialog = await this.driver.checkForApprovalDialog();
    if (!dialog.needsApproval) {
      const restricted = await this.driver.checkRestrictedMode();
      if (restricted?.restricted) {
        dialog = {
          needsApproval: true,
          dialogType: 'restricted_mode_banner',
          question: restricted.title || '受限模式已启用',
          buttons: restricted.manageButtonFound ? ['管理'] : [],
          canAutoApprove: restricted.trustButtonFound === true || restricted.manageButtonFound === true
        };
      }
    }
    this._json(req, res, {
      hasDialog: dialog.needsApproval,
      dialogType: dialog.dialogType || null,
      question: dialog.question || null,
      buttons: dialog.buttons || [],
      options: dialog.options || [],
      answerAction: dialog.dialogType === 'review_scope_question'
        ? { endpoint: '/api/dialog/approve', method: 'POST', body: { action: 'answer', answer: '<option label>' } }
        : null,
      canAutoApprove: dialog.canAutoApprove || false
    });
  }

  async _handleDebugAutomation(req, res) {
    const config = getConfig();
    await this._ensureConnection();
    const readiness = await this.driver.checkReadiness();

    this._json(req, res, {
      config: {
        composerSelectors: config.composerSelectors,
        sendButtonSelectors: config.sendButtonSelectors,
        responseSelectors: config.responseSelectors,
        activitySelectors: config.activitySelectors,
        newChatSelectors: config.newChatSelectors,
        modeTabSelectors: config.modeTabSelectors,
        ideTaskPanelSelectors: config.ideTaskPanelSelectors,
        ideResponseSelectors: config.ideResponseSelectors,
        ideNewChatSelectors: config.ideNewChatSelectors,
        sendTrigger: config.sendTrigger,
        defaultMode: config.defaultMode,
        modeSwitchWaitMs: config.modeSwitchWaitMs
      },
      readiness,
      mode: readiness.mode || null
    });
  }

  // ── Async delegate (Step 7 & 8) ─────────────────────────────────────────────

  // ── Async delegate (queue-aware v2) ──────────────────────────────────────
  //
  // Returns clear status signals to the caller:
  //   queued  → { status: 'queued', taskId, queueDetails }
  //   running → { status: 'running', message }
  //   done    → { status: 'done', text, ...result }
  //
  // Supports waitForQueue (default: true): if model is queued, enqueue the task
  // for background processing; if false, return immediately with queue info.

  async _handleDelegateAsync(req, res) {
    return delegateHandlers.handleDelegateAsync(req, res, this);
  }


  // ── Task status & cancel ──────────────────────────────────────────────────

  _historyTaskStatusResponse(record) {
    if (!record) return null;
    const statusMap = {
      completed: 'done',
      failed: 'error',
      cancelled: 'cancelled',
      queued: 'queued',
      executing: 'executing',
      awaiting_review: 'awaiting_review',
      approval_required: 'approval_required'
    };
    const status = statusMap[record.status] || record.status || 'unknown';
    const response = {
      taskId: record.taskId,
      status,
      historyStatus: record.status,
      createdAt: record.createdAtMs || Date.parse(record.createdAt) || null,
      elapsed: record.elapsedMs || (record.createdAtMs ? Math.max(0, Date.now() - record.createdAtMs) : null),
      completedAt: record.completedAt || null,
      message: status === 'error' ? '执行出错（来自历史记录）' : '任务已从活跃队列移至历史记录',
      fromHistory: true,
      metadata: record.metadata || {},
      stepCount: Array.isArray(record.steps) ? record.steps.length : 0
    };

    if (record.result) {
      if (record.result.error) {
        response.error = record.result.error;
      } else {
        response.result = record.result;
      }
    }
    if (Array.isArray(record.steps) && record.steps.length > 0) {
      const lastFailed = [...record.steps].reverse().find(step => step.success === false || step.error);
      const lastStep = record.steps[record.steps.length - 1];
      response.lastStep = {
        action: lastStep.action,
        timestamp: lastStep.timestamp,
        success: lastStep.success,
        error: lastStep.error || null,
        details: lastStep.details || {}
      };
      if (lastFailed && !response.error) response.error = lastFailed.error || lastFailed.details?.error || null;
    }
    return response;
  }

  async _handleTaskStatus(req, res, taskId) {
    return taskActionsHandlers.handleTaskStatus(req, res, this, taskId);
  }

  async _handleTaskReview(req, res, taskId) {
    return taskActionsHandlers.handleTaskReview(req, res, this, taskId);
  }

  async _handleTaskCancel(req, res, taskId) {
    return taskActionsHandlers.handleTaskCancel(req, res, this, taskId);
  }

  async _handleBatchSubmit(req, res) {
    return batchHandlers.handleBatchSubmit(req, res, this);
  }

  _startBatchExecution(batchId) {
    const batch = this.batchTasks.get(batchId);
    if (!batch || batch._cancelled) return;

    if (batch.strategy === 'parallel') {
      this._executeBatchParallel(batchId);
    } else if (batch.strategy === 'sequential') {
      this._executeBatchSequential(batchId);
    } else {
      this._executeBatchPriority(batchId);
    }
  }

  async _executeBatchParallel(batchId) {
    const batch = this.batchTasks.get(batchId);
    if (!batch) return;

    const pendingTasks = batch.tasks.filter(t => t.status === 'pending');
    const runningTasks = batch.tasks.filter(t => t.status === 'executing');
    const availableSlots = batch.maxConcurrency - runningTasks.length;

    if (availableSlots > 0 && pendingTasks.length > 0) {
      const tasksToStart = pendingTasks.slice(0, availableSlots);
      for (const task of tasksToStart) {
        task.status = 'executing';
        this._executeSingleBatchTask(batchId, task.taskId).catch(() => {});
      }
    }
  }

  async _executeBatchSequential(batchId) {
    const batch = this.batchTasks.get(batchId);
    if (!batch) return;

    const nextTask = batch.tasks.find(t => t.status === 'pending');
    if (nextTask) {
      nextTask.status = 'executing';
      await this._executeSingleBatchTask(batchId, nextTask.taskId);
    }
  }

  async _executeBatchPriority(batchId) {
    const batch = this.batchTasks.get(batchId);
    if (!batch) return;

    const runningCount = batch.tasks.filter(t => t.status === 'executing').length;
    if (runningCount >= batch.maxConcurrency) return;

    const pendingTasks = batch.tasks
      .filter(t => t.status === 'pending')
      .sort((a, b) => b.priority - a.priority);

    const slotsAvailable = batch.maxConcurrency - runningCount;
    const tasksToStart = pendingTasks.slice(0, slotsAvailable);

    for (const task of tasksToStart) {
      task.status = 'executing';
      this._executeSingleBatchTask(batchId, task.taskId).catch(() => {});
    }
  }

  async _executeSingleBatchTask(batchId, taskId) {
    const batch = this.batchTasks.get(batchId);
    if (!batch || batch._cancelled) return;

    const task = batch.tasks.find(t => t.taskId === taskId);
    if (!task || task.status !== 'executing' || batch._cancelled) return;

    try {
      await this._ensureConnection();
      const result = await this.driver.delegate(this._taskWithProjectContext(task.task, task.projectPath));

      task.status = 'done';
      task.result = {
        text: result.text,
        stable: result.stable,
        elapsedMs: result.elapsedMs,
        timedOut: result.timedOut || false
      };
      batch.completedCount++;
      batch.results.push({ taskId, status: 'done', result: task.result });

      if (result.needsApproval) {
        task.result.needsApproval = true;
        task.result.question = result.question || '';
      }
    } catch (e) {
      task.status = 'error';
      task.error = e.message;
      batch.failedCount++;
      batch.results.push({ taskId, status: 'error', error: e.message });
    }

    this._checkBatchCompletion(batchId);
  }

  _checkBatchCompletion(batchId) {
    const batch = this.batchTasks.get(batchId);
    if (!batch) return;

    const allDone = batch.tasks.every(t => t.status !== 'pending' && t.status !== 'executing');

    if (allDone) {
      batch.status = 'completed';
      this._notifyBatchComplete(batch);
    } else {
      this._startBatchExecution(batchId);
    }
  }

  async _notifyBatchComplete(batch) {
    if (!batch.onComplete) return;

    try {
      const payload = {
        batchId: batch.batchId,
        status: batch.status,
        totalCount: batch.totalCount,
        completedCount: batch.completedCount,
        failedCount: batch.failedCount,
        completedAt: new Date().toISOString(),
        results: batch.results
      };

      await fetch(batch.onComplete, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000)
      });
    } catch (e) {
      console.error('[Batch] Notification failed:', e.message);
    }
  }

  _handleBatchStatus(req, res, batchId) {
    return batchHandlers.handleBatchStatus(req, res, this, batchId);
  }

  _handleBatchCancel(req, res, batchId) {
    return batchHandlers.handleBatchCancel(req, res, this, batchId);
  }

  _handleQueueStatusList(req, res) {
    return queueHandlers.handleQueueStatusList(req, res, this);
  }

  _formatCompletionCheckFailure(validation = {}) {
    const parts = [];
    if (Array.isArray(validation.missingFiles) && validation.missingFiles.length > 0) {
      parts.push('missing files: ' + validation.missingFiles.join(', '));
    }
    if (Array.isArray(validation.missingText) && validation.missingText.length > 0) {
      const details = validation.missingText.map(item => `${item.filePath} missing ${item.includes.join(', ')}`);
      parts.push('missing text: ' + details.join('; '));
    }
    return parts.length > 0 ? 'Completion checks failed: ' + parts.join('; ') : 'Completion checks failed';
  }

  _taskWithCompletionCheckFeedback(taskText, validation) {
    const feedback = [
      '',
      '',
      'Completion checks failed after the previous attempt.',
      this._formatCompletionCheckFailure(validation),
      'Fix these missing deliverables before reporting completion.'
    ].join('\n');
    const base = String(taskText || '').replace(/\n\nCompletion checks failed after the previous attempt\.[\s\S]*$/m, '');
    return (base + feedback).slice(0, 100000);
  }

  async _retryBackgroundTaskAfterCompletionCheckFailure(taskId, task, result, validation, options = {}) {
    const maxAttempts = Number.isFinite(Number(options.maxAttempts))
      ? Number(options.maxAttempts)
      : Number(process.env.TRAECN_BACKGROUND_MAX_RETRIES || 3);
    const attempts = Number(task.attempts || 0);
    if (attempts >= maxAttempts) return false;

    task.attempts = attempts + 1;
    task.error = this._formatCompletionCheckFailure(validation);
    task.result = result;
    task.task = this._taskWithCompletionCheckFeedback(task.task, validation);
    task.status = 'queued';
    task.submittedToTrae = false;
    task.submittedAt = null;
    task.queueState = 'queued';
    task.queueMessage = 'retry scheduled after failed completion checks';

    this.taskHistoryStore.recordStep(taskId, 'completion_check_failed', {
      success: false,
      details: {
        attempts: task.attempts,
        maxAttempts,
        missingFiles: validation.missingFiles,
        missingText: validation.missingText
      }
    });
    this._syncTaskHistoryMirror(task);
    this._persistActiveQueue();
    return true;
  }

  async _finalizeCollectedBackgroundResult(taskId, task, result) {
    task.result = result;

    if (this._isQueuedTaskResult(result)) {
      this._keepSubmittedTaskWaitingInQueue(taskId, task, result);
    } else if (!this._resultBelongsToSubmittedTask(result, task)) {
      this._keepSubmittedTaskWaitingForOwnedResult(taskId, task, result, 'collected result did not include a task ownership token');
    } else if (result.needsApproval) {
      if (await this._tryAutoApproveTaskDialog(taskId, task, result)) return;
      await this._finalizeBackgroundTask(taskId, task, 'approval_required', {
        result
      });
    } else if (task.reviewRequired || (task.followupTasks && task.followupTasks.length > 0)) {
      if (this._isReviewableTaskResult(result, task)) {
        const validation = this._validateCompletionChecks(task);
        if (!validation.ok) {
          if (await this._retryBackgroundTaskAfterCompletionCheckFailure(taskId, task, result, validation)) return;
          await this._finalizeBackgroundTask(taskId, task, 'error', {
            result,
            error: this._formatCompletionCheckFailure(validation)
          });
          return;
        }
        if (task.autoContinue === true) {
          task.result = result;
          await this._continueReviewedTask(taskId, task, 'approve', 'autoContinue');
        } else {
          await this._finalizeBackgroundTask(taskId, task, 'awaiting_review', {
            result
          });
        }
      } else {
        if (await this._retryBackgroundTaskAfterResult(taskId, task, result)) {
          return;
        }
        await this._finalizeBackgroundTask(taskId, task, 'error', {
          result,
          error: 'Trae returned an incomplete or timed-out result before review'
        });
      }
    } else if (this._isSuccessfulTaskResult(result, task)) {
      const validation = this._validateCompletionChecks(task);
      if (!validation.ok) {
        if (await this._retryBackgroundTaskAfterCompletionCheckFailure(taskId, task, result, validation)) return;
        await this._finalizeBackgroundTask(taskId, task, 'error', {
          result,
          error: this._formatCompletionCheckFailure(validation)
        });
        return;
      }
      await this._finalizeBackgroundTask(taskId, task, 'done', {
        result
      });
    } else {
      if (await this._retryBackgroundTaskAfterResult(taskId, task, result)) {
        return;
      }
      await this._finalizeBackgroundTask(taskId, task, 'error', {
        result,
        error: result.error || 'Trae returned an incomplete, timed-out, or failed result'
      });
    }
  }

  async _finalizePersistedResultIfComplete(taskId, task) {
    if (!task || !task.result) return false;
    if (this._backgroundResultRetryMode(task.result, task)) return false;
    await this._finalizeCollectedBackgroundResult(taskId, task, task.result);
    return this._isTerminalTaskStatus(task.status);
  }

  _backgroundResultRetryMode(result, task = null) {
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

  async _retryBackgroundTaskAfterResult(taskId, task, result, options = {}) {
    const retryMode = this._backgroundResultRetryMode(result, task);
    if (!retryMode) return false;

    const maxAttempts = Number.isFinite(Number(options.maxAttempts))
      ? Number(options.maxAttempts)
      : Number(process.env.TRAECN_BACKGROUND_MAX_RETRIES || 3);
    const attempts = Number(task.attempts || 0);
    if (attempts >= maxAttempts) return false;

    task.attempts = attempts + 1;
    const retryMessage = retryMode === 'collect'
      ? 'Trae result was incomplete; collecting again'
      : 'Trae returned a failed result; resubmitting task';
    task.error = result?.error ? `${retryMessage}: ${result.error}` : retryMessage;
    task.result = result;
    if (retryMode === 'collect' && task.submittedToTrae === true) {
      task.status = 'executing';
    } else {
      task.status = 'queued';
      task.submittedToTrae = false;
      task.submittedAt = null;
      task.queueState = 'queued';
      task.queueMessage = task.queueMessage || 'retry scheduled after failed result';
    }

    this.taskHistoryStore.recordStep(taskId, 'retry_scheduled', {
      success: true,
      details: {
        attempts: task.attempts,
        maxAttempts,
        retryMode,
        submittedToTrae: task.submittedToTrae === true,
        error: task.error,
        timedOut: result?.timedOut === true,
        truncated: result?.truncated === true,
        streaming: result?.streaming === true,
        modelError: result?.modelError === true
      }
    });
    this._syncTaskHistoryMirror(task);
    this._persistActiveQueue();
    return true;
  }

  async _retryBackgroundTaskAfterError(taskId, task, err, options = {}) {
    const maxAttempts = Number.isFinite(Number(options.maxAttempts))
      ? Number(options.maxAttempts)
      : Number(process.env.TRAECN_BACKGROUND_MAX_RETRIES || 3);
    const attempts = Number(task.attempts || 0);
    if (attempts >= maxAttempts) return false;

    task.attempts = attempts + 1;
    task.error = err?.message || String(err || 'unknown error');
    task.status = task.submittedToTrae === true ? 'executing' : 'queued';
    task.queueState = task.status;
    this.taskHistoryStore.recordStep(taskId, 'retry_scheduled', {
      success: true,
      details: {
        attempts: task.attempts,
        maxAttempts,
        submittedToTrae: task.submittedToTrae === true,
        error: task.error
      }
    });
    this._syncTaskHistoryMirror(task);
    this._persistActiveQueue();
    return true;
  }

  async _collectSubmittedBackgroundTask(taskId, task) {
    return await this._withUiActionLock(async () => {
      await this._ensureConnection();
      await this._switchToTaskSoloChat(task, 'collect_result');
      if (this.driver && typeof this.driver.getActiveSoloChat === 'function') {
        const activeSnapshot = await this.driver.getActiveSoloChat();
        const activeChat = activeSnapshot?.active || null;
        if (activeChat?.status === 'running') {
          task.queueState = 'running';
          task.queueMessage = activeChat.title || activeChat.text || 'submitted Solo chat is still running';
          this.taskHistoryStore.recordStep(taskId, 'submitted_solo_chat_still_running', {
            success: true,
            details: { active: activeChat }
          });
          this._syncTaskHistoryMirror(task);
          this._persistActiveQueue();
          if (this.wsHandler) {
            this.wsHandler.notifyTaskStatusChange(taskId, task);
          }
          return { text: '', stable: false, elapsedMs: 0, running: true };
        }
      }
      const queueStatus = await this.driver.checkQueueStatus();
      this._updateQueuedTaskSnapshot(task, queueStatus);
      this._syncTaskHistoryMirror(task);
      this._persistActiveQueue();

      if (queueStatus.running === true || queueStatus.queued === true) {
        this.taskHistoryStore.recordStep(taskId, 'submitted_task_still_active', {
          success: true,
          details: this._queueDetailsFromStatus(queueStatus, task.currentModel)
        });
        if (this.wsHandler) {
          this.wsHandler.notifyTaskStatusChange(taskId, task);
        }
        return { text: '', stable: false, elapsedMs: 0, queued: queueStatus.queued === true, running: queueStatus.running === true };
      }

      const result = await this.driver.collectResponse();
      if (this._isTerminalTaskStatus(task.status)) {
        this.taskHistoryStore.recordStep(taskId, 'collected_result_ignored', {
          success: true,
          details: {
            status: task.status,
            reason: 'task already reached a terminal state before collectResponse returned'
          }
        });
        this._syncTaskHistoryMirror(task);
        this._persistActiveQueue();
        return result;
      }
      await this._finalizeCollectedBackgroundResult(taskId, task, result);
      return result;
    });
  }

  _resumeApprovalRequiredTasksAfterDialogAnswer(answer, result = {}) {
    const resumedTaskIds = [];
    const answeredAt = Date.now();

    for (const [taskId, task] of this.taskQueue) {
      if (task.status !== 'approval_required') continue;

      const dialogType = String(task.result?.dialogType || '');
      const question = String(task.result?.question || '');
      const isReviewScopeQuestion = dialogType === 'review_scope_question'
        || /review scope|what would you like me to review/i.test(question);
      if (!isReviewScopeQuestion) continue;

      task.status = 'executing';
      task.submittedToTrae = true;
      task.submittedAt = task.submittedAt || answeredAt;
      task.queueState = 'running';
      task.queueMessage = 'question answered; waiting for Trae result';
      task.error = null;
      task.answeredDialog = {
        answer,
        selectedOption: result.selectedOption || null,
        buttonClicked: result.buttonClicked || null,
        answeredAt
      };

      this.taskHistoryStore.recordStep(taskId, 'dialog_answered', {
        success: true,
        details: task.answeredDialog
      });
      this._syncTaskHistoryMirror(task);
      resumedTaskIds.push(taskId);
    }

    if (resumedTaskIds.length > 0) {
      this._persistActiveQueue();
      this._ensureBackgroundPolling();
    }

    return resumedTaskIds;
  }

  async _handleAdoptCurrentTask(req, res) {
    return taskActionsHandlers.handleAdoptCurrentTask(req, res, this);
  }

  // ── Background polling (queue-aware) ──────────────────────────────────────
  //
  // Polls periodically: checks queue state, runs newChat when the queue clears,
  // sends the task and waits for the response. Enforces per-task deadline.

  _ensureBackgroundPolling() {
    if (this.pollingTimer) return;
    const pollInterval = 15000;
    this.pollingTimer = this._setInterval(async () => {
      // Prevent concurrent polling
      if (this.isPolling) return;
      this.isPolling = true;

      try {
        // 定期清理机制：只清理超过一定时间的终态任务。
        // Paused or running workflow state must remain recoverable for long queues.
        const now = Date.now();
        const maxTaskAge = 3600000; // 1小时
        for (const [taskId, task] of this.taskQueue) {
          if (this._isTerminalTaskStatus(task.status) && now - task.createdAt > maxTaskAge) {
            console.log('[Queue] Cleaning up old task', taskId, 'with status', task.status);
            this.taskQueue.delete(taskId);
            this.taskLocks.delete(taskId);
          }
        }
        
        for (const [taskId, task] of this.taskQueue) {
          if (this.taskLocks.has(taskId)) continue;

          if (task.status === 'executing' && task.submittedToTrae === true) {
            this.taskLocks.add(taskId);
            try {
              if (await this._finalizePersistedResultIfComplete(taskId, task)) {
                continue;
              }
              await this._collectSubmittedBackgroundTask(taskId, task);
            } catch (e) {
              console.error('[Queue] Submitted task', taskId, 'recovery error:', e.message);
              if (/review gate/i.test(e.message || '')) {
                const recoveredResult = await this._recoverAwaitingReviewFromGate(task);
                if (recoveredResult) {
                  task.result = recoveredResult;
                  await this._finalizeCollectedBackgroundResult(taskId, task, recoveredResult);
                  continue;
                }
              }
              if (await this._retryBackgroundTaskAfterError(taskId, task, e)) {
                continue;
              }
              await this._finalizeBackgroundTask(taskId, task, 'error', {
                error: e.message
              });
            } finally {
              this.taskLocks.delete(taskId);
            }
            continue;
          }

          // Skip if task is not queued
          if (task.status !== 'queued') continue;

          try {
            await this._ensureConnection();
            let queueStatus = await this.driver.checkQueueStatus();
            this._updateQueuedTaskSnapshot(task, queueStatus);

            if ((queueStatus.queued || queueStatus.running) && Array.isArray(task.fallbackModels) && task.fallbackModels.length > 0) {
              const probe = await this._probeFallbackModels(task);
              if (probe.queueStatus) {
                queueStatus = probe.queueStatus;
                this._updateQueuedTaskSnapshot(task, queueStatus);
              }
            }

            if (task.deadline && Date.now() > task.deadline) {
              const extended = this._maybeExtendQueuedTaskDeadline(task, queueStatus);
              if (!extended) {
                console.log('[Queue] Task', taskId, 'queue timeout after', Date.now() - task.createdAt, 'ms');
                await this._finalizeBackgroundTask(taskId, task, 'queue_timeout', {
                  error: 'Task exceeded queue wait timeout'
                });
                continue;
              }
            }

            // Still queued or actively running — skip this task for now
            if (queueStatus.running || (queueStatus.queued && queueStatus.canSubmit !== true)) {
              if (this.wsHandler) {
                this.wsHandler.notifyTaskStatusChange(taskId, task);
              }
              this._syncTaskHistoryMirror(task);
              this._persistActiveQueue();
              continue;
            }

            // Lock this task before execution
            this.taskLocks.add(taskId);
            task.status = 'executing';
            this._syncTaskHistoryMirror(task);
            this._persistActiveQueue();

            if (this.wsHandler) {
              this.wsHandler.notifyTaskStatusChange(taskId, task);
            }

            try {
              await this._withUiActionLock(async () => {
                // Create a fresh chat before sending (background poller bypasses
                // delegate() which would also call newChat)
                if (task.soloChat) {
                  await this._switchToTaskSoloChat(task, 'send_task');
                } else {
                  await this.driver.newChat();
                }
                await this.driver.sendMessage(this._taskWithProjectContext(task.task, task.projectPath));
                task.submittedToTrae = true;
                task.submittedAt = Date.now();
                if (!task.soloChat) {
                  await this._captureTaskSoloChat(task);
                }
                this._syncTaskHistoryMirror(task);
                this._persistActiveQueue();
                const result = await this.driver.collectResponse();
                if (this._isTerminalTaskStatus(task.status)) {
                  this.taskHistoryStore.recordStep(taskId, 'collected_result_ignored', {
                    success: true,
                    details: {
                      status: task.status,
                      reason: 'task already reached a terminal state before collectResponse returned'
                    }
                  });
                  this._syncTaskHistoryMirror(task);
                  this._persistActiveQueue();
                  return;
                }
                await this._finalizeCollectedBackgroundResult(taskId, task, result);
              });
            } catch (e) {
              console.error('[Queue] Task', taskId, 'execution error:', e.message);
              if (/review gate/i.test(e.message || '')) {
                const recoveredResult = await this._recoverAwaitingReviewFromGate(task);
                if (recoveredResult) {
                  task.result = recoveredResult;
                  await this._finalizeCollectedBackgroundResult(taskId, task, recoveredResult);
                  continue;
                }
              }
              if (await this._retryBackgroundTaskAfterError(taskId, task, e)) {
                continue;
              }
              await this._finalizeBackgroundTask(taskId, task, 'error', {
                error: e.message
              });
            } finally {
              // Unlock the task after execution completes (success or error)
              this.taskLocks.delete(taskId);
            }
          } catch (e) {
            console.error('[Queue] polling error:', e.message);
          }
        }
      } finally {
        // Release the polling lock
        this.isPolling = false;
      }
    }, pollInterval);
    if (typeof this.pollingTimer.unref === 'function') {
      this.pollingTimer.unref();
    }
    console.log('[Gateway] Background polling started (interval=' + pollInterval + 'ms)');
  }

  _stopBackgroundPolling() {
    if (!this.pollingTimer) return;
    this._clearInterval(this.pollingTimer);
    this.pollingTimer = null;
  }

  async gracefulShutdown() {
    if (this._shutdownInProgress) {
      // Idempotent: a second call (e.g. SIGTERM after SIGINT, or test cleanup
      // racing with server.on('close')) returns the original promise.
      return this._shutdownInProgress;
    }
    this._shutdownInProgress = (async () => {
      console.log('[Gateway] Starting graceful shutdown...');

      this._stopBackgroundPolling();
      this._clearAllTimers();
      this._persistActiveQueue();

      const taskCount = this.taskQueue.size;
      this.taskQueue.clear();
      this.taskLocks.clear();
      console.log(`[Gateway] Cleared ${taskCount} tasks from queue`);

      const batchCount = this.batchTasks.size;
      this.batchTasks.clear();
      console.log(`[Gateway] Cleared ${batchCount} batch tasks`);

      if (this.taskHistoryStore) {
        this.taskHistoryStore.shutdown();
        console.log('[Gateway] Task history store shut down');
      }

      // Stop the CDP health watcher BEFORE closing the CDP client so any
      // in-flight probe sees `_stopped = true` and exits cleanly instead of
      // racing against a half-closed websocket.
      if (this.healthWatcher && typeof this.healthWatcher.stop === 'function') {
        try {
          this.healthWatcher.stop();
          console.log('[Gateway] CDP health watcher stopped');
        } catch (e) {
          console.error('[Gateway] Error stopping health watcher:', e.message);
        }
      }

      // Tear down WS server + heartbeat interval BEFORE the HTTP server's
      // close() runs, so upgrade requests don't try to attach to a dying wss.
      if (this.wsHandler && typeof this.wsHandler.close === 'function') {
        try {
          this.wsHandler.close();
          console.log('[Gateway] WebSocket handler closed');
        } catch (e) {
          console.error('[Gateway] Error closing WebSocket handler:', e.message);
        }
        this.wsHandler = null;
      }

      if (this.client) {
        try {
          await this.client.close();
          console.log('[Gateway] CDP client closed');
        } catch (e) {
          console.error('[Gateway] Error closing CDP client:', e.message);
        }
        this.client = null;
        this.driver = null;
      }

      if (this.server) {
        await new Promise((resolve) => {
          this.server.close(() => {
            console.log('[Gateway] HTTP server closed');
            this.server = null;
            resolve();
          });
        });
      }

      console.log('[Gateway] Graceful shutdown completed');
    })();

    try {
      await this._shutdownInProgress;
    } finally {
      // Keep `_shutdownInProgress` truthy so repeat callers still see the
      // resolved promise; clear no state.
    }
  }

  /**
   * Alias kept for callers (tests, embedders) that prefer the conventional
   * `close()` name. Equivalent to `gracefulShutdown()`.
   */
  close() {
    return this.gracefulShutdown();
  }
}

async function startGateway(options = {}) {
  const gateway = new Gateway(options);

  const server = http.createServer((req, res) => {
    gateway.handleRequest(req, res).catch(err => {
      console.error('[Gateway] Unhandled error:', err);
      gateway._json(req, res, { error: 'Internal server error' }, 500);
    });
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 125000;

  server.on('close', () => {
    gateway._stopBackgroundPolling();
    gateway._clearAllTimers();
    if (gateway.client) {
      gateway.client.close().catch(() => {});
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(gateway.port, gateway.host, () => {
      gateway.server = server;
      gateway.wsHandler = new WebSocketHandler(gateway);
      gateway.wsHandler.initialize(server);
      gateway._ensureBackgroundPolling();
      // `close` is the canonical embed/test handle. `gateway.gracefulShutdown()`
      // remains available for callers already wired to it.
      resolve({ server, gateway, close: () => gateway.gracefulShutdown() });
    });
    server.on('error', reject);
  });
}

module.exports = { Gateway, startGateway, sanitizeLog, RateLimiter };

// ── v0.4.0 driver command handling ─────────────────────────────────────

const { DriverRouter: _DriverRouter } = require('./driver-router');

Gateway.prototype._getDriverRouter = function() {
  if (!this._driverRouter) {
    this._driverRouter = new _DriverRouter(this.driver);
  }
  return this._driverRouter;
};

Gateway.prototype._handleDriverAction = async function(req, res, driverName) {
  return driverDispatchHandlers.handleDriverAction(req, res, this, driverName);
};
