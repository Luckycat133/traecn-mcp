'use strict';

/**
 * 从 cause 中提取可读消息，兼容 Error 实例与字符串。
 * @param {Error|string|any} cause - 错误原因
 * @returns {string} 可读消息
 * @private
 */
function _causeMessage(cause) {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/**
 * TraeCN Skill 错误基类
 * 提供统一的错误处理机制
 */
class TraeCNSkillError extends Error {
  /**
   * 创建 TraeCNSkillError 实例
   * @param {string} message - 错误消息
   * @param {string} code - 错误代码
   * @param {object} [details] - 错误详情
   */
  constructor(message, code, details) {
    super(message);
    this.name = 'TraeCNSkillError';
    this.code = code;
    this.details = details || {};
  }

  /**
   * 任务 ID 缺失错误
   * @returns {TraeCNSkillError}
   */
  static taskIdMissing() {
    return new TraeCNSkillError(
      'No taskId available. Set taskId or call queue/run first.',
      'TASK_ID_MISSING'
    );
  }

  /**
   * 未知模型错误
   * @param {string} model - 请求的模型名称
   * @param {string[]} availableModels - 可用模型列表
   * @returns {TraeCNSkillError}
   */
  static unknownModel(model, availableModels) {
    return new TraeCNSkillError(
      `Unknown model: ${model}. Available: ${availableModels.join(', ')}`,
      'UNKNOWN_MODEL',
      { model, availableModels }
    );
  }

  /**
   * 无效模式错误
   * @param {string} mode - 请求的模式
   * @param {string[]} validModes - 有效模式列表
   * @returns {TraeCNSkillError}
   */
  static invalidMode(mode, validModes) {
    return new TraeCNSkillError(
      `Invalid mode: ${mode}. Valid modes: ${validModes.join(', ')}`,
      'INVALID_MODE',
      { mode, validModes }
    );
  }

  /**
   * 任务执行错误
   * @param {Error|string|any} cause - 错误原因（Error 实例或字符串）
   * @param {object} [details] - 附加详情
   * @returns {TraeCNSkillError}
   */
  static taskFailed(cause, details) {
    return new TraeCNSkillError(
      `Task failed: ${_causeMessage(cause)}`,
      'TASK_FAILED',
      { cause, ...details }
    );
  }

  /**
   * 任务参数缺失错误
   * @param {string} [details] - 附加详情（如缺失字段名）
   * @returns {TraeCNSkillError}
   */
  static taskRequired(details) {
    return new TraeCNSkillError(
      'Task input is required. Provide a non-empty task string.',
      'TASK_REQUIRED',
      details || {}
    );
  }

  /**
   * 队列超时错误
   * @param {string} taskId - 任务 ID
   * @param {number} attempts - 尝试次数
   * @returns {TraeCNSkillError}
   */
  static queueTimeout(taskId, attempts) {
    return new TraeCNSkillError(
      `Queue timeout for task ${taskId} after ${attempts} attempts`,
      'QUEUE_TIMEOUT',
      { taskId, attempts }
    );
  }

  /**
   * 连接错误
   * @param {Error|string|any} cause - 错误原因
   * @returns {TraeCNSkillError}
   */
  static connectionError(cause) {
    return new TraeCNSkillError(
      `Connection error: ${_causeMessage(cause)}`,
      'CONNECTION_ERROR',
      { cause: _causeMessage(cause) }
    );
  }
}

module.exports = { TraeCNSkillError };
