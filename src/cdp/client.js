'use strict';

const { WebSocket } = require('ws');

// 共享常量
const DEFAULT_TIMEOUT = 30000;

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
          reject(new Error(`CDP method ${method} timed out`));
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
    for (const [, { reject }] of this._pending) {
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
 * Simple page-level CDP client.
 * Connects directly to a page's WebSocket URL.
 */
class CDPClient extends BaseCDPClient {
  constructor(wsUrl) {
    super();
    this.wsUrl = wsUrl;
    this._ws = null;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(this.wsUrl);

      this._ws.on('open', resolve);
      this._ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (!this._handleResponse(msg)) {
          this._handleEvent(msg);
        }
      });
      this._ws.on('error', reject);
      this._ws.on('close', () => this._clearPending());
    });
  }

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

  async close() {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  get isConnected() {
    return this._ws && this._ws.readyState === WebSocket.OPEN;
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
  constructor(wsUrl) {
    super();
    this.wsUrl = wsUrl;
    this._ws = null;
    this._sessions = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(this.wsUrl);

      this._ws.on('open', resolve);
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
      this._ws.on('error', reject);
      this._ws.on('close', () => {
        for (const [, session] of this._sessions) {
          session._clearPending();
        }
        this._sessions.clear();
        this._clearPending();
      });
    });
  }

  async attachToTarget(targetId, flatten = true) {
    const result = await this.send('Target.attachToTarget', { targetId, flatten });
    const session = new CDPSession(this, result.sessionId, targetId);
    this._sessions.set(result.sessionId, session);
    return session;
  }

  async close() {
    for (const [, session] of this._sessions) {
      try {
        await session.send('Target.closeTarget', { targetId: session._targetId });
      } catch { /* 忽略关闭错误 */ }
    }
    this._sessions.clear();
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  send(method, params = {}) {
    if (!this.isConnected) {
      throw new Error('CDP browser client is not connected');
    }
    return this._sendCommand(
      (msg) => this._ws.send(msg),
      method,
      params
    );
  }

  get isConnected() {
    return this._ws && this._ws.readyState === WebSocket.OPEN;
  }
}

module.exports = { CDPClient, BrowserCDPClient, CDPSession };
