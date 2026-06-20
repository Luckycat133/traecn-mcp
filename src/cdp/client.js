'use strict';

const ws = require('ws');
const { TraeCNAutomationError } = require('./errors');

// 共享常量
const DEFAULT_TIMEOUT = 30000;
const WS_OPEN_STATE = ws.WebSocket ? ws.WebSocket.OPEN : 1;
// Reconnection defaults — overridable per-instance.
const DEFAULT_RECONNECT = {
  enabled: false,
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 5000
};

// Test seam: lets unit tests inject a fake WebSocket. Production code reads
// `WebSocket` lazily through this indirection so swapping it after the module
// is loaded is sufficient.
let WebSocketCtor = null;
function getWebSocket() {
  return WebSocketCtor || ws.WebSocket;
}
function __setWebSocketForTesting(ctorOrNull) {
  WebSocketCtor = ctorOrNull;
}

/**
 * 基础 CDP 客户端功能，包含共享逻辑
 */
class BaseCDPClient {
  constructor() {
    this._msgId = 0;
    this._pending = new Map();
    this._eventHandlers = new Map();
  }
  /**
   * 发送 CDP 命令
   * @param {Function} sendFn 发送函数
   * @param {string} method CDP 方法名
   * @param {object} params 参数对象
   * @param {number} timeout 超时时间（毫秒）
   * @returns {Promise<any>}
   */
  _sendCommand(sendFn, method, params = {}, timeout = DEFAULT_TIMEOUT) {
    const id = ++this._msgId;
    const message = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      sendFn(message);

      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(TraeCNAutomationError.cdpTimeout(method, this._defaultTimeout));
        }
      }, timeout);
    });
  }

  /**
   * 处理响应消息
   * @param {object} msg 消息对象
   */
  _handleResponse(msg) {
    if (msg.id === undefined || !this._pending.has(msg.id)) return false;

    const { resolve, reject } = this._pending.get(msg.id);
    this._pending.delete(msg.id);

    try {
      if (msg.error) {
        // CDP-level RPC errors map to SEND_FAILED (502). The upstream code+message
        // are preserved so callers can inspect msg.error.code if they need to.
        reject(TraeCNAutomationError.sendFailed(`${msg.error.code}: ${msg.error.message}`));
      } else {
        resolve(msg.result);
      }
    } catch { /* 处理已完成，忽略重复调用 */ }

    return true;
  }

  /**
   * 处理事件消息
   * @param {object} msg 消息对象
   */
  _handleEvent(msg) {
    if (!msg.method) return;

    const handlers = this._eventHandlers.get(msg.method) || [];
    for (const h of handlers) {
      try { h(msg.params || {}); } catch { /* 忽略处理错误 */ }
    }
  }

  /**
   * 清除所有等待的请求
   */
  _clearPending(reason = 'WebSocket closed') {
    for (const [, { reject }] of this._pending) {
      reject(TraeCNAutomationError.cdpDisconnected(reason));
    }
    this._pending.clear();
  }

  on(event, handler) {
    if (!this._eventHandlers.has(event)) {
      this._eventHandlers.set(event, []);
    }
    this._eventHandlers.get(event).push(handler);
  }

  off(event, handler) {
    const handlers = this._eventHandlers.get(event);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx !== -1) handlers.splice(idx, 1);
    }
  }
}

/**
 * Simple page-level CDP client.
 * Connects directly to a page's WebSocket URL.
 */
class CDPClient extends BaseCDPClient {
  constructor(wsUrl, options = {}) {
    super();
    this.wsUrl = wsUrl;
    this._ws = null;
    this._closing = false;
    this._reconnecting = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._reconnect = {
      ...DEFAULT_RECONNECT,
      ...(options.reconnect || {})
    };
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const onOpen = () => {
        this._ws.removeListener('error', onError);
        this._ws.removeListener('close', onClose);
        this._reconnectAttempts = 0;
        this._emit('connect', { wsUrl: this.wsUrl });
        resolve();
      };
      const onError = (err) => {
        this._ws.removeListener('open', onOpen);
        this._ws.removeListener('close', onClose);
        reject(err);
      };
      const onClose = () => {
        this._ws.removeListener('open', onOpen);
        this._ws.removeListener('error', onError);
        reject(TraeCNAutomationError.cdpDisconnected('websocket closed before open'));
      };

      this._ws = new (getWebSocket())(this.wsUrl);
      this._ws.once('open', onOpen);
      this._ws.once('error', onError);
      this._ws.once('close', onClose);
      this._ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (!this._handleResponse(msg)) {
          this._handleEvent(msg);
        }
      });
      this._ws.on('close', (code, reason) => this._onClose(code, reason));
      this._ws.on('error', (err) => this._emit('error', err));
    });
  }

  _onClose(code, reason) {
    this._clearPending(`WebSocket closed (${code})`);
    this._emit('disconnect', { code, reason: reason && reason.toString() });
    if (this._closing) return;
    if (!this._reconnect.enabled) return;
    if (this._reconnecting) return;
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._reconnectAttempts >= this._reconnect.maxAttempts) {
      this._emit('reconnect-failed', { attempts: this._reconnectAttempts });
      return;
    }
    this._reconnectAttempts += 1;
    const attempt = this._reconnectAttempts;
    // Exponential backoff with cap.
    const delay = Math.min(
      this._reconnect.baseDelayMs * Math.pow(2, attempt - 1),
      this._reconnect.maxDelayMs
    );
    this._emit('reconnect-attempt', { attempt, delayMs: delay });
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      this._reconnecting = true;
      try {
        this._ws = null;
        await this.connect();
        this._emit('reconnect-success', { attempt });
      } catch (err) {
        this._emit('reconnect-error', { attempt, error: err });
        this._reconnecting = false;
        this._scheduleReconnect();
      } finally {
        this._reconnecting = false;
      }
    }, delay);
  }

  send(method, params = {}) {
    if (!this.isConnected) {
      throw TraeCNAutomationError.cdpNotConnected();
    }
    return this._sendCommand(
      (msg) => this._ws.send(msg),
      method,
      params
    );
  }

  async close() {
    this._closing = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      try {
        this._ws.close();
      } catch { /* ignore */ }
      this._ws = null;
    }
  }

  get isConnected() {
    return !!(this._ws && this._ws.readyState === WS_OPEN_STATE);
  }

  _emit(event, data) {
    const handlers = this._eventHandlers.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      try { h(data); } catch { /* ignore handler errors */ }
    }
  }
}

/**
 * A CDP session attached to a specific target.
 */
class CDPSession extends BaseCDPClient {
  constructor(parent, sessionId, targetId) {
    super();
    this._parent = parent;
    this._sessionId = sessionId;
    this._targetId = targetId;
  }

  send(method, params = {}) {
    return this._sendCommand(
      (msg) => {
        const fullMsg = JSON.parse(msg);
        fullMsg.sessionId = this._sessionId;
        this._parent._ws.send(JSON.stringify(fullMsg));
      },
      method,
      params
    );
  }

  _handleMessage(msg) {
    if (!this._handleResponse(msg)) {
      this._handleEvent(msg);
    }
  }
}

/**
 * Browser-level CDP client.
 */
class BrowserCDPClient extends BaseCDPClient {
  constructor(wsUrl, options = {}) {
    super();
    this.wsUrl = wsUrl;
    this._ws = null;
    this._sessions = new Map();
    this._closing = false;
    this._reconnecting = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._reconnect = {
      ...DEFAULT_RECONNECT,
      ...(options.reconnect || {})
    };
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const onOpen = () => {
        this._ws.removeListener('error', onError);
        this._ws.removeListener('close', onClose);
        this._reconnectAttempts = 0;
        this._emit('connect', { wsUrl: this.wsUrl });
        resolve();
      };
      const onError = (err) => {
        this._ws.removeListener('open', onOpen);
        this._ws.removeListener('close', onClose);
        reject(err);
      };
      const onClose = () => {
        this._ws.removeListener('open', onOpen);
        this._ws.removeListener('error', onError);
        reject(TraeCNAutomationError.cdpDisconnected('websocket closed before open'));
      };

      this._ws = new (getWebSocket())(this.wsUrl);
      this._ws.once('open', onOpen);
      this._ws.once('error', onError);
      this._ws.once('close', onClose);
      this._ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.sessionId && this._sessions.has(msg.sessionId)) {
          this._sessions.get(msg.sessionId)._handleMessage(msg);
          return;
        }
        if (!this._handleResponse(msg)) {
          this._handleEvent(msg);
        }
      });
      this._ws.on('close', (code, reason) => this._onClose(code, reason));
      this._ws.on('error', (err) => this._emit('error', err));
    });
  }

  _onClose(code, reason) {
    for (const [, session] of this._sessions) {
      session._clearPending(`Browser WebSocket closed (${code})`);
    }
    this._sessions.clear();
    this._clearPending(`Browser WebSocket closed (${code})`);
    this._emit('disconnect', { code, reason: reason && reason.toString() });
    if (this._closing) return;
    if (!this._reconnect.enabled) return;
    if (this._reconnecting) return;
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._reconnectAttempts >= this._reconnect.maxAttempts) {
      this._emit('reconnect-failed', { attempts: this._reconnectAttempts });
      return;
    }
    this._reconnectAttempts += 1;
    const attempt = this._reconnectAttempts;
    const delay = Math.min(
      this._reconnect.baseDelayMs * Math.pow(2, attempt - 1),
      this._reconnect.maxDelayMs
    );
    this._emit('reconnect-attempt', { attempt, delayMs: delay });
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      this._reconnecting = true;
      try {
        this._ws = null;
        await this.connect();
        this._emit('reconnect-success', { attempt });
      } catch (err) {
        this._emit('reconnect-error', { attempt, error: err });
        this._reconnecting = false;
        this._scheduleReconnect();
      } finally {
        this._reconnecting = false;
      }
    }, delay);
  }

  async attachToTarget(targetId, flatten = true) {
    const result = await this.send('Target.attachToTarget', { targetId, flatten });
    const session = new CDPSession(this, result.sessionId, targetId);
    this._sessions.set(result.sessionId, session);
    return session;
  }

  async close() {
    this._closing = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    for (const [, session] of this._sessions) {
      try {
        await session.send('Target.closeTarget', { targetId: session._targetId });
      } catch { /* 忽略关闭错误 */ }
    }
    this._sessions.clear();
    if (this._ws) {
      try {
        this._ws.close();
      } catch { /* ignore */ }
      this._ws = null;
    }
  }

  send(method, params = {}) {
    if (!this.isConnected) {
      throw TraeCNAutomationError.cdpNotConnected();
    }
    return this._sendCommand(
      (msg) => this._ws.send(msg),
      method,
      params
    );
  }

  get isConnected() {
    return !!(this._ws && this._ws.readyState === WS_OPEN_STATE);
  }

  _emit(event, data) {
    const handlers = this._eventHandlers.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      try { h(data); } catch { /* ignore handler errors */ }
    }
  }
}

module.exports = { CDPClient, BrowserCDPClient, CDPSession, DEFAULT_RECONNECT, __setWebSocketForTesting };
