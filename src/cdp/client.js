'use strict';

const ws = require('ws');

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
      // Store the timer alongside resolve/reject so _handleResponse can
      // clear it. Without this, every request leaks a live timer object
      // until its timeout fires, even though the response arrived.
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`CDP method ${method} timed out`));
        }
      }, timeout);
      this._pending.set(id, { resolve, reject, timer });
      sendFn(message);
    });
  }

  /**
   * 处理响应消息
   * @param {object} msg 消息对象
   */
  _handleResponse(msg) {
    if (msg.id === undefined || !this._pending.has(msg.id)) return false;

    const { resolve, reject, timer } = this._pending.get(msg.id);
    this._pending.delete(msg.id);
    if (timer) clearTimeout(timer);

    try {
      if (msg.error) {
        reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
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
    for (const [, { reject, timer }] of this._pending) {
      if (timer) clearTimeout(timer);
      reject(new Error(reason));
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
 * ReconnectingCDPClient — adds WebSocket lifecycle management (connect,
 * message dispatch, close, exponential-backoff reconnect) on top of
 * BaseCDPClient. Subclasses can override `_onMessage(msg)` to customize
 * message routing and `_beforeClose()` to release sub-resources before
 * the underlying socket is torn down.
 */
class ReconnectingCDPClient extends BaseCDPClient {
  /**
   * @param {string} wsUrl - WebSocket URL of the CDP endpoint.
   * @param {object} [options={}] - Optional configuration.
   * @param {object} [options.reconnect] - Reconnect settings (enabled,
   *   maxAttempts, baseDelayMs, maxDelayMs). Defaults to disabled.
   */
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

  /**
   * Establish the WebSocket connection. Resolves once the socket is open.
   * Rejects on error or if the socket closes before opening.
   *
   * @returns {Promise<void>}
   */
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
        reject(new Error('CDP websocket closed before open'));
      };

      this._ws = new (getWebSocket())(this.wsUrl);
      this._ws.once('open', onOpen);
      this._ws.once('error', onError);
      this._ws.once('close', onClose);
      this._ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch (err) {
          this._emit('error', new Error(`CDP malformed message: ${err.message}`));
          return;
        }
        this._onMessage(msg);
      });
      this._ws.on('close', (code, reason) => this._onClose(code, reason));
      this._ws.on('error', (err) => this._emit('error', err));
    });
  }

  /**
   * Dispatch an incoming CDP message. Default implementation routes
   * responses to pending requests and everything else to event handlers.
   * Override in subclasses to add custom routing (e.g. session dispatch).
   *
   * @param {object} msg - Parsed CDP message.
   */
  _onMessage(msg) {
    if (!this._handleResponse(msg)) {
      this._handleEvent(msg);
    }
  }

  /**
   * Handle WebSocket close. Clears pending requests, emits disconnect,
   * and schedules a reconnect if enabled.
   *
   * @param {number} code - Close code.
   * @param {Buffer} [reason] - Close reason.
   */
  _onClose(code, reason) {
    this._clearPending(`WebSocket closed (${code})`);
    this._emit('disconnect', { code, reason: reason && reason.toString() });
    if (this._closing) return;
    if (!this._reconnect.enabled) return;
    if (this._reconnecting) return;
    this._scheduleReconnect();
  }

  /**
   * Schedule a reconnect attempt with exponential backoff.
   * Emits `reconnect-attempt` before each try, `reconnect-success` on
   * success, `reconnect-error` on failure, and `reconnect-failed` when
   * max attempts are exhausted.
   */
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
    // Don't keep the process alive solely for a reconnect attempt.
    if (typeof this._reconnectTimer.unref === 'function') {
      this._reconnectTimer.unref();
    }
  }

  /**
   * Send a CDP command over the WebSocket.
   *
   * @param {string} method - CDP method name.
   * @param {object} [params={}] - CDP parameters.
   * @returns {Promise<*>} Resolves with the CDP result.
   * @throws {Error} If the client is not connected.
   */
  send(method, params = {}) {
    if (!this.isConnected) {
      throw new Error('CDP client not connected');
    }
    return this._sendCommand(
      (msg) => this._ws.send(msg),
      method,
      params
    );
  }

  /**
   * Close the WebSocket and release resources. Subclasses should override
   * `_beforeClose()` to release any sub-resources (e.g. sessions) before
   * the socket is torn down.
   *
   * @returns {Promise<void>}
   */
  async close() {
    this._closing = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    await this._beforeClose();
    if (this._ws) {
      try {
        this._ws.close();
      } catch { /* ignore */ }
      this._ws = null;
    }
  }

  /**
   * Hook for subclasses to release sub-resources before the WebSocket is
   * closed. Default implementation is a no-op.
   *
   * @returns {Promise<void>}
   */
  async _beforeClose() {
    // no-op; override in subclasses
  }

  /**
   * @returns {boolean} True if the WebSocket is in the OPEN state.
   */
  get isConnected() {
    return !!(this._ws && this._ws.readyState === WS_OPEN_STATE);
  }

  /**
   * Emit an event to all registered handlers for that event.
   *
   * @param {string} event - Event name.
   * @param {*} data - Event payload.
   */
  _emit(event, data) {
    const handlers = this._eventHandlers.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      try { h(data); } catch { /* ignore handler errors */ }
    }
  }
}

/**
 * Simple page-level CDP client.
 * Connects directly to a page's WebSocket URL.
 */
class CDPClient extends ReconnectingCDPClient {
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
    // Note: _sendCommand serializes {id, method, params} to a string, then
    // we parse it back to inject sessionId and re-serialize. This round-trip
    // is a minor inefficiency but keeps the BaseCDPClient._sendCommand API
    // simple (it owns the id counter and pending map).
    return this._sendCommand(
      (msg) => {
        const payload = JSON.parse(msg);
        payload.sessionId = this._sessionId;
        this._parent._ws.send(JSON.stringify(payload));
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
 * Browser-level CDP client. Manages a browser-level WebSocket and zero or
 * more `CDPSession` instances attached to individual targets.
 */
class BrowserCDPClient extends ReconnectingCDPClient {
  constructor(wsUrl, options = {}) {
    super(wsUrl, options);
    this._sessions = new Map();
  }

  /**
   * Route incoming messages to the owning session (if the message carries
   * a sessionId) or fall back to the default response/event dispatch.
   *
   * @param {object} msg - Parsed CDP message.
   */
  _onMessage(msg) {
    if (msg.sessionId && this._sessions.has(msg.sessionId)) {
      this._sessions.get(msg.sessionId)._handleMessage(msg);
      return;
    }
    if (!this._handleResponse(msg)) {
      this._handleEvent(msg);
    }
  }

  /**
   * On WebSocket close, also reject all pending requests in child sessions
   * and clear the session map.
   *
   * @param {number} code - Close code.
   * @param {Buffer} [reason] - Close reason.
   */
  _onClose(code, reason) {
    for (const [, session] of this._sessions) {
      session._clearPending(`Browser WebSocket closed (${code})`);
    }
    this._sessions.clear();
    super._onClose(code, reason);
  }

  /**
   * Before closing the WebSocket, attempt to close each attached target.
   *
   * @returns {Promise<void>}
   */
  async _beforeClose() {
    for (const [, session] of this._sessions) {
      try {
        await session.send('Target.closeTarget', { targetId: session._targetId });
      } catch { /* 忽略关闭错误 */ }
    }
    this._sessions.clear();
  }

  /**
   * Attach to a browser target and return a `CDPSession` for it.
   *
   * @param {string} targetId - The target id to attach to.
   * @param {boolean} [flatten=true] - Whether to use the flattened protocol.
   * @returns {Promise<CDPSession>}
   */
  async attachToTarget(targetId, flatten = true) {
    const result = await this.send('Target.attachToTarget', { targetId, flatten });
    const session = new CDPSession(this, result.sessionId, targetId);
    this._sessions.set(result.sessionId, session);
    return session;
  }
}

module.exports = { CDPClient, BrowserCDPClient, CDPSession, BaseCDPClient, ReconnectingCDPClient, DEFAULT_RECONNECT, __setWebSocketForTesting };
