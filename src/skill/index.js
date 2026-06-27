'use strict';

/**
 * TraeCN Skill - 分层加载架构
 * 遵循 Skills 最佳实践：按需加载，分层暴露
 */

const { TraeCNSkill, TraeCNSkillError } = require('./traecn-skill');
const promptLayers = require('./prompt-layers');
const { buildCodeReviewTask } = require('./review');

// ============ 核心层 (Core Layer) ============
// 最基础的功能，所有AI都应该使用

function getSkill(context = {}) {
  return TraeCNSkill.getSharedInstance(context);
}

function reset() {
  TraeCNSkill.resetSharedInstance();
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
    if (error instanceof TraeCNSkillError) throw error;
    throw TraeCNSkillError.taskFailed(error.message, { task });
  }
}

async function switchModel(name) {
  const skill = getSkill();
  try {
    return await skill.switchModel(name);
  } catch (error) {
    if (error.code === 'UNKNOWN_MODEL') {
      throw error; // 保留原始错误，包含可用模型列表
    }
    throw TraeCNSkillError.taskFailed(`切换模型失败: ${error.message}`, { model: name });
  }
}

async function checkStatus() {
  const skill = getSkill();
  try {
    const status = await skill.status();
    return status.connected;
  } catch (error) {
    return false; // 连接失败返回false，不抛错
  }
}

async function queueTask(task, opts = {}) {
  const skill = getSkill();
  try {
    const result = await skill.queue(task, opts);
    return result.taskId;
  } catch (error) {
    throw TraeCNSkillError.taskFailed(`队列任务失败: ${error.message}`, { task });
  }
}

async function pollTask(taskId = null) {
  const skill = getSkill();
  try {
    return await skill.poll(taskId);
  } catch (error) {
    if (error.code === 'TASK_ID_MISSING') {
      throw error; // 保留原始错误
    }
    throw TraeCNSkillError.taskFailed(`轮询失败: ${error.message}`, { taskId });
  }
}

async function waitTask(taskId = null, opts = {}) {
  const skill = getSkill();
  try {
    return await skill.wait(taskId, opts);
  } catch (error) {
    if (error.code === 'TASK_ID_MISSING') {
      throw error; // 保留原始错误
    }
    throw TraeCNSkillError.taskFailed(`等待任务失败: ${error.message}`, { taskId });
  }
}

async function reviewCode(input, opts = {}) {
  const skill = getSkill();
  try {
    const result = await skill.reviewCode(input, opts);
    return opts.queue === true ? result.taskId : result.text;
  } catch (error) {
    throw TraeCNSkillError.taskFailed(`代码审查失败: ${error.message}`, { input });
  }
}

async function preflight(options = {}) {
  const skill = getSkill();
  try {
    return await skill.preflight(options);
  } catch (error) {
    throw TraeCNSkillError.taskFailed(`预检失败: ${error.message}`, options);
  }
}

// ============ 进阶层 (Advanced Layer) ============
// 需要时才加载，按需导入

const advanced = {
  async cancelTask(taskId = null) {
    const skill = getSkill();
    try {
      return await skill.cancel(taskId);
    } catch (error) {
      throw TraeCNSkillError.taskFailed(`取消任务失败: ${error.message}`, { taskId });
    }
  },

  async switchMode(mode) {
    const skill = getSkill();
    try {
      return await skill.switchMode(mode);
    } catch (error) {
      throw TraeCNSkillError.invalidMode(mode, ['solo', 'ide']);
    }
  },

  async newChat() {
    const skill = getSkill();
    try {
      return await skill.newChat();
    } catch (error) {
      throw TraeCNSkillError.taskFailed(`新建对话失败: ${error.message}`);
    }
  },

  async listSoloChats() {
    const skill = getSkill();
    try {
      return await skill.listSoloChats();
    } catch (error) {
      throw TraeCNSkillError.taskFailed(`列出 Solo 对话失败: ${error.message}`);
    }
  },

  async switchSoloChat(criteria = {}) {
    const skill = getSkill();
    try {
      return await skill.switchSoloChat(criteria);
    } catch (error) {
      throw TraeCNSkillError.taskFailed(`切换 Solo 对话失败: ${error.message}`, criteria);
    }
  },

  async submitSoloChatTask(task, opts = {}) {
    const skill = getSkill();
    try {
      return await skill.submitSoloChatTask(task, opts);
    } catch (error) {
      throw TraeCNSkillError.taskFailed(`提交 Solo 对话任务失败: ${error.message}`, { task });
    }
  },

  async openProject(projectPath) {
    const skill = getSkill();
    try {
      return await skill.openProject(projectPath);
    } catch (error) {
      throw TraeCNSkillError.taskFailed(
        `打开项目失败: ${error.message}. 请检查路径是否存在: ${projectPath}`,
        { projectPath }
      );
    }
  }
};

// ============ 配置层 (Config Layer) ============
// 设置管理，需要时才使用

const config = {
  async getSettings(section = null) {
    const skill = getSkill();
    try {
      return await skill.getSettings(section);
    } catch (error) {
      throw TraeCNSkillError.taskFailed(
        `获取设置失败: ${error.message}. 可用区域: general, model, agents, mcp, flow`,
        { section }
      );
    }
  },

  async setSetting(label, value, section = null) {
    const skill = getSkill();
    try {
      return await skill.setSetting(label, value, section);
    } catch (error) {
      throw TraeCNSkillError.taskFailed(
        `设置失败: ${error.message}. 请检查设置项名称和区域`,
        { label, value, section }
      );
    }
  }
};

// ============ 对话框层 (Dialog Layer) ============
// 对话框处理，特殊情况使用

const dialog = {
  async checkDialog() {
    const skill = getSkill();
    try {
      return await skill.checkDialog();
    } catch (error) {
      throw TraeCNSkillError.taskFailed(`检查对话框失败: ${error.message}`);
    }
  },

  async approveDialog(action = 'auto', wait = false) {
    const skill = getSkill();
    try {
      return await skill.approveDialog(action, wait);
    } catch (error) {
      throw TraeCNSkillError.taskFailed(
        `批准对话框失败: ${error.message}. 可用操作: trust, deny, auto`,
        { action }
      );
    }
  },

  async checkQueue() {
    const skill = getSkill();
    try {
      return await skill.queueStatus();
    } catch (error) {
      throw TraeCNSkillError.taskFailed(`检查队列失败: ${error.message}`);
    }
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
