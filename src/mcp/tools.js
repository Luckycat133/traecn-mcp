'use strict';

/**
 * MCP 工具定义 — 所有面向 AI agent 的 Tool Schema、内部名称映射和序列化辅助。
 * 从 mcp-server.js 拆分，保持单一职责。
 */

const promptLayers = require('../skill/prompt-layers');
const { buildCapabilities } = require('../capabilities');
const { listCommands } = require('../client/command-set');
const { buildCodeReviewTask } = require('../skill/review');
const { buildConfirmationPlan } = require('../shared/operation-confirmation');
const { isGenericQueueProbeTask } = require('../shared/utils');

function schema(properties = {}, required = []) {
  return { type: 'object', properties, required };
}

const COMPLETION_CHECKS_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    requiredFiles: { type: 'array', items: { type: 'string' } },
    requiredText: {
      type: 'array',
      items: {
        type: 'object',
        required: ['filePath', 'includes'],
        properties: {
          filePath: { type: 'string' },
          includes: {
            anyOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } }
            ]
          }
        }
      }
    }
  }
});

const WORKFLOW_STEP_SCHEMA = Object.freeze({
  anyOf: [
    { type: 'string' },
    {
      type: 'object',
      required: ['task'],
      properties: {
        task: { type: 'string' },
        reviewRequired: { type: 'boolean' },
        autoContinue: { type: 'boolean' },
        includeProcessText: { type: 'boolean' },
        completionChecks: COMPLETION_CHECKS_SCHEMA
      }
    }
  ]
});

const RAW_MCP_TOOLS = Object.freeze([
  {
    name: 'traecn_get_capabilities',
    description: 'Return a compact agent-facing capability catalog for low-token discovery.',
    inputSchema: schema()
  },
  {
    name: 'traecn_list_commands',
    description: 'List every stable TraeCNclaw command exposed to agents.',
    inputSchema: schema()
  },
  {
    name: 'traecn_run_command',
    description: 'Execute a stable TraeCNclaw command by name. Use traecn_list_commands for parameters.',
    inputSchema: schema({
      command: { type: 'string', enum: listCommands().map(item => item.command) },
      params: { type: 'object', description: 'Command-specific parameters.' }
    }, ['command'])
  },
  {
    name: 'traecn_plan_operation',
    description: 'Create a compact confirmation/preflight plan before executing a side-effecting TraeCN command.',
    inputSchema: schema({
      command: { type: 'string' },
      params: { type: 'object' },
      forceConfirm: { type: 'boolean' }
    }, ['command'])
  },
  {
    name: 'traecn_preflight',
    description: 'Return one compact status/readiness/queue/dialog summary plus optional command confirmation plan.',
    inputSchema: schema({
      command: { type: 'string' },
      params: { type: 'object' },
      forceConfirm: { type: 'boolean' }
    })
  },
  {
    name: 'traecn_run_task',
    description: 'Delegate a task to TraeCN and wait for the final response when possible.',
    inputSchema: schema({
      task: { type: 'string' },
      projectPath: { type: 'string' },
      sessionId: { type: 'string' },
      includeProcess: { type: 'boolean' },
      autoWait: { type: 'boolean', default: true },
      mode: { type: 'string', enum: ['solo', 'ide'] },
      reviewRequired: { type: 'boolean' },
      autoContinue: { type: 'boolean' },
      followupTasks: { type: 'array', items: WORKFLOW_STEP_SCHEMA },
      completionChecks: COMPLETION_CHECKS_SCHEMA,
      autoApproveDialog: {
        anyOf: [
          { type: 'boolean' },
          { type: 'string' }
        ]
      },
      notifyUrl: { type: 'string' },
      fallbackModels: { type: 'array', items: { type: 'string' } },
      autoModelFallback: { type: 'boolean' },
      modelProbeIntervalMs: { type: 'number' }
    }, ['task'])
  },
  {
    name: 'traecn_queue_task',
    description: 'Submit a task for queue-aware background processing and return a taskId.',
    inputSchema: schema({
      task: { type: 'string' },
      projectPath: { type: 'string' },
      sessionId: { type: 'string' },
      chatId: { type: 'string' },
      soloChat: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          titleIncludes: { type: 'string' },
          textIncludes: { type: 'string' }
        }
      },
      soloChatIndex: { type: 'number' },
      soloChatTitleIncludes: { type: 'string' },
      soloChatTextIncludes: { type: 'string' },
      newChat: { type: 'boolean' },
      reviewRequired: { type: 'boolean' },
      autoContinue: { type: 'boolean' },
      followupTasks: { type: 'array', items: WORKFLOW_STEP_SCHEMA },
      completionChecks: COMPLETION_CHECKS_SCHEMA,
      autoApproveDialog: {
        anyOf: [
          { type: 'boolean' },
          { type: 'string' }
        ]
      },
      notifyUrl: { type: 'string' },
      background: { type: 'boolean' },
      forceBackground: { type: 'boolean' },
      waitForQueue: { type: 'boolean' },
      fallbackModels: { type: 'array', items: { type: 'string' } },
      autoModelFallback: { type: 'boolean' },
      modelProbeIntervalMs: { type: 'number' },
      maxQueueWaitMs: { type: 'number' },
      queueMaxWaitMs: { type: 'number' }
    }, ['task'])
  },
  {
    name: 'traecn_poll_task',
    description: 'Poll a queued TraeCN task by taskId.',
    inputSchema: schema({ taskId: { type: 'string' } })
  },
  {
    name: 'traecn_wait_task',
    description: 'Wait locally for a queued TraeCN task to reach a terminal or decision-required state.',
    inputSchema: schema({
      taskId: { type: 'string' },
      pollMs: { type: 'number' },
      timeoutMs: { type: 'number' },
      autoApproveDialog: {
        anyOf: [
          { type: 'boolean' },
          { type: 'string' }
        ]
      }
    }, ['taskId'])
  },
  {
    name: 'traecn_resolve_task_review',
    description: 'Resolve a gateway task checkpoint in awaiting_review state. This is separate from TraeCN internal keep/revert review gates.',
    inputSchema: schema({
      taskId: { type: 'string' },
      decision: { type: 'string', enum: ['approve', 'continue', 'reject'] },
      notes: { type: 'string' }
    }, ['taskId', 'decision'])
  },
  {
    name: 'traecn_adopt_current_task',
    description: 'Recover tracking for the currently queued/running TraeCN request without resending the prompt.',
    inputSchema: schema({
      task: { type: 'string' },
      reviewRequired: { type: 'boolean' },
      autoContinue: { type: 'boolean' },
      followupTasks: { type: 'array', items: WORKFLOW_STEP_SCHEMA },
      completionChecks: COMPLETION_CHECKS_SCHEMA,
      chatId: { type: 'string' },
      includeProcessText: { type: 'boolean' },
      autoApproveDialog: {
        anyOf: [
          { type: 'boolean' },
          { type: 'string' }
        ]
      },
      notifyUrl: { type: 'string' },
      fallbackModels: { type: 'array', items: { type: 'string' } },
      autoModelFallback: { type: 'boolean' },
      modelProbeIntervalMs: { type: 'number' },
      submittedAt: { type: 'number' },
      force: { type: 'boolean' }
    })
  },
  {
    name: 'traecn_cancel_task',
    description: 'Cancel a queued or review-waiting TraeCN background task.',
    inputSchema: schema({ taskId: { type: 'string' } }, ['taskId'])
  },
  {
    name: 'traecn_stop_generation',
    description: 'Stop the current TraeCN generation or queued model request.',
    inputSchema: schema()
  },
  {
    name: 'traecn_get_review_gate_status',
    description: 'Inspect whether TraeCN is blocked on its internal keep/revert review gate.',
    inputSchema: schema()
  },
  {
    name: 'traecn_resolve_review_gate',
    description: 'Resolve TraeCN internal keep/revert review gate.',
    inputSchema: schema({ action: { type: 'string', enum: ['keep_all', 'revert_all', 'keep', 'discard'] } })
  },
  {
    name: 'traecn_dismiss_dialog',
    description: 'Dismiss the current TraeCN dialog.',
    inputSchema: schema()
  },
  {
    name: 'traecn_restart_debug_session',
    description: 'Restart TraeCN with remote debugging enabled using the existing logged-in profile.',
    inputSchema: schema({
      confirmationPhrase: { type: 'string' },
      confirmationId: { type: 'string' },
      projectPath: { type: 'string' },
      quitTimeoutMs: { type: 'number' },
      cdpWaitMs: { type: 'number' }
    })
  },
  {
    name: 'traecn_review_code',
    description: 'Ask TraeCN to review code, a diff, or a review instruction with findings-first output.',
    inputSchema: schema({
      instruction: { type: 'string' },
      files: { type: 'array', items: { type: 'string' } },
      focus: { type: 'array', items: { type: 'string' } },
      code: { type: 'string' },
      diff: { type: 'string' },
      queue: { type: 'boolean' },
      projectPath: { type: 'string' },
      sessionId: { type: 'string' },
      includeProcessText: { type: 'boolean' },
      waitForQueue: { type: 'boolean' },
      background: { type: 'boolean' },
      reviewRequired: { type: 'boolean' },
      autoContinue: { type: 'boolean' },
      followupTasks: { type: 'array', items: WORKFLOW_STEP_SCHEMA },
      completionChecks: COMPLETION_CHECKS_SCHEMA,
      notifyUrl: { type: 'string' },
      fallbackModels: { type: 'array', items: { type: 'string' } },
      autoModelFallback: { type: 'boolean' },
      modelProbeIntervalMs: { type: 'number' }
    }, ['instruction'])
  },
  {
    name: 'traecn_get_status',
    description: 'Check whether the TraeCN gateway is connected.',
    inputSchema: schema()
  },
  {
    name: 'traecn_switch_model',
    description: 'Switch the active TraeCN model with fuzzy matching.',
    inputSchema: schema({
      name: { type: 'string' },
      waitForQueue: { type: 'boolean' }
    }, ['name'])
  },
  {
    name: 'traecn_switch_mode',
    description: 'Switch TraeCN between SOLO and IDE modes.',
    inputSchema: schema({ mode: { type: 'string', enum: ['solo', 'ide'] } }, ['mode'])
  },
  {
    name: 'traecn_create_chat',
    description: 'Create a new TraeCN chat.',
    inputSchema: schema()
  },
  {
    name: 'traecn_list_solo_chats',
    description: 'List real Solo-mode TraeCN conversations from the Solo sidebar.',
    inputSchema: schema()
  },
  {
    name: 'traecn_switch_solo_chat',
    description: 'Switch to a real Solo-mode TraeCN conversation by index or visible text.',
    inputSchema: schema({
      index: { type: 'number' },
      titleIncludes: { type: 'string' },
      textIncludes: { type: 'string' }
    })
  },
  {
    name: 'traecn_cleanup_queue_probe_chats',
    description: 'Find and optionally delete accidental queue-probe Solo conversations without sending another prompt to TraeCN.',
    inputSchema: schema({
      dryRun: { type: 'boolean' },
      execute: { type: 'boolean' },
      maxPasses: { type: 'number' },
      settleMs: { type: 'number' }
    })
  },
  {
    name: 'traecn_get_cleanup_watch_status',
    description: 'Read local cleanup watcher lock/PID/stale status without contacting TraeCN or creating conversations.',
    inputSchema: schema({
      lockFile: { type: 'string' }
    })
  },
  {
    name: 'traecn_start_long_queue_proof',
    description: 'Start the guarded GLM-5.2 long-queue proof. Defaults to dry-run; execute=true plus allowQuotaSpend=true is required for a new real TraeCN submission.',
    inputSchema: schema({
      marker: { type: 'string' },
      model: { type: 'string' },
      projectPath: { type: 'string' },
      execute: { type: 'boolean' },
      allowQuotaSpend: { type: 'boolean' },
      detach: { type: 'boolean' },
      forceNew: { type: 'boolean' },
      resumeTaskId: { type: 'string' },
      timeoutMs: { type: 'number' },
      pollMs: { type: 'number' },
      outputDir: { type: 'string' },
      cleanupIntervalMs: { type: 'number' },
      cleanupStabilizeChecks: { type: 'number' },
      cleanupStabilizeDelayMs: { type: 'number' },
      cleanupMaxAttempts: { type: 'number' }
    })
  },
  {
    name: 'traecn_get_long_queue_proof_status',
    description: 'Read the latest or marker-scoped GLM-5.2 proof status without sending any TraeCN prompt.',
    inputSchema: schema({
      marker: { type: 'string' },
      outputDir: { type: 'string' }
    })
  },
  {
    name: 'traecn_cancel_long_queue_proof',
    description: 'Cancel the latest or marker-scoped GLM-5.2 proof watcher/task tracking without resubmitting a prompt.',
    inputSchema: schema({
      marker: { type: 'string' },
      taskId: { type: 'string' },
      outputDir: { type: 'string' }
    })
  },
  {
    name: 'traecn_submit_solo_task',
    description: 'Submit a task into a real Solo conversation and return a taskId; background polling switches back to that conversation to collect queued results.',
    inputSchema: schema({
      task: { type: 'string' },
      projectPath: { type: 'string' },
      soloChat: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          titleIncludes: { type: 'string' },
          textIncludes: { type: 'string' }
        }
      },
      soloChatIndex: { type: 'number' },
      soloChatTitleIncludes: { type: 'string' },
      soloChatTextIncludes: { type: 'string' },
      newChat: { type: 'boolean' },
      includeProcessText: { type: 'boolean' },
      reviewRequired: { type: 'boolean' },
      autoContinue: { type: 'boolean' },
      followupTasks: { type: 'array', items: WORKFLOW_STEP_SCHEMA },
      completionChecks: COMPLETION_CHECKS_SCHEMA,
      autoApproveDialog: {
        anyOf: [
          { type: 'boolean' },
          { type: 'string' }
        ]
      },
      notifyUrl: { type: 'string' },
      fallbackModels: { type: 'array', items: { type: 'string' } },
      autoModelFallback: { type: 'boolean' },
      modelProbeIntervalMs: { type: 'number' },
      maxQueueWaitMs: { type: 'number' },
      queueMaxWaitMs: { type: 'number' }
    }, ['task'])
  },
  {
    name: 'traecn_get_settings',
    description: 'Read TraeCN settings from the current or named section.',
    inputSchema: schema({ section: { type: 'string' } })
  },
  {
    name: 'traecn_set_setting',
    description: 'Set a TraeCN setting by label.',
    inputSchema: schema({ label: { type: 'string' }, value: {}, section: { type: 'string' } }, ['label', 'value'])
  },
  {
    name: 'traecn_respond_dialog',
    description: 'Respond to the current TraeCN dialog by approving, denying, confirming, answering, or dismissing it.',
    inputSchema: schema({ action: { type: 'string' }, wait: { type: 'boolean' } })
  },
  {
    name: 'traecn_get_dialog_status',
    description: 'Check whether TraeCN is showing a dialog that needs user confirmation.',
    inputSchema: schema()
  },
  {
    name: 'traecn_get_queue_status',
    description: 'Check current model queue/busy status.',
    inputSchema: schema()
  },
  {
    name: 'traecn_open_project',
    description: 'Open a local project path in TraeCN.',
    inputSchema: schema({ projectPath: { type: 'string' } }, ['projectPath'])
  },
  {
    name: 'traecn_run_unattended_workflow',
    description: 'Run a multi-step TraeCN workflow. Follow-ups auto-continue by default; set reviewRequired=true and autoContinue=false for human task checkpoints.',
    inputSchema: schema({
      task: { type: 'string' },
      steps: { type: 'array', items: WORKFLOW_STEP_SCHEMA },
      followupTasks: { type: 'array', items: WORKFLOW_STEP_SCHEMA },
      projectPath: { type: 'string' },
      chatId: { type: 'string' },
      reviewRequired: { type: 'boolean' },
      autoContinue: { type: 'boolean' },
      includeProcessText: { type: 'boolean' },
      completionChecks: COMPLETION_CHECKS_SCHEMA,
      autoApproveDialog: {
        anyOf: [
          { type: 'boolean' },
          { type: 'string' }
        ]
      },
      notifyUrl: { type: 'string' },
      fallbackModels: { type: 'array', items: { type: 'string' } },
      autoModelFallback: { type: 'boolean' },
      modelProbeIntervalMs: { type: 'number' },
      maxQueueWaitMs: { type: 'number' }
    }, ['task'])
  }
]);

const MCP_TOOL_INTERNAL_NAMES = Object.freeze({
  traecn_get_capabilities: 'traecn_capabilities',
  traecn_list_commands: 'traecn_command_set',
  traecn_run_command: 'traecn_command',
  traecn_plan_operation: 'plan_operation',
  traecn_preflight: 'preflight',
  traecn_run_task: 'run_task',
  traecn_queue_task: 'queue_task',
  traecn_poll_task: 'poll_task',
  traecn_wait_task: 'wait_task',
  traecn_resolve_task_review: 'resolve_task_review',
  traecn_adopt_current_task: 'adopt_current_task',
  traecn_cancel_task: 'cancel_task',
  traecn_stop_generation: 'stop_generation',
  traecn_get_review_gate_status: 'review_gate_status',
  traecn_resolve_review_gate: 'resolve_review_gate',
  traecn_dismiss_dialog: 'dismiss_dialog',
  traecn_restart_debug_session: 'restart_trae_debug',
  traecn_review_code: 'review_code',
  traecn_get_status: 'check_status',
  traecn_switch_model: 'switch_model',
  traecn_switch_mode: 'switch_mode',
  traecn_create_chat: 'new_chat',
  traecn_list_solo_chats: 'list_solo_chats',
  traecn_switch_solo_chat: 'switch_solo_chat',
  traecn_cleanup_queue_probe_chats: 'cleanup_foreign_solo_queue',
  traecn_get_cleanup_watch_status: 'cleanup_queue_watch_status',
  traecn_start_long_queue_proof: 'long_queue_proof_start',
  traecn_get_long_queue_proof_status: 'long_queue_proof_status',
  traecn_cancel_long_queue_proof: 'long_queue_proof_cancel',
  traecn_submit_solo_task: 'submit_solo_chat_task',
  traecn_get_settings: 'get_settings',
  traecn_set_setting: 'set_setting',
  traecn_respond_dialog: 'approve_dialog',
  traecn_get_dialog_status: 'check_dialog',
  traecn_get_queue_status: 'check_queue',
  traecn_open_project: 'open_project',
  traecn_run_unattended_workflow: 'vibe_workflow'
});

function internalMcpToolName(toolName) {
  return MCP_TOOL_INTERNAL_NAMES[toolName] || null;
}

function asMcpContent(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

/**
 * 构建能力声明（在 MCP tool 调用中直接使用，避免循环依赖）。
 * @param {object} options
 * @returns {object}
 */
function buildMcpCapabilities(options = {}) {
  return buildCapabilities(options);
}

/**
 * 构建代码审查任务。
 * @param {object} args
 * @returns {string}
 */
function buildMcpCodeReviewTask(args) {
  return buildCodeReviewTask(args);
}

/**
 * 构建确认计划。
 * @param {object} args
 * @returns {object}
 */
function buildMcpConfirmationPlan(args) {
  return buildConfirmationPlan(args);
}

/**
 * 检查是否为通用队列探测任务。
 * @param {string} task
 * @returns {boolean}
 */
function checkGenericQueueProbe(task) {
  return isGenericQueueProbeTask(task);
}

module.exports = {
  RAW_MCP_TOOLS,
  COMPLETION_CHECKS_SCHEMA,
  WORKFLOW_STEP_SCHEMA,
  MCP_TOOL_INTERNAL_NAMES,
  internalMcpToolName,
  asMcpContent,
  buildMcpCapabilities,
  buildMcpCodeReviewTask,
  buildMcpConfirmationPlan,
  checkGenericQueueProbe,
  schema
};
