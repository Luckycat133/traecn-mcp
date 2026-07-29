'use strict';

const { TraeCNApiClient } = require('../../integrations/openclaw-traecn-plugin/lib/traecnapi-client');
const { TraeCNSkillError } = require('./errors');
const { buildCodeReviewTask } = require('./review');
const { KNOWN_MODELS } = require('../shared/models');

/** Alias mapping for settings sections */
const SETTINGS_SECTIONS = {
  general: '通用',
  account: '账号',
  accounts: '账号',
  agents: '智能体',
  mcp: 'MCP',
  flow: '对话流',
  dialog: '对话流',
  cue: 'CUE',
  model: '模型',
  models: '模型',
  context: '上下文',
  rules: '规则和技能',
  skills: '规则和技能',
  beta: 'Beta',
  about: '关于 TRAE'
};

/** List of valid modes */
// (Currently informational only — mode validation lives inside TraeCNSkill's
// switchMode/constructor. Kept here as documentation; remove if it stays
// unused in the next refactor pass.)
const VALID_MODES = ['solo', 'ide'];

/**
 * Main TraeCN Skill class.
 * Provides a simplified, unified interface to TraeCN automation features.
 */
class TraeCNSkill {
  /**
   * Create a TraeCNSkill instance.
   * @param {object} [context={}] - Context configuration object.
   */
  constructor(context = {}) {
    /** @type {object} Context configuration */
    this.context = context;
    /** @type {TraeCNApiClient} TraeCN API client */
    this.client = new TraeCNApiClient(context);
    /** @type {string|null} Current session ID */
    this._sessionId = null;
    /** @type {string|null} Last executed task ID */
    this._lastTaskId = null;
  }

  /**
   * Get TraeCN connection status
   * @param {boolean} [allowAutoStart=false] - Whether to allow auto-start
   * @returns {Promise<object>} Status result
   */
  async status(allowAutoStart = false) {
    try {
      const result = await this.client.getStatus(allowAutoStart);
      return this._normalizeStatus(result);
    } catch (cause) {
      throw TraeCNSkillError.connectionError(cause);
    }
  }

  /**
   * Get the compact capability catalog for the agent.
   * @returns {Promise<object>} Capabilities result
   */
  async getCapabilities() {
    const result = await this.client.getCapabilities();
    return result.data || result;
  }

  /**
   * Generate a confirmation/preflight plan for an upcoming operation without touching TraeCN.
   * @param {string} command - Command name.
   * @param {object} [params={}] - Command parameters.
   * @param {object} [options={}] - Options.
   * @returns {Promise<object>} Confirmation plan
   */
  async planOperation(command, params = {}, options = {}) {
    const result = await this.client.createConfirmationPlan(command, params, options);
    return result.data || result;
  }

  /**
   * Fetch a low-token preflight summary in one shot: connection, readiness, queue, popups, and an optional operation confirmation plan.
   * @param {object} [options={}] - Optional { command, params, forceConfirm }.
   * @returns {Promise<object>} Preflight summary
   */
  async preflight(options = {}) {
    const result = await this.client.preflight(options);
    return result.data || result;
  }

  /**
   * Run a task
   * @param {string} task - Task description
   * @param {object} [options={}] - Run options
   * @param {string} [options.projectPath] - Project path
   * @param {boolean} [options.includeProcess] - Whether to include process info
   * @param {boolean} [options.autoWait=true] - Whether to auto-wait for the queue
   * @param {string} [options.mode] - Mode ('solo' or 'ide')
   * @returns {Promise<object>} Run result
   */
  async run(task, options = {}) {
    const {
      projectPath,
      includeProcess,
      autoWait = true,
      mode = null,
      reviewRequired,
      autoContinue,
      followupTasks,
      completionChecks,
      autoApproveDialog,
      notifyUrl,
      fallbackModels,
      autoModelFallback,
      modelProbeIntervalMs
    } = options;
    // autoApproveDialog is consumed downstream via options in delegate(); keeping
    // the explicit destructure here makes the supported option surface
    // self-documenting. No-op reference so eslint no-unused-vars is satisfied.
    void autoApproveDialog;

    if (mode) {
      await this.switchMode(mode).catch(() => {});
    }

    if (projectPath && !this._sessionId) {
      try {
        const session = await this.client.createSession({ projectPath });
        this._sessionId = session.data?.sessionId || session.sessionId;
      } catch {
        // Silently fail and continue.
      }
    }

    try {
      let result;
      
      if (autoWait) {
        result = await this._delegateWithPoll(task, { 
          projectPath, 
          sessionId: this._sessionId, 
          includeProcess,
          reviewRequired,
          autoContinue,
          followupTasks,
          completionChecks,
          notifyUrl,
          fallbackModels,
          autoModelFallback,
          modelProbeIntervalMs
        });
      } else {
        result = await this.client.delegate(task, {
          projectPath,
          sessionId: this._sessionId,
          includeProcessText: includeProcess,
          reviewRequired,
          autoContinue,
          followupTasks,
          completionChecks,
          notifyUrl,
          fallbackModels,
          autoModelFallback,
          modelProbeIntervalMs
        });
      }

      if (result.taskId) {
        this._lastTaskId = result.taskId;
      }

      return this._normalizeResult(result);
    } catch (cause) {
      throw TraeCNSkillError.taskFailed(cause, { task });
    }
  }

  /**
   * Queue a task (asynchronous execution)
   * @param {string} task - Task description
   * @param {object} [options={}] - Run options
   * @param {string} [options.projectPath] - Project path
   * @returns {Promise<object>} Queue result
   */
  async queue(task, options = {}) {
    const {
      projectPath,
      sessionId,
      chatId,
      includeProcessText,
      includeProcess,
      waitForQueue = true,
      background,
      forceBackground,
      reviewRequired,
      autoContinue,
      followupTasks,
      completionChecks,
      autoApproveDialog,
      notifyUrl,
      fallbackModels,
      autoModelFallback,
      modelProbeIntervalMs,
      maxQueueWaitMs,
      queueMaxWaitMs,
      soloChat,
      soloChatIndex,
      soloChatTitleIncludes,
      soloChatTextIncludes,
      newChat
    } = options;
    
    try {
      const result = await this.client.delegateAsync(task, {
        projectPath,
        sessionId: sessionId || this._sessionId,
        chatId,
        includeProcessText: includeProcessText === true || includeProcess === true,
        waitForQueue,
        background,
        forceBackground,
        reviewRequired,
        autoContinue,
        followupTasks,
        completionChecks,
        autoApproveDialog,
        notifyUrl,
        fallbackModels,
        autoModelFallback,
        modelProbeIntervalMs,
        maxQueueWaitMs,
        queueMaxWaitMs,
        soloChat,
        soloChatIndex,
        soloChatTitleIncludes,
        soloChatTextIncludes,
        newChat
      });

      this._lastTaskId = result.taskId || result.data?.taskId;
      return this._normalizeQueueResult(result);
    } catch (cause) {
      throw TraeCNSkillError.taskFailed(cause, { task });
    }
  }

  /**
   * Poll task status
   * @param {string|null} [taskId=null] - Task ID (optional, defaults to the last executed task)
   * @returns {Promise<object>} Poll result
   * @throws {TraeCNSkillError} If no task ID is available
   */
  async poll(taskId = null) {
    const id = taskId || this._lastTaskId;
    if (!id) {
      throw TraeCNSkillError.taskIdMissing();
    }

    try {
      const result = await this.client.getTaskStatus(id);
      return this._normalizePollResult(result);
    } catch (cause) {
      throw TraeCNSkillError.taskFailed(cause, { taskId: id });
    }
  }

  /**
   * Wait locally for a task until it reaches a terminal state or a stop point requiring a code decision.
   * @param {string|null} [taskId=null] - Task ID (optional, defaults to the last executed task)
   * @param {object} [options={}] - Wait options
   * @returns {Promise<object>} Wait result
   */
  async wait(taskId = null, options = {}) {
    const id = taskId || this._lastTaskId;
    if (!id) {
      throw TraeCNSkillError.taskIdMissing();
    }

    try {
      const result = await this.client.waitForTask(id, options);
      return {
        ok: !['error', 'queue_timeout', 'review_rejected', 'not_found'].includes(String(result.status || '').toLowerCase()),
        ...result
      };
    } catch (cause) {
      throw TraeCNSkillError.taskFailed(cause, { taskId: id });
    }
  }

  /**
   * Cancel a task
   * @param {string|null} [taskId=null] - Task ID (optional, defaults to the last executed task)
   * @returns {Promise<object>} Cancel result
   * @throws {TraeCNSkillError} If no task ID is available
   */
  async cancel(taskId = null) {
    const id = taskId || this._lastTaskId;
    if (!id) {
      throw TraeCNSkillError.taskIdMissing();
    }

    try {
      const result = await this.client.cancelTask(id);
      return this._normalizeCancelResult(result);
    } catch (cause) {
      throw TraeCNSkillError.taskFailed(cause, { taskId: id, action: 'cancel' });
    }
  }

  /**
   * Create a new chat
   * @returns {Promise<object>} New chat result
   */
  async newChat() {
    const result = await this.client.newChat();
    this._sessionId = null;
    return result;
  }

  async listSoloChats() {
    return await this.client.listSoloChats();
  }

  async switchSoloChat(criteria = {}) {
    return await this.client.switchSoloChat(criteria);
  }

  async submitSoloChatTask(task, options = {}) {
    try {
      const result = await this.client.submitSoloChatTask(task, options);
      this._lastTaskId = result.taskId || result.data?.taskId;
      return this._normalizeQueueResult(result);
    } catch (cause) {
      throw TraeCNSkillError.taskFailed(cause, { task });
    }
  }

  /**
   * Switch mode
   * @param {string} mode - Mode name ('solo' or 'ide')
   * @returns {Promise<object>} Switch result
   */
  async switchMode(mode) {
    const validMode = mode.toLowerCase() === 'ide' ? 'ide' : 'solo';
    return await this.client.switchMode(validMode);
  }

  /**
   * Switch model
   * @param {string} model - Model name (supports fuzzy matching)
   * @returns {Promise<object>} Switch result
   * @throws {TraeCNSkillError} If the model is unknown
   */
  async switchModel(model, options = {}) {
    const normalized = this._normalizeModel(model);
    if (!normalized) {
      throw TraeCNSkillError.unknownModel(model, KNOWN_MODELS);
    }
    return await this.client.switchModel(normalized, options);
  }

  /**
   * Get settings
   * @param {string|null} [section=null] - Settings section (optional)
   * @returns {Promise<object>} Settings result
   */
  async getSettings(section = null) {
    const normalized = this._normalizeSection(section);
    const result = await this.client.settingsRead(normalized);
    return this._normalizeSettings(result);
  }

  /**
   * Set a setting
   * @param {string} label - Setting label
   * @param {any} value - Setting value
   * @param {string|null} [section=null] - Settings section (optional)
   * @returns {Promise<object>} Settings result
   */
  async setSetting(label, value, section = null) {
    const normalized = this._normalizeSection(section);
    const result = await this.client.settingsWrite(normalized, { label, value });
    return this._normalizeSetResult(result);
  }

  /**
   * Approve dialog
   * @param {string} [action='auto'] - Approval action
   * @param {boolean} [wait=false] - Whether to wait
   * @returns {Promise<object>} Approval result
   */
  async approveDialog(action = 'auto', wait = false) {
    if (wait) {
      await this._sleep(2000);
    }
    const result = await this.client.approveDialog(action);
    return this._normalizeApproveResult(result);
  }

  /**
   * Check dialog status
   * @returns {Promise<object>} Dialog status
   */
  async checkDialog() {
    const result = await this.client.dialogStatus();
    return this._normalizeDialogStatus(result);
  }

  /**
   * Check queue status
   * @returns {Promise<object>} Queue status
   */
  async queueStatus() {
    const result = await this.client.checkQueueStatus();
    return this._normalizeQueueStatus(result);
  }

  /**
   * Open project
   * @param {string} projectPath - Project path
   * @returns {Promise<object>} Open result
   */
  async openProject(projectPath) {
    return await this.client.openProject(projectPath);
  }

  /**
   * Code-review helper: wrap code, a diff, or review notes into a stable review prompt and delegate to TraeCN.
   * @param {string|object} input - Review notes, or { instruction, files, focus, code, diff }
   * @param {object} [options={}] - run/queue options; queued asynchronously when options.queue=true
   * @returns {Promise<object>} Review result
   */
  async reviewCode(input, options = {}) {
    const task = buildCodeReviewTask(input, options);
    if (options.queue === true) {
      return this.queue(task, options);
    }
    return this.run(task, options);
  }

  /**
   * Start an unattended vibe-coding workflow: automatically continue with follow-ups after the initial task completes.
   * @param {object} input - { task, steps?, projectPath?, reviewRequired? }
   * @returns {Promise<object>} Queue result
   */
  async vibeWorkflow(input = {}) {
    if (!input || typeof input.task !== 'string' || !input.task.trim()) {
      throw TraeCNSkillError.taskFailed(new Error('task is required'), { action: 'vibeWorkflow' });
    }
    const steps = Array.isArray(input.steps)
      ? input.steps
      : (Array.isArray(input.followupTasks) ? input.followupTasks : []);
    const followupTasks = steps.map(step => {
      if (typeof step === 'string') {
        return { task: step, reviewRequired: input.reviewRequired === true, autoContinue: true };
      }
      return {
        ...step,
        reviewRequired: step.reviewRequired === true || input.reviewRequired === true,
        autoContinue: true
      };
    });
    return this.queue(input.task, {
      ...input,
      background: input.background !== false,
      forceBackground: input.forceBackground === true,
      reviewRequired: input.reviewRequired === true,
      autoContinue: true,
      autoApproveDialog: input.autoApproveDialog === undefined ? 'auto' : input.autoApproveDialog,
      followupTasks
    });
  }

  /**
   * Normalize status data
   * @private
   * @param {any} data - Raw data
   * @returns {object} Normalized status
   */
  _normalizeStatus(data) {
    const payload = data.data || data;
    return {
      ok: true,
      status: payload.status,
      connected: payload.status === 'connected',
      version: payload.version || null,
      mock: payload.mockBridge || false
    };
  }

  /**
   * Normalize run result
   * @private
   * @param {any} data - Raw data
   * @returns {object} Normalized result
  */
  _normalizeResult(data) {
    const payload = data.data || data;

    // Honest failure propagation: if the gateway (or any upstream) reported
    // an explicit failure, surface it instead of rewriting it into a false
    // success. This is what prevents `traecn_run_task` from returning
    // ok:true when the TraeCN CDP endpoint is actually unreachable.
    if (payload.ok === false || payload.error) {
      return {
        ok: false,
        error: payload.error || 'TASK_FAILED',
        code: payload.code || null,
        message: payload.message || null,
        status: payload.status || 'failed'
      };
    }

    if (payload.status === 'queued') {
      return {
        ok: true,
        queued: true,
        taskId: payload.taskId,
        status: 'queued'
      };
    }

    return {
      ok: true,
      text: payload.text || '',
      status: payload.stable ? 'stable' : 'unstable',
      elapsed: payload.elapsedMs || 0,
      process: payload.processText || null
    };
  }

  /**
   * Normalize queue result
   * @private
   * @param {any} data - Raw data
   * @returns {object} Normalized queue result
  */
  _normalizeQueueResult(data) {
    const payload = data.data || data;
    if (payload.ok === false || payload.error) {
      return {
        ok: false,
        error: payload.error || 'TASK_FAILED',
        code: payload.code || null,
        message: payload.message || null,
        status: payload.status || 'failed'
      };
    }
    return {
      ok: true,
      queued: true,
      taskId: payload.taskId,
      status: payload.status,
      queue: payload.queueDetails || null
    };
  }

  /**
   * Normalize poll result
   * @private
   * @param {any} data - Raw data
   * @returns {object} Normalized poll result
   */
  _normalizePollResult(data) {
    const payload = data.data || data;
    const status = payload.status || 'queued';
    
    const result = { ok: true, status };

    if (status === 'done' && payload.result) {
      result.text = payload.result.text;
      result.elapsed = payload.result.elapsedMs;
    }

    if (payload.elapsed) {
      result.elapsed = payload.elapsed;
    }

    if (payload.error) {
      result.error = payload.error;
      result.ok = false;
    }

    return result;
  }

  /**
   * Normalize cancel result
   * @private
   * @param {any} data - Raw data
   * @returns {object} Normalized cancel result
   */
  _normalizeCancelResult(data) {
    const payload = data.data || data;
    return { ok: true, cancelled: true };
  }

  /**
   * Normalize settings result
   * @private
   * @param {any} data - Raw data
   * @returns {object} Normalized settings result
   */
  _normalizeSettings(data) {
    const payload = data.data || data;
    return { ok: true, section: payload.section || null, content: payload };
  }

  /**
   * Normalize setting result
   * @private
   * @param {any} data - Raw data
   * @returns {object} Normalized setting result
   */
  _normalizeSetResult(data) {
    const payload = data.data || data;
    return { ok: true, label: payload.label, value: payload.value };
  }

  /**
   * Normalize approval result
   * @private
   * @param {any} data - Raw data
   * @returns {object} Normalized approval result
   */
  _normalizeApproveResult(data) {
    const payload = data.data || data;
    return {
      ok: true,
      success: payload.success,
      action: payload.action,
      clicked: payload.buttonClicked || null
    };
  }

  /**
   * Normalize dialog status
   * @private
   * @param {any} data - Raw data
   * @returns {object} Normalized dialog status
   */
  _normalizeDialogStatus(data) {
    const payload = data.data || data;
    return {
      ok: true,
      hasDialog: payload.hasDialog || false,
      type: payload.dialogType || null,
      question: payload.question || null,
      buttons: payload.buttons || []
    };
  }

  /**
   * Normalize queue status
   * @private
   * @param {any} data - Raw data
   * @returns {object} Normalized queue status
   */
  _normalizeQueueStatus(data) {
    const payload = data.data || data;
    return {
      ok: true,
      queued: payload.queued || false,
      position: payload.position || null,
      message: payload.message || null
    };
  }

  /**
   * Normalize a model name (supports fuzzy matching)
   * @private
   * @param {string} model - Model name
   * @returns {string|null} Normalized model name or null
   */
  _normalizeModel(model) {
    if (!model) return null;
    const m = model.toLowerCase();
    
    for (const known of KNOWN_MODELS) {
      if (known.toLowerCase().includes(m) || m.includes(known.toLowerCase())) {
        return known;
      }
    }
    
    if (KNOWN_MODELS.includes(model)) return model;
    
    return null;
  }

  /**
   * Normalize settings section
   * @private
   * @param {string|null} section - Section name
   * @returns {string|null} Normalized section name
   */
  _normalizeSection(section) {
    if (!section) return null;
    return SETTINGS_SECTIONS[section.toLowerCase()] || section;
  }

  /**
   * Delay/wait
   * @private
   * @param {number} ms - Milliseconds
   * @returns {Promise<void>}
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Delegate a task and poll until completion
   * @private
   * @param {string} task - Task description
   * @param {object} opts - Options
   * @returns {Promise<any>} Task result
   */
  async _delegateWithPoll(task, opts) {
    const {
      projectPath,
      sessionId,
      includeProcess,
      reviewRequired,
      autoContinue,
      followupTasks,
      completionChecks,
      notifyUrl,
      fallbackModels,
      autoModelFallback,
      modelProbeIntervalMs
    } = opts;

    const result = await this.client.delegate(task, {
      projectPath,
      sessionId,
      includeProcessText: includeProcess,
      reviewRequired,
      autoContinue,
      followupTasks,
      completionChecks,
      notifyUrl,
      fallbackModels,
      autoModelFallback,
      modelProbeIntervalMs
    });

    const d = result.data || result;
    
    if (d.status === 'queued') {
      const taskId = d.taskId;
      const maxAttempts = 40;
      const interval = 5000;

      for (let i = 0; i < maxAttempts; i++) {
        await this._sleep(interval);
        const poll = await this.client.getTaskStatus(taskId);
        const status = poll.data?.status || poll.status;

        if (status === 'done') {
          return poll.data?.result || poll.result || poll;
        }

        if (status === 'error' || status === 'queue_timeout' || status === 'cancelled') {
          return poll;
        }
      }

      throw TraeCNSkillError.queueTimeout(taskId, maxAttempts);
    }

    return result;
  }

  // ── Shared singleton management ─────────────────────────────────────
  //
  // Both index.js and simple-api.js need a process-wide singleton so that
  // `reset()` in one module affects the other. Centralizing the singleton
  // here avoids split-state bugs when consumers mix the two entry points.

  /**
   * Get the shared singleton instance, creating it on first access.
   * @param {object} [context] - Optional context for first-time creation.
   * @returns {TraeCNSkill}
   */
  static getSharedInstance(context) {
    if (!TraeCNSkill._sharedInstance) {
      TraeCNSkill._sharedInstance = new TraeCNSkill(context);
    }
    return TraeCNSkill._sharedInstance;
  }

  /**
   * Reset the shared singleton. The next `getSharedInstance` call will
   * create a fresh instance.
   */
  static resetSharedInstance() {
    TraeCNSkill._sharedInstance = null;
  }
}

module.exports = { TraeCNSkill, KNOWN_MODELS, SETTINGS_SECTIONS, TraeCNSkillError };
