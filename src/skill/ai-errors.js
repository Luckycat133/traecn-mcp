'use strict';

/**
 * AI 友好的错误处理模块
 * 提供可直接执行的解决方案，减少人类干预
 */

class AIFriendlyError extends Error {
  constructor(message, code, solutions = [], autoFix = null) {
    super(message);
    this.name = 'AIFriendlyError';
    this.code = code;
    this.solutions = solutions;  // AI 可以尝试的解决方案
    this.autoFix = autoFix;      // 自动修复函数（如果可用）
  }

  /**
   * 获取第一个可用的解决方案
   */
  getFirstSolution() {
    return this.solutions[0] || null;
  }

  /**
   * 尝试自动修复
   */
  async tryAutoFix() {
    if (this.autoFix) {
      try {
        return await this.autoFix();
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    return { success: false, error: 'No auto-fix available' };
  }

  /**
   * 生成 AI 可读的报告
   */
  toAIReport() {
    return {
      error: this.message,
      code: this.code,
      canAutoFix: !!this.autoFix,
      solutions: this.solutions,
      suggestion: this.solutions[0] || '请检查配置或联系管理员'
    };
  }
}

// ============ 预定义错误及解决方案 ============

const Errors = {
  /**
   * 连接错误
   */
  connectionFailed: (details) => new AIFriendlyError(
    `无法连接到 TraeCN: ${details}. 请确保 TraeCN IDE 正在运行。`,
    'CONNECTION_FAILED',
    [
      '1. 检查 TraeCN IDE 是否已启动',
      '2. 检查端口 9222 是否被占用',
      '3. 尝试重启 TraeCN IDE',
      '4. 检查环境变量 TRAECN_URL 是否正确'
    ],
    async () => {
      // 自动修复：尝试重新连接
      const { checkStatus } = require('./index');
      await new Promise(r => setTimeout(r, 2000));
      return await checkStatus();
    }
  ),

  /**
   * 任务执行失败
   */
  taskExecutionFailed: (task, reason) => new AIFriendlyError(
    `任务执行失败: ${reason}`,
    'TASK_EXECUTION_FAILED',
    [
      '1. 检查任务描述是否清晰',
      '2. 尝试简化任务',
      '3. 使用 queueTask 代替 runTask 处理长时间任务',
      '4. 检查当前模型是否支持该任务类型'
    ]
  ),

  /**
   * 模型切换失败
   */
  modelSwitchFailed: (model, availableModels) => new AIFriendlyError(
    `无法切换到模型 "${model}"。可用模型: ${availableModels.join(', ')}`,
    'MODEL_SWITCH_FAILED',
    [
      `1. 尝试使用模糊匹配: "${model.toLowerCase().slice(0, 3)}"`,
      '2. 使用 checkStatus() 确认连接正常',
      '3. 尝试其他模型',
      `4. 可用模型: ${availableModels.slice(0, 3).join(', ')}...`
    ]
  ),

  /**
   * 任务 ID 缺失
   */
  taskIdMissing: () => new AIFriendlyError(
    '缺少任务 ID。请先调用 runTask() 或 queueTask() 获取任务 ID。',
    'TASK_ID_MISSING',
    [
      '1. 先调用 runTask() 执行任务',
      '2. 或使用 queueTask() 获取 taskId',
      '3. 保存返回的 taskId 用于后续轮询',
      '示例: const taskId = await queueTask("任务"); await pollTask(taskId);'
    ]
  ),

  /**
   * 队列超时
   */
  queueTimeout: (taskId, waitTime) => new AIFriendlyError(
    `任务 ${taskId} 队列超时（已等待 ${waitTime}ms）。任务仍在队列中。`,
    'QUEUE_TIMEOUT',
    [
      '1. 继续使用 pollTask(taskId) 轮询状态',
      '2. 任务完成后会自动返回结果',
      '3. 或使用 cancelTask(taskId) 取消任务',
      '4. 检查队列状态: await checkQueue()'
    ],
    async () => {
      // 自动修复：继续轮询
      const { pollTask } = require('./index');
      return await pollTask(taskId);
    }
  ),

  /**
   * 设置失败
   */
  settingFailed: (label, section) => new AIFriendlyError(
    `设置 "${label}" 失败。区域: ${section || 'default'}`,
    'SETTING_FAILED',
    [
      '1. 检查设置项名称是否正确',
      '2. 使用 getSettings() 查看可用设置',
      '3. 尝试使用英文设置名称',
      '4. 可用区域: general, model, agents, mcp, flow'
    ]
  ),

  /**
   * 项目打开失败
   */
  projectOpenFailed: (path) => new AIFriendlyError(
    `无法打开项目: ${path}`,
    'PROJECT_OPEN_FAILED',
    [
      `1. 检查路径是否存在: ls -la "${path}"`,
      '2. 检查路径是否为绝对路径',
      '3. 检查是否有权限访问该路径',
      '4. 尝试使用相对路径: ./project-name'
    ]
  ),

  /**
   * 对话框处理失败
   */
  dialogHandlingFailed: (action) => new AIFriendlyError(
    `对话框处理失败。操作: ${action}`,
    'DIALOG_HANDLING_FAILED',
    [
      '1. 先使用 checkDialog() 检查对话框状态',
      '2. 可用操作: trust（信任）, deny（拒绝）, auto（自动）',
      '3. 设置 wait=true 等待对话框出现',
      '4. 示例: await approveDialog("trust", true)'
    ]
  ),

  /**
   * 无效模式
   */
  invalidMode: (mode) => new AIFriendlyError(
    `无效模式: "${mode}"。可用模式: solo, ide`,
    'INVALID_MODE',
    [
      '1. 使用 "solo" 切换到独立模式',
      '2. 使用 "ide" 切换到 IDE 模式',
      '3. 模式名称不区分大小写',
      '示例: await switchMode("ide")'
    ]
  ),

  /**
   * 认证失败
   */
  authenticationFailed: () => new AIFriendlyError(
    '认证失败。API 密钥无效或已过期。',
    'AUTHENTICATION_FAILED',
    [
      '1. 检查环境变量 TRAECN_API_KEY 是否设置',
      '2. 检查 API 密钥是否过期',
      '3. 尝试重新生成 API 密钥',
      '4. 检查请求签名是否正确'
    ]
  ),

  /**
   * 速率限制
   */
  rateLimitExceeded: (retryAfter) => new AIFriendlyError(
    `请求过于频繁。请在 ${retryAfter}ms 后重试。`,
    'RATE_LIMIT_EXCEEDED',
    [
      `1. 等待 ${retryAfter}ms 后重试`,
      '2. 使用 queueTask() 将任务加入队列',
      '3. 减少并发请求数量',
      '4. 批量处理任务而不是逐个发送'
    ],
    async () => {
      // 自动修复：等待后重试
      await new Promise(r => setTimeout(r, retryAfter));
      return { success: true, message: 'Waited for rate limit' };
    }
  ),

  /**
   * 未知错误
   */
  unknownError: (error) => new AIFriendlyError(
    `发生未知错误: ${error.message || error}`,
    'UNKNOWN_ERROR',
    [
      '1. 检查错误日志获取详细信息',
      '2. 尝试重置连接: reset()',
      '3. 重启 TraeCN IDE',
      '4. 检查网络连接'
    ],
    async () => {
      // 自动修复：重置并重试
      const { reset, checkStatus } = require('./index');
      reset();
      await new Promise(r => setTimeout(r, 1000));
      return await checkStatus();
    }
  )
};

// ============ 错误处理器 ============

class AIErrorHandler {
  constructor() {
    this.errorHistory = [];
    this.maxHistory = 10;
  }

  /**
   * 处理错误并返回 AI 友好的响应
   */
  handle(error, context = {}) {
    // 记录错误
    this.errorHistory.push({
      error: error.message,
      code: error.code,
      context,
      timestamp: new Date().toISOString()
    });

    // 保持历史记录大小
    if (this.errorHistory.length > this.maxHistory) {
      this.errorHistory.shift();
    }

    // 如果已经是 AI 友好错误，直接返回
    if (error instanceof AIFriendlyError) {
      return error.toAIReport();
    }

    // 根据错误类型创建对应的 AI 友好错误
    const aiError = this.classifyError(error, context);
    return aiError.toAIReport();
  }

  /**
   * 分类错误并创建对应的 AI 友好错误
   */
  classifyError(error, context) {
    const message = error.message || String(error);
    const code = error.code || 'UNKNOWN';

    // 连接错误
    if (message.includes('connect') || message.includes('ECONNREFUSED') || code === 'CONNECTION_ERROR') {
      return Errors.connectionFailed(message);
    }

    // 模型错误
    if (message.includes('model') || code === 'UNKNOWN_MODEL') {
      return Errors.modelSwitchFailed(context.model || 'unknown', context.availableModels || []);
    }

    // 任务 ID 缺失
    if (message.includes('taskId') || code === 'TASK_ID_MISSING') {
      return Errors.taskIdMissing();
    }

    // 队列超时
    if (message.includes('timeout') || message.includes('queue') || code === 'QUEUE_TIMEOUT') {
      return Errors.queueTimeout(context.taskId, context.waitTime || 0);
    }

    // 设置错误
    if (message.includes('setting') || code === 'SETTING_FAILED') {
      return Errors.settingFailed(context.label, context.section);
    }

    // 项目错误
    if (message.includes('project') || message.includes('path') || code === 'PROJECT_OPEN_FAILED') {
      return Errors.projectOpenFailed(context.path);
    }

    // 对话框错误
    if (message.includes('dialog') || code === 'DIALOG_HANDLING_FAILED') {
      return Errors.dialogHandlingFailed(context.action);
    }

    // 模式错误
    if (message.includes('mode') || code === 'INVALID_MODE') {
      return Errors.invalidMode(context.mode);
    }

    // 认证错误
    if (message.includes('auth') || message.includes('key') || message.includes('token') || code === 'AUTHENTICATION_FAILED') {
      return Errors.authenticationFailed();
    }

    // 速率限制
    if (message.includes('rate') || message.includes('limit') || code === 'RATE_LIMIT_EXCEEDED') {
      return Errors.rateLimitExceeded(context.retryAfter || 5000);
    }

    // 默认：未知错误
    return Errors.unknownError(error);
  }

  /**
   * 获取错误历史
   */
  getHistory() {
    return this.errorHistory;
  }

  /**
   * 清除历史
   */
  clearHistory() {
    this.errorHistory = [];
  }

  /**
   * 分析错误模式
   */
  analyzePatterns() {
    const patterns = {};
    for (const entry of this.errorHistory) {
      patterns[entry.code] = (patterns[entry.code] || 0) + 1;
    }
    return patterns;
  }
}

// ============ 导出 ============

module.exports = {
  AIFriendlyError,
  AIErrorHandler,
  Errors
};
