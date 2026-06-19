'use strict';

const http = require('http');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8788;
const DEFAULT_TIMEOUT = 120000;
const DEFAULT_TASK_POLL_MS = 30000;
const DEFAULT_TASK_WAIT_TIMEOUT_MS = 0;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TERMINAL_TASK_STATUSES = Object.freeze([
  'done',
  'error',
  'cancelled',
  'queue_timeout',
  'review_rejected',
  'awaiting_review',
  'approval_required',
  'not_found'
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeWaitMs(value, fallback, { allowZero = false } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed === 0 && allowZero) return 0;
  return parsed > 0 ? parsed : fallback;
}

function isTerminalTaskStatus(status) {
  return TERMINAL_TASK_STATUSES.includes(String(status || '').toLowerCase());
}

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

  async restartTraeDebug(options = {}) {
    const body = {};
    if (options.projectPath) body.projectPath = options.projectPath;
    if (options.confirmationPhrase) body.confirmationPhrase = options.confirmationPhrase;
    if (options.confirmationId) body.confirmationId = options.confirmationId;
    if (options.quitTimeoutMs !== undefined) body.quitTimeoutMs = options.quitTimeoutMs;
    if (options.cdpWaitMs !== undefined) body.cdpWaitMs = options.cdpWaitMs;
    return this._request('POST', '/api/trae/restart-debug', body);
  }

  async getReadiness() {
    return this._request('GET', '/api/readiness');
  }

  async newChat(allowAutoStart = false) {
    return this._request('POST', '/api/new-chat', { allowAutoStart });
  }

  async listSoloChats() {
    return this._request('GET', '/api/solo/chats');
  }

  async switchSoloChat(options = {}) {
    const body = {};
    if (Number.isInteger(options.index)) body.index = options.index;
    if (options.titleIncludes) body.titleIncludes = options.titleIncludes;
    if (options.textIncludes) body.textIncludes = options.textIncludes;
    return this._request('POST', '/api/solo/chats/switch', body);
  }

  async submitSoloChatTask(task, options = {}) {
    const body = { task };
    if (options.projectPath) body.projectPath = options.projectPath;
    if (options.chatId) body.chatId = options.chatId;
    if (options.soloChat && typeof options.soloChat === 'object') body.soloChat = options.soloChat;
    if (Number.isInteger(options.soloChatIndex)) body.soloChatIndex = options.soloChatIndex;
    if (options.soloChatTitleIncludes) body.soloChatTitleIncludes = options.soloChatTitleIncludes;
    if (options.soloChatTextIncludes) body.soloChatTextIncludes = options.soloChatTextIncludes;
    if (options.newChat === false) body.newChat = false;
    if (options.includeProcessText) body.includeProcessText = true;
    if (options.reviewRequired === true) body.reviewRequired = true;
    if (options.autoContinue === true) body.autoContinue = true;
    if (Array.isArray(options.followupTasks)) body.followupTasks = options.followupTasks;
    if (options.completionChecks && typeof options.completionChecks === 'object') body.completionChecks = options.completionChecks;
    if (options.autoApproveDialog !== undefined) body.autoApproveDialog = options.autoApproveDialog;
    if (options.notifyUrl) body.notifyUrl = options.notifyUrl;
    if (Array.isArray(options.fallbackModels)) body.fallbackModels = options.fallbackModels;
    if (options.autoModelFallback === true) body.autoModelFallback = true;
    if (options.modelProbeIntervalMs !== undefined) body.modelProbeIntervalMs = options.modelProbeIntervalMs;
    if (options.maxQueueWaitMs !== undefined) body.maxQueueWaitMs = options.maxQueueWaitMs;
    if (options.queueMaxWaitMs !== undefined) body.queueMaxWaitMs = options.queueMaxWaitMs;
    return this._request('POST', '/api/solo/chats/submit', body);
  }

  async delegate(task, options = {}) {
    const body = { task };
    if (options.projectPath) body.projectPath = options.projectPath;
    if (options.sessionId) body.sessionId = options.sessionId;
    if (options.allowAutoStart) body.allowAutoStart = true;
    if (options.includeProcessText) body.includeProcessText = true;
    if (options.waitForQueue !== undefined) body.waitForQueue = options.waitForQueue;
    if (options.background === true) body.background = true;
    if (options.forceBackground === true) body.forceBackground = true;
    if (options.reviewRequired === true) body.reviewRequired = true;
    if (options.autoContinue === true) body.autoContinue = true;
    if (Array.isArray(options.followupTasks)) body.followupTasks = options.followupTasks;
    if (options.completionChecks && typeof options.completionChecks === 'object') body.completionChecks = options.completionChecks;
    if (options.autoApproveDialog !== undefined) body.autoApproveDialog = options.autoApproveDialog;
    if (options.notifyUrl) body.notifyUrl = options.notifyUrl;
    if (Array.isArray(options.fallbackModels)) body.fallbackModels = options.fallbackModels;
    if (options.autoModelFallback === true) body.autoModelFallback = true;
    if (options.modelProbeIntervalMs !== undefined) body.modelProbeIntervalMs = options.modelProbeIntervalMs;
    // gateway wraps result in { status: 'done', text, ... };
    // unwrap the HTTP envelope for clean access by the caller
    const response = await this._request('POST', '/api/delegate', body);
    return response.data || response;
  }

  async delegateAsync(task, options = {}) {
    const body = { task };
    if (options.projectPath) body.projectPath = options.projectPath;
    if (options.sessionId) body.sessionId = options.sessionId;
    if (options.chatId) body.chatId = options.chatId;
    if (options.soloChat && typeof options.soloChat === 'object') body.soloChat = options.soloChat;
    if (Number.isInteger(options.soloChatIndex)) body.soloChatIndex = options.soloChatIndex;
    if (options.soloChatTitleIncludes) body.soloChatTitleIncludes = options.soloChatTitleIncludes;
    if (options.soloChatTextIncludes) body.soloChatTextIncludes = options.soloChatTextIncludes;
    if (options.newChat === false) body.newChat = false;
    if (options.includeProcessText) body.includeProcessText = true;
    if (options.waitForQueue !== undefined) body.waitForQueue = options.waitForQueue;
    if (options.background === true) body.background = true;
    if (options.forceBackground === true) body.forceBackground = true;
    if (options.reviewRequired === true) body.reviewRequired = true;
    if (options.autoContinue === true) body.autoContinue = true;
    if (Array.isArray(options.followupTasks)) body.followupTasks = options.followupTasks;
    if (options.completionChecks && typeof options.completionChecks === 'object') body.completionChecks = options.completionChecks;
    if (options.autoApproveDialog !== undefined) body.autoApproveDialog = options.autoApproveDialog;
    if (options.notifyUrl) body.notifyUrl = options.notifyUrl;
    if (options.maxQueueWaitMs !== undefined) body.maxQueueWaitMs = options.maxQueueWaitMs;
    if (options.queueMaxWaitMs !== undefined) body.queueMaxWaitMs = options.queueMaxWaitMs;
    if (Array.isArray(options.fallbackModels)) body.fallbackModels = options.fallbackModels;
    if (options.autoModelFallback === true) body.autoModelFallback = true;
    if (options.modelProbeIntervalMs !== undefined) body.modelProbeIntervalMs = options.modelProbeIntervalMs;
    return this._request('POST', '/api/delegate-async', body);
  }

  async getTaskStatus(taskId) {
    return this._request('GET', '/api/task/' + encodeURIComponent(taskId));
  }

  async waitForTask(taskId, options = {}) {
    if (!taskId) {
      throw new Error('taskId is required');
    }

    const pollMs = normalizeWaitMs(options.pollMs || options.pollIntervalMs, DEFAULT_TASK_POLL_MS);
    const timeoutMs = normalizeWaitMs(
      options.timeoutMs || options.waitTimeoutMs,
      DEFAULT_TASK_WAIT_TIMEOUT_MS,
      { allowZero: true }
    );
    const startedAt = Date.now();
    const deadline = timeoutMs > 0 ? startedAt + timeoutMs : 0;
    const autoApproveDialog = options.autoApproveDialog || options.approveDialogAction || null;
    let attempts = 0;
    let lastSnapshot = null;

    while (true) {
      attempts++;
      const response = await this.getTaskStatus(taskId);
      const data = response.data || {};
      const status = response.status === 404 ? 'not_found' : (data.status || 'unknown');
      const elapsedMs = Date.now() - startedAt;
      lastSnapshot = data;

      if (typeof options.onSnapshot === 'function') {
        await options.onSnapshot({
          type: 'task_status',
          at: new Date().toISOString(),
          taskId,
          status,
          httpStatus: response.status,
          attempt: attempts,
          elapsedMs,
          data
        });
      }

      if (status === 'approval_required' && autoApproveDialog) {
        const dialogResponse = await this.dialogStatus();
        if (typeof options.onSnapshot === 'function') {
          await options.onSnapshot({
            type: 'dialog_status',
            at: new Date().toISOString(),
            taskId,
            status,
            httpStatus: dialogResponse.status,
            attempt: attempts,
            elapsedMs: Date.now() - startedAt,
            data: dialogResponse.data || {}
          });
        }

        const dialog = dialogResponse.data || {};
        if (dialog.hasDialog) {
          const action = typeof autoApproveDialog === 'string' ? autoApproveDialog : 'auto';
          const approvalResponse = await this.approveDialog(action);
          if (typeof options.onSnapshot === 'function') {
            await options.onSnapshot({
              type: 'dialog_approval',
              at: new Date().toISOString(),
              taskId,
              status,
              action,
              httpStatus: approvalResponse.status,
              attempt: attempts,
              elapsedMs: Date.now() - startedAt,
              data: approvalResponse.data || {}
            });
          }
          await sleep(Math.min(pollMs, 3000));
          continue;
        }
      }

      if (isTerminalTaskStatus(status)) {
        return {
          ...data,
          taskId: data.taskId || taskId,
          status,
          wait: {
            terminal: true,
            timedOut: false,
            attempts,
            elapsedMs,
            pollMs,
            timeoutMs
          }
        };
      }

      if (deadline && Date.now() >= deadline) {
        return {
          taskId,
          status,
          wait: {
            terminal: false,
            timedOut: true,
            attempts,
            elapsedMs: Date.now() - startedAt,
            pollMs,
            timeoutMs
          },
          lastSnapshot
        };
      }

      const remainingMs = deadline ? Math.max(0, deadline - Date.now()) : pollMs;
      await sleep(deadline ? Math.min(pollMs, remainingMs) : pollMs);
    }
  }

  async adoptCurrentTask(options = {}) {
    const body = {};
    if (options.task) body.task = options.task;
    if (options.reviewRequired === true) body.reviewRequired = true;
    if (Array.isArray(options.followupTasks)) body.followupTasks = options.followupTasks;
    if (options.chatId) body.chatId = options.chatId;
    if (options.includeProcessText === true) body.includeProcessText = true;
    if (options.notifyUrl) body.notifyUrl = options.notifyUrl;
    if (options.autoApproveDialog !== undefined) body.autoApproveDialog = options.autoApproveDialog;
    if (Array.isArray(options.fallbackModels)) body.fallbackModels = options.fallbackModels;
    if (options.autoModelFallback === true) body.autoModelFallback = true;
    if (options.modelProbeIntervalMs !== undefined) body.modelProbeIntervalMs = options.modelProbeIntervalMs;
    if (options.submittedAt !== undefined) body.submittedAt = options.submittedAt;
    if (options.force === true) body.force = true;
    return this._request('POST', '/api/task/adopt-current', body);
  }

  async cancelTask(taskId) {
    return this._request('POST', '/api/task/' + encodeURIComponent(taskId) + '/cancel');
  }

  async stopGeneration() {
    return this._request('POST', '/api/trae/stop-generation');
  }

  async getReviewGateStatus() {
    return this._request('GET', '/api/trae/review-gate');
  }

  async resolveReviewGate(action = 'keep_all') {
    return this._request('POST', '/api/trae/review-gate', { action });
  }

  async switchMode(mode, allowAutoStart = false) {
    return this._request('POST', '/api/switch-mode', { mode, allowAutoStart });
  }

  async switchModel(model, options = {}) {
    return this._request('POST', '/api/switch-model', { model, ...options });
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

module.exports = {
  TraeCNApiClient,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT,
  DEFAULT_TASK_POLL_MS,
  TERMINAL_TASK_STATUSES,
  isTerminalTaskStatus
};
