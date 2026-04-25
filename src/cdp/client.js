'use strict';

const { WebSocket } = require('ws');

/**
 * Simple page-level CDP client.
 * Connects directly to a page's WebSocket URL (e.g. ws://host:port/devtools/page/<id>).
 * All commands are sent to that single page.
 */
class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this._ws = null;
    this._msgId = 0;
    this._pending = new Map();
    this._eventHandlers = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(this.wsUrl);
      this._ws.on('open', resolve);
      this._ws.on('message', (data) => this._handleMessage(JSON.parse(data.toString())));
      this._ws.on('error', reject);
      this._ws.on('close', () => {
        for (const [id, { reject }] of this._pending) reject(new Error('WebSocket closed'));
        this._pending.clear();
      });
    });
  }

  _handleMessage(msg) {
    if (msg.id !== undefined && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      try {
        if (msg.error) reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      } catch(e) { /* resolve/reject already called */ }
      return;
    }
    if (msg.method) {
      const handlers = this._eventHandlers.get(msg.method) || [];
      for (const h of handlers) {
        try { h(msg.params || {}); } catch(e) { /* ignore */ }
      }
    }
  }

  send(method, params = {}) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) throw new Error('CDP client not connected');
    const id = ++this._msgId;
    this._ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this._pending.has(id)) { this._pending.delete(id); reject(new Error(`CDP method ${method} timed out`)); }
      }, 30000);
    });
  }

  on(event, handler) {
    if (!this._eventHandlers.has(event)) this._eventHandlers.set(event, []);
    this._eventHandlers.get(event).push(handler);
  }

  off(event, handler) {
    const h = this._eventHandlers.get(event); if (h) { const i = h.indexOf(handler); if (i !== -1) h.splice(i, 1); }
  }

  async close() {
    if (this._ws) { this._ws.close(); this._ws = null; }
  }

  get isConnected() { return this._ws && this._ws.readyState === WebSocket.OPEN; }
}

/**
 * A CDP session attached to a specific target (frame).
 * All sessions share the parent CDPClient's shared browser-level WebSocket connection.
 * Commands are routed to the correct frame via the sessionId.
 */
class CDPSession {
  constructor(parent, sessionId, targetId) {
    this._parent = parent;
    this._sessionId = sessionId;
    this._targetId = targetId;
    this._msgId = 0;
    this._pending = new Map();
    this._eventHandlers = new Map();
  }

  /** Send a CDP command targeting this frame. */
  send(method, params = {}) {
    const id = ++this._msgId;
    const message = JSON.stringify({ id, method, params, sessionId: this._sessionId });

    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._parent._ws.send(message);

      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`CDP session method ${method} timed out`));
        }
      }, 30000);
    });
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

  _handleMessage(msg) {
    if (msg.id !== undefined && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      const handlers = this._eventHandlers.get(msg.method);
      if (handlers) {
        for (const handler of handlers) {
          handler(msg.params || {});
        }
      }
    }
  }
}

/**
 * Browser-level CDP client.
 * Connects to the Chrome DevTools browser endpoint (not a specific page).
 * Supports multiple simultaneous frame sessions via attachToTarget().
 *
 * Usage:
 *   const browserClient = new BrowserCDPClient('ws://127.0.0.1:9333/devtools/browser/<id>');
 *   await browserClient.connect();
 *   const targets = await browserClient.send('Target.getTargets', {});
 *   const session = await browserClient.attachToTarget(targetId);
 *   // Use session.send() to talk to that specific frame
 */
class BrowserCDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this._ws = null;
    this._msgId = 0;
    this._pending = new Map();
    this._sessions = new Map();  // sessionId → CDPSession
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(this.wsUrl);

      this._ws.on('open', () => {
        resolve();
      });

      this._ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        this._handleMessage(msg);
      });

      this._ws.on('error', (err) => {
        reject(err);
      });

      this._ws.on('close', () => {
        for (const [sessionId, session] of this._sessions) {
          for (const [id, { reject: rej }] of session._pending) {
            rej(new Error('WebSocket closed'));
          }
          session._pending.clear();
        }
        this._sessions.clear();
      });
    });
  }

  _handleMessage(msg) {
    // Route to the correct session based on sessionId
    if (msg.sessionId && this._sessions.has(msg.sessionId)) {
      this._sessions.get(msg.sessionId)._handleMessage(msg);
      return;
    }
    // Browser-level response (no sessionId)
    if (msg.id !== undefined && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        resolve(msg.result);
      }
    }
  }

  /** Attach to a target and return a CDPSession for that frame. */
  async attachToTarget(targetId, flatten = true) {
    const result = await this.send('Target.attachToTarget', { targetId, flatten });
    const sessionId = result.sessionId;
    const session = new CDPSession(this, sessionId, targetId);
    this._sessions.set(sessionId, session);
    return session;
  }

  /** Close the browser-level connection and all sessions. */
  async close() {
    for (const [, session] of this._sessions) {
      try {
        await session.send('Target.closeTarget', { targetId: session._targetId });
      } catch { /* ignore */ }
    }
    this._sessions.clear();
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  /** Send a browser-level CDP command (no session). */
  send(method, params = {}) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      throw new Error('CDP browser client is not connected');
    }
    const id = ++this._msgId;
    const message = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._ws.send(message);

      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`CDP browser method ${method} timed out`));
        }
      }, 30000);
    });
  }

  get isConnected() {
    return this._ws && this._ws.readyState === WebSocket.OPEN;
  }
}

module.exports = { CDPClient, BrowserCDPClient, CDPSession };
