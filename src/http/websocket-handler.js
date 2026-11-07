'use strict';

const { WebSocketServer } = require('ws');
const { secureCompare } = require('../shared/utils');

const WS_HEARTBEAT_INTERVAL = 30000;
const WS_HEARTBEAT_TIMEOUT = 60000;
const WS_PUBLIC_PROTOCOL = 'traecnclaw.v1';
const WS_BEARER_PROTOCOL_PREFIX = 'traecnclaw.bearer.';
// Hard cap on inbound WS frame payload. Default 64 KiB; messages above this
// size are dropped by the ws library with code 1009 (Message Too Big).
// Prevents slow-loris / memory-exhaustion attacks on long-lived WS clients.
const WS_MAX_PAYLOAD_BYTES = parseInt(
  (typeof process !== 'undefined' && process.env && process.env.TRAECN_WS_MAX_PAYLOAD_BYTES) || '65536',
  10
);
const WS_MAX_CLIENTS = parseInt(
  (typeof process !== 'undefined' && process.env && process.env.TRAECN_WS_MAX_CLIENTS) || '100',
  10
);
const WS_RATE_LIMIT_WINDOW_MS = parseInt(
  (typeof process !== 'undefined' && process.env && process.env.TRAECN_WS_RATE_LIMIT_WINDOW_MS) || '60000',
  10
);
const WS_MAX_UPGRADES_PER_WINDOW = parseInt(
  (typeof process !== 'undefined' && process.env && process.env.TRAECN_WS_MAX_UPGRADES_PER_WINDOW) || '60',
  10
);

class WebSocketHandler {
  constructor(gateway) {
    this.gateway = gateway;
    this.wss = null;
    this.taskSubscriptions = new Map();
    this.globalEventListeners = new Set();
    this.heartbeatTimers = new Map();
    this.clients = new Set();
    this.upgradeAttempts = new Map();
  }

  initialize(server) {
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: WS_MAX_PAYLOAD_BYTES,
      handleProtocols: (protocols, request) => this._selectProtocol(protocols, request)
    });

    this.wss.on('connection', (ws, req, context) => {
      this._handleConnection(ws, req, context);
    });

    this._setupUpgrade(server);
    this._startHeartbeat();
  }

  _setupUpgrade(server) {
    server.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

      if (!pathname.startsWith('/ws')) {
        socket.destroy();
        return;
      }

      const rateCheck = this._checkUpgradeRateLimit(request);
      if (!rateCheck.allowed) {
        const status = rateCheck.reason === 'too_many_clients' ? '503 Service Unavailable' : '429 Too Many Requests';
        socket.write(`HTTP/1.1 ${status}\r\nRetry-After: 60\r\n\r\n`);
        socket.destroy();
        return;
      }

      const context = { authenticated: false };

      if (!this._handleUpgradeAuth(request, context)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      if (!this._checkOrigin(request)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        ws._context = context;
        this.wss.emit('connection', ws, request);
      });
    });
  }

  _handleUpgradeAuth(request, context) {
    if (this._hasQueryCredential(request)) return false;

    const protocols = this._protocolsFromRequest(request);
    const browserCredentials = protocols.filter(protocol => protocol.startsWith(WS_BEARER_PROTOCOL_PREFIX));
    if (browserCredentials.length > 1) return false;
    let browserToken = null;
    if (browserCredentials.length === 1) {
      if (!protocols.includes(WS_PUBLIC_PROTOCOL)) return false;
      browserToken = this._decodeBearerProtocol(browserCredentials[0]);
      if (browserToken === null) return false;
    }
    if (protocols.includes(WS_PUBLIC_PROTOCOL)) {
      request._traecnclawSelectedProtocol = WS_PUBLIC_PROTOCOL;
    }

    const token = this.gateway.token;
    if (!token) {
      context.authenticated = true;
      context.authMethod = 'none';
      return true;
    }

    const credentials = [];
    const authHeaderName = String(this.gateway.authHeader || 'Authorization').toLowerCase();
    const authHeader = request.headers[authHeaderName] || '';
    if (authHeader.startsWith('Bearer ')) {
      credentials.push({ method: 'authorization', value: authHeader.slice(7) });
    }

    const customToken = request.headers['x-traecn-token'];
    if (customToken) {
      credentials.push({ method: 'x-traecn-token', value: customToken });
    }

    if (browserToken !== null) credentials.push({ method: 'subprotocol', value: browserToken });
    if (credentials.length === 0) return false;
    if (credentials.some(credential => credential.value !== credentials[0].value)) return false;

    context.authenticated = secureCompare(credentials[0].value, token);
    context.authMethod = context.authenticated ? credentials[0].method : null;
    return context.authenticated;
  }

  _protocolsFromRequest(request) {
    const raw = request.headers['sec-websocket-protocol'];
    if (typeof raw !== 'string') return [];
    return raw.split(',').map(value => value.trim()).filter(Boolean);
  }

  _decodeBearerProtocol(protocol) {
    const encoded = protocol.slice(WS_BEARER_PROTOCOL_PREFIX.length);
    if (!encoded || encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    try {
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.length === 0 || bytes.toString('base64url') !== encoded) return null;
      const value = bytes.toString('utf8');
      if (!Buffer.from(value, 'utf8').equals(bytes)) return null;
      return value;
    } catch {
      return null;
    }
  }

  _hasQueryCredential(request) {
    let parsed;
    try {
      parsed = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    } catch {
      return true;
    }
    for (const key of parsed.searchParams.keys()) {
      if (/token|authorization|api[_-]?key|secret|password|credential|cookie/i.test(key)) return true;
    }
    return false;
  }

  _selectProtocol(protocols, request) {
    if (
      request._traecnclawSelectedProtocol === WS_PUBLIC_PROTOCOL &&
      protocols.has(WS_PUBLIC_PROTOCOL)
    ) {
      return WS_PUBLIC_PROTOCOL;
    }
    return false;
  }

  _checkOrigin(request) {
    if (this.gateway && typeof this.gateway._checkOrigin === 'function') {
      return this.gateway._checkOrigin(request);
    }
    const origin = request.headers.origin;
    if (!origin) return true;

    const allowed = this.gateway.allowedOrigins.split(',').map(o => o.trim()).filter(Boolean);
    if (!allowed.length) {
      try {
        return new URL(origin).host.toLowerCase() === String(request.headers.host || '').toLowerCase();
      } catch {
        return false;
      }
    }
    return allowed.includes(origin) || allowed.includes('*');
  }

  _checkUpgradeRateLimit(request) {
    const maxClients = Number.isFinite(WS_MAX_CLIENTS) && WS_MAX_CLIENTS > 0 ? WS_MAX_CLIENTS : 100;
    if (this.clients.size >= maxClients) {
      return { allowed: false, reason: 'too_many_clients' };
    }

    const maxUpgrades = Number.isFinite(WS_MAX_UPGRADES_PER_WINDOW) && WS_MAX_UPGRADES_PER_WINDOW > 0
      ? WS_MAX_UPGRADES_PER_WINDOW
      : 60;
    const windowMs = Number.isFinite(WS_RATE_LIMIT_WINDOW_MS) && WS_RATE_LIMIT_WINDOW_MS > 0
      ? WS_RATE_LIMIT_WINDOW_MS
      : 60000;
    const key = request.socket?.remoteAddress || request.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    const recent = (this.upgradeAttempts.get(key) || []).filter(timestamp => now - timestamp < windowMs);
    if (recent.length >= maxUpgrades) {
      this.upgradeAttempts.set(key, recent);
      return { allowed: false, reason: 'rate_limited' };
    }
    recent.push(now);
    this.upgradeAttempts.set(key, recent);
    return { allowed: true };
  }

  /**
   * Periodically reclaim Map entries for IPs whose upgrade-attempt windows
   * have fully expired. Without this, the upgradeAttempts Map grows
   * unbounded over the process lifetime as every IP that ever connected
   * leaves a (possibly empty) array entry.
   */
  _cleanupUpgradeAttempts() {
    const now = Date.now();
    const windowMs = Number.isFinite(WS_RATE_LIMIT_WINDOW_MS) && WS_RATE_LIMIT_WINDOW_MS > 0
      ? WS_RATE_LIMIT_WINDOW_MS
      : 60000;
    for (const [key, timestamps] of this.upgradeAttempts) {
      const recent = timestamps.filter(t => now - t < windowMs);
      if (recent.length === 0) {
        this.upgradeAttempts.delete(key);
      } else if (recent.length !== timestamps.length) {
        this.upgradeAttempts.set(key, recent);
      }
    }
  }

  _handleConnection(ws, req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname === '/ws/events') {
      this._handleGlobalEvents(ws);
    } else if (pathname.startsWith('/ws/tasks/')) {
      const taskId = pathname.split('/').pop();
      this._handleTaskUpdates(ws, taskId);
    } else {
      this._sendJson(ws, { type: 'error', message: 'Unknown endpoint' });
      ws.close(1008, 'Unknown endpoint');
    }
  }

  _handleTaskUpdates(ws, taskId) {
    const task = this.gateway.taskQueue.get(taskId);
    const clientInfo = {
      ws,
      type: 'task',
      taskId,
      subscribed: true
    };

    this.clients.add(clientInfo);

    if (!this.taskSubscriptions.has(taskId)) {
      this.taskSubscriptions.set(taskId, new Set());
    }
    this.taskSubscriptions.get(taskId).add(clientInfo);

    this._sendJson(ws, {
      type: 'subscribed',
      taskId,
      message: `Subscribed to task updates for ${taskId}`
    });

    if (task) {
      this._sendTaskUpdate(taskId, task);
    } else {
      this._sendJson(ws, {
        type: 'taskUpdate',
        taskId,
        status: 'not_found',
        message: 'Task not found in queue'
      });
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this._handleTaskMessage(ws, taskId, msg, clientInfo);
      } catch {
        this._sendJson(ws, { type: 'error', message: 'Invalid JSON message' });
      }
    });

    ws.on('close', () => {
      this._cleanupClient(clientInfo);
    });

    ws.on('error', () => {
      this._cleanupClient(clientInfo);
    });

    // Reset the heartbeat timeout when a WebSocket pong is received —
    // this is the signal that the client is actually alive. Without this,
    // the heartbeat timer is reset on every server-side ping (which the
    // client may never receive), so dead clients are never terminated.
    ws.on('pong', () => {
      this._setHeartbeat(ws);
    });

    this._setHeartbeat(ws);
  }

  _handleTaskMessage(ws, taskId, msg, clientInfo) {
    switch (msg.type) {
      case 'ping':
        this._sendJson(ws, { type: 'pong', timestamp: Date.now() });
        this._setHeartbeat(ws);
        break;
      case 'unsubscribe': {
        clientInfo.subscribed = false;
        const subs = this.taskSubscriptions.get(taskId);
        if (subs) {
          subs.delete(clientInfo);
          if (subs.size === 0) {
            this.taskSubscriptions.delete(taskId);
          }
        }
        this._sendJson(ws, { type: 'unsubscribed', taskId });
        break;
      }
      case 'getStatus': {
        const task = this.gateway.taskQueue.get(taskId);
        if (task) {
          this._sendTaskUpdate(taskId, task);
        } else {
          this._sendJson(ws, {
            type: 'taskUpdate',
            taskId,
            status: 'not_found'
          });
        }
        break;
      }
      default:
        this._sendJson(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  }

  _handleGlobalEvents(ws) {
    const clientInfo = {
      ws,
      type: 'events',
      subscribed: true
    };

    this.clients.add(clientInfo);
    this.globalEventListeners.add(clientInfo);

    this._sendJson(ws, {
      type: 'connected',
      message: 'Connected to global event stream',
      timestamp: Date.now()
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this._handleGlobalMessage(ws, msg, clientInfo);
      } catch {
        this._sendJson(ws, { type: 'error', message: 'Invalid JSON message' });
      }
    });

    ws.on('close', () => {
      this._cleanupClient(clientInfo);
    });

    ws.on('error', () => {
      this._cleanupClient(clientInfo);
    });

    ws.on('pong', () => {
      this._setHeartbeat(ws);
    });

    this._setHeartbeat(ws);
  }

  _handleGlobalMessage(ws, msg, clientInfo) {
    switch (msg.type) {
      case 'ping':
        this._sendJson(ws, { type: 'pong', timestamp: Date.now() });
        this._setHeartbeat(ws);
        break;
      case 'subscribe':
        if (msg.taskId) {
          this._subscribeToTask(clientInfo, msg.taskId);
        }
        break;
      case 'unsubscribe':
        if (msg.taskId) {
          this._unsubscribeFromTask(clientInfo, msg.taskId);
        }
        break;
      default:
        this._sendJson(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  }

  _subscribeToTask(clientInfo, taskId) {
    if (!this.taskSubscriptions.has(taskId)) {
      this.taskSubscriptions.set(taskId, new Set());
    }
    this.taskSubscriptions.get(taskId).add(clientInfo);

    const task = this.gateway.taskQueue.get(taskId);
    if (task) {
      this._sendTaskUpdate(taskId, task);
    }

    this._sendJson(clientInfo.ws, {
      type: 'subscribed',
      taskId,
      message: `Subscribed to task ${taskId}`
    });
  }

  _unsubscribeFromTask(clientInfo, taskId) {
    const subs = this.taskSubscriptions.get(taskId);
    if (subs) {
      subs.delete(clientInfo);
      if (subs.size === 0) {
        this.taskSubscriptions.delete(taskId);
      }
    }
    this._sendJson(clientInfo.ws, {
      type: 'unsubscribed',
      taskId,
      message: `Unsubscribed from task ${taskId}`
    });
  }

  _cleanupClient(clientInfo) {
    this.clients.delete(clientInfo);

    if (clientInfo.type === 'events') {
      this.globalEventListeners.delete(clientInfo);
    }

    if (clientInfo.taskId) {
      const subs = this.taskSubscriptions.get(clientInfo.taskId);
      if (subs) {
        subs.delete(clientInfo);
        if (subs.size === 0) {
          this.taskSubscriptions.delete(clientInfo.taskId);
        }
      }
    }

    this._clearHeartbeat(clientInfo.ws);
  }

  _setHeartbeat(ws) {
    this._clearHeartbeat(ws);
    const timer = setTimeout(() => {
      ws.terminate();
    }, WS_HEARTBEAT_TIMEOUT);
    ws._heartbeatTimer = timer;
  }

  _clearHeartbeat(ws) {
    if (ws._heartbeatTimer) {
      clearTimeout(ws._heartbeatTimer);
      ws._heartbeatTimer = null;
    }
  }

  _startHeartbeat() {
    this._heartbeatInterval = setInterval(() => {
      for (const clientInfo of this.clients) {
        if (clientInfo.ws.readyState === 1) {
          // Ping the client. The heartbeat timeout timer is NOT reset
          // here — it is only reset when we receive a pong (or an
          // application-level ping). If the client is dead and never
          // responds, the existing timer will fire and terminate the
          // connection. Previously this called _setHeartbeat on every
          // ping, which reset the timer before it could ever fire.
          clientInfo.ws.ping();
        }
      }
      // Reclaim expired upgrade-attempt entries to bound Map growth.
      this._cleanupUpgradeAttempts();
    }, WS_HEARTBEAT_INTERVAL);
    if (typeof this._heartbeatInterval.unref === 'function') {
      this._heartbeatInterval.unref();
    }
  }

  _stopHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
    for (const clientInfo of this.clients) {
      this._clearHeartbeat(clientInfo.ws);
    }
  }

  _sendJson(ws, data) {
    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(data));
      } catch {
        // Ignore send failures for sockets closed between readyState and send.
      }
    }
  }

  _sendTaskUpdate(taskId, task) {
    const subs = this.taskSubscriptions.get(taskId);
    if (!subs || subs.size === 0) return;

    const message = {
      type: 'taskUpdate',
      taskId,
      status: task.status,
      progress: this._calculateProgress(task),
      timestamp: Date.now()
    };

    switch (task.status) {
      case 'done':
        message.result = {
          text: task.result?.text || '',
          stable: task.result?.stable || false,
          elapsedMs: task.result?.elapsedMs || null,
          timedOut: task.result?.timedOut || false,
          needsApproval: task.result?.needsApproval || false
        };
        break;
      case 'error':
        message.error = task.error;
        break;
      case 'queued':
        message.queueElapsed = Date.now() - task.createdAt;
        message.deadline = task.deadline;
        message.remaining = Math.max(0, task.deadline - Date.now());
        break;
      case 'awaiting_review':
        message.result = {
          text: task.result?.text || '',
          stable: task.result?.stable || false,
          elapsedMs: task.result?.elapsedMs || null
        };
        message.reviewRequired = true;
        message.followupCount = task.followupTasks?.length || 0;
        break;
      case 'approval_required':
        message.result = {
          text: task.result?.text || '',
          needsApproval: true,
          question: task.result?.question || ''
        };
        break;
    }

    for (const clientInfo of subs) {
      this._sendJson(clientInfo.ws, message);
    }
  }

  _calculateProgress(task) {
    switch (task.status) {
      case 'queued':
        return 0;
      case 'executing':
        return 50;
      case 'approval_required':
        return 75;
      case 'awaiting_review':
        return 90;
      case 'done':
        return 100;
      case 'error':
      case 'cancelled':
      case 'queue_timeout':
      case 'review_rejected':
        return -1;
      default:
        return null;
    }
  }

  broadcastAIResponse(taskId, chunk, done = false) {
    const subs = this.taskSubscriptions.get(taskId);
    if (!subs || subs.size === 0) return;

    const message = {
      type: 'aiResponse',
      taskId,
      chunk,
      done,
      timestamp: Date.now()
    };

    for (const clientInfo of subs) {
      this._sendJson(clientInfo.ws, message);
    }
  }

  broadcastApprovalRequired(taskId, question, dialogType) {
    const message = {
      type: 'approvalRequired',
      taskId,
      question,
      dialogType,
      timestamp: Date.now()
    };

    for (const clientInfo of this.globalEventListeners) {
      this._sendJson(clientInfo.ws, message);
    }

    const taskSubs = this.taskSubscriptions.get(taskId);
    if (taskSubs) {
      for (const clientInfo of taskSubs) {
        this._sendJson(clientInfo.ws, message);
      }
    }
  }

  notifyTaskStatusChange(taskId, task) {
    this._sendTaskUpdate(taskId, task);

    const globalMessage = {
      type: 'taskStatusChanged',
      taskId,
      status: task.status,
      timestamp: Date.now()
    };

    for (const clientInfo of this.globalEventListeners) {
      this._sendJson(clientInfo.ws, globalMessage);
    }
  }

  broadcastEvent(eventType, data) {
    const message = {
      type: 'event',
      eventType,
      data,
      timestamp: Date.now()
    };

    for (const clientInfo of this.globalEventListeners) {
      this._sendJson(clientInfo.ws, message);
    }
  }

  close() {
    this._stopHeartbeat();

    for (const clientInfo of this.clients) {
      try {
        clientInfo.ws.close(1001, 'Server shutting down');
      } catch {
        // Ignore sockets already closed by the peer.
      }
    }

    this.clients.clear();
    this.taskSubscriptions.clear();
    this.globalEventListeners.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }
}

module.exports = {
  WebSocketHandler,
  WS_MAX_PAYLOAD_BYTES,
  WS_HEARTBEAT_INTERVAL,
  WS_HEARTBEAT_TIMEOUT,
  WS_PUBLIC_PROTOCOL,
  WS_BEARER_PROTOCOL_PREFIX,
  WS_MAX_CLIENTS,
  WS_RATE_LIMIT_WINDOW_MS,
  WS_MAX_UPGRADES_PER_WINDOW
};
