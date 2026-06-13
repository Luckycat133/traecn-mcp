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
const { getEnvWithFallback, parsePositiveInt } = require('../shared/utils');
const { ConfigManager } = require('../shared/config-manager');
const { getGlobalStore } = require('../shared/task-history');
const { buildCapabilities } = require('../shared/capabilities');
const { buildConfirmationPlan } = require('../shared/operation-confirmation');
const requestContext = require('../shared/request-context');
const { globalMetrics } = require('../shared/metrics');
const { listCommands } = require('../../integrations/openclaw-traecn-plugin/lib/command-set');
const { WebSocketHandler } = require('./websocket-handler');
const { findTraeCNBinary, isTraeCNRunning, restartTraeCNWithDebug, startTraeCN, getQuickstartConfig } = require('../config/quickstart');
const { DEFAULT_FALLBACK_MODELS } = require('../shared/models');

function normalizeUrl(rawUrl) {
  return rawUrl.replace(/[\x80-\xff]/g, ch => {
    const byteVal = Buffer.from(ch, 'latin1')[0];
    return '%' + byteVal.toString(16).toUpperCase().padStart(2, '0');
  });
}

const SENSITIVE_KEYS = ['token', 'password', 'secret', 'credential', 'authorization'];
const DEFAULT_JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};
const DEFAULT_HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"
};
// Safe X-Request-ID: ASCII letters/digits/_- up to 128 chars. Anything else is
// rejected and replaced with a server-generated id.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_MODEL_PROBE_INTERVAL_MS = 60000;

function sanitizeLog(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const sanitized = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.some(k => key.toLowerCase().includes(k))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeLog(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function secureCompare(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

class RateLimiter {
  constructor(windowMs, maxRequests) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.requests = new Map();
    this._lastCleanup = Date.now();
  }

  _cleanup() {
    const now = Date.now();
    if (now - this._lastCleanup < this.windowMs) return;
    this._lastCleanup = now;
    for (const [key, record] of this.requests) {
      if (now - record.startTime > this.windowMs) {
        this.requests.delete(key);
      }
    }
  }

  check(key) {
    this._cleanup();
    const now = Date.now();
    const record = this.requests.get(key);

    if (!record || now - record.startTime > this.windowMs) {
      this.requests.set(key, { startTime: now, count: 1 });
      return true;
    }

    record.count++;
    return record.count <= this.maxRequests;
  }

  getRemaining(key) {
    const record = this.requests.get(key);
    if (!record) return this.maxRequests;
    return Math.max(0, this.maxRequests - record.count);
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    const maxSize = 1024 * 1024;

    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new HttpError('Request body too large', 413, 'REQUEST_BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new HttpError('Invalid JSON body', 400, 'INVALID_JSON'));
      }
    });

    req.on('error', reject);
  });
}

class HttpError extends Error {
  constructor(message, statusCode = 500, code = 'HTTP_ERROR') {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function jsonResponse(res, data, statusCode = 200, headers = {}, req = null) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  const acceptEncoding = req ? (req.headers['accept-encoding'] || '') : '';
  const useGzip = body.length > 1024 && acceptEncoding.includes('gzip');
  const responseHeaders = { ...DEFAULT_JSON_HEADERS, ...headers };

  if (useGzip) {
    responseHeaders['Content-Encoding'] = 'gzip';
    res.writeHead(statusCode, responseHeaders);
    zlib.gzip(body, (err, compressed) => {
      if (err) {
        res.end(body);
      } else {
        res.end(compressed);
      }
    });
  } else {
    res.writeHead(statusCode, responseHeaders);
    res.end(body);
  }
}

function htmlResponse(res, html, statusCode = 200, headers = {}) {
  res.writeHead(statusCode, {
    ...DEFAULT_HTML_HEADERS,
    ...headers
  });
  res.end(html);
}

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
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  await response.text().catch(() => {});
}

class Gateway {
  constructor(options = {}) {
    const host = process.env.TRAECN_HOST ?? process.env.HOST ?? process.env.TRAE_HOST ?? '127.0.0.1';
    const port = process.env.TRAECN_PORT ?? process.env.PORT ?? process.env.TRAE_PORT ?? '8788';
    this.host = options.host || host;
    this.port = options.port !== undefined ? options.port : parsePositiveInt(port, 8788);
    this.token = getEnvWithFallback('TRAECN_GATEWAY_TOKEN', 'TRAE_GATEWAY_TOKEN', '');
    this.authHeader = getEnvWithFallback('TRAECN_AUTH_HEADER', 'TRAE_AUTH_HEADER', 'Authorization');
    this.allowedOrigins = getEnvWithFallback('TRAECN_ALLOWED_ORIGINS', 'TRAE_ALLOWED_ORIGINS', '');
    this.debugEndpoints = getEnvWithFallback('TRAECN_ENABLE_DEBUG_ENDPOINTS', 'TRAE_ENABLE_DEBUG_ENDPOINTS', '0') === '1';
    this.mockBridge = getEnvWithFallback('TRAECN_ENABLE_MOCK_BRIDGE', 'TRAE_ENABLE_MOCK_BRIDGE', '0') === '1';
    this.enforceOperationConfirmation = getEnvWithFallback('TRAECN_ENFORCE_OPERATION_CONFIRMATION', 'TRAE_ENFORCE_OPERATION_CONFIRMATION', '0') === '1';

    const rateWindowMs = parsePositiveInt(getEnvWithFallback('TRAECN_RATE_LIMIT_WINDOW_MS', 'TRAE_RATE_LIMIT_WINDOW_MS', '60000'), 60000);
    const rateMaxRequests = parsePositiveInt(getEnvWithFallback('TRAECN_RATE_LIMIT_MAX_REQUESTS', 'TRAE_RATE_LIMIT_MAX_REQUESTS', '60'), 60);
    this.rateLimiter = new RateLimiter(rateWindowMs, rateMaxRequests);

    this.configManager = options.configManager || new ConfigManager({
      configFile: process.env.TRAECN_CONFIG_FILE,
      watchEnabled: process.env.TRAECN_CONFIG_WATCH === '1'
    });

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
    this.taskLocks = new Set();
    this.activeTimers = new Set();
    this.autoStartTrae = getEnvWithFallback('TRAECN_AUTO_START_TRAE', 'TRAE_AUTO_START_TRAE', '1') !== '0';
    this.traeRecoveryCooldownMs = parsePositiveInt(
      getEnvWithFallback('TRAECN_TRAE_RECOVERY_COOLDOWN_MS', 'TRAE_TRAE_RECOVERY_COOLDOWN_MS', '30000'),
      30000
    );
    this.traeRecoveryWaitMs = parsePositiveInt(
      getEnvWithFallback('TRAECN_TRAE_RECOVERY_WAIT_MS', 'TRAE_TRAE_RECOVERY_WAIT_MS', '60000'),
      60000
    );
    this.lastTraeRecoveryAt = 0;
    this.activeQueuePersistencePath = this._resolveActiveQueuePersistencePath();
    this._restoreActiveQueue();

    this.configManager.on('configChanged', (data) => {
      this._applyConfigChanges(data.changes);
    });
  }

  _applyConfigChanges(changes) {
    if (changes.rateLimit) {
      const newWindowMs = this.configManager.getConfig().rateLimit.windowMs;
      const newMaxRequests = this.configManager.getConfig().rateLimit.maxRequests;
      this.rateLimiter = new RateLimiter(newWindowMs, newMaxRequests);
    }
    if (changes.cors) {
      this.allowedOrigins = this.configManager.getConfig().cors.allowedOrigins;
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

  _setInterval(callback, interval) {
    const timer = setInterval(callback, interval);
    this.activeTimers.add(timer);
    return timer;
  }

  _resolveActiveQueuePersistencePath() {
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
        followupCount: Array.isArray(task.followupTasks) ? task.followupTasks.length : 0,
        notifyUrl: task.notifyUrl || null,
        queueState: task.queueState || null,
        currentModel: task.currentModel || null,
        fallbackModels: Array.isArray(task.fallbackModels) ? task.fallbackModels : [],
        lastModelProbeAt: task.lastModelProbeAt || null,
        submittedToTrae: task.submittedToTrae === true,
        submittedAt: task.submittedAt || null
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

  _clearInterval(timer) {
    clearInterval(timer);
    this.activeTimers.delete(timer);
  }

  async _attemptTraeRecovery(reason) {
    if (this.mockBridge || !this.autoStartTrae) return false;

    const now = Date.now();
    if (now - this.lastTraeRecoveryAt < this.traeRecoveryCooldownMs) {
      return false;
    }
    this.lastTraeRecoveryAt = now;

    const binPath = findTraeCNBinary();
    if (!binPath) {
      console.warn('[Gateway] Trae recovery skipped: binary not found');
      return false;
    }

    const quickstart = getQuickstartConfig();
    const requestedPort = getEnvWithFallback(
      'TRAECN_REMOTE_DEBUGGING_PORT',
      'TRAE_REMOTE_DEBUGGING_PORT',
      quickstart.remoteDebuggingPort || '9334'
    );
    process.env.TRAECN_REMOTE_DEBUGGING_PORT = requestedPort;

    try {
      const running = isTraeCNRunning();
      const recoveryNewInstance = getEnvWithFallback(
        'TRAECN_TRAE_RECOVERY_NEW_INSTANCE',
        'TRAE_TRAE_RECOVERY_NEW_INSTANCE',
        '0'
      ) === '1';
      if (running && !recoveryNewInstance) {
        console.warn('[Gateway] Trae recovery skipped: normal Trae is already running without a reachable CDP endpoint; restart Trae CN with remote debugging enabled and existing profile.');
        return false;
      }
      const launched = startTraeCN({
        binPath,
        newInstance: recoveryNewInstance,
        useIsolatedProfile: quickstart.profileMode === 'existing' ? false : quickstart.useIsolatedProfile
      });
      console.log('[Gateway] Trae recovery launched:', {
        reason: reason?.message || String(reason || 'unknown'),
        requestedPort,
        profileMode: quickstart.profileMode,
        recoveryNewInstance,
        alreadyRunning: running,
        pid: launched.pid
      });
    } catch (err) {
      console.error('[Gateway] Trae recovery failed:', err.message);
      return false;
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < this.traeRecoveryWaitMs) {
      try {
        await discoverTarget();
        return true;
      } catch (err) {
        await new Promise(resolve => { this._setTimeout(resolve, 1500); });
      }
    }
    console.warn('[Gateway] Trae recovery timed out waiting for CDP surface');
    return false;
  }

  _normalizeFollowupTasks(items) {
    if (!Array.isArray(items)) return [];
    return items
      .map(item => {
        if (typeof item === 'string') {
          return { task: item, reviewRequired: true };
        }
        if (!item || typeof item !== 'object' || typeof item.task !== 'string') return null;
        return {
          task: item.task,
          reviewRequired: item.reviewRequired !== false,
          includeProcessText: item.includeProcessText === true
        };
      })
      .filter(item => item && item.task && item.task.length <= 100000);
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
    const followupTasks = this._normalizeFollowupTasks(body.followupTasks);
    const fallbackModels = this._normalizeFallbackModels(body.fallbackModels, body.autoModelFallback === true);
    const modelProbeIntervalMs = this._modelProbeIntervalMs(body.modelProbeIntervalMs);
    const historyTaskId = this.taskHistoryStore.createTask(null, body.task, {
      metadata: {
        source: 'delegate_async',
        reviewRequired,
        followupCount: followupTasks.length,
        notifyUrl: body.notifyUrl || null,
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
      chatId: body.chatId || null,
      task: body.task,
      status: 'queued',
      createdAt: now,
      deadline: queueMaxWaitMs ? now + Math.min(perTaskTimeoutMs, queueMaxWaitMs) : null,
      maxDeadline: queueMaxWaitMs ? now + queueMaxWaitMs : null,
      timeoutExtensions: 0,
      attempts: 0,
      includeProcessText: body.includeProcessText === true,
      reviewRequired,
      followupTasks,
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
        followupCount: followupTasks.length
      }
    });
    this.taskQueue.set(historyTaskId, task);
    this._syncTaskHistoryMirror(task);
    this._persistActiveQueue();
    return task;
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
    task.queueState = queueStatus.running ? 'running' : (queueStatus.queued ? 'queued' : task.queueState);
    task.queuePosition = queueStatus.queuePosition || queueStatus.position || null;
    task.currentModel = queueStatus.currentModel || task.currentModel || null;
    task.queueEstimatedWait = queueStatus.queueEstimatedWait || null;
    task.queueMessage = queueStatus.queueMessage || queueStatus.message || task.queueMessage || null;
    task.queueCanSubmit = queueStatus.canSubmit === true;
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
        stable: false,
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

  _isSuccessfulResult(result) {
    if (!result || result.needsApproval) return false;
    if (result.timedOut || result.truncated || result.streaming || result.modelError) return false;
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    if (!this._hasMeaningfulResultText(text) || this._isFailedResultText(text) || this._isIncompleteReviewText(text)) return false;
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

  _isIncompleteReviewText(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return true;
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

    const nextSpec = task.followupTasks.shift();
    const nextTask = this._createQueuedTask({
      task: nextSpec.task,
      includeProcessText: nextSpec.includeProcessText === true,
      reviewRequired: nextSpec.reviewRequired !== false,
      followupTasks: task.followupTasks,
      notifyUrl: task.notifyUrl,
      chatId: task.chatId,
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
    if (!this.allowedOrigins) {
      return { 'Access-Control-Allow-Origin': '*' };
    }
    const allowed = this.allowedOrigins.split(',').map(o => o.trim()).filter(Boolean);
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
    if (!this.allowedOrigins) return true;
    const origin = req.headers.origin;
    if (!origin) return true;

    const allowed = this.allowedOrigins.split(',').map(o => o.trim()).filter(Boolean);
    return allowed.includes(origin) || allowed.includes('*');
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
    };

    const connectFresh = async () => {
      try {
        const discovered = await discoverTarget();
        this.client = await connectToTarget(discovered, discovered.client);
        this.driver = new DomDriver(this.client);
        return discovered;
      } catch (err) {
        await closeCurrentConnection();
        const recovered = await this._attemptTraeRecovery(err);
        if (!recovered) throw err;
        const discovered = await discoverTarget();
        this.client = await connectToTarget(discovered, discovered.client);
        this.driver = new DomDriver(this.client);
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
          `[Gateway] ${req.method} ${req.url} -> ${statusCode} [requestId=${requestId}] [duration=${duration}ms]\n`
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

    if (pathname === '/api/status' && method === 'GET') {
      if (!this._checkRateLimit(req)) {
        this._finishRequestLog(req, res, 429);
        return this._json(req, res, { error: 'Rate limit exceeded' }, 429);
      }
      return this._handleStatus(req, res);
    }
    if (pathname === '/api/capabilities' && method === 'GET') {
      if (!this._checkRateLimit(req)) {
        this._finishRequestLog(req, res, 429);
        return this._json(req, res, { error: 'Rate limit exceeded' }, 429);
      }
      return this._json(req, res, buildCapabilities({ commands: listCommands() }));
    }

    if (pathname === '/api/config' && method === 'GET') {
      return this._handleGetConfig(req, res);
    }
    if (pathname === '/api/config/schema' && method === 'GET') {
      return this._handleGetConfigSchema(req, res);
    }
    if (pathname === '/api/config/update' && method === 'POST') {
      return await this._handleUpdateConfig(req, res);
    }
    if (pathname === '/api/config/reset' && method === 'POST') {
      return await this._handleResetConfig(req, res);
    }
    if (pathname === '/api/config/diff' && method === 'GET') {
      return this._handleConfigDiff(req, res);
    }
    if (pathname === '/' && method === 'GET') {
      if (!this._checkRateLimit(req)) {
        this._finishRequestLog(req, res, 429);
        return this._json(req, res, { error: 'Rate limit exceeded' }, 429);
      }
      return this._html(req, res, renderChatUI());
    }
    if (pathname === '/openapi.json' && method === 'GET') {
      if (!this._checkRateLimit(req)) {
        this._finishRequestLog(req, res, 429);
        return this._json(req, res, { error: 'Rate limit exceeded' }, 429);
      }
      return this._json(req, res, generateOpenAPISpec());
    }

    // /metrics is intentionally unauthenticated so Prometheus can scrape it.
    // The endpoint rate-limits per IP to deter abuse.
    if (pathname === '/metrics' && method === 'GET') {
      if (!this._checkRateLimit(req)) {
        this._finishRequestLog(req, res, 429);
        return this._json(req, res, { error: 'Rate limit exceeded' }, 429);
      }
      return this._handleMetrics(req, res);
    }
    if (pathname === '/metrics.json' && method === 'GET') {
      if (!this._checkRateLimit(req)) {
        this._finishRequestLog(req, res, 429);
        return this._json(req, res, { error: 'Rate limit exceeded' }, 429);
      }
      return this._handleMetricsJson(req, res);
    }

    if (!this._authenticate(req)) {
      this._finishRequestLog(req, res, 401);
      return this._json(req, res, { error: 'Unauthorized' }, 401);
    }

    if (!this._checkRateLimit(req)) {
      this._finishRequestLog(req, res, 429);
      return this._json(req, res, { error: 'Rate limit exceeded' }, 429);
    }

    const idempotencyResponse = this._checkIdempotency(req);
    if (idempotencyResponse) {
      this._finishRequestLog(req, res, idempotencyResponse.statusCode);
      return this._json(req, res, idempotencyResponse.data, idempotencyResponse.statusCode);
    }

    try {
      if (pathname === '/api/tasks/history' && method === 'GET') {
        return this._handleTasksHistory(req, res);
      }
      if (pathname === '/api/confirm/plan' && method === 'POST') {
        return await this._handleConfirmPlan(req, res);
      }
      if (pathname === '/api/preflight' && method === 'POST') {
        return await this._handlePreflight(req, res);
      }
      if (pathname === '/api/tasks/history' && method === 'DELETE') {
        return this._handleTasksHistoryClear(req, res);
      }
      if (pathname.match(/^\/api\/tasks\/[^/]+\/replay$/) && method === 'GET') {
        const taskId = pathname.split('/')[3];
        return this._handleTaskReplay(req, res, taskId);
      }
      if (pathname.match(/^\/api\/tasks\/[^/]+$/) && method === 'GET') {
        const taskId = pathname.split('/')[3];
        return this._handleGetTask(req, res, taskId);
      }
      if (pathname === '/api/sessions' && method === 'POST') {
        return await this._handleCreateSession(req, res);
      }
      if (pathname === '/api/sessions' && method === 'GET') {
        return this._handleListSessions(req, res);
      }
      if (pathname.match(/^\/api\/sessions\/[^/]+$/) && method === 'GET') {
        const sessionId = pathname.split('/').pop();
        return this._handleGetSession(req, res, sessionId);
      }
      if (pathname.match(/^\/api\/sessions\/[^/]+\/delegate$/) && method === 'POST') {
        const sessionId = pathname.split('/')[3];
        return await this._handleDelegate(req, res, sessionId);
      }
      if (pathname === '/api/new-chat' && method === 'POST') {
        return await this._handleNewChat(req, res);
      }
      if (pathname === '/api/trae/stop-generation' && method === 'POST') {
        return await this._handleStopGeneration(req, res);
      }
      if (pathname === '/api/trae/restart-debug' && method === 'POST') {
        return await this._handleRestartTraeDebug(req, res);
      }
      if (pathname === '/api/trae/review-gate' && method === 'GET') {
        return await this._handleReviewGateStatus(req, res);
      }
      if (pathname === '/api/trae/review-gate' && method === 'POST') {
        return await this._handleReviewGateResolve(req, res);
      }
      if (pathname === '/api/detect-mode' && method === 'GET') {
        return await this._handleDetectMode(req, res);
      }
      if (pathname === '/api/switch-mode' && method === 'POST') {
        return await this._handleSwitchMode(req, res);
      }
      if (pathname === '/api/switch-model' && method === 'POST') {
        return await this._handleSwitchModel(req, res);
      }
      if (pathname === '/api/queue-status' && method === 'GET') {
        return await this._handleQueueStatus(req, res);
      }
      if (pathname === '/api/queue/status' && method === 'GET') {
        return this._handleQueueStatusList(req, res);
      }
      if (pathname === '/api/task/adopt-current' && method === 'POST') {
        return await this._handleAdoptCurrentTask(req, res);
      }
      if (pathname.match(/^\/api\/task\/[^/]+$/) && method === 'GET') {
        const taskId = pathname.split('/').pop();
        return await this._handleTaskStatus(req, res, taskId);
      }
      if (pathname.match(/^\/api\/task\/[^/]+\/review$/) && method === 'POST') {
        const segments = pathname.split('/');
        const taskId = segments[3];
        return await this._handleTaskReview(req, res, taskId);
      }
      if (pathname.match(/^\/api\/task\/[^/]+\/cancel$/) && method === 'POST') {
        const segments = pathname.split('/');
        const taskId = segments[3];
        return await this._handleTaskCancel(req, res, taskId);
      }
      if (pathname === '/api/tasks/batch' && method === 'POST') {
        return this._handleBatchSubmit(req, res);
      }
      if (pathname.match(/^\/api\/tasks\/batch\/[^/]+$/) && method === 'GET') {
        const batchId = pathname.split('/').pop();
        return this._handleBatchStatus(req, res, batchId);
      }
      if (pathname.match(/^\/api\/tasks\/batch\/[^/]+$/) && method === 'DELETE') {
        const batchId = pathname.split('/').pop();
        return this._handleBatchCancel(req, res, batchId);
      }
      if (pathname === '/api/delegate' && method === 'POST') {
        return await this._handleDelegateAsync(req, res);
      }
      if (pathname === '/api/delegate-async' && method === 'POST') {
        return await this._handleDelegateAsync(req, res);
      }
      if (pathname === '/api/open-project' && method === 'POST') {
        return await this._handleOpenProject(req, res);
      }
      if (pathname === '/api/update-self' && method === 'POST') {
        return await this._handleUpdateSelf(req, res);
      }
      if (pathname === '/api/readiness' && method === 'GET') {
        return await this._handleReadiness(req, res);
      }
      if (pathname === '/api/settings/read-all' && method === 'GET') {
        return await this._handleSettingsReadAll(req, res);
      }
      if (pathname === '/api/settings/read' && method === 'GET') {
        return await this._handleSettingsRead(req, res);
      }
      if (pathname === '/api/settings' && method === 'GET') {
        return await this._handleSettingsRead(req, res);
      }
      if (pathname === '/api/settings/set' && method === 'POST') {
        return await this._handleSettingsSet(req, res);
      }
      if (pathname === '/api/settings' && method === 'POST') {
        return await this._handleSettingsSet(req, res);
      }
      if (pathname === '/api/settings/switch-tab' && method === 'POST') {
        return await this._handleSettingsSwitchTab(req, res);
      }
      if (pathname === '/api/settings/back-to-chat' && method === 'POST') {
        return await this._handleSettingsBackToChat(req, res);
      }
      if (pathname === '/api/dialog/approve' && method === 'POST') {
        return await this._handleDialogApprove(req, res);
      }
      if (pathname === '/api/dialog/dismiss' && method === 'POST') {
        return await this._handleDialogDismiss(req, res);
      }
      if (pathname === '/api/dialog/status' && method === 'GET') {
        return await this._handleDialogStatus(req, res);
      }
      // v0.4.0 — driver-level commands
      const driverRoute = {
        editor: '/api/editor',
        file: '/api/file',
        terminal: '/api/terminal',
        git: '/api/git',
        search: '/api/search',
        diagnostics: '/api/diagnostics',
        snapshot: '/api/snapshot',
        extension: '/api/extension',
        command: '/api/command'
      };
      for (const [name, path_] of Object.entries(driverRoute)) {
        if (pathname === path_ && method === 'POST') {
          return await this._handleDriverAction(req, res, name);
        }
      }
      if (pathname === '/debug/automation' && method === 'GET' && this.debugEndpoints) {
        return await this._handleDebugAutomation(req, res);
      }

      this._finishRequestLog(req, res, 404);
      return this._json(req, res, { error: 'Not found' }, 404);
    } catch (err) {
      console.error('[Gateway] Error:', sanitizeLog({ message: err.message, code: err.code }));
      const statusCode = err instanceof HttpError ? err.statusCode : (err instanceof TraeCNAutomationError ? 502 : 500);
      this._finishRequestLog(req, res, statusCode);
      return this._json(req, res, { error: err.message, code: err.code || 'INTERNAL_ERROR' }, statusCode);
    }
  }

  _handleTasksHistory(req, res) {
    const parsedUrl = new URL(req._normalizedUrl || req.url, `http://${req.headers.host}`);
    const page = parsePositiveInt(parsedUrl.searchParams.get('page'), 1);
    const limit = Math.min(parsePositiveInt(parsedUrl.searchParams.get('limit'), 20), 100);
    const status = parsedUrl.searchParams.get('status') || null;
    const keyword = parsedUrl.searchParams.get('keyword') || null;
    const startDate = parsedUrl.searchParams.get('startDate') || null;
    const endDate = parsedUrl.searchParams.get('endDate') || null;
    const sessionId = parsedUrl.searchParams.get('sessionId') || null;

    const result = this.taskHistoryStore.getHistory({
      page, limit, status, keyword, startDate, endDate, sessionId
    });
    this._json(req, res, result);
  }

  _handleTasksHistoryClear(req, res) {
    const parsedUrl = new URL(req._normalizedUrl || req.url, `http://${req.headers.host}`);
    const olderThanHours = parsedUrl.searchParams.has('olderThanHours')
      ? parsePositiveInt(parsedUrl.searchParams.get('olderThanHours'), null)
      : null;
    const status = parsedUrl.searchParams.get('status') || null;
    const beforeDate = parsedUrl.searchParams.get('beforeDate') || null;

    const result = this.taskHistoryStore.clearHistory({ olderThanHours, status, beforeDate });
    this._json(req, res, { success: true, ...result });
  }

  _handleGetTask(req, res, taskId) {
    const task = this.taskHistoryStore.getTask(taskId);
    if (!task) {
      return this._json(req, res, { error: 'Task not found' }, 404);
    }
    this._json(req, res, task);
  }

  _handleTaskReplay(req, res, taskId) {
    const replay = this.taskHistoryStore.getReplay(taskId);
    if (!replay) {
      return this._json(req, res, { error: 'Task not found' }, 404);
    }
    this._json(req, res, replay);
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
      } catch {}
    } catch {}

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
    const queue = queueProbe.ok ? this._compactQueue(queueProbe.value) : null;
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
    this._json(req, res, await this._statusSnapshot());
  }

  /**
   * Prometheus exposition format metrics endpoint.
   * The body uses the standard text/plain; version=0.0.4 content type so
   * any Prometheus / VictoriaMetrics / Mimir scraper picks it up without
   * extra configuration. Counters, gauges, and histograms are exposed with
   * the `traecn_*` prefix defined in MetricsCollector.
   */
  _handleMetrics(req, res) {
    // Refresh volatile gauges so scrapers see fresh values.
    try { this._refreshMetricsGauges(); } catch { /* never fail the scrape */ }
    const body = globalMetrics.toPrometheus();
    res.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  }

  /**
   * JSON variant for ad-hoc debugging (curl, dashboards, smoke tests).
   * Mirrors `/metrics` semantics but is not meant for production scraping.
   */
  _handleMetricsJson(req, res) {
    try { this._refreshMetricsGauges(); } catch { /* never fail the scrape */ }
    this._json(req, res, globalMetrics.getMetrics());
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
      config,
      auditLog: auditLog.slice(-10)
    });
  }

  _handleGetConfigSchema(req, res) {
    const schema = this.configManager.getSchema();
    const diff = (prev, curr) => {
      const result = {};
      for (const key of Object.keys(schema)) {
        if (JSON.stringify(prev[key]) !== JSON.stringify(curr[key])) {
          result[key] = { previous: prev[key], current: curr[key] };
        }
      }
      return result;
    };
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
      this._json(req, res, result);
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
    this._json(req, res, result);
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
      diff,
      history: history.slice(-20)
    });
  }

  async _handleCreateSession(req, res) {
    const body = await parseBody(req);
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    await this._ensureConnection();

    const session = {
      id: sessionId,
      createdAt: new Date().toISOString(),
      projectPath: body.projectPath || null,
      messages: []
    };

    this.sessions.set(sessionId, session);

    const responseData = { sessionId, createdAt: session.createdAt };
    this._storeIdempotency(req.headers['idempotency-key'], { data: responseData, statusCode: 201 });
    this._json(req, res, responseData, 201);
  }

  _handleListSessions(req, res) {
    const sessions = Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      createdAt: s.createdAt,
      messageCount: s.messages.length
    }));
    this._json(req, res, { sessions });
  }

  _handleGetSession(req, res, sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return this._json(req, res, { error: 'Session not found' }, 404);
    }
    this._json(req, res, session);
  }

  async _handleDelegate(req, res, sessionId) {
    const body = await parseBody(req);
    if (!body.task) {
      return this._json(req, res, { error: 'task is required' }, 400);
    }
    if (typeof body.task !== 'string' || body.task.length > 100000) {
      return this._json(req, res, { error: 'task must be a string with max 100000 characters' }, 400);
    }

    await this._ensureConnection();

    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages.push({ role: 'user', content: body.task, timestamp: new Date().toISOString() });
    }

    const result = await this.driver.delegate(body.task);

    if (session) {
      session.messages.push({ role: 'assistant', content: result.text, timestamp: new Date().toISOString() });
    }

    const responseData = {
      text: result.text,
      stable: result.stable,
      elapsedMs: result.elapsedMs,
      timedOut: result.timedOut || false
    };

    if (body.includeProcessText) {
      responseData.processText = result.text;
    }

    this._storeIdempotency(req.headers['idempotency-key'], { data: responseData, statusCode: 200 });
    this._json(req, res, responseData);
  }

  async _handleNewChat(req, res) {
    await this._ensureConnection();
    const success = await this.driver.newChat();
    this._json(req, res, { success });
  }

  async _handleStopGeneration(req, res) {
    await this._ensureConnection();
    const result = typeof this.driver.stopGeneration === 'function'
      ? await this.driver.stopGeneration()
      : { success: false, reason: 'driver_does_not_support_stop_generation' };
    this._json(req, res, result, result.success === false ? 409 : 200);
  }

  async _handleRestartTraeDebug(req, res) {
    const body = await parseBody(req);
    const expectedPhrase = 'restart-trae-cn-with-debug-existing-profile';
    const plan = buildConfirmationPlan({
      command: 'restart_trae_debug',
      params: {
        projectPath: body.projectPath || null,
        profileMode: 'existing'
      },
      forceConfirm: true
    });
    const confirmed = body.confirmationPhrase === expectedPhrase || body.confirmationId === plan.confirmationId;
    if (!confirmed) {
      return this._json(req, res, {
        error: 'Explicit confirmation required before restarting Trae CN',
        confirmationPhrase: expectedPhrase,
        confirmationId: plan.confirmationId,
        plan
      }, 409);
    }

    if (this.client) {
      try {
        await this.client.close();
      } catch (_) {}
      this.client = null;
      this.driver = null;
    }

    const quickstart = getQuickstartConfig();
    const requestedPort = getEnvWithFallback(
      'TRAECN_REMOTE_DEBUGGING_PORT',
      'TRAE_REMOTE_DEBUGGING_PORT',
      quickstart.remoteDebuggingPort || '9334'
    );
    process.env.TRAECN_REMOTE_DEBUGGING_PORT = requestedPort;

    let restart;
    try {
      restart = await restartTraeCNWithDebug({
        projectPath: body.projectPath,
        quitTimeoutMs: body.quitTimeoutMs,
        pollMs: body.pollMs
      });
    } catch (err) {
      return this._json(req, res, {
        ok: false,
        error: err.message,
        profileMode: 'existing',
        requestedPort
      }, 500);
    }

    const cdpWaitMs = Number.isFinite(Number(body.cdpWaitMs)) ? Number(body.cdpWaitMs) : 60000;
    const startedAt = Date.now();
    let connected = false;
    let surface = null;
    let lastError = null;
    while (Date.now() - startedAt < cdpWaitMs) {
      try {
        surface = await discoverTarget();
        connected = true;
        break;
      } catch (err) {
        lastError = err.message;
        await new Promise(resolve => { this._setTimeout(resolve, 1000); });
      }
    }

    this._json(req, res, {
      ok: connected,
      action: 'restart_trae_debug',
      profileMode: 'existing',
      requestedPort,
      restart,
      cdpWaitMs,
      connected,
      surface: surface ? describeCDPSurface([surface.target || surface]) : null,
      error: connected ? null : (lastError || 'Timed out waiting for CDP')
    }, connected ? 200 : 504);
  }

  async _handleReviewGateStatus(req, res) {
    await this._ensureConnection();
    const result = typeof this.driver.checkTaskReviewGate === 'function'
      ? await this.driver.checkTaskReviewGate()
      : { awaitingReview: false, reason: 'driver_does_not_support_review_gate' };
    this._json(req, res, result);
  }

  async _handleReviewGateResolve(req, res) {
    const body = await parseBody(req);
    const action = body.action || 'keep_all';
    if (!['keep_all', 'revert_all', 'keep', 'discard'].includes(action)) {
      return this._json(req, res, { error: 'action must be keep_all or revert_all' }, 400);
    }
    await this._ensureConnection();
    const normalizedAction = action === 'keep' ? 'keep_all' : (action === 'discard' ? 'revert_all' : action);
    const result = typeof this.driver.resolveTaskReviewGate === 'function'
      ? await this.driver.resolveTaskReviewGate(normalizedAction)
      : { success: false, reason: 'driver_does_not_support_review_gate' };
    this._json(req, res, result, result.success === false ? 409 : 200);
  }

  async _handleDetectMode(req, res) {
    await this._ensureConnection();
    const modeInfo = await this.driver.detectMode();
    this._json(req, res, {
      mode: modeInfo.mode,
      confidence: modeInfo.confidence,
      indicators: modeInfo.indicators
    });
  }

  async _handleSwitchMode(req, res) {
    const body = await parseBody(req);
    if (!body.mode) {
      return this._json(req, res, { error: 'mode is required' }, 400);
    }
    if (!['solo', 'ide'].includes(body.mode.toLowerCase())) {
      return this._json(req, res, { error: 'mode must be "solo" or "ide"' }, 400);
    }

    await this._ensureConnection();
    const result = await this.driver.switchMode(body.mode);
    this._json(req, res, {
      success: result.success,
      mode: body.mode,
      previousMode: result.previousMode || null,
      alreadyInMode: result.alreadyInMode || false
    });
  }

  async _handleSwitchModel(req, res) {
    const body = await parseBody(req);
    if (!body.model) {
      return this._json(req, res, { error: 'model is required' }, 400);
    }

    await this._ensureConnection();
    const switchResult = await this.driver.switchModel(body.model);
    const normalizedSwitch = this._normalizeModelSwitchResult(switchResult);

    if (!normalizedSwitch.success) {
      return this._json(req, res, {
        success: false,
        model: normalizedSwitch.model || null,
        requestedModel: body.model,
        switchResult: normalizedSwitch.switchResult || switchResult,
        error: normalizedSwitch.error || 'Model switch failed'
      }, 502);
    }

    if (body.waitForQueue === false) {
      const status = await this.driver.checkQueueStatus();
      return this._json(req, res, {
        success: true,
        model: normalizedSwitch.model || body.model,
        requestedModel: body.model,
        switchResult: normalizedSwitch.switchResult || switchResult,
        previousModel: normalizedSwitch.previousModel || null,
        alreadySelected: normalizedSwitch.alreadySelected || false,
        queued: status.queued === true,
        running: status.running === true,
        canSubmit: status.canSubmit === true,
        queueDetails: this._queueDetailsFromStatus(status, normalizedSwitch.model || body.model)
      });
    }

    // Wait for model to become available (up to 10 minutes)
    const queueWaitTimeoutMs = this.driver.config.queueWaitTimeoutMs || 600000;
    const queuePollIntervalMs = this.driver.config.queuePollIntervalMs || 15000;
    const maxRetries = Math.ceil(queueWaitTimeoutMs / queuePollIntervalMs);

    let waitedMs = 0;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const status = await this.driver.checkQueueStatus();
      if (!status.queued) {
        // Model is ready
        return this._json(req, res, {
          success: true,
          model: normalizedSwitch.model || body.model,
          requestedModel: body.model,
          switchResult: normalizedSwitch.switchResult || switchResult,
          previousModel: normalizedSwitch.previousModel || null,
          alreadySelected: normalizedSwitch.alreadySelected || false,
          queueWaitMs: waitedMs,
          queueWaitAttempts: attempt
        });
      }

      // Still queued — wait and retry
      await new Promise(r => { this._setTimeout(r, queuePollIntervalMs); });
      waitedMs += queuePollIntervalMs;
    }

    // Timed out waiting for model to become available
    return this._json(req, res, {
      success: false,
      model: normalizedSwitch.model || body.model,
      requestedModel: body.model,
      switchResult: normalizedSwitch.switchResult || switchResult,
      error: 'Model queue wait timeout',
      queueWaitMs: waitedMs,
      queueWaitAttempts: maxRetries
    }, 504);
  }

  async _handleQueueStatus(req, res) {
    await this._ensureConnection();
    const status = await this.driver.checkQueueStatus();
    this._json(req, res, status);
  }

  async _handleOpenProject(req, res) {
    const body = await parseBody(req);
    if (!body.projectPath) {
      return this._json(req, res, { error: 'projectPath is required' }, 400);
    }

    const projectPath = body.projectPath;
    const newInstance = body.newInstance === true;
    let result;

    try {
      // Use the existing quickstart machinery so we honor TRAECN_BIN / platform-specific
      // binary resolution (.app bundles on macOS, .exe on Windows) instead of relying on
      // a `trae-cn` shim that does not exist on this machine.
      const {
        findTraeCNBinary,
        isTraeCNRunning,
        startTraeCN
      } = require('../config/quickstart');

      const cdpHost = process.env.TRAECN_CDP_HOST || process.env.TRAE_CDP_HOST || '127.0.0.1';
      const cdpPort = process.env.TRAECN_REMOTE_DEBUGGING_PORT || process.env.TRAE_REMOTE_DEBUGGING_PORT || '9222';

      const alreadyRunning = isTraeCNRunning();

      if (alreadyRunning && !newInstance) {
        // TraeCN is already running. Restarting it would lose the user's session,
        // unsaved buffers, and AI chat context. We refuse to spawn a duplicate and
        // report the current surface so the caller can decide what to do (e.g.
        // ask the user to switch projects manually, or call --newInstance=true
        // to opt into spawning a separate window).
        let currentSurface = null;
        try {
          const { fetchCDPTargets } = require('../cdp/discovery');
          const targets = await fetchCDPTargets(cdpHost, cdpPort);
          const page = targets.find(t => t.type === 'page');
          if (page) {
            currentSurface = {
              targetId: page.id,
              title: page.title,
              url: page.url
            };
          }
        } catch (e) {
          // CDP probe failed — TraeCN may be running but unreachable. Fall through
          // to the not-running path so the caller can still try to start a fresh
          // instance.
        }

        result = {
          success: false,
          alreadyRunning: true,
          projectPath,
          currentSurface,
          cdp: { host: cdpHost, port: cdpPort },
          hint: 'TraeCN is already running. Pass newInstance=true to spawn a separate window, or stop TraeCN first.',
          error: currentSurface
            ? `TraeCN is already running on workspace "${currentSurface.title || '(untitled)'}".`
            : 'TraeCN is already running but CDP did not return any page target.'
        };
        this._json(req, res, result, 409);
        return;
      }

      // TraeCN is not running (or caller asked for a separate window). Start it
      // with the project via the canonical quickstart helper so we get the right
      // binary path, --remote-debugging-port, and platform-correct spawn args.
      const binPath = findTraeCNBinary();
      if (!binPath) {
        result = {
          success: false,
          projectPath,
          error: 'TraeCN binary not found. Set TRAECN_BIN environment variable.'
        };
        this._json(req, res, result, 404);
        return;
      }

      const startResult = startTraeCN({ binPath, projectPath, newInstance });
      result = {
        success: true,
        projectPath,
        binPath,
        pid: startResult.pid,
        command: startResult.command,
        args: startResult.args,
        cdp: { host: cdpHost, port: cdpPort },
        started: true
      };

      // Poll for CDP target readiness (replaces hardcoded sleep)
      const { fetchCDPTargets } = require('../cdp/discovery');
      const maxWaitMs = 15000;
      const pollIntervalMs = 1000;
      const startTime = Date.now();

      let pageTarget = null;
      while (Date.now() - startTime < maxWaitMs) {
        try {
          const targets = await fetchCDPTargets(cdpHost, cdpPort);
          pageTarget = targets.find(t => t.type === 'page');
          if (pageTarget && pageTarget.webSocketDebuggerUrl) break;
        } catch (e) {
          // CDP not ready yet — retry
        }
        await new Promise(r => this._setTimeout(r, pollIntervalMs));
      }

      // Try to check for restricted mode dialog via CDP
      try {
        const { CDPClient } = require('../cdp/client');

        if (pageTarget && pageTarget.webSocketDebuggerUrl) {
          const cdpClient = new CDPClient(pageTarget.webSocketDebuggerUrl);
          await cdpClient.connect();
          await cdpClient.send('DOM.enable');
          await cdpClient.send('Runtime.enable');
          const { DomDriver } = require('../cdp/dom-driver');
          const tempDriver = new DomDriver(cdpClient);
          const restrictedCheck = await tempDriver.checkRestrictedMode();
          await cdpClient.close();

          if (restrictedCheck && restrictedCheck.restricted) {
            result.restrictedMode = true;
            result.restrictedInfo = restrictedCheck;
            result.message = '受限模式已启用，请在Trae CN窗口手动点击「信任」以继续';
          }
        }
      } catch (cdpErr) {
        // CDP not available yet (gateway just started, browser not ready) — non-fatal
        result._cdpCheckNote = 'CDP check skipped: ' + cdpErr.message;
      }
    } catch (err) {
      result = { success: false, projectPath, error: err.message };
    }

    this._json(req, res, result);
  }

  async _handleUpdateSelf(req, res) {
    const body = await parseBody(req);
    this._json(req, res, {
      success: false,
      version: packageInfo.version,
      force: body.force === true,
      message: 'Automatic self-update is not enabled. Pull the latest repository revision and run npm install.',
      currentVersion: packageInfo.version
    }, 200);
  }

  async _handleReadiness(req, res) {
    await this._ensureConnection();
    const readiness = await this.driver.checkReadiness();
    this._json(req, res, readiness);
  }

  async _handleSettingsReadAll(req, res) {
    await this._ensureConnection();
    const data = await this.driver.settings.readAll();
    this._json(req, res, { sections: SETTINGS_SECTIONS, data });
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
    const body = await parseBody(req);
    if (!body.task) {
      return this._json(req, res, { error: 'task is required' }, 400);
    }
    if (typeof body.task !== 'string' || body.task.length > 100000) {
      return this._json(req, res, { error: 'task must be a string with max 100000 characters' }, 400);
    }

    const chatId = body.chatId || null;
    const includeProcessText = body.includeProcessText === true;
    const waitForQueue = body.waitForQueue !== false;
    const fallbackModels = this._normalizeFallbackModels(body.fallbackModels, body.autoModelFallback === true);
    const modelProbeIntervalMs = this._modelProbeIntervalMs(body.modelProbeIntervalMs);
    await this._ensureConnection();

    // Get queue status with enhanced detection
    let queueStatus = await this.driver.checkQueueStatus();
    let modelProbe = null;
    let queueVisible = queueStatus.queued === true;
    let queueBlocked = queueStatus.running || (queueVisible && queueStatus.canSubmit !== true);
    let shouldBackgroundWait = queueStatus.running || (waitForQueue && queueVisible);

    if ((shouldBackgroundWait || queueBlocked) && fallbackModels.length > 0) {
      const probeTask = {
        taskId: 'probe_' + Date.now(),
        fallbackModels,
        modelProbeIntervalMs,
        nextModelProbeAt: Date.now(),
        modelProbeResults: [],
        currentModel: queueStatus.currentModel || null,
        queueState: queueStatus.running ? 'running' : (queueStatus.queued ? 'queued' : null)
      };
      modelProbe = await this._probeFallbackModels(probeTask, { recordHistory: false });
      if (modelProbe.queueStatus) {
        queueStatus = modelProbe.queueStatus;
        queueVisible = queueStatus.queued === true;
        queueBlocked = queueStatus.running || (queueVisible && queueStatus.canSubmit !== true);
        shouldBackgroundWait = queueStatus.running || (waitForQueue && queueVisible && queueStatus.canSubmit !== true);
      }
      body.fallbackModels = fallbackModels;
      body.modelProbeIntervalMs = modelProbeIntervalMs;
      body.initialModelProbeResults = modelProbe.results || [];
      body.initialLastModelProbeAt = probeTask.lastModelProbeAt || null;
      body.initialNextModelProbeAt = probeTask.nextModelProbeAt || null;
    }

    // Build queue ETA message
    let queueEtaMessage = '';
    if (queueStatus.queueEstimatedWait) {
      queueEtaMessage = `，预计等待 ${queueStatus.queueEstimatedWait}`;
    } else if (queueStatus.queuePosition) {
      queueEtaMessage = `，当前第 ${queueStatus.queuePosition} 位`;
    }

    if (shouldBackgroundWait || queueBlocked) {
      if (!waitForQueue) {
        if (queueVisible && queueStatus.canSubmit === true && !queueStatus.running) {
          // Caller explicitly opted out of local waiting. Let Trae own the queue.
        } else {
        // Caller doesn't want to wait — return queue info immediately
          return this._json(req, res, {
            status: queueStatus.queued ? 'queued' : 'running',
            queueDetails: {
              state: queueStatus.queued ? 'queued' : 'running',
              currentModel: queueStatus.currentModel || '',
              queuePosition: queueStatus.queuePosition,
              queueEstimatedWait: queueStatus.queueEstimatedWait,
              queueMessage: queueStatus.queueMessage || (queueStatus.running ? '模型正在执行其他任务' : '模型排队中')
            },
            message: `${queueStatus.running ? 'Trae 正在执行其他任务' : '模型排队中'}${queueEtaMessage}，请稍后重试或设置 waitForQueue=true 自动等待`,
            model: queueStatus.currentModel
          }, 202);
        }
      }

      if (shouldBackgroundWait) {
        body.chatId = chatId;
        body.includeProcessText = includeProcessText;
        const task = this._createQueuedTask(body, queueStatus);
        if (Array.isArray(body.initialModelProbeResults)) {
          task.modelProbeResults = body.initialModelProbeResults;
          task.lastModelProbeAt = body.initialLastModelProbeAt;
          task.nextModelProbeAt = body.initialNextModelProbeAt;
        }
        this._ensureBackgroundPolling();

        return this._json(req, res, {
          taskId: task.taskId,
          status: 'queued',
          queueDetails: {
            state: queueStatus.queued ? 'queued' : 'running',
            currentModel: queueStatus.currentModel || '',
            queuePosition: queueStatus.queuePosition,
            queueEstimatedWait: queueStatus.queueEstimatedWait,
            queueMessage: queueStatus.queueMessage || (queueStatus.running ? '模型正在执行其他任务' : '模型排队中')
          },
          reviewRequired: task.reviewRequired,
          followupCount: task.followupTasks.length,
          modelProbeResults: task.modelProbeResults || [],
          nextModelProbeAt: task.nextModelProbeAt || null,
          message: `${queueStatus.running ? 'Trae 正在执行其他任务' : '模型排队中'}${queueEtaMessage}，任务已加入后台。用 traecn_task_status 查询进度`,
          model: queueStatus.currentModel
        }, 202);
      }
    }

    if (body.background === true || body.forceBackground === true) {
      body.chatId = chatId;
      body.includeProcessText = includeProcessText;
      const task = this._createQueuedTask(body, {
        ...queueStatus,
        queued: true,
        queueMessage: queueStatus.queueMessage || 'background execution requested'
      });
      if (Array.isArray(body.initialModelProbeResults)) {
        task.modelProbeResults = body.initialModelProbeResults;
        task.lastModelProbeAt = body.initialLastModelProbeAt;
        task.nextModelProbeAt = body.initialNextModelProbeAt;
      }
      this._ensureBackgroundPolling();
      return this._json(req, res, {
        taskId: task.taskId,
        status: 'queued',
        queueDetails: {
          state: 'queued',
          currentModel: queueStatus.currentModel || '',
          queuePosition: queueStatus.queuePosition,
          queueEstimatedWait: queueStatus.queueEstimatedWait,
          queueMessage: task.queueMessage
        },
        reviewRequired: task.reviewRequired,
        followupCount: task.followupTasks.length,
        modelProbeResults: task.modelProbeResults || [],
        nextModelProbeAt: task.nextModelProbeAt || null,
        message: '任务已加入后台执行队列。用 traecn_task_status 查询进度',
        model: queueStatus.currentModel
      }, 202);
    }

    // Model is idle/ready — execute synchronously with timeout protection
    if (!this.driver) {
      return this._json(req, res, { error: 'CDP driver not available — connection may have failed' }, 503);
    }

    let result;
    let timeoutId;
    let delegatePromise;
    try {
      const syncTimeout = 180000;
      const timeoutPromise = new Promise((_, reject) =>
        { timeoutId = this._setTimeout(() => reject(new Error('delegate timeout (' + syncTimeout + 'ms)')), syncTimeout); }
      );
      delegatePromise = this.driver.delegate(body.task);
      result = await Promise.race([delegatePromise, timeoutPromise]);
    } catch (e) {
      if (/delegate timeout/i.test(e.message || '') && delegatePromise) {
        const normalizedFollowups = this._normalizeFollowupTasks(body.followupTasks);
        const task = this._createQueuedTask({
          task: body.task,
          reviewRequired: body.reviewRequired === true,
          followupTasks: normalizedFollowups,
          chatId,
          includeProcessText,
          notifyUrl: body.notifyUrl
        }, {
          queued: true,
          running: false,
          queueMessage: 'sync delegate timed out; tracking submitted Trae request in background'
        });
        task.status = 'executing';
        task.submittedToTrae = true;
        task.submittedAt = Date.now();
        task.error = null;
        this.taskLocks.add(task.taskId);
        this._syncTaskHistoryMirror(task);
        this._persistActiveQueue();

        delegatePromise
          .then(async (resolvedResult) => {
            const liveTask = this.taskQueue.get(task.taskId);
            if (!liveTask || this._isTerminalTaskStatus(liveTask.status)) return;
            await this._finalizeCollectedBackgroundResult(task.taskId, liveTask, resolvedResult);
          })
          .catch(async (err) => {
            const liveTask = this.taskQueue.get(task.taskId);
            if (!liveTask || this._isTerminalTaskStatus(liveTask.status)) return;
            if (await this._retryBackgroundTaskAfterError(task.taskId, liveTask, err)) {
              return;
            }
            await this._finalizeBackgroundTask(task.taskId, liveTask, 'error', {
              error: err.message
            });
          })
          .finally(() => {
            this.taskLocks.delete(task.taskId);
          });

        return this._json(req, res, {
          taskId: task.taskId,
          status: task.status,
          submittedToTrae: true,
          reviewRequired: task.reviewRequired,
          followupCount: task.followupTasks.length,
          message: 'Trae 请求已提交但同步等待超时，已自动转入后台追踪。用 traecn_task_status 查询进度'
        }, 202);
      }
      const recoveredResult = await this._recoverAwaitingReviewFromGate({
        createdAt: Date.now(),
        followupTasks: this._normalizeFollowupTasks(body.followupTasks),
        reviewRequired: body.reviewRequired === true
      });
      if (recoveredResult) {
        const normalizedFollowups = this._normalizeFollowupTasks(body.followupTasks);
        const task = this._createQueuedTask({
          task: body.task,
          reviewRequired: body.reviewRequired === true,
          followupTasks: normalizedFollowups,
          chatId,
          includeProcessText,
          notifyUrl: body.notifyUrl
        }, { queued: false, running: false, queueMessage: 'recovered from review gate' });
        await this._finalizeCollectedBackgroundResult(task.taskId, task, recoveredResult);
        return this._json(req, res, {
          taskId: task.taskId,
          status: task.status,
          reviewRequired: task.reviewRequired,
          followupCount: task.followupTasks.length,
          message: 'Trae 已生成结果，但当前停在内部审查闸口；任务已恢复为等待审查',
          resultPreview: (recoveredResult.text || '').slice(0, 500)
        }, 202);
      }
      return this._json(req, res, { error: 'delegate failed: ' + e.message }, 504);
    } finally {
      if (timeoutId) this._clearTimeout(timeoutId);
    }

    if (chatId) {
      await notifyOpenClaw(chatId, formatResult(result));
    }

    const responseData = {
      status: this._isSuccessfulResult(result) ? 'done' : 'error',
      text: result.text,
      stable: result.stable,
      elapsedMs: result.elapsedMs,
      timedOut: result.timedOut || false,
      needsApproval: result.needsApproval || false,
      question: result.question || '',
      error: this._isSuccessfulResult(result) ? undefined : (result.error || 'Trae returned an incomplete, timed-out, or failed result')
    };

    if (body.reviewRequired === true || this._normalizeFollowupTasks(body.followupTasks).length > 0) {
      const normalizedFollowups = this._normalizeFollowupTasks(body.followupTasks);
      const task = this._createQueuedTask({
        task: body.task,
        reviewRequired: body.reviewRequired === true,
        followupTasks: normalizedFollowups,
        chatId,
        includeProcessText,
        notifyUrl: body.notifyUrl
      }, { queued: false, running: false, queueMessage: 'immediate execution' });
      task.submittedToTrae = true;
      task.submittedAt = Date.now();
      task.queueState = 'running';
      await this._finalizeCollectedBackgroundResult(task.taskId, task, result);
      return this._json(req, res, {
        taskId: task.taskId,
        status: task.status,
        reviewRequired: task.reviewRequired,
        followupCount: task.followupTasks.length,
        message: task.status === 'approval_required'
          ? 'Trae 结果需要先处理确认弹窗'
          : (task.status === 'awaiting_review'
              ? 'Trae 已完成，等待人工审查'
              : (task.status === 'executing'
                  ? 'Trae 已返回过程文本，任务已转入后台继续收集。用 traecn_task_status 查询进度'
                  : 'Trae 返回了不完整或超时结果，未进入审查')),
        resultPreview: (result.text || '').slice(0, 500)
      }, task.status === 'error' ? 504 : 202);
    }

    if (includeProcessText && result.processText) {
      responseData.processText = result.processText;
    }

    this._storeIdempotency(req.headers['idempotency-key'], { data: responseData, statusCode: 200 });
    this._json(req, res, responseData);
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
    const task = this.taskQueue.get(taskId);
    if (!task) {
      const historyTask = this.taskHistoryStore.getTask(taskId);
      if (historyTask) {
        return this._json(req, res, this._historyTaskStatusResponse(historyTask));
      }
      return this._json(req, res, { error: 'Task not found' }, 404);
    }

    if (task.status === 'queued') {
      await this._refreshQueuedTaskSnapshot(task);
    } else if (task.status === 'executing') {
      await this._refreshExecutingTaskSnapshot(task);
    }

    const response = {
      taskId,
      status: task.status,
      createdAt: task.createdAt,
      elapsed: Date.now() - task.createdAt
    };

    switch (task.status) {
      case 'queued':
        response.message = '队列等待中';
        response.queueElapsed = Date.now() - task.createdAt;
        response.deadline = task.deadline || null;
        response.remaining = task.deadline ? Math.max(0, task.deadline - Date.now()) : null;
        response.queueDetails = {
          state: task.queueState || 'queued',
          queuePosition: task.queuePosition || null,
          queueEstimatedWait: task.queueEstimatedWait || null,
          queueMessage: task.queueMessage || null,
          currentModel: task.currentModel || null,
          canSubmit: task.queueCanSubmit === true
        };
        response.fallbackModels = task.fallbackModels || [];
        response.modelProbe = {
          lastModelProbeAt: task.lastModelProbeAt || null,
          nextModelProbeAt: task.nextModelProbeAt || null,
          results: task.modelProbeResults || []
        };
        break;
      case 'executing':
        response.message = 'Trae 正在执行';
        response.submittedToTrae = task.submittedToTrae === true;
        response.submittedAt = task.submittedAt || null;
        response.queueDetails = {
          state: task.queueState || null,
          queuePosition: task.queuePosition || null,
          queueEstimatedWait: task.queueEstimatedWait || null,
          queueMessage: task.queueMessage || null,
          currentModel: task.currentModel || null,
          canSubmit: task.queueCanSubmit === true
        };
        break;
      case 'approval_required':
        response.message = 'Trae 需要先处理确认弹窗';
        response.result = {
          text: task.result?.text || '',
          needsApproval: true,
          question: task.result?.question || '',
          dialogType: task.result?.dialogType || null,
          buttons: task.result?.buttons || [],
          options: task.result?.options || [],
          answerAction: task.result?.dialogType === 'review_scope_question'
            ? { endpoint: '/api/dialog/approve', method: 'POST', body: { action: 'answer', answer: '<option label>' } }
            : null
        };
        break;
      case 'awaiting_review':
        response.message = '等待人工审查';
        response.reviewRequired = true;
        response.followupCount = task.followupTasks?.length || 0;
        response.result = {
          text: task.result?.text || '',
          stable: task.result?.stable || false,
          elapsedMs: task.result?.elapsedMs || null,
          timedOut: task.result?.timedOut || false,
          needsApproval: false
        };
        break;
      case 'done':
        response.message = '执行完成';
        response.result = {
          text: task.result.text,
          stable: task.result.stable,
          elapsedMs: task.result.elapsedMs,
          timedOut: task.result.timedOut || false,
          needsApproval: task.result.needsApproval || false
        };
        break;
      case 'error':
        response.message = '执行出错';
        response.error = task.error;
        break;
      case 'cancelled':
        response.message = '已取消';
        break;
      case 'queue_timeout':
        response.message = '排队超时，请稍后重试或切换模型';
        response.error = 'Task exceeded queue wait timeout';
        break;
      case 'review_rejected':
        response.message = '审查未通过，任务已停止';
        response.reviewDecision = task.reviewDecision || 'reject';
        response.reviewNotes = task.reviewNotes || '';
        break;
    }

    this._json(req, res, response);
  }

  async _handleTaskReview(req, res, taskId) {
    const task = this.taskQueue.get(taskId);
    if (!task) {
      return this._json(req, res, { error: 'Task not found' }, 404);
    }
    if (task.status !== 'awaiting_review') {
      return this._json(req, res, {
        error: 'Task is not awaiting review',
        status: task.status
      }, 400);
    }

    const body = await parseBody(req);
    const decision = String(body.decision || '').toLowerCase();
    const notes = typeof body.notes === 'string' ? body.notes : '';
    if (!['approve', 'continue', 'reject'].includes(decision)) {
      return this._json(req, res, { error: 'decision must be approve, continue, or reject' }, 400);
    }

    const result = await this._continueReviewedTask(taskId, task, decision === 'continue' ? 'approve' : decision, notes);
    this._json(req, res, result);
  }

  async _handleTaskCancel(req, res, taskId) {
    const task = this.taskQueue.get(taskId);
    if (!task) {
      return this._json(req, res, { error: 'Task not found' }, 404);
    }
    if (!['queued', 'executing', 'awaiting_review', 'approval_required'].includes(task.status)) {
      return this._json(req, res, {
        error: 'Task is not in a cancellable state',
        status: task.status
      }, 400);
    }
    let stopResult = null;
    if (task.status === 'executing' && task.submittedToTrae === true && this.driver && typeof this.driver.stopGeneration === 'function') {
      try {
        stopResult = await this.driver.stopGeneration();
      } catch (err) {
        stopResult = { success: false, error: err.message };
      }
    }
    // Remove task from locks if it's there
    this.taskLocks.delete(taskId);
    task.status = 'cancelled';
    task.error = null;
    task.cancelledAt = Date.now();
    if (stopResult) task.stopResult = stopResult;
    this.taskHistoryStore.cancelTask(taskId);
    if (this.wsHandler) {
      this.wsHandler.notifyTaskStatusChange(taskId, task);
    }
    this._syncTaskHistoryMirror(task);
    this._persistActiveQueue();
    this._json(req, res, { taskId, status: 'cancelled', stopResult });
  }

  async _handleBatchSubmit(req, res) {
    const body = await parseBody(req);
    if (!body.tasks || !Array.isArray(body.tasks) || body.tasks.length === 0) {
      return this._json(req, res, { error: 'tasks array is required and must not be empty' }, 400);
    }
    if (body.tasks.length > 100) {
      return this._json(req, res, { error: 'Maximum 100 tasks per batch' }, 400);
    }
    for (const item of body.tasks) {
      if (!item.task || typeof item.task !== 'string') {
        return this._json(req, res, { error: 'Each task must have a task string' }, 400);
      }
      if (item.task.length > 100000) {
        return this._json(req, res, { error: 'Each task must be at most 100000 characters' }, 400);
      }
    }

    const strategy = body.strategy || 'parallel';
    if (!['parallel', 'sequential', 'priority'].includes(strategy)) {
      return this._json(req, res, { error: 'strategy must be "parallel", "sequential", or "priority"' }, 400);
    }

    const maxConcurrency = Math.min(Math.max(body.maxConcurrency || 5, 1), 20);
    const onComplete = body.onComplete || null;

    const batchId = 'batch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const tasks = body.tasks.map((item, index) => ({
      taskId: `${batchId}_${index}`,
      task: item.task,
      priority: item.priority || 5,
      status: 'pending',
      result: null,
      error: null
    }));

    if (strategy === 'priority') {
      tasks.sort((a, b) => b.priority - a.priority);
    }

    const batch = {
      batchId,
      tasks,
      strategy,
      maxConcurrency,
      onComplete,
      status: 'running',
      createdAt: Date.now(),
      completedCount: 0,
      failedCount: 0,
      totalCount: tasks.length,
      results: []
    };

    this.batchTasks.set(batchId, batch);
    this._startBatchExecution(batchId);

    return this._json(req, res, {
      batchId,
      status: 'running',
      totalTasks: tasks.length,
      strategy,
      maxConcurrency,
      message: `Batch submitted with ${tasks.length} tasks using ${strategy} strategy`
    }, 202);
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
      const result = await this.driver.delegate(task.task);

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
    const batch = this.batchTasks.get(batchId);
    if (!batch) {
      return this._json(req, res, { error: 'Batch not found' }, 404);
    }

    const response = {
      batchId: batch.batchId,
      status: batch.status,
      strategy: batch.strategy,
      maxConcurrency: batch.maxConcurrency,
      totalCount: batch.totalCount,
      completedCount: batch.completedCount,
      failedCount: batch.failedCount,
      pendingCount: batch.tasks.filter(t => t.status === 'pending').length,
      executingCount: batch.tasks.filter(t => t.status === 'executing').length,
      createdAt: batch.createdAt,
      tasks: batch.tasks.map(t => ({
        taskId: t.taskId,
        priority: t.priority,
        status: t.status,
        result: t.result,
        error: t.error
      }))
    };

    this._json(req, res, response);
  }

  _handleBatchCancel(req, res, batchId) {
    const batch = this.batchTasks.get(batchId);
    if (!batch) {
      return this._json(req, res, { error: 'Batch not found' }, 404);
    }

    if (batch.status === 'completed' || batch.status === 'cancelled') {
      return this._json(req, res, {
        error: 'Batch is already ' + batch.status,
        status: batch.status
      }, 400);
    }

    batch.status = 'cancelled';
    batch._cancelled = true;
    for (const task of batch.tasks) {
      if (task.status === 'pending' || task.status === 'executing') {
        task.status = 'cancelled';
      }
    }

    this.batchTasks.delete(batchId);

    this._json(req, res, {
      batchId,
      status: 'cancelled',
      message: 'Batch cancelled'
    });
  }

  _handleQueueStatusList(req, res) {
    const tasks = Array.from(this.taskQueue.entries())
      .filter(([, t]) => !this._isTerminalTaskStatus(t.status))
      .map(([id, t]) => ({
      taskId: id,
      status: t.status,
      createdAt: t.createdAt,
      currentModel: t.currentModel || null,
      fallbackModels: t.fallbackModels || [],
      lastModelProbeAt: t.lastModelProbeAt || null,
      nextModelProbeAt: t.nextModelProbeAt || null,
      modelProbeResults: t.modelProbeResults || [],
      submittedToTrae: t.submittedToTrae === true,
      submittedAt: t.submittedAt || null,
      result: t.status === 'done' ? t.result : undefined,
      error: t.status === 'error' ? t.error : undefined
      }));
    this._json(req, res, { tasks });
  }

  async _finalizeCollectedBackgroundResult(taskId, task, result) {
    task.result = result;

    if (result.needsApproval) {
      await this._finalizeBackgroundTask(taskId, task, 'approval_required', {
        result
      });
    } else if (task.reviewRequired || (task.followupTasks && task.followupTasks.length > 0)) {
      if (this._isReviewableResult(result)) {
        await this._finalizeBackgroundTask(taskId, task, 'awaiting_review', {
          result
        });
      } else {
        if (await this._retryBackgroundTaskAfterResult(taskId, task, result)) {
          return;
        }
        await this._finalizeBackgroundTask(taskId, task, 'error', {
          result,
          error: 'Trae returned an incomplete or timed-out result before review'
        });
      }
    } else if (this._isSuccessfulResult(result)) {
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

  _backgroundResultRetryMode(result, task = null) {
    if (!result || result.needsApproval) return null;
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    if (result.modelError || this._isFailedResultText(text)) return 'resubmit';
    if (task?.reviewRequired === true && !this._isReviewableResult(result)) return 'collect';
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
    await this._ensureConnection();
    const queueStatus = await this.driver.checkQueueStatus();
    this._updateQueuedTaskSnapshot(task, queueStatus);
    this._syncTaskHistoryMirror(task);
    this._persistActiveQueue();

    const result = await this.driver.collectResponse();
    await this._finalizeCollectedBackgroundResult(taskId, task, result);
    return result;
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
    const body = await parseBody(req);
    const taskText = typeof body.task === 'string' && body.task.trim()
      ? body.task
      : 'Adopt existing Trae request from current chat';
    if (taskText.length > 100000) {
      return this._json(req, res, { error: 'task must be a string with max 100000 characters' }, 400);
    }

    await this._ensureConnection();
    const queueStatus = await this.driver.checkQueueStatus();
    const hasSubmittedWork = queueStatus.queued === true || queueStatus.running === true || body.force === true;
    if (!hasSubmittedWork) {
      return this._json(req, res, {
        error: 'No visible queued or running Trae request to adopt. Pass force=true only if the current chat is already producing a response.',
        queueDetails: this._queueDetailsFromStatus(queueStatus)
      }, 409);
    }

    const task = this._createQueuedTask({
      task: taskText,
      reviewRequired: body.reviewRequired === true,
      followupTasks: this._normalizeFollowupTasks(body.followupTasks),
      chatId: body.chatId || null,
      includeProcessText: body.includeProcessText === true,
      notifyUrl: body.notifyUrl,
      fallbackModels: body.fallbackModels,
      autoModelFallback: body.autoModelFallback === true,
      modelProbeIntervalMs: body.modelProbeIntervalMs
    }, {
      ...queueStatus,
      queued: queueStatus.queued !== false,
      queueMessage: queueStatus.queueMessage || queueStatus.message || 'adopted existing Trae request'
    });
    task.status = 'executing';
    task.submittedToTrae = true;
    task.submittedAt = Number.isFinite(Number(body.submittedAt)) ? Number(body.submittedAt) : Date.now();
    task.queueMessage = queueStatus.queueMessage || queueStatus.message || 'adopted existing Trae request';
    this._syncTaskHistoryMirror(task);
    this._persistActiveQueue();
    this._ensureBackgroundPolling();

    return this._json(req, res, {
      taskId: task.taskId,
      status: task.status,
      submittedToTrae: true,
      reviewRequired: task.reviewRequired,
      followupCount: task.followupTasks.length,
      queueDetails: {
        state: task.queueState || (queueStatus.running ? 'running' : 'queued'),
        currentModel: task.currentModel || queueStatus.currentModel || null,
        queuePosition: task.queuePosition || null,
        queueEstimatedWait: task.queueEstimatedWait || null,
        queueMessage: task.queueMessage || null,
        canSubmit: task.queueCanSubmit === true
      },
      message: '已接管当前 Trae 请求；后台将只等待/收集现有结果，不会重新发送任务'
    }, 202);
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
        // 定期清理机制：清理超过一定时间的非排队状态任务
        const now = Date.now();
        const maxTaskAge = 3600000; // 1小时
        for (const [taskId, task] of this.taskQueue) {
          if (task.status !== 'queued' && now - task.createdAt > maxTaskAge) {
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
              // Create a fresh chat before sending (background poller bypasses
              // delegate() which would also call newChat)
              await this.driver.newChat();
              await this.driver.sendMessage(task.task);
              task.submittedToTrae = true;
              task.submittedAt = Date.now();
              this._syncTaskHistoryMirror(task);
              this._persistActiveQueue();
              const result = await this.driver.collectResponse();
              await this._finalizeCollectedBackgroundResult(taskId, task, result);
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
      return new Promise((resolve) => {
        this.server.close(() => {
          console.log('[Gateway] HTTP server closed');
          this.server = null;
          resolve();
        });
      });
    }
    
    console.log('[Gateway] Graceful shutdown completed');
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
      resolve({ server, gateway });
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
  await this._ensureConnection();
  if (!this.driver) {
    return this._json(req, res, {
      error: 'CDP driver not initialized; TraeCN may not be reachable',
      code: 'DRIVER_NOT_READY'
    }, 503);
  }
  if (this.mockBridge) {
    return this._json(req, res, {
      error: 'Driver commands require a live TraeCN connection; mock bridge is active (TRAECN_ENABLE_MOCK_BRIDGE=1)',
      code: 'MOCK_BRIDGE_ACTIVE'
    }, 503);
  }
  let body;
  try {
    body = await new Promise((resolve, reject) => {
      let buf = '';
      let size = 0;
      const max = 1024 * 1024;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > max) { reject(new Error('body too large')); req.destroy(); return; }
        buf += chunk;
      });
      req.on('end', () => {
        if (!buf) return resolve({});
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('Invalid JSON body')); }
      });
      req.on('error', reject);
    });
  } catch (err) {
    return this._json(req, res, { error: err.message || 'Invalid JSON body' }, 400);
  }
  if (!body || typeof body !== 'object') {
    return this._json(req, res, { error: 'JSON object body required' }, 400);
  }
  const router = this._getDriverRouter();
  try {
    const result = await router.invoke(driverName, body);
    return this._json(req, res, { ok: true, driver: driverName, action: body.action, result });
  } catch (err) {
    const code = err.code || 'DRIVER_ERROR';
    return this._json(req, res, {
      ok: false,
      driver: driverName,
      action: body.action,
      error: err.message,
      code
    }, code === 'UNKNOWN_DRIVER' || code === 'UNKNOWN_ACTION' || code === 'MISSING_ACTION' ? 400 : 500);
  }
};
