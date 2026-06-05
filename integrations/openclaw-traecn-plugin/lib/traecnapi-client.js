'use strict';

const http = require('http');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8788;
const DEFAULT_TIMEOUT = 120000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

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
        let responseBody = '';
        let responseBytes = 0;
        res.on('data', chunk => {
          responseBytes += chunk.length;
          if (responseBytes > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('Response body too large'));
            return;
          }
          responseBody += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseBody);
            resolve({ status: res.statusCode, data: parsed });
          } catch(e) {
            resolve({ status: res.statusCode, data: responseBody });
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

  async getCapabilities() {
    return this._request('GET', '/api/capabilities');
  }

  async createConfirmationPlan(command, params = {}, options = {}) {
    return this._request('POST', '/api/confirm/plan', {
      command,
      params,
      forceConfirm: options.forceConfirm === true
    });
  }

  async preflight(options = {}) {
    const body = {};
    if (options.command) body.command = options.command;
    if (options.params) body.params = options.params;
    if (options.forceConfirm === true) body.forceConfirm = true;
    return this._request('POST', '/api/preflight', body);
  }

  async getReadiness() {
    return this._request('GET', '/api/readiness');
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
    if (options.waitForQueue !== undefined) body.waitForQueue = options.waitForQueue;
    // gateway wraps result in { status: 'done', text, ... };
    // unwrap the HTTP envelope for clean access by the caller
    const response = await this._request('POST', '/api/delegate', body);
    return response.data || response;
  }

  async delegateAsync(task, options = {}) {
    const body = { task };
    if (options.chatId) body.chatId = options.chatId;
    if (options.includeProcessText) body.includeProcessText = true;
    if (options.waitForQueue !== undefined) body.waitForQueue = options.waitForQueue;
    return this._request('POST', '/api/delegate-async', body);
  }

  async getTaskStatus(taskId) {
    return this._request('GET', '/api/task/' + encodeURIComponent(taskId));
  }

  async cancelTask(taskId) {
    return this._request('POST', '/api/task/' + encodeURIComponent(taskId) + '/cancel');
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
    const path = section ? `/api/settings/read?section=${encodeURIComponent(section)}` : '/api/settings/read';
    return this._request('GET', path);
  }

  async settingsReadAll() {
    return this._request('GET', '/api/settings/read-all');
  }

  async settingsWrite(section, data, options = {}) {
    return this._request('POST', '/api/settings/set', {
      section,
      ...data,
      confirmationId: options.confirmationId,
      requireConfirmation: options.requireConfirmation === true
    });
  }

  async settingsAction(action, params = {}) {
    switch (action) {
      case 'navigate':
      case 'clickTab':
        return this.settingsSwitchTab(params.section || params.text);
      case 'read':
        return this.settingsRead(params.section || null);
      case 'readAll':
      case 'readTables':
        return this.settingsReadAll();
      case 'type':
      case 'toggle':
      case 'dropdown':
      case 'set': {
        const value = params.value !== undefined ? params.value : (params.enabled !== undefined ? params.enabled : params.text);
        return this.settingsWrite(params.section || null, { label: params.label, value });
      }
      case 'back':
        return this.settingsBackToChat();
      default:
        return { status: 400, data: { error: `Unsupported settings action: ${action}` } };
    }
  }

  async settingsSwitchTab(section) {
    return this._request('POST', '/api/settings/switch-tab', { section });
  }

  async settingsBackToChat() {
    return this._request('POST', '/api/settings/back-to-chat', {});
  }

  async submitBatch(tasks, options = {}) {
    const body = { tasks };
    if (options.strategy) body.strategy = options.strategy;
    if (options.maxConcurrency !== undefined) body.maxConcurrency = options.maxConcurrency;
    if (options.onComplete) body.onComplete = options.onComplete;
    return this._request('POST', '/api/tasks/batch', body);
  }

  async getBatchStatus(batchId) {
    return this._request('GET', '/api/tasks/batch/' + encodeURIComponent(batchId));
  }

  async cancelBatch(batchId) {
    return this._request('DELETE', '/api/tasks/batch/' + encodeURIComponent(batchId));
  }

  async updateSelf(force = false) {
    return this._request('POST', '/api/update-self', { force });
  }

  async approveDialog(action = 'auto', options = {}) {
    return this._request('POST', '/api/dialog/approve', {
      action,
      confirmationId: options.confirmationId,
      requireConfirmation: options.requireConfirmation === true
    });
  }

  async dismissDialog(options = {}) {
    return this._request('POST', '/api/dialog/dismiss', {
      confirmationId: options.confirmationId,
      requireConfirmation: options.requireConfirmation === true
    });
  }

  async dialogStatus() {
    return this._request('GET', '/api/dialog/status');
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
