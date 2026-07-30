'use strict';

/**
 * TraeCN Skill - 分层加载架构
 * 遵循 Skills 最佳实践：按需加载，分层暴露
 */

const { TraeCNSkill, TraeCNSkillError } = require('./traecn-skill');
const promptLayers = require('./prompt-layers');

// ============ 核心层 (Core Layer) ============
// 最基础的功能，所有AI都应该使用

function getSkill(context = {}) {
  return TraeCNSkill.getSharedInstance(context);
}

function reset() {
  TraeCNSkill.resetSharedInstance();
}

// ============ 错误映射辅助 ============
//
// 统一 try/catch 模板：保留 TraeCNSkillError（携带稳定错误码），
// 仅把底层抛出的普通 Error 包装成 TASK_FAILED，避免丢失原始错误码。
// 这解决了此前各方法错误处理不一致的问题（如 cancelTask 会把
// TASK_ID_MISSING 重新包装成 TASK_FAILED）。

/**
 * 包装一个异步 skill 调用，统一错误映射。
 * @param {string} message - 失败时的上下文消息前缀
 * @param {object} details - 附加到错误的详情
 * @param {() => Promise} fn - 实际 skill 调用
 * @returns {Promise<any>} 调用结果
 * @private
 */
async function withSkillError(message, details, fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof TraeCNSkillError || (error && error.name === 'TraeCNSkillError')) throw error;
    throw TraeCNSkillError.taskFailed(`${message}: ${error.message}`, details);
  }
}

// ============ 基础层 (Basic Layer) ============
// 覆盖90%使用场景，5个核心函数

async function runTask(task, opts = {}) {
  const skill = getSkill();
  try {
    const result = await skill.run(task, opts);
    if (result.error) {
      throw TraeCNSkillError.taskFailed(result.error, { task });
    }
    return result.text;
  } catch (error) {
    if (error instanceof TraeCNSkillError || (error && error.name === 'TraeCNSkillError')) throw error;
    throw TraeCNSkillError.taskFailed(error.message, { task });
  }
}

async function switchModel(name) {
  const skill = getSkill();
  try {
    return await skill.switchModel(name);
  } catch (error) {
    if (error instanceof TraeCNSkillError || (error && error.name === 'TraeCNSkillError')) throw error;
    throw TraeCNSkillError.taskFailed(`切换模型失败: ${error.message}`, { model: name });
  }
}

async function checkStatus() {
  const skill = getSkill();
  try {
    const status = await skill.status();
    return status.connected;
  } catch {
    return false; // 连接失败返回false，不抛错
  }
}

async function queueTask(task, opts = {}) {
  const skill = getSkill();
  return withSkillError('队列任务失败', { task }, () => skill.queue(task, opts).then(r => r.taskId));
}

async function pollTask(taskId = null) {
  const skill = getSkill();
  return withSkillError('轮询失败', { taskId }, () => skill.poll(taskId));
}

async function waitTask(taskId = null, opts = {}) {
  const skill = getSkill();
  return withSkillError('等待任务失败', { taskId }, () => skill.wait(taskId, opts));
}

async function reviewCode(input, opts = {}) {
  const skill = getSkill();
  return withSkillError('代码审查失败', { input }, async () => {
    const result = await skill.reviewCode(input, opts);
    return opts.queue === true ? result.taskId : result.text;
  });
}

async function preflight(options = {}) {
  const skill = getSkill();
  return withSkillError('预检失败', options, () => skill.preflight(options));
}

// ============ 进阶层 (Advanced Layer) ============
// 需要时才加载，按需导入

const advanced = {
  async cancelTask(taskId = null) {
    const skill = getSkill();
    return withSkillError('取消任务失败', { taskId }, () => skill.cancel(taskId));
  },

  async switchMode(mode) {
    const skill = getSkill();
    // switchMode 现在在类内部校验并抛 INVALID_MODE，这里保留该错误透传
    return withSkillError('切换模式失败', { mode }, () => skill.switchMode(mode));
  },

  async newChat() {
    const skill = getSkill();
    return withSkillError('新建对话失败', {}, () => skill.newChat());
  },

  async listSoloChats() {
    const skill = getSkill();
    return withSkillError('列出 Solo 对话失败', {}, () => skill.listSoloChats());
  },

  async switchSoloChat(criteria = {}) {
    const skill = getSkill();
    return withSkillError('切换 Solo 对话失败', criteria, () => skill.switchSoloChat(criteria));
  },

  async submitSoloChatTask(task, opts = {}) {
    const skill = getSkill();
    return withSkillError('提交 Solo 对话任务失败', { task }, () => skill.submitSoloChatTask(task, opts));
  },

  async openProject(projectPath, options = {}) {
    const skill = getSkill();
    return withSkillError(
      `打开项目失败. 请检查路径是否存在: ${projectPath}`,
      { projectPath, newInstance: options.newInstance === true },
      () => skill.openProject(projectPath, options)
    );
  }
};

// ============ 配置层 (Config Layer) ============
// 设置管理，需要时才使用

const config = {
  async getSettings(section = null) {
    const skill = getSkill();
    return withSkillError(
      '获取设置失败. 可用区域: general, model, agents, mcp, flow',
      { section },
      () => skill.getSettings(section)
    );
  },

  async setSetting(label, value, section = null) {
    const skill = getSkill();
    return withSkillError(
      '设置失败. 请检查设置项名称和区域',
      { label, value, section },
      () => skill.setSetting(label, value, section)
    );
  }
};

// ============ 对话框层 (Dialog Layer) ============
// 对话框处理，特殊情况使用

const dialog = {
  async checkDialog() {
    const skill = getSkill();
    return withSkillError('检查对话框失败', {}, () => skill.checkDialog());
  },

  async approveDialog(action = 'auto', wait = false) {
    const skill = getSkill();
    return withSkillError(
      '批准对话框失败. 可用操作: trust, deny, auto',
      { action },
      () => skill.approveDialog(action, wait)
    );
  },

  async checkQueue() {
    const skill = getSkill();
    return withSkillError('检查队列失败', {}, () => skill.queueStatus());
  }
};

// ============ 批量操作层 (Batch Layer) ============
// 批量处理，高级场景

const batch = {
  async runTasks(tasks, opts = {}) {
    const results = [];
    for (const task of tasks) {
      try {
        const result = await runTask(task, opts);
        results.push({ task, result, success: true });
      } catch (error) {
        results.push({ task, error: error.message, success: false });
      }
    }
    return results;
  },

  async queueTasks(tasks, opts = {}) {
    const taskIds = [];
    for (const task of tasks) {
      try {
        const taskId = await queueTask(task, opts);
        taskIds.push({ task, taskId, success: true });
      } catch (error) {
        taskIds.push({ task, error: error.message, success: false });
      }
    }
    return taskIds;
  },

  async pollTasks(taskIds) {
    const results = [];
    for (const taskId of taskIds) {
      try {
        const result = await pollTask(taskId);
        results.push({ taskId, result, success: true });
      } catch (error) {
        results.push({ taskId, error: error.message, success: false });
      }
    }
    return results;
  }
};

// ============ 别名 (Aliases) ============
// 短名称，用于快速编码

const aliases = {
  t: runTask,
  q: queueTask,
  p: pollTask,
  w: waitTask,
  s: checkStatus,
  pf: preflight,
  model: switchModel,
  mode: advanced.switchMode,
  settings: config.getSettings,
  set: config.setSetting,
  approve: dialog.approveDialog,
  dlg: dialog.checkDialog,
  queue: dialog.checkQueue,
  open: advanced.openProject,
  cancel: advanced.cancelTask,
  soloChats: advanced.listSoloChats,
  soloSwitch: advanced.switchSoloChat,
  soloSubmit: advanced.submitSoloChatTask
};

// ============ 导出 ============

module.exports = {
  // 核心
  getSkill,
  reset,
  TraeCNSkill,
  TraeCNSkillError,

  // 基础层 (推荐)
  runTask,
  switchModel,
  checkStatus,
  queueTask,
  pollTask,
  waitTask,
  reviewCode,
  preflight,
  listSoloChats: advanced.listSoloChats,
  switchSoloChat: advanced.switchSoloChat,
  submitSoloChatTask: advanced.submitSoloChatTask,

  // 进阶层 (按需导入)
  advanced,

  // 配置层 (按需导入)
  config,

  // 对话框层 (按需导入)
  dialog,

  // 批量操作层 (按需导入)
  batch,

  // 别名
  ...aliases,

  // 分层提示词与 MCP 描述
  promptLayers
};
