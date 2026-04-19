'use strict';

const http = require('http');
const { URL } = require('url');
const { discoverTarget, connectToTarget, fetchCDPVersion } = require('../cdp/discovery');
const { DomDriver, getConfig } = require('../cdp/dom-driver');
const { MockDriver } = require('../cdp/mock-driver');
const { TraeCNAutomationError } = require('../cdp/errors');
const { renderChatUI } = require('./chat-ui');
const { generateOpenAPISpec } = require('./openapi');

function _getEnvWithFallback(traecnKey, traeKey, defaultValue) {
  return process.env[traecnKey] || process.env[traeKey] || defaultValue;
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
  }

  check(key) {
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

class Gateway {
  constructor(options = {}) {
    this.host = options.host || _getEnvWithFallback('TRAECN_HOST', 'TRAE_HOST', '127.0.0.1');
    this.port = options.port || parseInt(_getEnvWithFallback('TRAECN_PORT', 'TRAE_PORT', '8788'), 10);
    this.token = _getEnvWithFallback('TRAECN_GATEWAY_TOKEN', 'TRAE_GATEWAY_TOKEN', '');
    this.authHeader = _getEnvWithFallback('TRAECN_AUTH_HEADER', 'TRAE_AUTH_HEADER', 'Authorization');
    this.allowedOrigins = _getEnvWithFallback('TRAECN_ALLOWED_ORIGINS', 'TRAE_ALLOWED_ORIGINS', '');
    this.debugEndpoints = _getEnvWithFallback('TRAECN_ENABLE_DEBUG_ENDPOINTS', 'TRAE_ENABLE_DEBUG_ENDPOINTS', '0') === '1';
    this.mockBridge = _getEnvWithFallback('TRAECN_ENABLE_MOCK_BRIDGE', 'TRAE_ENABLE_MOCK_BRIDGE', '0') === '1';

    const rateWindowMs = parseInt(_getEnvWithFallback('TRAECN_RATE_LIMIT_WINDOW_MS', 'TRAE_RATE_LIMIT_WINDOW_MS', '60000'), 10);
    const rateMaxRequests = parseInt(_getEnvWithFallback('TRAECN_RATE_LIMIT_MAX_REQUESTS', 'TRAE_RATE_LIMIT_MAX_REQUESTS', '60'), 10);
    this.rateLimiter = new RateLimiter(rateWindowMs, rateMaxRequests);

    this.client = null;
    this.driver = null;
    this.server = null;
    this.sessions = new Map();
    this.idempotencyKeys = new Map();
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

    const targetInfo = await discoverTarget();
    this.client = await connectToTarget(targetInfo);
    this.driver = new DomDriver(this.client);
  }

  async handleRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
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
      if (pathname === '/api/open-project' && method === 'POST') {
        return await this._handleOpenProject(req, res);
      }
      if (pathname === '/api/readiness' && method === 'GET') {
        return await this._handleReadiness(req, res);
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
      const host = _getEnvWithFallback('TRAECN_CDP_HOST', 'TRAE_CDP_HOST', '127.0.0.1');
      const port = _getEnvWithFallback('TRAECN_REMOTE_DEBUGGING_PORT', 'TRAE_REMOTE_DEBUGGING_PORT', '9222');
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
    const success = await this.driver.switchModel(body.model);
    jsonResponse(res, { success, model: body.model });
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
}

async function startGateway(options = {}) {
  const gateway = new Gateway(options);

  const server = http.createServer((req, res) => {
    gateway.handleRequest(req, res).catch(err => {
      console.error('[Gateway] Unhandled error:', err);
      jsonResponse(res, { error: 'Internal server error' }, 500);
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(gateway.port, gateway.host, () => {
      gateway.server = server;
      resolve(server);
    });
    server.on('error', reject);
  });
}

module.exports = { Gateway, startGateway, sanitizeLog, RateLimiter };
