'use strict';

const http = require('http');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8788;
const DEFAULT_TIMEOUT = 120000;

class TraeCNApiClient {
  constructor(options = {}) {
    this.host = options.host || DEFAULT_HOST;
    this.port = options.port || DEFAULT_PORT;
    this.token = options.token || '';
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
  }

  _request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      };
      if (this.token) {
        headers['Authorization'] = `Bearer ${this.token}`;
      }
      if (data) {
        headers['Content-Length'] = Buffer.byteLength(data);
      }

      const req = http.request({
        hostname: this.host,
        port: this.port,
        path,
        method,
        headers,
        timeout: this.timeout
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve({ status: res.statusCode, data: parsed });
          } catch(e) {
            resolve({ status: res.statusCode, data: body });
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      if (data) req.write(data);
      req.end();
    });
  }

  async getStatus(allowAutoStart = false) {
    return this._request('GET', `/api/status?allowAutoStart=${allowAutoStart}`);
  }

  async newChat(allowAutoStart = false) {
    return this._request('POST', '/api/new-chat', { allowAutoStart });
  }

  async delegate(task, options = {}) {
    const body = { task };
    if (options.projectPath) body.projectPath = options.projectPath;
    if (options.sessionId) body.sessionId = options.sessionId;
    if (options.allowAutoStart) body.allowAutoStart = true;
    if (options.includeProcessText) body.includeProcessText = true;
    return this._request('POST', '/api/delegate', body);
  }

  async delegateAsync(task, options = {}) {
    const body = { task };
    if (options.chatId) body.chatId = options.chatId;
    return this._request('POST', '/api/delegate-async', body);
  }

  async switchMode(mode, allowAutoStart = false) {
    return this._request('POST', '/api/switch-mode', { mode, allowAutoStart });
  }

  async switchModel(model) {
    return this._request('POST', '/api/switch-model', { model });
  }

  async checkQueueStatus() {
    return this._request('GET', '/api/queue-status');
  }

  async openProject(projectPath) {
    return this._request('POST', '/api/open-project', { projectPath });
  }

  async settingsRead(section = null) {
    const path = section ? `/api/settings?section=${encodeURIComponent(section)}` : '/api/settings';
    return this._request('GET', path);
  }

  async settingsWrite(section, data) {
    return this._request('POST', '/api/settings', { section, ...data });
  }

  async updateSelf(force = false) {
    return this._request('POST', '/api/update-self', { force });
  }

  async healthCheck() {
    try {
      const result = await this._request('GET', '/api/status');
      return result.status === 200;
    } catch(e) {
      return false;
    }
  }
}

module.exports = { TraeCNApiClient, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_TIMEOUT };
