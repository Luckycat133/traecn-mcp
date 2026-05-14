'use strict';

const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const WS_HEARTBEAT_INTERVAL = 30000;
const WS_HEARTBEAT_TIMEOUT = 60000;

class WebSocketHandler {
  constructor(gateway) {
    this.gateway = gateway;
    this.wss = null;
    this.taskSubscriptions = new Map();
    this.globalEventListeners = new Set();
    this.heartbeatTimers = new Map();
    this.clients = new Set();
  }

  initialize(server) {
    this.wss = new WebSocketServer({
      noServer: true,
      path: '/ws'
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
    const token = this.gateway.token;
    if (!token) {
      context.authenticated = true;
      return true;
    }

    const authHeader = request.headers[this.gateway.authHeader.toLowerCase()] || '';
    if (authHeader.startsWith('Bearer ')) {
      context.authenticated = this._secureCompare(authHeader.slice(7), token);
      return context.authenticated;
    }

    const customToken = request.headers['x-traecn-token'];
    if (customToken) {
      context.authenticated = this._secureCompare(customToken, token);
      return context.authenticated;
    }

    return false;
  }

  _checkOrigin(request) {
    if (!this.gateway.allowedOrigins) return true;
    const origin = request.headers.origin;
    if (!origin) return true;

    const allowed = this.gateway.allowedOrigins.split(',').map(o => o.trim()).filter(Boolean);
    return allowed.includes(origin) || allowed.includes('*');
  }

  _secureCompare(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
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

    this._setHeartbeat(ws);
  }

  _handleTaskMessage(ws, taskId, msg, clientInfo) {
    switch (msg.type) {
      case 'ping':
        this._sendJson(ws, { type: 'pong', timestamp: Date.now() });
        this._setHeartbeat(ws);
        break;
      case 'unsubscribe':
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
      case 'getStatus':
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
          clientInfo.ws.ping();
          this._setHeartbeat(clientInfo.ws);
        }
      }
    }, WS_HEARTBEAT_INTERVAL);
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
          text: task.result.text,
          stable: task.result.stable,
          elapsedMs: task.result.elapsedMs,
          timedOut: task.result.timedOut || false,
          needsApproval: task.result.needsApproval || false
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
      case 'done':
        return 100;
      case 'error':
      case 'cancelled':
      case 'queue_timeout':
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

module.exports = { WebSocketHandler };
