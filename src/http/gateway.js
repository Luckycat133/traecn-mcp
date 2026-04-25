'use strict';

const http = require('http');
const { URL } = require('url');
const { discoverTarget, connectToTarget, fetchCDPVersion } = require('../cdp/discovery');
const { DomDriver, getConfig } = require('../cdp/dom-driver');
const { SETTINGS_SECTIONS } = require('../cdp/settings-driver');
const { MockDriver } = require('../cdp/mock-driver');
const { TraeCNAutomationError } = require('../cdp/errors');
const { renderChatUI } = require('./chat-ui');
const { generateOpenAPISpec } = require('./openapi');
const { getEnvWithFallback } = require('../shared/utils');

function normalizeUrl(rawUrl) {
  return rawUrl.replace(/[\x80-\xff]/g, ch => {
    const byteVal = Buffer.from(ch, 'latin1')[0];
    return '%' + byteVal.toString(16).toUpperCase().padStart(2, '0');
  });
}

const SENSITIVE_KEYS = ['token', 'password', 'secret', 'credential', 'authorization'];

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
        reject(new Error('Request body too large'));
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });

    req.on('error', reject);
  });
}

function jsonResponse(res, data, statusCode = 200) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'X-Powered-By': 'traecn-cdp-http-bridge'
  });
  res.end(JSON.stringify(data));
}

function htmlResponse(res, html, statusCode = 200) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8'
  });
  res.end(html);
}

// Task queue for async scheduling: taskId → { chatId, task, status, createdAt, result }
const taskQueue = new Map();

// Notify OpenClaw (Telegram gateway) when async task completes
async function notifyOpenClaw(chatId, message) {
  try {
    const body = JSON.stringify({ chatId, text: message });
    const req = http.request({
      hostname: '127.0.0.1',
      port: 18789,
      path: '/api/message/send',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 5000
    });
    req.write(body);
    req.end();
    await new Promise((resolve, reject) => {
      req.on('response', resolve);
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  } catch (e) {
    console.error('[Queue] notify failed:', e.message);
  }
}

function formatResult(result) {
  if (!result) return '✅ Trae 完成（无详情）';
  if (result.needsConfirmation) {
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
    this.host = options.host || getEnvWithFallback('TRAECN_HOST', 'TRAE_HOST', '127.0.0.1');
    this.port = options.port || parseInt(getEnvWithFallback('TRAECN_PORT', 'TRAE_PORT', '8788'), 10);
    this.token = getEnvWithFallback('TRAECN_GATEWAY_TOKEN', 'TRAE_GATEWAY_TOKEN', '');
    this.authHeader = getEnvWithFallback('TRAECN_AUTH_HEADER', 'TRAE_AUTH_HEADER', 'Authorization');
    this.allowedOrigins = getEnvWithFallback('TRAECN_ALLOWED_ORIGINS', 'TRAE_ALLOWED_ORIGINS', '');
    this.debugEndpoints = getEnvWithFallback('TRAECN_ENABLE_DEBUG_ENDPOINTS', 'TRAE_ENABLE_DEBUG_ENDPOINTS', '0') === '1';
    this.mockBridge = getEnvWithFallback('TRAECN_ENABLE_MOCK_BRIDGE', 'TRAE_ENABLE_MOCK_BRIDGE', '0') === '1';

    const rateWindowMs = parseInt(getEnvWithFallback('TRAECN_RATE_LIMIT_WINDOW_MS', 'TRAE_RATE_LIMIT_WINDOW_MS', '60000'), 10);
    const rateMaxRequests = parseInt(getEnvWithFallback('TRAECN_RATE_LIMIT_MAX_REQUESTS', 'TRAE_RATE_LIMIT_MAX_REQUESTS', '60'), 10);
    this.rateLimiter = new RateLimiter(rateWindowMs, rateMaxRequests);

    this.client = null;
    this.driver = null;
    this.server = null;
    this.sessions = new Map();
    this.idempotencyKeys = new Map();
    this.taskQueue = taskQueue;
  }

  _authenticate(req) {
    if (!this.token) return true;

    const authHeader = req.headers[this.authHeader.toLowerCase()] || '';
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7) === this.token;
    }

    const customToken = req.headers['x-traecn-token'];
    if (customToken) {
      return customToken === this.token;
    }

    return false;
  }

  _checkOrigin(req) {
    if (!this.allowedOrigins) return true;
    const origin = req.headers.origin;
    if (!origin) return true;

    const allowed = this.allowedOrigins.split(',').map(o => o.trim());
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
      setTimeout(() => this.idempotencyKeys.delete(key), 300000);
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
      return jsonResponse(res, { error: 'Invalid URL: ' + e.message }, 400);
    }
    req._normalizedUrl = normalizedUrl;
    const pathname = parsedUrl.pathname;
    const method = req.method;

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': this.allowedOrigins || '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-TraeCN-Token, Idempotency-Key',
        'Access-Control-Max-Age': '86400'
      });
      res.end();
      return;
    }

    if (!this._checkOrigin(req)) {
      return jsonResponse(res, { error: 'Origin not allowed' }, 403);
    }

    if (pathname === '/api/status' && method === 'GET') {
      return this._handleStatus(req, res);
    }

    if (!this._authenticate(req)) {
      return jsonResponse(res, { error: 'Unauthorized' }, 401);
    }

    if (!this._checkRateLimit(req)) {
      return jsonResponse(res, { error: 'Rate limit exceeded' }, 429);
    }

    const idempotencyResponse = this._checkIdempotency(req);
    if (idempotencyResponse) {
      return jsonResponse(res, idempotencyResponse.data, idempotencyResponse.statusCode);
    }

    try {
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
      if (pathname === '/api/delegate' && method === 'POST') {
        return await this._handleDelegateAsync(req, res);
      }
      if (pathname === '/api/open-project' && method === 'POST') {
        return await this._handleOpenProject(req, res);
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
      if (pathname === '/api/settings/set' && method === 'POST') {
        return await this._handleSettingsSet(req, res);
      }
      if (pathname === '/api/settings/switch-tab' && method === 'POST') {
        return await this._handleSettingsSwitchTab(req, res);
      }
      if (pathname === '/api/settings/back-to-chat' && method === 'POST') {
        return await this._handleSettingsBackToChat(req, res);
      }
      if (pathname === '/' && method === 'GET') {
        return htmlResponse(res, renderChatUI());
      }
      if (pathname === '/openapi.json' && method === 'GET') {
        return jsonResponse(res, generateOpenAPISpec());
      }
      if (pathname === '/debug/automation' && method === 'GET' && this.debugEndpoints) {
        return await this._handleDebugAutomation(req, res);
      }

      jsonResponse(res, { error: 'Not found' }, 404);
    } catch (err) {
      console.error('[Gateway] Error:', sanitizeLog({ message: err.message, code: err.code }));
      const statusCode = err instanceof TraeCNAutomationError ? 502 : 500;
      jsonResponse(res, { error: err.message, code: err.code || 'INTERNAL_ERROR' }, statusCode);
    }
  }

  async _handleStatus(req, res) {
    let cdpVersion = null;
    let connected = false;

    try {
      const host = getEnvWithFallback('TRAECN_CDP_HOST', 'TRAE_CDP_HOST', '127.0.0.1');
      const port = getEnvWithFallback('TRAECN_REMOTE_DEBUGGING_PORT', 'TRAE_REMOTE_DEBUGGING_PORT', '9222');
      cdpVersion = await fetchCDPVersion(host, port);
      connected = !!(this.client && this.client.isConnected);
    } catch {
      connected = false;
    }

    jsonResponse(res, {
      status: connected ? 'connected' : 'disconnected',
      service: 'traecn-cdp-http-bridge',
      version: '0.1.0',
      mockBridge: this.mockBridge,
      cdp: cdpVersion ? { browser: cdpVersion.Browser, protocolVersion: cdpVersion['Protocol-Version'] } : null,
      uptime: process.uptime()
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
    jsonResponse(res, responseData, 201);
  }

  _handleListSessions(req, res) {
    const sessions = Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      createdAt: s.createdAt,
      messageCount: s.messages.length
    }));
    jsonResponse(res, { sessions });
  }

  _handleGetSession(req, res, sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return jsonResponse(res, { error: 'Session not found' }, 404);
    }
    jsonResponse(res, session);
  }

  async _handleDelegate(req, res, sessionId) {
    const body = await parseBody(req);
    if (!body.task) {
      return jsonResponse(res, { error: 'task is required' }, 400);
    }
    if (typeof body.task !== 'string' || body.task.length > 100000) {
      return jsonResponse(res, { error: 'task must be a string with max 100000 characters' }, 400);
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
    jsonResponse(res, responseData);
  }

  async _handleNewChat(req, res) {
    await this._ensureConnection();
    const success = await this.driver.newChat();
    jsonResponse(res, { success });
  }

  async _handleSwitchMode(req, res) {
    const body = await parseBody(req);
    if (!body.mode) {
      return jsonResponse(res, { error: 'mode is required' }, 400);
    }
    if (!['solo', 'ide'].includes(body.mode.toLowerCase())) {
      return jsonResponse(res, { error: 'mode must be "solo" or "ide"' }, 400);
    }

    await this._ensureConnection();
    const success = await this.driver.switchMode(body.mode);
    jsonResponse(res, { success, mode: body.mode });
  }

  async _handleSwitchModel(req, res) {
    const body = await parseBody(req);
    if (!body.model) {
      return jsonResponse(res, { error: 'model is required' }, 400);
    }

    await this._ensureConnection();
    const switchResult = await this.driver.switchModel(body.model);

    // Wait for model to become available (up to 10 minutes)
    const queueWaitTimeoutMs = this.driver.config.queueWaitTimeoutMs || 600000;
    const queuePollIntervalMs = this.driver.config.queuePollIntervalMs || 15000;
    const maxRetries = Math.ceil(queueWaitTimeoutMs / queuePollIntervalMs);

    let waitedMs = 0;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const status = await this.driver.checkQueueStatus();
      if (!status.queued) {
        // Model is ready
        return jsonResponse(res, {
          success: true,
          model: body.model,
          switchResult,
          queueWaitMs: waitedMs,
          queueWaitAttempts: attempt
        });
      }

      // Still queued — wait and retry
      await new Promise(r => setTimeout(r, queuePollIntervalMs));
      waitedMs += queuePollIntervalMs;
    }

    // Timed out waiting for model to become available
    return jsonResponse(res, {
      success: false,
      model: body.model,
      switchResult,
      error: 'Model queue wait timeout',
      queueWaitMs: waitedMs,
      queueWaitAttempts: maxRetries
    }, 504);
  }

  async _handleQueueStatus(req, res) {
    await this._ensureConnection();
    const status = await this.driver.checkQueueStatus();
    jsonResponse(res, status);
  }

  async _handleOpenProject(req, res) {
    const body = await parseBody(req);
    if (!body.projectPath) {
      return jsonResponse(res, { error: 'projectPath is required' }, 400);
    }

    jsonResponse(res, { success: true, projectPath: body.projectPath, note: 'Project opening requires trae-cn CLI or manual action' });
  }

  async _handleReadiness(req, res) {
    await this._ensureConnection();
    const readiness = await this.driver.checkReadiness();
    jsonResponse(res, readiness);
  }

  async _handleSettingsReadAll(req, res) {
    await this._ensureConnection();
    const data = await this.driver.settings.readAll();
    jsonResponse(res, { sections: SETTINGS_SECTIONS, data });
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
      return jsonResponse(res, { error: e.message }, 500);
    }

    jsonResponse(res, { section: section || 'current', ...data });
  }

  async _handleSettingsSet(req, res) {
    const body = await parseBody(req);
    if (!body.label) {
      return jsonResponse(res, { error: 'label is required' }, 400);
    }
    if (body.value === undefined || body.value === null) {
      return jsonResponse(res, { error: 'value is required' }, 400);
    }

    await this._ensureConnection();

    // If section is specified, navigate there first
    if (body.section) {
      await this.driver.settings.switchTab(body.section);
    }

    const result = await this.driver.settings.set(body.label, body.value);
    jsonResponse(res, { label: body.label, value: body.value, result });
  }

  async _handleSettingsSwitchTab(req, res) {
    const body = await parseBody(req);
    if (!body.section) {
      return jsonResponse(res, { error: 'section is required' }, 400);
    }

    await this._ensureConnection();
    const result = await this.driver.settings.switchTab(body.section);
    jsonResponse(res, result);
  }

  async _handleSettingsBackToChat(req, res) {
    await this._ensureConnection();
    const result = await this.driver.settings.backToChat();
    jsonResponse(res, { result });
  }

  async _handleDebugAutomation(req, res) {
    const config = getConfig();
    await this._ensureConnection();
    const readiness = await this.driver.checkReadiness();

    jsonResponse(res, {
      config: {
        composerSelectors: config.composerSelectors,
        sendButtonSelectors: config.sendButtonSelectors,
        responseSelectors: config.responseSelectors,
        activitySelectors: config.activitySelectors,
        newChatSelectors: config.newChatSelectors,
        modeTabSelectors: config.modeTabSelectors,
        sendTrigger: config.sendTrigger
      },
      readiness
    });
  }

  // ── Async delegate (Step 7 & 8) ─────────────────────────────────────────────

  async _handleDelegateAsync(req, res) {
    const body = await parseBody(req);
    if (!body.task) {
      return jsonResponse(res, { error: 'task is required' }, 400);
    }
    if (typeof body.task !== 'string' || body.task.length > 100000) {
      return jsonResponse(res, { error: 'task must be a string with max 100000 characters' }, 400);
    }

    const chatId = body.chatId || null;
    await this._ensureConnection();

    // If model is queued, store task and return 202 immediately
    const queueStatus = await this.driver.checkQueueStatus();
    if (queueStatus.queued) {
      const taskId = 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      this.taskQueue.set(taskId, {
        chatId,
        task: body.task,
        status: 'queued',
        createdAt: Date.now(),
        attempts: 0
      });
      return jsonResponse(res, {
        taskId,
        status: 'queued',
        message: `Trae 排队中（${queueStatus.message || '模型忙'}），完成后自动通知`
      }, 202);
    }

    // Model ready — execute synchronously with timeout protection
    let result;
    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('delegate timeout (60s)')), 60000)
      );
      result = await Promise.race([this.driver.delegate(body.task), timeoutPromise]);
    } catch (e) {
      return jsonResponse(res, { error: 'delegate failed: ' + e.message }, 504);
    }
    if (chatId) {
      await notifyOpenClaw(chatId, formatResult(result));
    }

    const responseData = {
      text: result.text,
      stable: result.stable,
      elapsedMs: result.elapsedMs,
      timedOut: result.timedOut || false
    };
    this._storeIdempotency(req.headers['idempotency-key'], { data: responseData, statusCode: 200 });
    jsonResponse(res, responseData);
  }

  _handleQueueStatusList(req, res) {
    const tasks = Array.from(this.taskQueue.entries()).map(([id, t]) => ({
      taskId: id,
      status: t.status,
      createdAt: t.createdAt,
      result: t.status === 'done' ? t.result : undefined,
      error: t.status === 'error' ? t.error : undefined
    }));
    jsonResponse(res, { tasks });
  }

  _startBackgroundPolling() {
    const pollInterval = 15000;
    setInterval(async () => {
      for (const [taskId, task] of this.taskQueue) {
        if (task.status !== 'queued') continue;
        try {
          await this._ensureConnection();
          const queueStatus = await this.driver.checkQueueStatus();
          if (queueStatus.queued) continue;
          task.status = 'executing';
          try {
            const result = await this.driver.delegate(task.task);
            task.status = 'done';
            task.result = result;
            if (task.chatId) {
              await notifyOpenClaw(task.chatId, formatResult(result));
            }
          } catch (e) {
            task.status = 'error';
            task.error = e.message;
            if (task.chatId) {
              await notifyOpenClaw(task.chatId, '❌ Trae 出错: ' + e.message);
            }
          }
        } catch (e) {
          console.error('[Queue] polling error:', e.message);
          // Continue to next task instead of crashing the loop
        }
      }
    }, pollInterval);
    console.log('[Gateway] Background polling started (interval=15s)');
  }
}

async function startGateway(options = {}) {
  const gateway = new Gateway(options);

  const server = http.createServer((req, res) => {
    gateway.handleRequest(req, res).catch(err => {
      console.error('[Gateway] Unhandled error:', err);
      jsonResponse(res, { error: 'Internal server error' }, 500);
    });
  });

  server.on('close', () => {
    if (gateway.client) {
      gateway.client.close().catch(() => {});
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(gateway.port, gateway.host, () => {
      gateway.server = server;
      gateway._startBackgroundPolling();
      resolve(server);
    });
    server.on('error', reject);
  });
}

module.exports = { Gateway, startGateway, sanitizeLog, RateLimiter };
