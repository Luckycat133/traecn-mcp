'use strict';

const { composeTraeCNPrompt } = require('../../../src/skill/prompt-layers');
const { buildCodeReviewTask } = require('../../../src/skill/review');
const { buildCapabilities } = require('../../../src/shared/capabilities');
const { buildConfirmationPlan } = require('../../../src/shared/operation-confirmation');

const COMMANDS = Object.freeze({
  CAPABILITIES: 'capabilities',
  PREFLIGHT: 'preflight',
  CONFIRM_PLAN: 'confirm_plan',
  STATUS: 'status',
  READINESS: 'readiness',
  NEW_CHAT: 'new_chat',
  DELEGATE: 'delegate',
  DELEGATE_ASYNC: 'delegate_async',
  TASK_STATUS: 'task_status',
  CANCEL_TASK: 'cancel_task',
  SWITCH_MODE: 'switch_mode',
  SWITCH_MODEL: 'switch_model',
  QUEUE_STATUS: 'queue_status',
  OPEN_PROJECT: 'open_project',
  SETTINGS_READ: 'settings_read',
  SETTINGS_READ_ALL: 'settings_read_all',
  SETTINGS_SET: 'settings_set',
  SETTINGS_NAVIGATE: 'settings_navigate',
  SETTINGS_BACK: 'settings_back',
  DIALOG_STATUS: 'dialog_status',
  APPROVE_DIALOG: 'approve_dialog',
  DISMISS_DIALOG: 'dismiss_dialog',
  BATCH_SUBMIT: 'batch_submit',
  BATCH_STATUS: 'batch_status',
  BATCH_CANCEL: 'batch_cancel',
  REVIEW_CODE: 'review_code'
});

const COMMAND_DEFINITIONS = Object.freeze([
  {
    command: COMMANDS.CAPABILITIES,
    summary: '返回面向 agent 的紧凑能力目录，用于低 token 发现 HTTP、MCP、命令和 TraeCN 控制范围',
    required: [],
    optional: []
  },
  {
    command: COMMANDS.PREFLIGHT,
    summary: '一次性返回状态、就绪度、队列、弹窗和可选命令确认计划，减少 agent 的预检 token 与往返',
    required: [],
    optional: ['command', 'params', 'forceConfirm']
  },
  {
    command: COMMANDS.CONFIRM_PLAN,
    summary: '为即将执行的命令生成副作用、风险等级、确认要求和预检步骤，不执行实际操作',
    required: ['command'],
    optional: ['params', 'forceConfirm']
  },
  {
    command: COMMANDS.STATUS,
    summary: '检查 TraeCNclaw 网关和 TraeCN 自动化状态',
    required: [],
    optional: ['allowAutoStart']
  },
  {
    command: COMMANDS.READINESS,
    summary: '检查 TraeCN 输入框、发送按钮、响应区域等关键 UI 就绪状态',
    required: [],
    optional: []
  },
  {
    command: COMMANDS.NEW_CHAT,
    summary: '在 TraeCN 中创建并切换到一个新对话',
    required: [],
    optional: ['allowAutoStart']
  },
  {
    command: COMMANDS.DELEGATE,
    summary: '向 TraeCN 发送任务并等待最终响应',
    required: ['task'],
    optional: ['projectPath', 'sessionId', 'allowAutoStart', 'includeProcessText', 'waitForQueue']
  },
  {
    command: COMMANDS.DELEGATE_ASYNC,
    summary: '向 TraeCN 提交异步任务，返回 taskId 或直接返回结果',
    required: ['task'],
    optional: ['chatId', 'includeProcessText', 'waitForQueue']
  },
  {
    command: COMMANDS.TASK_STATUS,
    summary: '查询异步任务状态',
    required: ['taskId'],
    optional: []
  },
  {
    command: COMMANDS.CANCEL_TASK,
    summary: '取消仍在排队的异步任务',
    required: ['taskId'],
    optional: []
  },
  {
    command: COMMANDS.SWITCH_MODE,
    summary: '切换 TraeCN SOLO/IDE 模式',
    required: ['mode'],
    optional: ['allowAutoStart']
  },
  {
    command: COMMANDS.SWITCH_MODEL,
    summary: '切换 TraeCN 当前模型',
    required: ['model'],
    optional: []
  },
  {
    command: COMMANDS.QUEUE_STATUS,
    summary: '检查当前模型是否排队或忙碌',
    required: [],
    optional: []
  },
  {
    command: COMMANDS.OPEN_PROJECT,
    summary: '让 TraeCN 打开指定本地项目路径',
    required: ['projectPath'],
    optional: []
  },
  {
    command: COMMANDS.SETTINGS_READ,
    summary: '读取设置页当前或指定分区内容',
    required: [],
    optional: ['section']
  },
  {
    command: COMMANDS.SETTINGS_READ_ALL,
    summary: '读取所有设置分区快照',
    required: [],
    optional: []
  },
  {
    command: COMMANDS.SETTINGS_SET,
    summary: '按设置项标签写入字符串、布尔值或下拉选项',
    required: ['label', 'value'],
    optional: ['section', 'confirmationId', 'requireConfirmation']
  },
  {
    command: COMMANDS.SETTINGS_NAVIGATE,
    summary: '跳转到设置页指定分区',
    required: ['section'],
    optional: []
  },
  {
    command: COMMANDS.SETTINGS_BACK,
    summary: '从设置页返回聊天编辑区',
    required: [],
    optional: []
  },
  {
    command: COMMANDS.DIALOG_STATUS,
    summary: '检查限制模式、权限、确认等弹窗状态',
    required: [],
    optional: []
  },
  {
    command: COMMANDS.APPROVE_DIALOG,
    summary: '批准、拒绝或自动处理当前弹窗',
    required: [],
    optional: ['action', 'confirmationId', 'requireConfirmation']
  },
  {
    command: COMMANDS.DISMISS_DIALOG,
    summary: '关闭当前弹窗',
    required: [],
    optional: ['confirmationId', 'requireConfirmation']
  },
  {
    command: COMMANDS.BATCH_SUBMIT,
    summary: '提交批量任务',
    required: ['tasks'],
    optional: ['strategy', 'maxConcurrency', 'onComplete']
  },
  {
    command: COMMANDS.BATCH_STATUS,
    summary: '查询批量任务状态',
    required: ['batchId'],
    optional: []
  },
  {
    command: COMMANDS.BATCH_CANCEL,
    summary: '取消批量任务',
    required: ['batchId'],
    optional: []
  },
  {
    command: COMMANDS.REVIEW_CODE,
    summary: '将代码、diff 或审查说明委派给 TraeCN 执行结构化代码审查',
    required: ['instruction'],
    optional: ['files', 'focus', 'code', 'diff', 'queue', 'projectPath', 'sessionId', 'includeProcessText', 'waitForQueue']
  }
]);

function listCommands() {
  return COMMAND_DEFINITIONS.map(definition => ({ ...definition }));
}

function requireParam(params, key) {
  if (params[key] === undefined || params[key] === null || params[key] === '') {
    throw new Error(`Missing required command parameter: ${key}`);
  }
}

function normalizeSettingsValue(params) {
  if (Object.prototype.hasOwnProperty.call(params, 'value')) return params.value;
  if (Object.prototype.hasOwnProperty.call(params, 'enabled')) return params.enabled;
  if (Object.prototype.hasOwnProperty.call(params, 'text')) return params.text;
  return undefined;
}

function withLayeredTask(command, params = {}) {
  if (params.useLayeredPrompt === false) return params;
  const composed = composeTraeCNPrompt(command, params);
  return {
    ...params,
    originalTask: params.task,
    task: composed.prompt,
    promptLayers: composed.layerOrder
  };
}

async function executeCommand(client, command, params = {}) {
  switch (command) {
    case COMMANDS.CAPABILITIES:
      if (client && typeof client.getCapabilities === 'function') {
        try {
          const response = await client.getCapabilities();
          if (response.status >= 200 && response.status < 300) return response;
        } catch {}
      }
      return { status: 200, data: buildCapabilities({ commands: listCommands() }) };
    case COMMANDS.PREFLIGHT:
      if (client && typeof client.preflight === 'function') {
        return client.preflight(params);
      }
      return {
        status: 200,
        data: {
          ok: false,
          connected: false,
          nextAction: 'connect_traecn',
          commandPlan: params.command ? buildConfirmationPlan(params) : null,
          tokenHint: 'Client does not expose live preflight; use capabilities and confirm_plan as fallback.'
        }
      };
    case COMMANDS.CONFIRM_PLAN:
      requireParam(params, 'command');
      if (client && typeof client.createConfirmationPlan === 'function') {
        try {
          const response = await client.createConfirmationPlan(params.command, params.params || {}, {
            forceConfirm: params.forceConfirm === true
          });
          if (response.status >= 200 && response.status < 300) return response;
        } catch {}
      }
      return { status: 200, data: buildConfirmationPlan(params) };
    case COMMANDS.STATUS:
      return client.getStatus(params.allowAutoStart === true);
    case COMMANDS.READINESS:
      return client.getReadiness();
    case COMMANDS.NEW_CHAT:
      return client.newChat(params.allowAutoStart === true);
    case COMMANDS.DELEGATE:
      requireParam(params, 'task');
      return client.delegate(withLayeredTask(command, params).task, {
        projectPath: params.projectPath,
        sessionId: params.sessionId,
        allowAutoStart: params.allowAutoStart === true,
        includeProcessText: params.includeProcessText === true,
        waitForQueue: params.waitForQueue !== false
      });
    case COMMANDS.DELEGATE_ASYNC:
      requireParam(params, 'task');
      return client.delegateAsync(withLayeredTask(command, params).task, {
        chatId: params.chatId,
        includeProcessText: params.includeProcessText === true,
        waitForQueue: params.waitForQueue !== false
      });
    case COMMANDS.TASK_STATUS:
      requireParam(params, 'taskId');
      return client.getTaskStatus(params.taskId);
    case COMMANDS.CANCEL_TASK:
      requireParam(params, 'taskId');
      return client.cancelTask(params.taskId);
    case COMMANDS.SWITCH_MODE:
      requireParam(params, 'mode');
      return client.switchMode(params.mode, params.allowAutoStart === true);
    case COMMANDS.SWITCH_MODEL:
      requireParam(params, 'model');
      return client.switchModel(params.model);
    case COMMANDS.QUEUE_STATUS:
      return client.checkQueueStatus();
    case COMMANDS.OPEN_PROJECT:
      requireParam(params, 'projectPath');
      return client.openProject(params.projectPath);
    case COMMANDS.SETTINGS_READ:
      return client.settingsRead(params.section || null);
    case COMMANDS.SETTINGS_READ_ALL:
      return client.settingsReadAll();
    case COMMANDS.SETTINGS_SET: {
      requireParam(params, 'label');
      const value = normalizeSettingsValue(params);
      if (value === undefined) requireParam(params, 'value');
      return client.settingsWrite(params.section || null, { label: params.label, value }, {
        confirmationId: params.confirmationId,
        requireConfirmation: params.requireConfirmation === true
      });
    }
    case COMMANDS.SETTINGS_NAVIGATE:
      requireParam(params, 'section');
      return client.settingsSwitchTab(params.section);
    case COMMANDS.SETTINGS_BACK:
      return client.settingsBackToChat();
    case COMMANDS.DIALOG_STATUS:
      return client.dialogStatus();
    case COMMANDS.APPROVE_DIALOG:
      return client.approveDialog(params.action || 'auto', {
        confirmationId: params.confirmationId,
        requireConfirmation: params.requireConfirmation === true
      });
    case COMMANDS.DISMISS_DIALOG:
      return client.dismissDialog({
        confirmationId: params.confirmationId,
        requireConfirmation: params.requireConfirmation === true
      });
    case COMMANDS.BATCH_SUBMIT:
      requireParam(params, 'tasks');
      return client.submitBatch(params.tasks, {
        strategy: params.strategy,
        maxConcurrency: params.maxConcurrency,
        onComplete: params.onComplete
      });
    case COMMANDS.BATCH_STATUS:
      requireParam(params, 'batchId');
      return client.getBatchStatus(params.batchId);
    case COMMANDS.BATCH_CANCEL:
      requireParam(params, 'batchId');
      return client.cancelBatch(params.batchId);
    case COMMANDS.REVIEW_CODE: {
      requireParam(params, 'instruction');
      const task = buildCodeReviewTask(params);
      if (params.queue === true) {
        return client.delegateAsync(task, {
          chatId: params.chatId,
          includeProcessText: params.includeProcessText === true,
          waitForQueue: params.waitForQueue !== false
        });
      }
      return client.delegate(task, {
        projectPath: params.projectPath,
        sessionId: params.sessionId,
        includeProcessText: params.includeProcessText === true,
        waitForQueue: params.waitForQueue !== false
      });
    }
    default:
      throw new Error(`Unsupported TraeCN command: ${command}`);
  }
}

function mapSettingsAction(action, params = {}) {
  switch (action) {
    case 'navigate':
    case 'clickTab':
      return { command: COMMANDS.SETTINGS_NAVIGATE, params };
    case 'read':
      return { command: COMMANDS.SETTINGS_READ, params };
    case 'readAll':
    case 'readTables':
      return { command: COMMANDS.SETTINGS_READ_ALL, params };
    case 'type':
    case 'toggle':
    case 'dropdown':
    case 'set':
      return { command: COMMANDS.SETTINGS_SET, params };
    case 'back':
      return { command: COMMANDS.SETTINGS_BACK, params };
    default:
      throw new Error(`Unsupported settings action: ${action}`);
  }
}

module.exports = {
  COMMANDS,
  COMMAND_DEFINITIONS,
  executeCommand,
  listCommands,
  mapSettingsAction
};
