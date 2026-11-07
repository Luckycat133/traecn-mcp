'use strict';

const { TraeCNApiClient } = require('../client/traecnapi-client');
const { TraeCNSkillError } = require('./errors');
const { buildCodeReviewTask } = require('./review');
const { KNOWN_MODELS } = require('../shared/models');

/** _delegateWithPoll 的默认轮询参数 */
const DEFAULT_POLL_MAX_ATTEMPTS = 40;
const DEFAULT_POLL_INTERVAL_MS = 5000;

/**
 * 解包网关响应，统一 `data.data || data` 取值模式。
 * @param {any} data - 原始响应
 * @returns {any} 解包后的负载
 * @private
 */
function _unwrap(data) {
  return (data && typeof data === 'object' && 'data' in data) ? data.data : data;
}

/** 设置区域的别名映射 */
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

/**
 * TraeCN Skill 主类
 * 提供 TraeCN 自动化功能的简化、统一接口
 */
class TraeCNSkill {
  /**
   * 创建 TraeCNSkill 实例
   * @param {object} [context={}] - 上下文配置对象
   */
  constructor(context = {}) {
    /** @type {object} 上下文配置 */
    this.context = context;
    /** @type {TraeCNApiClient} TraeCN API 客户端 */
    this.client = new TraeCNApiClient(context);
    /** @type {string|null} 当前会话 ID */
    this._sessionId = null;
    /** @type {string|null} 最后执行的任务 ID */
    this._lastTaskId = null;
  }

  /**
   * 获取 TraeCN 连接状态
   * @param {boolean} [allowAutoStart=false] - 是否允许自动启动
   * @returns {Promise<object>} 状态结果
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
   * 获取面向 agent 的紧凑能力目录。
   * @returns {Promise<object>} capabilities 结果
   */
  async getCapabilities() {
    const result = await this.client.getCapabilities();
    return result.data || result;
  }

  /**
   * 为即将执行的操作生成确认/预检计划，不操作 TraeCN。
   * @param {string} command - 命令名
   * @param {object} [params={}] - 命令参数
   * @param {object} [opts={}] - 选项
   * @returns {Promise<object>} 确认计划
   */
  async planOperation(command, params = {}, opts = {}) {
    const result = await this.client.createConfirmationPlan(command, params, opts);
    return result.data || result;
  }

  /**
   * 一次性获取低 token 预检摘要：连接、就绪、队列、弹窗和可选操作确认计划。
   * @param {object} [options={}] - 可选 { command, params, forceConfirm }
   * @returns {Promise<object>} 预检摘要
   */
  async preflight(options = {}) {
    const result = await this.client.preflight(options);
    return result.data || result;
  }

  /**
   * 运行任务
   * @param {string} task - 任务描述
   * @param {object} [opts={}] - 运行选项
   * @param {string} [opts.projectPath] - 项目路径
   * @param {boolean} [opts.autoWait=true] - 是否自动等待队列
   * @param {string} [opts.mode] - 模式 ('solo' 或 'ide')
   * @returns {Promise<object>} 运行结果
   */
  async run(task, opts = {}) {
    const {
      projectPath,
      autoWait = true,
      mode = null,
      pollMaxAttempts,
      pollIntervalMs
    } = opts;

    if (mode) {
      await this.switchMode(mode).catch(() => {});
    }

    if (projectPath && !this._sessionId) {
      try {
        const session = await this.client.createSession({ projectPath });
        this._sessionId = session.data?.sessionId || session.sessionId;
      } catch {
        // 静默失败，继续执行
      }
    }

    // 集中收集 delegate 选项，避免 run/queue 两处分别罗列导致漂移
    const delegateOpts = this._buildDelegateOptions(opts, { sessionId: this._sessionId });

    try {
      let result;
      if (autoWait) {
        result = await this._delegateWithPoll(task, delegateOpts, { pollMaxAttempts, pollIntervalMs });
      } else {
        result = await this.client.delegate(task, delegateOpts);
      }

      if (result.taskId) {
        this._lastTaskId = result.taskId;
      }

      return this._normalizeResult(result);
    } catch (cause) {
      if (cause instanceof TraeCNSkillError || (cause && cause.name === 'TraeCNSkillError')) throw cause;
      throw TraeCNSkillError.taskFailed(cause, { task });
    }
  }

  /**
   * 队列任务（异步执行）
   * @param {string} task - 任务描述
   * @param {object} [opts={}] - 运行选项
   * @param {string} [opts.projectPath] - 项目路径
   * @returns {Promise<object>} 队列结果
   */
  async queue(task, opts = {}) {
    const { sessionId, includeProcessText, includeProcess } = opts;

    try {
      const delegateOpts = this._buildQueueOptions(opts, {
        sessionId: sessionId || this._sessionId,
        includeProcessText: includeProcessText === true || includeProcess === true
      });

      const result = await this.client.delegateAsync(task, delegateOpts);

      this._lastTaskId = result.taskId || result.data?.taskId;
      return this._normalizeQueueResult(result);
    } catch (cause) {
      if (cause instanceof TraeCNSkillError || (cause && cause.name === 'TraeCNSkillError')) throw cause;
      throw TraeCNSkillError.taskFailed(cause, { task });
    }
  }

  /**
   * 轮询任务状态
   * @param {string|null} [taskId=null] - 任务 ID（可选，默认为最后执行的任务）
   * @returns {Promise<object>} 轮询结果
   * @throws {TraeCNSkillError} 如果没有可用的任务 ID
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
      if (cause instanceof TraeCNSkillError || (cause && cause.name === 'TraeCNSkillError')) throw cause;
      throw TraeCNSkillError.taskFailed(cause, { taskId: id });
    }
  }

  /**
   * 在本地等待任务直到终态或需要代码决策的停点。
   * @param {string|null} [taskId=null] - 任务 ID（可选，默认为最后执行的任务）
   * @param {object} [opts={}] - 等待选项
   * @returns {Promise<object>} 等待结果
   */
  async wait(taskId = null, opts = {}) {
    const id = taskId || this._lastTaskId;
    if (!id) {
      throw TraeCNSkillError.taskIdMissing();
    }

    try {
      const result = await this.client.waitForTask(id, opts);
      return {
        ok: !['error', 'queue_timeout', 'review_rejected', 'not_found'].includes(String(result.status || '').toLowerCase()),
        ...result
      };
    } catch (cause) {
      if (cause instanceof TraeCNSkillError || (cause && cause.name === 'TraeCNSkillError')) throw cause;
      throw TraeCNSkillError.taskFailed(cause, { taskId: id });
    }
  }

  /**
   * 取消任务
   * @param {string|null} [taskId=null] - 任务 ID（可选，默认为最后执行的任务）
   * @returns {Promise<object>} 取消结果
   * @throws {TraeCNSkillError} 如果没有可用的任务 ID
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
      if (cause instanceof TraeCNSkillError || (cause && cause.name === 'TraeCNSkillError')) throw cause;
      throw TraeCNSkillError.taskFailed(cause, { taskId: id, action: 'cancel' });
    }
  }

  /**
   * 创建新对话
   * @returns {Promise<object>} 新对话结果
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

  async submitSoloChatTask(task, opts = {}) {
    try {
      const result = await this.client.submitSoloChatTask(task, opts);
      this._lastTaskId = result.taskId || result.data?.taskId;
      return this._normalizeQueueResult(result);
    } catch (cause) {
      if (cause instanceof TraeCNSkillError || (cause && cause.name === 'TraeCNSkillError')) throw cause;
      throw TraeCNSkillError.taskFailed(cause, { task });
    }
  }

  /**
   * 切换模式
   * @param {string} mode - 模式名称 ('solo' 或 'ide')，忽略大小写
   * @returns {Promise<object>} 切换结果
   * @throws {TraeCNSkillError} 如果模式不是 'solo' 或 'ide'
   */
  async switchMode(mode) {
    if (typeof mode !== 'string') {
      throw TraeCNSkillError.invalidMode(String(mode), ['solo', 'ide']);
    }
    const normalized = mode.toLowerCase();
    if (normalized !== 'solo' && normalized !== 'ide') {
      throw TraeCNSkillError.invalidMode(mode, ['solo', 'ide']);
    }
    return await this.client.switchMode(normalized);
  }

  /**
   * 切换模型
   * @param {string} model - 模型名称（支持模糊匹配）
   * @returns {Promise<object>} 切换结果
   * @throws {TraeCNSkillError} 如果模型未知
   */
  async switchModel(model, options = {}) {
    const normalized = this._normalizeModel(model);
    if (!normalized) {
      throw TraeCNSkillError.unknownModel(model, KNOWN_MODELS);
    }
    return await this.client.switchModel(normalized, options);
  }

  /**
   * 获取设置
   * @param {string|null} [section=null] - 设置区域（可选）
   * @returns {Promise<object>} 设置结果
   */
  async getSettings(section = null) {
    const normalized = this._normalizeSection(section);
    const result = await this.client.settingsRead(normalized);
    return this._normalizeSettings(result);
  }

  /**
   * 设置项
   * @param {string} label - 设置标签
   * @param {any} value - 设置值
   * @param {string|null} [section=null] - 设置区域（可选）
   * @returns {Promise<object>} 设置结果
   */
  async setSetting(label, value, section = null) {
    const normalized = this._normalizeSection(section);
    const result = await this.client.settingsWrite(normalized, { label, value });
    return this._normalizeSetResult(result);
  }

  /**
   * 批准对话框
   * @param {string} [action='auto'] - 批准动作
   * @param {boolean} [wait=false] - 是否等待
   * @returns {Promise<object>} 批准结果
   */
  async approveDialog(action = 'auto', wait = false) {
    if (wait) {
      await this._sleep(2000);
    }
    const result = await this.client.approveDialog(action);
    return this._normalizeApproveResult(result);
  }

  /**
   * 检查对话框状态
   * @returns {Promise<object>} 对话框状态
   */
  async checkDialog() {
    const result = await this.client.dialogStatus();
    return this._normalizeDialogStatus(result);
  }

  /**
   * 检查队列状态
   * @returns {Promise<object>} 队列状态
   */
  async queueStatus() {
    const result = await this.client.checkQueueStatus();
    return this._normalizeQueueStatus(result);
  }

  /**
   * 打开项目
   * @param {string} projectPath - 项目路径
   * @param {object} [options={}] - 打开选项
   * @param {boolean} [options.newInstance=false] - TraeCN 已运行时是否新建窗口
   * @returns {Promise<object>} 打开结果
   */
  async openProject(projectPath, options = {}) {
    return await this.client.openProject(projectPath, options);
  }

  /**
   * 代码审查辅助：将代码、diff 或审查说明包装成稳定审查提示并委派给 TraeCN。
   * @param {string|object} input - 审查说明，或 { instruction, files, focus, code, diff }
   * @param {object} [opts={}] - run/queue 选项；opts.queue=true 时异步排队
   * @returns {Promise<object>} 审查结果
   */
  async reviewCode(input, opts = {}) {
    const task = buildCodeReviewTask(input, opts);
    if (opts.queue === true) {
      return this.queue(task, opts);
    }
    return this.run(task, opts);
  }

  /**
   * 启动无人值守 vibe coding 工作流：初始任务完成后自动继续 follow-up。
   * @param {object} input - { task, steps?, projectPath?, reviewRequired? }
   * @returns {Promise<object>} 队列结果
   */
  async vibeWorkflow(input = {}) {
    if (!input || typeof input.task !== 'string' || !input.task.trim()) {
      throw TraeCNSkillError.taskFailed(new Error('task is required'), { action: 'vibeWorkflow' });
    }
    const steps = Array.isArray(input.steps)
      ? input.steps
      : (Array.isArray(input.followupTasks) ? input.followupTasks : []);
    const autoContinue = input.autoContinue !== false;
    const followupTasks = steps.map(step => {
      if (typeof step === 'string') {
        return { task: step, reviewRequired: input.reviewRequired === true, autoContinue };
      }
      return {
        ...step,
        reviewRequired: step.reviewRequired === true || input.reviewRequired === true,
        autoContinue: typeof step.autoContinue === 'boolean' ? step.autoContinue : autoContinue
      };
    });
    return this.queue(input.task, {
      ...input,
      background: input.background !== false,
      forceBackground: input.forceBackground === true,
      reviewRequired: input.reviewRequired === true,
      autoContinue,
      autoApproveDialog: input.autoApproveDialog === undefined ? 'auto' : input.autoApproveDialog,
      followupTasks
    });
  }

  /**
   * 标准化状态数据
   * @private
   * @param {any} data - 原始数据
   * @returns {object} 标准化的状态
   */
  _normalizeStatus(data) {
    const d = _unwrap(data);
    return {
      ok: true,
      status: d.status,
      connected: d.status === 'connected',
      version: d.version || null,
      mock: d.mockBridge || false
    };
  }

  /**
   * 标准化运行结果
   * @private
   * @param {any} data - 原始数据
   * @returns {object} 标准化的结果
   */
  _normalizeResult(data) {
    const d = _unwrap(data);

    // Honest failure propagation: if the gateway (or any upstream) reported
    // an explicit failure, surface it instead of rewriting it into a false
    // success. This is what prevents `traecn_run_task` from returning
    // ok:true when the TraeCN CDP endpoint is actually unreachable.
    if (d.ok === false || d.error) {
      return {
        ok: false,
        error: d.error || 'TASK_FAILED',
        code: d.code || null,
        message: d.message || null,
        status: d.status || 'failed'
      };
    }

    if (d.status === 'queued') {
      return {
        ok: true,
        queued: true,
        taskId: d.taskId,
        status: 'queued'
      };
    }

    return {
      ok: true,
      text: d.text || '',
      status: d.stable ? 'stable' : 'unstable',
      elapsed: d.elapsedMs || 0,
      process: d.processText || null
    };
  }

  /**
   * 标准化队列结果
   * @private
   * @param {any} data - 原始数据
   * @returns {object} 标准化的队列结果
   */
  _normalizeQueueResult(data) {
    const d = _unwrap(data);
    if (d.ok === false || d.error) {
      return {
        ok: false,
        error: d.error || 'TASK_FAILED',
        code: d.code || null,
        message: d.message || null,
        status: d.status || 'failed'
      };
    }
    return {
      ok: true,
      queued: true,
      taskId: d.taskId,
      status: d.status,
      queue: d.queueDetails || null
    };
  }

  /**
   * 标准化轮询结果
   * @private
   * @param {any} data - 原始数据
   * @returns {object} 标准化的轮询结果
   */
  _normalizePollResult(data) {
    const d = _unwrap(data);
    const status = d.status || 'queued';

    const result = { ok: true, status };

    if (status === 'done' && d.result) {
      result.text = d.result.text;
      result.elapsed = d.result.elapsedMs;
    }

    if (d.elapsed) {
      result.elapsed = d.elapsed;
    }

    if (d.error) {
      result.error = d.error;
      result.ok = false;
    }

    return result;
  }

  /**
   * 标准化取消结果
   * @private
   * @param {any} data - 原始数据
   * @returns {object} 标准化的取消结果
   */
  _normalizeCancelResult(_data) {
    return { ok: true, cancelled: true };
  }

  /**
   * 标准化设置结果
   * @private
   * @param {any} data - 原始数据
   * @returns {object} 标准化的设置结果
   */
  _normalizeSettings(data) {
    const d = _unwrap(data);
    return { ok: true, section: d.section || null, content: d };
  }

  /**
   * 标准化设置项结果
   * @private
   * @param {any} data - 原始数据
   * @returns {object} 标准化的设置项结果
   */
  _normalizeSetResult(data) {
    const d = _unwrap(data);
    return { ok: true, label: d.label, value: d.value };
  }

  /**
   * 标准化批准结果
   * @private
   * @param {any} data - 原始数据
   * @returns {object} 标准化的批准结果
   */
  _normalizeApproveResult(data) {
    const d = _unwrap(data);
    return {
      ok: true,
      success: d.success,
      action: d.action,
      clicked: d.buttonClicked || null,
      requiresAgentReview: d.requiresAgentReview === true,
      risk: d.risk || null,
      reasonCodes: d.reasonCodes || [],
      command: d.command || null
    };
  }

  /**
   * 标准化对话框状态
   * @private
   * @param {any} data - 原始数据
   * @returns {object} 标准化的对话框状态
   */
  _normalizeDialogStatus(data) {
    const d = _unwrap(data);
    return {
      ok: true,
      hasDialog: d.hasDialog || false,
      type: d.dialogType || null,
      question: d.question || null,
      buttons: d.buttons || [],
      canAutoApprove: d.canAutoApprove === true,
      approvalDecision: d.approvalDecision || null,
      risk: d.commandRisk || null,
      reasonCodes: d.riskReasons || [],
      command: d.command || null
    };
  }

  /**
   * 标准化队列状态
   * @private
   * @param {any} data - 原始数据
   * @returns {object} 标准化的队列状态
   */
  _normalizeQueueStatus(data) {
    const d = _unwrap(data);
    return {
      ok: true,
      queued: d.queued || false,
      position: d.position || null,
      message: d.message || null
    };
  }

  /**
   * 标准化模型名称（支持模糊匹配）。
   * 匹配优先级：精确（忽略大小写）> 前缀 > 子串；同层取首个匹配。
   * 优先精确匹配可避免短输入被歧义子串结果抢先返回。
   * @private
   * @param {string} model - 模型名称
   * @returns {string|null} 标准化的模型名称或 null
   */
  _normalizeModel(model) {
    if (!model || typeof model !== 'string') return null;
    const m = model.toLowerCase();

    // 1. 精确匹配（忽略大小写）
    for (const known of KNOWN_MODELS) {
      if (known.toLowerCase() === m) return known;
    }

    // 2. 前缀匹配（请求是已知模型名的前缀）
    for (const known of KNOWN_MODELS) {
      if (known.toLowerCase().startsWith(m)) return known;
    }

    // 3. 子串匹配（请求是已知模型名的子串）
    for (const known of KNOWN_MODELS) {
      if (known.toLowerCase().includes(m)) return known;
    }

    return null;
  }

  /**
   * 标准化设置区域
   * @private
   * @param {string|null} section - 区域名称
   * @returns {string|null} 标准化的区域名称
   */
  _normalizeSection(section) {
    if (!section) return null;
    return SETTINGS_SECTIONS[section.toLowerCase()] || section;
  }

  /**
   * 延时等待
   * @private
   * @param {number} ms - 毫秒数
   * @returns {Promise<void>}
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 委托任务并轮询完成
   * @private
   * @param {string} task - 任务描述
   * @param {object} delegateOpts - 透传给 client.delegate 的选项
   * @param {object} [pollOpts] - 轮询控制参数
   * @param {number} [pollOpts.pollMaxAttempts] - 最大轮询次数
   * @param {number} [pollOpts.pollIntervalMs] - 轮询间隔毫秒
   * @returns {Promise<any>} 任务结果
   */
  async _delegateWithPoll(task, delegateOpts, pollOpts = {}) {
    const result = await this.client.delegate(task, delegateOpts);

    const d = _unwrap(result);

    if (d.status === 'queued') {
      const taskId = d.taskId;
      // 记住 taskId，使后续 poll()/cancel()/wait() 无需显式传参即可复用
      if (taskId) this._lastTaskId = taskId;
      const maxAttempts = pollOpts.pollMaxAttempts || DEFAULT_POLL_MAX_ATTEMPTS;
      const interval = pollOpts.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;

      for (let i = 0; i < maxAttempts; i++) {
        await this._sleep(interval);
        const poll = await this.client.getTaskStatus(taskId);
        const pd = _unwrap(poll);
        const status = pd.status;

        if (status === 'done') {
          return pd.result || pd;
        }

        if (status === 'error' || status === 'queue_timeout' || status === 'cancelled') {
          return poll;
        }
      }

      throw TraeCNSkillError.queueTimeout(taskId, maxAttempts);
    }

    return result;
  }

  /**
   * 从用户选项构建同步 delegate 调用的选项对象。
   * 集中映射避免 run/queue 两处分别罗列导致漂移。
   * @private
   * @param {object} opts - 用户运行选项
   * @param {object} [overrides] - 额外覆盖字段
   * @returns {object} delegate 选项
   */
  _buildDelegateOptions(opts, overrides = {}) {
    return {
      projectPath: opts.projectPath,
      includeProcessText: opts.includeProcess,
      reviewRequired: opts.reviewRequired,
      autoContinue: opts.autoContinue,
      followupTasks: opts.followupTasks,
      completionChecks: opts.completionChecks,
      notifyUrl: opts.notifyUrl,
      fallbackModels: opts.fallbackModels,
      autoModelFallback: opts.autoModelFallback,
      modelProbeIntervalMs: opts.modelProbeIntervalMs,
      ...overrides
    };
  }

  /**
   * 从用户选项构建异步 delegateAsync 调用的选项对象。
   * @private
   * @param {object} opts - 用户队列选项
   * @param {object} [overrides] - 额外覆盖字段
   * @returns {object} delegateAsync 选项
   */
  _buildQueueOptions(opts, overrides = {}) {
    return {
      projectPath: opts.projectPath,
      chatId: opts.chatId,
      waitForQueue: opts.waitForQueue !== false,
      background: opts.background,
      forceBackground: opts.forceBackground,
      reviewRequired: opts.reviewRequired,
      autoContinue: opts.autoContinue,
      followupTasks: opts.followupTasks,
      completionChecks: opts.completionChecks,
      autoApproveDialog: opts.autoApproveDialog,
      notifyUrl: opts.notifyUrl,
      fallbackModels: opts.fallbackModels,
      autoModelFallback: opts.autoModelFallback,
      modelProbeIntervalMs: opts.modelProbeIntervalMs,
      maxQueueWaitMs: opts.maxQueueWaitMs,
      queueMaxWaitMs: opts.queueMaxWaitMs,
      soloChat: opts.soloChat,
      soloChatIndex: opts.soloChatIndex,
      soloChatTitleIncludes: opts.soloChatTitleIncludes,
      soloChatTextIncludes: opts.soloChatTextIncludes,
      newChat: opts.newChat,
      ...overrides
    };
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
