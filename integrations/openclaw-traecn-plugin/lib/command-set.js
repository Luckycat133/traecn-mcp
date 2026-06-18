'use strict';

const { composeTraeCNPrompt } = require('../../../src/skill/prompt-layers');
const { buildCodeReviewTask } = require('../../../src/skill/review');
const { buildCapabilities } = require('../../../src/shared/capabilities');
const { buildConfirmationPlan } = require('../../../src/shared/operation-confirmation');

const COMMANDS = Object.freeze({
  CAPABILITIES: 'capabilities',
  PREFLIGHT: 'preflight',
  CONFIRM_PLAN: 'confirm_plan',
  RESTART_TRAE_DEBUG: 'restart_trae_debug',
  STATUS: 'status',
  READINESS: 'readiness',
  NEW_CHAT: 'new_chat',
  DELEGATE: 'delegate',
  DELEGATE_ASYNC: 'delegate_async',
  TASK_STATUS: 'task_status',
  WAIT_TASK: 'wait_task',
  ADOPT_CURRENT_TASK: 'adopt_current_task',
  CANCEL_TASK: 'cancel_task',
  STOP_GENERATION: 'stop_generation',
  REVIEW_GATE_STATUS: 'review_gate_status',
  RESOLVE_REVIEW_GATE: 'resolve_review_gate',
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
  REVIEW_CODE: 'review_code',
  VIBE_WORKFLOW: 'vibe_workflow',
  // v0.4.0 — new driver-level commands. Each takes an `action` param that
  // routes to a specific method on the corresponding driver.
  EDITOR: 'editor',
  FILE: 'file',
  TERMINAL: 'terminal',
  GIT: 'git',
  SEARCH: 'search',
  DIAGNOSTICS: 'diagnostics',
  SNAPSHOT: 'snapshot',
  EXTENSION: 'extension',
  COMMAND: 'command'
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
    command: COMMANDS.RESTART_TRAE_DEBUG,
    summary: '在明确确认后关闭 Trae CN，并用已登录 existing profile 和 CDP 调试端口重新启动',
    required: [],
    optional: ['confirmationPhrase', 'confirmationId', 'projectPath', 'quitTimeoutMs', 'cdpWaitMs']
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
    optional: ['projectPath', 'sessionId', 'allowAutoStart', 'includeProcessText', 'waitForQueue', 'background', 'fallbackModels', 'autoModelFallback', 'modelProbeIntervalMs']
  },
  {
    command: COMMANDS.DELEGATE_ASYNC,
    summary: '向 TraeCN 提交异步任务，返回 taskId 或直接返回结果',
    required: ['task'],
    optional: ['projectPath', 'chatId', 'includeProcessText', 'waitForQueue', 'background', 'reviewRequired', 'autoContinue', 'followupTasks', 'completionChecks', 'notifyUrl', 'fallbackModels', 'autoModelFallback', 'modelProbeIntervalMs']
  },
  {
    command: COMMANDS.TASK_STATUS,
    summary: '查询异步任务状态',
    required: ['taskId'],
    optional: []
  },
  {
    command: COMMANDS.WAIT_TASK,
    summary: '在本地等待异步任务直到终态或需要代码决策的停点，适合长队列期间释放 agent 上下文',
    required: ['taskId'],
    optional: ['pollMs', 'timeoutMs', 'autoApproveDialog']
  },
  {
    command: COMMANDS.ADOPT_CURRENT_TASK,
    summary: '接管 TraeCN 当前已经提交但本地丢失追踪的排队/生成请求，只等待并收集现有结果，不重新发送任务',
    required: [],
    optional: ['task', 'reviewRequired', 'followupTasks', 'chatId', 'includeProcessText', 'notifyUrl', 'fallbackModels', 'autoModelFallback', 'modelProbeIntervalMs', 'submittedAt', 'force']
  },
  {
    command: COMMANDS.CANCEL_TASK,
    summary: '取消仍在排队的异步任务',
    required: ['taskId'],
    optional: []
  },
  {
    command: COMMANDS.STOP_GENERATION,
    summary: '停止 TraeCN 当前正在生成或排队的请求，清理同步超时后残留的 UI 队列',
    required: [],
    optional: []
  },
  {
    command: COMMANDS.REVIEW_GATE_STATUS,
    summary: '检查 TraeCN 是否停在内部任务审查闸口（全部保留/全部撤销）',
    required: [],
    optional: []
  },
  {
    command: COMMANDS.RESOLVE_REVIEW_GATE,
    summary: '处理 TraeCN 内部任务审查闸口，可全部保留或全部撤销以恢复自动化流程',
    required: [],
    optional: ['action']
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
    optional: ['waitForQueue']
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
    optional: ['files', 'focus', 'code', 'diff', 'queue', 'projectPath', 'sessionId', 'includeProcessText', 'waitForQueue', 'fallbackModels', 'autoModelFallback', 'modelProbeIntervalMs']
  },
  {
    command: COMMANDS.VIBE_WORKFLOW,
    summary: '启动无人值守 vibe coding 工作流：提交初始任务并自动继续后续步骤，不需要人工审查推进',
    required: ['task'],
    optional: ['steps', 'followupTasks', 'completionChecks', 'projectPath', 'chatId', 'includeProcessText', 'fallbackModels', 'autoModelFallback', 'modelProbeIntervalMs', 'notifyUrl', 'maxQueueWaitMs']
  },
  {
    command: COMMANDS.EDITOR,
    summary: '驱动 TraeCN 编辑器：接受/拒绝 AI 改动、保存、格式化、注释、撤销/重做、跳转、读/写活跃编辑器内容。action 必传。',
    required: ['action'],
    optional: ['text', 'value', 'line', 'column']
  },
  {
    command: COMMANDS.FILE,
    summary: '文件与工作区操作：open/close/save/revert/listOpen/listTree + 直接磁盘 readDisk/writeDisk/deleteDisk/mkdirDisk/renameDisk。',
    required: [],
    optional: ['action', 'filePath', 'content', 'oldPath', 'newPath', 'rootPath', 'maxDepth', 'ignore']
  },
  {
    command: COMMANDS.TERMINAL,
    summary: '驱动集成终端：open/new/kill/clear/snapshot/tail/send/sendLine/sendKey (Ctrl+C/D/L/Z 等)。',
    required: [],
    optional: ['action', 'text', 'key', 'code', 'wvk', 'modifiers', 'lines', 'title']
  },
  {
    command: COMMANDS.GIT,
    summary: 'Git / SCM 操作：stageAll/unstageAll/commit/push/pull/sync/fetch/branch/checkout/stash/commitWithMessage/readStatus/execGit (CLI fallback)。',
    required: [],
    optional: ['action', 'message', 'args', 'cwd', 'filePath']
  },
  {
    command: COMMANDS.SEARCH,
    summary: 'Search / Find in Files：open/findInFiles/find (带 query/include/exclude/timeoutMs)/readResults/collapseAll。',
    required: [],
    optional: ['action', 'query', 'include', 'exclude', 'maxResults', 'timeoutMs']
  },
  {
    command: COMMANDS.DIAGNOSTICS,
    summary: '诊断：openProblems/nextProblem/prevProblem/readAll/readModelMarkers/count/hover。',
    required: [],
    optional: ['action', 'max', 'line', 'column']
  },
  {
    command: COMMANDS.SNAPSHOT,
    summary: '快照：dom/text/layout/pageHash/screenshot/screenshotElement，供回放与调试。',
    required: [],
    optional: ['action', 'selector', 'targetPath', 'max', 'minSize']
  },
  {
    command: COMMANDS.EXTENSION,
    summary: '扩展：openExtensions/install/uninstall/enable/disable/searchMarketplace/readVisible/listViaCLI/installViaCLI/uninstallViaCLI。',
    required: [],
    optional: ['action', 'query', 'extensionId', 'version', 'maxResults', 'timeoutMs']
  },
  {
    command: COMMANDS.COMMAND,
    summary: '走 VS Code Command Palette：open/close/run(commandId)/runSequence(commandIds)。',
    required: ['action'],
    optional: ['commandId', 'commandIds']
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
    case COMMANDS.RESTART_TRAE_DEBUG:
      return client.restartTraeDebug({
        confirmationPhrase: params.confirmationPhrase,
        confirmationId: params.confirmationId,
        projectPath: params.projectPath,
        quitTimeoutMs: params.quitTimeoutMs,
        cdpWaitMs: params.cdpWaitMs
      });
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
        waitForQueue: params.waitForQueue !== false,
        background: params.background === true,
        reviewRequired: params.reviewRequired === true,
        autoContinue: params.autoContinue === true,
        followupTasks: params.followupTasks,
        completionChecks: params.completionChecks,
        notifyUrl: params.notifyUrl,
        fallbackModels: params.fallbackModels,
        autoModelFallback: params.autoModelFallback === true,
        modelProbeIntervalMs: params.modelProbeIntervalMs
      });
    case COMMANDS.DELEGATE_ASYNC:
      requireParam(params, 'task');
      return client.delegateAsync(withLayeredTask(command, params).task, {
        projectPath: params.projectPath,
        sessionId: params.sessionId,
        chatId: params.chatId,
        includeProcessText: params.includeProcessText === true,
        waitForQueue: params.waitForQueue !== false,
        background: params.background === true,
        reviewRequired: params.reviewRequired === true,
        autoContinue: params.autoContinue === true,
        followupTasks: params.followupTasks,
        completionChecks: params.completionChecks,
        notifyUrl: params.notifyUrl,
        fallbackModels: params.fallbackModels,
        autoModelFallback: params.autoModelFallback === true,
        modelProbeIntervalMs: params.modelProbeIntervalMs
      });
    case COMMANDS.TASK_STATUS:
      requireParam(params, 'taskId');
      return client.getTaskStatus(params.taskId);
    case COMMANDS.WAIT_TASK:
      requireParam(params, 'taskId');
      return {
        status: 200,
        data: await client.waitForTask(params.taskId, {
          pollMs: params.pollMs,
          timeoutMs: params.timeoutMs,
          autoApproveDialog: params.autoApproveDialog
        })
      };
    case COMMANDS.ADOPT_CURRENT_TASK:
      return client.adoptCurrentTask({
        task: params.task,
        reviewRequired: params.reviewRequired === true,
        followupTasks: params.followupTasks,
        chatId: params.chatId,
        includeProcessText: params.includeProcessText === true,
        notifyUrl: params.notifyUrl,
        fallbackModels: params.fallbackModels,
        autoModelFallback: params.autoModelFallback === true,
        modelProbeIntervalMs: params.modelProbeIntervalMs,
        submittedAt: params.submittedAt,
        force: params.force === true
      });
    case COMMANDS.CANCEL_TASK:
      requireParam(params, 'taskId');
      return client.cancelTask(params.taskId);
    case COMMANDS.STOP_GENERATION:
      return client.stopGeneration();
    case COMMANDS.REVIEW_GATE_STATUS:
      return client.getReviewGateStatus();
    case COMMANDS.RESOLVE_REVIEW_GATE:
      return client.resolveReviewGate(params.action || 'keep_all');
    case COMMANDS.SWITCH_MODE:
      requireParam(params, 'mode');
      return client.switchMode(params.mode, params.allowAutoStart === true);
    case COMMANDS.SWITCH_MODEL:
      requireParam(params, 'model');
      return client.switchModel(params.model, { waitForQueue: params.waitForQueue });
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
          projectPath: params.projectPath,
          sessionId: params.sessionId,
          chatId: params.chatId,
          includeProcessText: params.includeProcessText === true,
          waitForQueue: params.waitForQueue !== false,
          background: params.background === true,
          reviewRequired: params.reviewRequired === true,
          autoContinue: params.autoContinue === true,
          followupTasks: params.followupTasks,
          completionChecks: params.completionChecks,
          notifyUrl: params.notifyUrl,
          fallbackModels: params.fallbackModels,
          autoModelFallback: params.autoModelFallback === true,
          modelProbeIntervalMs: params.modelProbeIntervalMs
        });
      }
      return client.delegate(task, {
        projectPath: params.projectPath,
        sessionId: params.sessionId,
        includeProcessText: params.includeProcessText === true,
        waitForQueue: params.waitForQueue !== false,
        completionChecks: params.completionChecks,
        fallbackModels: params.fallbackModels,
        autoModelFallback: params.autoModelFallback === true,
        modelProbeIntervalMs: params.modelProbeIntervalMs
      });
    }
    case COMMANDS.VIBE_WORKFLOW: {
      requireParam(params, 'task');
      const steps = Array.isArray(params.steps) ? params.steps : (Array.isArray(params.followupTasks) ? params.followupTasks : []);
      const followupTasks = steps.map(step => {
        if (typeof step === 'string') {
          return { task: step, reviewRequired: params.reviewRequired === true, autoContinue: true };
        }
        return {
          ...step,
          reviewRequired: step.reviewRequired === true || params.reviewRequired === true,
          autoContinue: true
        };
      });
      return client.delegateAsync(withLayeredTask(command, params).task, {
        projectPath: params.projectPath,
        chatId: params.chatId,
        includeProcessText: params.includeProcessText === true,
        waitForQueue: params.waitForQueue !== false,
        background: true,
        forceBackground: params.forceBackground === true,
        reviewRequired: params.reviewRequired === true,
        autoContinue: true,
        followupTasks,
        completionChecks: params.completionChecks,
        notifyUrl: params.notifyUrl,
        fallbackModels: params.fallbackModels,
        autoModelFallback: params.autoModelFallback === true,
        modelProbeIntervalMs: params.modelProbeIntervalMs,
        maxQueueWaitMs: params.maxQueueWaitMs
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
