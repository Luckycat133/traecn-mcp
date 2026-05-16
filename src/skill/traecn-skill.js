'use strict';

const { TraeCNApiClient } = require('../../integrations/openclaw-traecn-plugin/lib/traecnapi-client');
const { TraeCNSkillError } = require('./errors');

/** 已知支持的模型列表 */
const KNOWN_MODELS = [
  'Doubao-Seed-2.0-Code',
  'Doubao-Seed-1.8',
  'GLM-5.1',
  'DeepSeek-V3.1-Terminus',
  'MiniMax-M2.7',
  'MiniMax-M2.5',
  'Kimi-K2.5',
  'Qwen3.6-Plus',
  'Qwen3.5-Plus'
];

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

/** 有效模式列表 */
const VALID_MODES = ['solo', 'ide'];

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
   * 运行任务
   * @param {string} task - 任务描述
   * @param {object} [opts={}] - 运行选项
   * @param {string} [opts.projectPath] - 项目路径
   * @param {boolean} [opts.includeProcess] - 是否包含过程信息
   * @param {boolean} [opts.autoWait=true] - 是否自动等待队列
   * @param {string} [opts.mode] - 模式 ('solo' 或 'ide')
   * @returns {Promise<object>} 运行结果
   */
  async run(task, opts = {}) {
    const { projectPath, includeProcess, autoWait = true, mode = null } = opts;

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

    try {
      let result;
      
      if (autoWait) {
        result = await this._delegateWithPoll(task, { 
          projectPath, 
          sessionId: this._sessionId, 
          includeProcess 
        });
      } else {
        result = await this.client.delegate(task, {
          projectPath,
          sessionId: this._sessionId,
          includeProcessText: includeProcess
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
   * 队列任务（异步执行）
   * @param {string} task - 任务描述
   * @param {object} [opts={}] - 运行选项
   * @param {string} [opts.projectPath] - 项目路径
   * @returns {Promise<object>} 队列结果
   */
  async queue(task, opts = {}) {
    const { projectPath } = opts;
    
    try {
      const result = await this.client.delegateAsync(task, {
        projectPath,
        sessionId: this._sessionId,
        waitForQueue: true
      });

      this._lastTaskId = result.taskId || result.data?.taskId;
      return this._normalizeQueueResult(result);
    } catch (cause) {
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

  /**
   * 切换模式
   * @param {string} mode - 模式名称 ('solo' 或 'ide')
   * @returns {Promise<object>} 切换结果
   */
  async switchMode(mode) {
    const validMode = mode.toLowerCase() === 'ide' ? 'ide' : 'solo';
    return await this.client.switchMode(validMode);
  }

  /**
   * 切换模型
   * @param {string} model - 模型名称（支持模糊匹配）
   * @returns {Promise<object>} 切换结果
   * @throws {TraeCNSkillError} 如果模型未知
   */
  async switchModel(model) {
    const normalized = this._normalizeModel(model);
    if (!normalized) {
      throw TraeCNSkillError.unknownModel(model, KNOWN_MODELS);
    }
    return await this.client.switchModel(normalized);
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
   * @returns {Promise<object>} 打开结果
   */
  async openProject(projectPath) {
    return await this.client.openProject(projectPath);
  }

  /**
   * 标准化状态数据
   * @private
   * @param {any} data - 原始数据
   * @returns {object} 标准化的状态
   */
  _normalizeStatus(data) {
    const d = data.data || data;
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
    const d = data.data || data;
    
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
    const d = data.data || data;
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
    const d = data.data || data;
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
  _normalizeCancelResult(data) {
    const d = data.data || data;
    return { ok: true, cancelled: true };
  }

  /**
   * 标准化设置结果
   * @private
   * @param {any} data - 原始数据
   * @returns {object} 标准化的设置结果
   */
  _normalizeSettings(data) {
    const d = data.data || data;
    return { ok: true, section: d.section || null, content: d };
  }

  /**
   * 标准化设置项结果
   * @private
   * @param {any} data - 原始数据
   * @returns {object} 标准化的设置项结果
   */
  _normalizeSetResult(data) {
    const d = data.data || data;
    return { ok: true, label: d.label, value: d.value };
  }

  /**
   * 标准化批准结果
   * @private
   * @param {any} data - 原始数据
   * @returns {object} 标准化的批准结果
   */
  _normalizeApproveResult(data) {
    const d = data.data || data;
    return {
      ok: true,
      success: d.success,
      action: d.action,
      clicked: d.buttonClicked || null
    };
  }

  /**
   * 标准化对话框状态
   * @private
   * @param {any} data - 原始数据
   * @returns {object} 标准化的对话框状态
   */
  _normalizeDialogStatus(data) {
    const d = data.data || data;
    return {
      ok: true,
      hasDialog: d.hasDialog || false,
      type: d.dialogType || null,
      question: d.question || null,
      buttons: d.buttons || []
    };
  }

  /**
   * 标准化队列状态
   * @private
   * @param {any} data - 原始数据
   * @returns {object} 标准化的队列状态
   */
  _normalizeQueueStatus(data) {
    const d = data.data || data;
    return {
      ok: true,
      queued: d.queued || false,
      position: d.position || null,
      message: d.message || null
    };
  }

  /**
   * 标准化模型名称（支持模糊匹配）
   * @private
   * @param {string} model - 模型名称
   * @returns {string|null} 标准化的模型名称或 null
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
   * @param {object} opts - 选项
   * @returns {Promise<any>} 任务结果
   */
  async _delegateWithPoll(task, opts) {
    const { projectPath, sessionId, includeProcess } = opts;

    let result = await this.client.delegate(task, {
      projectPath,
      sessionId,
      includeProcessText: includeProcess
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
}

module.exports = { TraeCNSkill, KNOWN_MODELS, SETTINGS_SECTIONS, TraeCNSkillError };
