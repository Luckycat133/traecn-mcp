'use strict';

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const packageInfo = require('../../package.json');
const { discoverTarget, connectToTarget, resolveCDPEndpoint, fetchCDPTargets, describeCDPSurface } = require('../cdp/discovery');
const { DomDriver, getConfig } = require('../cdp/dom-driver');
const { SETTINGS_SECTIONS } = require('../cdp/settings-driver');
const { MockDriver } = require('../cdp/mock-driver');
const { TraeCNAutomationError } = require('../cdp/errors');
const { renderChatUI } = require('./chat-ui');
const { generateOpenAPISpec } = require('./openapi');
const { getEnvWithFallback, parsePositiveInt } = require('../shared/utils');
const { ConfigManager } = require('../shared/config-manager');
const { getGlobalStore } = require('../shared/task-history');
const { buildCapabilities } = require('../shared/capabilities');
const { buildConfirmationPlan } = require('../shared/operation-confirmation');
const { listCommands } = require('../../integrations/openclaw-traecn-plugin/lib/command-set');

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

function jsonResponse(res, data, statusCode = 200, headers = {}) {
  res.writeHead(statusCode, {
    ...DEFAULT_JSON_HEADERS,
    ...headers
  });
  res.end(JSON.stringify(data));
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
    this.sessions = new Map();
    this.idempotencyKeys = new Map();
    this.taskQueue = new Map();
    this.batchTasks = new Map();
    this.pollingTimer = null;
    this.isPolling = false;
    this.taskLocks = new Set();
    this.activeTimers = new Set();

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

  _clearInterval(timer) {
    clearInterval(timer);
    this.activeTimers.delete(timer);
  }

  _clearAllTimers() {
    for (const timer of this.activeTimers) {
      clearTimeout(timer);
      clearInterval(timer);
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
    return jsonResponse(res, data, statusCode, { ...this._corsHeaders(req), ...headers });
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

  _checkRateLimit(req) {
    const ip = req.socket.remoteAddress;
    return this.rateLimiter.check(ip);
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
    if (this.mockBridge) {
      if (!this.driver) {
        this.driver = new MockDriver();
      }
      return;
    }

    if (this.client && this.client.isConnected && this.driver) {
      return;
    }

    const discovered = await discoverTarget();
    this.client = await connectToTarget(discovered, discovered.client);
    this.driver = new DomDriver(this.client);
  }

  async handleRequest(req, res) {
    let parsedUrl;
    const normalizedUrl = normalizeUrl(req.url);
    try {
      parsedUrl = new URL(normalizedUrl, `http://${req.headers.host}`);
    } catch(e) {
      return this._json(req, res, { error: 'Invalid URL: ' + e.message }, 400);
    }
    req._normalizedUrl = normalizedUrl;
    const pathname = parsedUrl.pathname;
    const method = req.method;

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        ...this._corsHeaders(req),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-TraeCN-Token, Idempotency-Key',
        'Access-Control-Max-Age': '86400'
      });
      res.end();
      return;
    }

    if (!this._checkOrigin(req)) {
      return this._json(req, res, { error: 'Origin not allowed' }, 403);
    }

    if (pathname === '/api/status' && method === 'GET') {
      return this._handleStatus(req, res);
    }
    if (pathname === '/api/capabilities' && method === 'GET') {
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
      return this._html(req, res, renderChatUI());
    }
    if (pathname === '/openapi.json' && method === 'GET') {
      return this._json(req, res, generateOpenAPISpec());
    }

    if (!this._authenticate(req)) {
      return this._json(req, res, { error: 'Unauthorized' }, 401);
    }

    if (!this._checkRateLimit(req)) {
      return this._json(req, res, { error: 'Rate limit exceeded' }, 429);
    }

    const idempotencyResponse = this._checkIdempotency(req);
    if (idempotencyResponse) {
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
      if (pathname.match(/^\/api\/task\/[^/]+$/) && method === 'GET') {
        const taskId = pathname.split('/').pop();
        return this._handleTaskStatus(req, res, taskId);
      }
      if (pathname.match(/^\/api\/task\/[^/]+\/cancel$/) && method === 'POST') {
        const segments = pathname.split('/');
        const taskId = segments[3];
        return this._handleTaskCancel(req, res, taskId);
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
      if (pathname === '/debug/automation' && method === 'GET' && this.debugEndpoints) {
        return await this._handleDebugAutomation(req, res);
      }

      this._json(req, res, { error: 'Not found' }, 404);
    } catch (err) {
      console.error('[Gateway] Error:', sanitizeLog({ message: err.message, code: err.code }));
      const statusCode = err instanceof HttpError ? err.statusCode : (err instanceof TraeCNAutomationError ? 502 : 500);
      this._json(req, res, { error: err.message, code: err.code || 'INTERNAL_ERROR' }, statusCode);
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
      } : null
    };
  }

  _compactQueue(queue = {}) {
    return {
      queued: queue.queued === true,
      running: queue.running === true,
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

  _queueRuntimeSummary() {
    const tasks = Array.from(this.taskQueue.values());
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

  _preflightNextAction({ connected, surface, readiness, queue, dialog }) {
    if (!connected) return 'connect_traecn';
    if (surface?.kind === 'setup') return 'complete_setup_or_login';
    if (dialog?.hasDialog) return dialog.canAutoApprove ? 'approve_dialog' : 'inspect_dialog';
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

    const status = await this._statusSnapshot();
    const connectionProbe = await this._probe('connection', async () => {
      await this._ensureConnection();
      return true;
    });

    const connected = connectionProbe.ok;
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
    const canDelegate = connected && readiness?.ready === true && !queue?.queued && !queue?.running && !dialog?.hasDialog;
    const nextAction = this._preflightNextAction({ connected, surface: status.surface, readiness, queue, dialog });
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
    const normalizedSwitch = typeof switchResult === 'object' && switchResult !== null
      ? switchResult
      : { success: !String(switchResult || '').startsWith('model_switch_blocked') && !String(switchResult || '').startsWith('no model items') && !String(switchResult || '').startsWith('model not found'), switchResult };

    if (!normalizedSwitch.success) {
      return this._json(req, res, {
        success: false,
        model: normalizedSwitch.model || null,
        requestedModel: body.model,
        switchResult: normalizedSwitch.switchResult || switchResult,
        error: normalizedSwitch.error || 'Model switch failed'
      }, 502);
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
      await new Promise(r => setTimeout(r, queuePollIntervalMs));
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

    const { spawn } = require('child_process');
    const { sleep } = require('../shared/utils');
    const projectPath = body.projectPath;
    let result;

    try {
      const child = spawn('trae-cn', ['--reuse-window', projectPath], {
        stdio: 'pipe',
        timeout: 10000
      });

      result = await new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => stdout += d);
        child.stderr.on('data', d => stderr += d);
        child.on('error', (err) => resolve({ success: false, error: err.message }));
        child.on('close', (code) => {
          resolve({
            success: code === 0,
            projectPath,
            exitCode: code,
            stdout: stdout.trim(),
            stderr: stderr.trim()
          });
        });
      });

      if (result.success) {
        // Wait for the new window/tab to load its DOM
        await sleep(3000);

        // Try to check for restricted mode dialog via CDP
        try {
          const { fetchCDPTargets } = require('../cdp/discovery');
          const { CDPClient } = require('../cdp/client');
          const host = process.env.TRAECN_CDP_HOST || process.env.TRAE_CDP_HOST || '127.0.0.1';
          const port = process.env.TRAECN_REMOTE_DEBUGGING_PORT || process.env.TRAE_REMOTE_DEBUGGING_PORT || '9222';
          const targets = await fetchCDPTargets(host, port);
          const pageTarget = targets.find(t => t.type === 'page');

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
      }
    } catch (err) {
      result = { success: false, error: err.message };
    }

    this._json(req, res, result);
  }

  async _handleUpdateSelf(req, res) {
    const body = await parseBody(req);
    this._json(req, res, {
      success: false,
      version: packageInfo.version,
      force: body.force === true,
      message: 'Automatic self-update is not enabled. Pull the latest repository revision and run npm install.'
    }, 501);
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
      if (/[\x80-\xff]/.test(raw)) {
        const rawBytes = Buffer.from(raw, 'latin1');
        const encoded = Array.from(rawBytes).map(b => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
        return decodeURIComponent(encoded);
      }
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

    if (action === 'auto') {
      // Auto-detect the best action based on dialog type
      const dialog = await this.driver.checkForApprovalDialog();
      if (!dialog.needsApproval) {
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

    if (!['trust', 'allow', 'confirm', 'approve', 'deny', 'cancel', 'dismiss'].includes(action)) {
      return this._json(req, res, { error: 'Invalid action: ' + action }, 400);
    }

    const result = await this.driver.approveDialog(action);
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
    const dialog = await this.driver.checkForApprovalDialog();
    this._json(req, res, {
      hasDialog: dialog.needsApproval,
      dialogType: dialog.dialogType || null,
      question: dialog.question || null,
      buttons: dialog.buttons || [],
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
    await this._ensureConnection();

    // Get queue status with enhanced detection
    const queueStatus = await this.driver.checkQueueStatus();

    // Build queue ETA message
    let queueEtaMessage = '';
    if (queueStatus.queueEstimatedWait) {
      queueEtaMessage = `，预计等待 ${queueStatus.queueEstimatedWait}`;
    } else if (queueStatus.queuePosition) {
      queueEtaMessage = `，当前第 ${queueStatus.queuePosition} 位`;
    }

    if (queueStatus.queued) {
      if (!waitForQueue) {
        // Caller doesn't want to wait — return queue info immediately
        return this._json(req, res, {
          status: 'queued',
          queueDetails: {
            state: 'queued',
            currentModel: queueStatus.currentModel || '',
            queuePosition: queueStatus.queuePosition,
            queueEstimatedWait: queueStatus.queueEstimatedWait,
            queueMessage: queueStatus.queueMessage || '模型排队中'
          },
          message: `模型排队中${queueEtaMessage}，请稍后重试或设置 waitForQueue=true 自动等待`,
          model: queueStatus.currentModel
        }, 202);
      }

      // Store task for background processing with per-task queue timeout
      const taskId = 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const perTaskTimeoutMs = this.driver.config.queuePerTaskTimeoutMs || 600000;
      this.taskQueue.set(taskId, {
        chatId,
        task: body.task,
        status: 'queued',
        createdAt: Date.now(),
        deadline: Date.now() + perTaskTimeoutMs,
        attempts: 0,
        includeProcessText
      });

      this._ensureBackgroundPolling();

      return this._json(req, res, {
        taskId,
        status: 'queued',
        queueDetails: {
          state: 'queued',
          currentModel: queueStatus.currentModel || '',
          queuePosition: queueStatus.queuePosition,
          queueEstimatedWait: queueStatus.queueEstimatedWait,
          queueMessage: queueStatus.queueMessage || '模型排队中'
        },
        message: `模型排队中${queueEtaMessage}，任务已加入后台。用 traecn_task_status 查询进度`,
        model: queueStatus.currentModel
      }, 202);
    }

    if (queueStatus.running) {
      // Model is currently generating — can't send new task yet
      return this._json(req, res, {
        status: 'running',
        message: 'Trae 正在执行其他任务，请稍后重试',
        model: queueStatus.currentModel
      }, 202);
    }

    // Model is idle/ready — execute synchronously with timeout protection
    let result;
    let timeoutId;
    try {
      const syncTimeout = 180000;
      const timeoutPromise = new Promise((_, reject) =>
        { timeoutId = this._setTimeout(() => reject(new Error('delegate timeout (' + syncTimeout + 'ms)')), syncTimeout); }
      );
      result = await Promise.race([this.driver.delegate(body.task), timeoutPromise]);
    } catch (e) {
      return this._json(req, res, { error: 'delegate failed: ' + e.message }, 504);
    } finally {
      if (timeoutId) this._clearTimeout(timeoutId);
    }

    if (chatId) {
      await notifyOpenClaw(chatId, formatResult(result));
    }

    const responseData = {
      status: 'done',
      text: result.text,
      stable: result.stable,
      elapsedMs: result.elapsedMs,
      timedOut: result.timedOut || false,
      needsApproval: result.needsApproval || false,
      question: result.question || ''
    };

    if (includeProcessText && result.processText) {
      responseData.processText = result.processText;
    }

    this._storeIdempotency(req.headers['idempotency-key'], { data: responseData, statusCode: 200 });
    this._json(req, res, responseData);
  }

  // ── Task status & cancel ──────────────────────────────────────────────────

  _handleTaskStatus(req, res, taskId) {
    const task = this.taskQueue.get(taskId);
    if (!task) {
      return this._json(req, res, { error: 'Task not found' }, 404);
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
        response.deadline = task.deadline;
        response.remaining = Math.max(0, task.deadline - Date.now());
        break;
      case 'executing':
        response.message = 'Trae 正在执行';
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
    }

    this._json(req, res, response);
  }

  _handleTaskCancel(req, res, taskId) {
    const task = this.taskQueue.get(taskId);
    if (!task) {
      return this._json(req, res, { error: 'Task not found' }, 404);
    }
    if (task.status !== 'queued') {
      return this._json(req, res, {
        error: 'Task is not in a cancellable state',
        status: task.status
      }, 400);
    }
    // Remove task from locks if it's there
    this.taskLocks.delete(taskId);
    task.status = 'cancelled';
    this.taskQueue.delete(taskId);
    this._json(req, res, { taskId, status: 'cancelled' });
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
    if (!batch) return;

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
    if (!batch) return;

    const task = batch.tasks.find(t => t.taskId === taskId);
    if (!task || task.status !== 'executing') return;

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
    for (const task of batch.tasks) {
      if (task.status === 'pending') {
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
    const tasks = Array.from(this.taskQueue.entries()).map(([id, t]) => ({
      taskId: id,
      status: t.status,
      createdAt: t.createdAt,
      result: t.status === 'done' ? t.result : undefined,
      error: t.status === 'error' ? t.error : undefined
    }));
    this._json(req, res, { tasks });
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
          // Skip if task is not queued or already locked
          if (task.status !== 'queued' || this.taskLocks.has(taskId)) continue;

          // Check per-task queue timeout
        if (Date.now() > task.deadline) {
          task.status = 'queue_timeout';

          if (this.wsHandler) {
            this.wsHandler.notifyTaskStatusChange(taskId, task);
          }

          console.log('[Queue] Task', taskId, 'queue timeout after', Date.now() - task.createdAt, 'ms');
          if (task.chatId) {
            await notifyOpenClaw(task.chatId, '❌ Trae 排队超时（超过限制），请稍后重试或切换模型');
          }
          this.taskQueue.delete(taskId);
          continue;
        }

          try {
            await this._ensureConnection();
            const queueStatus = await this.driver.checkQueueStatus();

            // Still queued or actively running — skip this task for now
            if (queueStatus.queued || queueStatus.running) continue;

            // Lock this task before execution
            this.taskLocks.add(taskId);
            task.status = 'executing';

            if (this.wsHandler) {
              this.wsHandler.notifyTaskStatusChange(taskId, task);
            }

            try {
              // Create a fresh chat before sending (background poller bypasses
              // delegate() which would also call newChat)
              await this.driver.newChat();
              await this.driver.sendMessage(task.task);
              const result = await this.driver.collectResponse();

              task.status = 'done';
              task.result = result;

              if (task.chatId) {
                await notifyOpenClaw(task.chatId, formatResult(result));
              }
              this.taskQueue.delete(taskId);
            } catch (e) {
              task.status = 'error';
              task.error = e.message;
              console.error('[Queue] Task', taskId, 'execution error:', e.message);
              if (task.chatId) {
                await notifyOpenClaw(task.chatId, '❌ Trae 出错: ' + e.message);
              }
              this.taskQueue.delete(taskId);
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
      gateway._ensureBackgroundPolling();
      resolve({ server, gateway });
    });
    server.on('error', reject);
  });
}

module.exports = { Gateway, startGateway, sanitizeLog, RateLimiter };
