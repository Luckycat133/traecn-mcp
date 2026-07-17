#!/usr/bin/env node
'use strict';

const { TraeCNSkill } = require('./src/skill/traecn-skill');
const promptLayers = require('./src/skill/prompt-layers');
const { buildCodeReviewTask } = require('./src/skill/review');
const { buildCapabilities } = require('./src/shared/capabilities');
const { buildConfirmationPlan } = require('./src/shared/operation-confirmation');
const { executeCommand, listCommands } = require('./integrations/openclaw-traecn-plugin/lib/command-set');
const { TraeCNApiClient } = require('./integrations/openclaw-traecn-plugin/lib/traecnapi-client');
const { getGatewayContext, isGenericQueueProbeTask } = require('./src/shared/utils');
const mcpAuth = require('./src/shared/mcp-auth');

const SERVER_INFO = Object.freeze({ name: 'traecnclaw', version: require('./package.json').version });

function envContext() {
  // getGatewayContext handles TRAECN_* and TRAE_* keys with sane defaults;
  // we override the defaults here for the MCP server's higher port/timeout.
  const ctx = getGatewayContext();
  const env = process.env;
  return {
    host: env.TRAECN_HOST || ctx.host,
    port: Number(env.TRAECN_PORT || env.PORT || 8788),
    token: env.TRAECN_GATEWAY_TOKEN || env.TRAECN_API_KEY || ctx.token,
    timeout: Number(env.TRAECN_TIMEOUT || 120000)
  };
}

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
    description: 'Run an unattended TraeCN workflow: initial task plus auto-continued follow-up tasks.',
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

const DEFAULT_MCP_TOOL_PROFILE = 'public';

const TOOL_METADATA = Object.freeze({
  traecn_get_capabilities: { layer: 'discovery', profile: 'public', risk: 'read' },
  traecn_list_commands: { layer: 'discovery', profile: 'public', risk: 'read' },
  traecn_run_command: { layer: 'escape-hatch', profile: 'public', risk: 'dynamic' },
  traecn_plan_operation: { layer: 'planning', profile: 'public', risk: 'read' },
  traecn_preflight: { layer: 'planning', profile: 'public', risk: 'read' },
  traecn_run_task: { layer: 'task', profile: 'public', risk: 'delegate' },
  traecn_queue_task: { layer: 'task', profile: 'public', risk: 'delegate' },
  traecn_poll_task: { layer: 'task', profile: 'public', risk: 'read' },
  traecn_wait_task: { layer: 'task', profile: 'public', risk: 'read-or-delegate' },
  traecn_cancel_task: { layer: 'task', profile: 'public', risk: 'delegate', destructive: true },
  traecn_review_code: { layer: 'review', profile: 'public', risk: 'delegate' },
  traecn_switch_model: { layer: 'control', profile: 'public', risk: 'write' },
  traecn_switch_mode: { layer: 'control', profile: 'public', risk: 'write' },
  traecn_create_chat: { layer: 'control', profile: 'public', risk: 'write' },
  traecn_get_settings: { layer: 'settings', profile: 'public', risk: 'read' },
  traecn_set_setting: { layer: 'settings', profile: 'public', risk: 'admin' },
  traecn_respond_dialog: { layer: 'dialog', profile: 'public', risk: 'delegate' },
  traecn_get_dialog_status: { layer: 'dialog', profile: 'public', risk: 'read' },
  traecn_open_project: { layer: 'control', profile: 'public', risk: 'delegate' },
  traecn_run_unattended_workflow: { layer: 'workflow', profile: 'public', risk: 'delegate' },

  traecn_adopt_current_task: { layer: 'recovery', profile: 'ops', risk: 'delegate' },
  traecn_stop_generation: { layer: 'recovery', profile: 'ops', risk: 'delegate', destructive: true },
  traecn_get_review_gate_status: { layer: 'recovery', profile: 'ops', risk: 'read' },
  traecn_resolve_review_gate: { layer: 'recovery', profile: 'ops', risk: 'delegate', destructive: true },
  traecn_restart_debug_session: { layer: 'recovery', profile: 'ops', risk: 'delegate', destructive: true },
  traecn_list_solo_chats: { layer: 'solo', profile: 'ops', risk: 'read' },
  traecn_switch_solo_chat: { layer: 'solo', profile: 'ops', risk: 'write' },
  traecn_cleanup_queue_probe_chats: { layer: 'cleanup', profile: 'ops', risk: 'delegate', destructive: true },
  traecn_get_cleanup_watch_status: { layer: 'cleanup', profile: 'ops', risk: 'read' },
  traecn_start_long_queue_proof: { layer: 'acceptance', profile: 'ops', risk: 'delegate' },
  traecn_get_long_queue_proof_status: { layer: 'acceptance', profile: 'ops', risk: 'read' },
  traecn_cancel_long_queue_proof: { layer: 'acceptance', profile: 'ops', risk: 'delegate', destructive: true },

  traecn_get_status: { layer: 'diagnostics', profile: 'full', risk: 'read', alternative: 'traecn_preflight' },
  traecn_get_queue_status: { layer: 'diagnostics', profile: 'full', risk: 'read', alternative: 'traecn_preflight' },
  traecn_dismiss_dialog: { layer: 'dialog', profile: 'full', risk: 'delegate', destructive: true, alternative: 'traecn_respond_dialog' },
  traecn_submit_solo_task: { layer: 'solo', profile: 'full', risk: 'delegate', alternative: 'traecn_queue_task' }
});

const TOOL_ANNOTATIONS = Object.freeze({
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  delegate: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  admin: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  dynamic: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  'read-or-delegate': { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
});

const PUBLIC_MCP_TOOL_NAMES = Object.freeze(
  Object.entries(TOOL_METADATA)
    .filter(([, meta]) => meta.profile === 'public')
    .map(([name]) => name)
);

const OPS_MCP_TOOL_NAMES = Object.freeze(
  Object.entries(TOOL_METADATA)
    .filter(([, meta]) => meta.profile === 'public' || meta.profile === 'ops')
    .map(([name]) => name)
);

const DESTRUCTIVE_MCP_TOOLS = new Set(
  Object.entries(TOOL_METADATA)
    .filter(([, meta]) => meta.destructive === true)
    .map(([name]) => name)
);

function decorateTool(tool) {
  const metadata = TOOL_METADATA[tool.name] || { layer: 'misc', profile: 'full', risk: 'dynamic' };
  const annotations = {
    ...(TOOL_ANNOTATIONS[metadata.risk] || TOOL_ANNOTATIONS.dynamic),
    destructiveHint: DESTRUCTIVE_MCP_TOOLS.has(tool.name)
  };
  return Object.freeze({
    ...tool,
    annotations
  });
}

const MCP_TOOLS = Object.freeze(RAW_MCP_TOOLS.map(decorateTool));

const FULL_MCP_TOOL_NAMES = Object.freeze(MCP_TOOLS.map(tool => tool.name));

const MCP_TOOL_PROFILES = Object.freeze({
  public: Object.freeze(PUBLIC_MCP_TOOL_NAMES.slice()),
  ops: Object.freeze(OPS_MCP_TOOL_NAMES.slice()),
  full: FULL_MCP_TOOL_NAMES
});

const MCP_TOOL_PROFILE_DESCRIPTIONS = Object.freeze({
  public: 'Default profile for general MCP clients. Keeps high-signal task, review, settings, dialog, and workflow tools visible.',
  ops: 'Operational profile for recovery, cleanup, Solo conversation management, and long-queue proof workflows.',
  full: 'Complete explicit tool surface, including diagnostics and compatibility shortcuts that public clients can usually reach through traecn_preflight or traecn_run_command.'
});

function normalizeMcpToolProfile(profile) {
  const normalized = String(profile || DEFAULT_MCP_TOOL_PROFILE).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(MCP_TOOL_PROFILES, normalized) ? normalized : DEFAULT_MCP_TOOL_PROFILE;
}

function getMcpToolsForProfile(profile = DEFAULT_MCP_TOOL_PROFILE) {
  const normalized = normalizeMcpToolProfile(profile);
  const names = new Set(MCP_TOOL_PROFILES[normalized]);
  return MCP_TOOLS.filter(tool => names.has(tool.name));
}

function getMcpToolMetadata(toolName) {
  return TOOL_METADATA[toolName] || { layer: 'misc', profile: 'full', risk: 'dynamic' };
}

function getMcpToolProfileSummary() {
  return Object.fromEntries(Object.entries(MCP_TOOL_PROFILES).map(([name, tools]) => [
    name,
    {
      default: name === DEFAULT_MCP_TOOL_PROFILE,
      count: tools.length,
      description: MCP_TOOL_PROFILE_DESCRIPTIONS[name],
      tools: tools.slice()
    }
  ]));
}

function envToolProfile() {
  return normalizeMcpToolProfile(process.env.TRAECN_MCP_TOOL_PROFILE);
}

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

async function callTool(name, args = {}, context = envContext(), authContext = {}, options = {}) {
  const internalName = internalMcpToolName(name);
  if (!internalName) throw new Error(`Unknown tool: ${name}`);

  // Authorize before any side effects. The auth layer is a no-op when the
  // API key manager is not enabled, preserving single-user setups.
  const decision = mcpAuth.authorizeTool({
    apiKeyManager: authContext.apiKeyManager,
    keyId: authContext.keyId,
    toolName: name,
    args
  });
  if (!decision.ok) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: decision.message,
          code: decision.code,
          required: decision.required
        }, null, 2)
      }],
      isError: true
    };
  }

  const skill = new TraeCNSkill(context);

  switch (internalName) {
    case 'traecn_capabilities':
      return asMcpContent(buildCapabilities({
        commands: listCommands(),
        mcpTools: getMcpToolsForProfile(options.toolProfile || envToolProfile()),
        mcpToolProfile: normalizeMcpToolProfile(options.toolProfile || envToolProfile()),
        mcpToolProfiles: getMcpToolProfileSummary(),
        mcpToolMetadata: Object.fromEntries(MCP_TOOLS.map(tool => [tool.name, getMcpToolMetadata(tool.name)]))
      }));
    case 'traecn_command_set':
      return asMcpContent({ commands: listCommands() });
    case 'traecn_command': {
      const client = new TraeCNApiClient(context);
      const result = await executeCommand(client, args.command, args.params || {});
      return asMcpContent(result.data || result);
    }
    case 'plan_operation':
      return asMcpContent(buildConfirmationPlan(args));
    case 'preflight':
      return asMcpContent(await skill.preflight(args));
    case 'run_task':
      if (isGenericQueueProbeTask(args && args.task)) {
        return asMcpContent({
          ok: false,
          error: 'generic_queue_probe_task_rejected',
          message: 'Do not send queue probe prompts to Trae. Use traecn_preflight, queue_status, or traecn_wait_task for local waiting.'
        });
      }
      return asMcpContent(await skill.run(args.task, args));
    case 'queue_task':
      if (isGenericQueueProbeTask(args && args.task)) {
        return asMcpContent({
          ok: false,
          error: 'generic_queue_probe_task_rejected',
          message: 'Do not send queue probe prompts to Trae. Use traecn_preflight, queue_status, or traecn_wait_task for local waiting.'
        });
      }
      return asMcpContent(await skill.queue(args.task, args));
    case 'poll_task':
      return asMcpContent(await skill.poll(args.taskId || null));
    case 'wait_task': {
      const client = new TraeCNApiClient(context);
      return asMcpContent(await client.waitForTask(args.taskId, args));
    }
    case 'adopt_current_task': {
      const client = new TraeCNApiClient(context);
      const result = await client.adoptCurrentTask(args);
      return asMcpContent(result.data || result);
    }
    case 'cancel_task': {
      const client = new TraeCNApiClient(context);
      const result = await client.cancelTask(args.taskId);
      return asMcpContent(result.data || result);
    }
    case 'stop_generation': {
      const client = new TraeCNApiClient(context);
      const result = await client.stopGeneration();
      return asMcpContent(result.data || result);
    }
    case 'review_gate_status': {
      const client = new TraeCNApiClient(context);
      const result = await client.getReviewGateStatus();
      return asMcpContent(result.data || result);
    }
    case 'resolve_review_gate': {
      const client = new TraeCNApiClient(context);
      const result = await client.resolveReviewGate(args.action || 'keep_all');
      return asMcpContent(result.data || result);
    }
    case 'dismiss_dialog': {
      const client = new TraeCNApiClient(context);
      const result = await executeCommand(client, 'dismiss_dialog', {});
      return asMcpContent(result.data || result);
    }
    case 'restart_trae_debug': {
      const client = new TraeCNApiClient(context);
      const result = await client.restartTraeDebug(args);
      return asMcpContent(result.data || result);
    }
    case 'review_code':
      return asMcpContent(args.queue ? await skill.queue(buildCodeReviewTask(args), args) : await skill.reviewCode(args, args));
    case 'check_status':
      return asMcpContent(await skill.status(args.allowAutoStart === true));
    case 'switch_model':
      return asMcpContent(await skill.switchModel(args.name, { waitForQueue: args.waitForQueue }));
    case 'switch_mode':
      return asMcpContent(await skill.switchMode(args.mode));
    case 'new_chat':
      return asMcpContent(await skill.newChat());
    case 'list_solo_chats': {
      const client = new TraeCNApiClient(context);
      const result = await client.listSoloChats();
      return asMcpContent(result.data || result);
    }
    case 'switch_solo_chat': {
      const client = new TraeCNApiClient(context);
      const result = await client.switchSoloChat(args);
      return asMcpContent(result.data || result);
    }
    case 'cleanup_foreign_solo_queue': {
      const client = new TraeCNApiClient(context);
      const result = await client.cleanupForeignSoloQueue(args);
      return asMcpContent(result.data || result);
    }
    case 'cleanup_queue_watch_status': {
      const client = new TraeCNApiClient(context);
      const result = await executeCommand(client, 'cleanup_queue_watch_status', args);
      return asMcpContent(result.data || result);
    }
    case 'long_queue_proof_start': {
      const client = new TraeCNApiClient(context);
      const result = await executeCommand(client, 'long_queue_proof_start', args);
      return asMcpContent(result.data || result);
    }
    case 'long_queue_proof_status': {
      const client = new TraeCNApiClient(context);
      const result = await executeCommand(client, 'long_queue_proof_status', args);
      return asMcpContent(result.data || result);
    }
    case 'long_queue_proof_cancel': {
      const client = new TraeCNApiClient(context);
      const result = await executeCommand(client, 'long_queue_proof_cancel', args);
      return asMcpContent(result.data || result);
    }
    case 'submit_solo_chat_task': {
      const client = new TraeCNApiClient(context);
      const result = await client.submitSoloChatTask(args.task, args);
      return asMcpContent(result.data || result);
    }
    case 'get_settings':
      return asMcpContent(await skill.getSettings(args.section || null));
    case 'set_setting':
      return asMcpContent(await skill.setSetting(args.label, args.value, args.section || null));
    case 'approve_dialog':
      return asMcpContent(await skill.approveDialog(args.action || 'auto', args.wait === true));
    case 'check_dialog':
      return asMcpContent(await skill.checkDialog());
    case 'check_queue':
      return asMcpContent(await skill.queueStatus());
    case 'open_project':
      return asMcpContent(await skill.openProject(args.projectPath));
    case 'vibe_workflow':
      return asMcpContent(await skill.vibeWorkflow(args));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function createMcpHandlers(context = envContext(), authContext = {}, options = {}) {
  const toolProfile = normalizeMcpToolProfile(options.toolProfile || envToolProfile());
  return {
    async handle(message) {
      const { method, params = {} } = message;
      if (method === 'initialize') {
        return {
          protocolVersion: params.protocolVersion || '2024-11-05',
          capabilities: promptLayers.getMcpCapabilities(),
          serverInfo: SERVER_INFO
        };
      }
      if (method === 'tools/list') return { tools: getMcpToolsForProfile(toolProfile) };
      if (method === 'tools/call') {
        return callTool(params.name, params.arguments || {}, context, authContext, { toolProfile });
      }
      if (method === 'prompts/list') return { prompts: promptLayers.listMcpPrompts() };
      if (method === 'prompts/get') return promptLayers.getMcpPrompt(params.name, params.arguments || {});
      if (method === 'resources/list') return { resources: promptLayers.listMcpResources() };
      if (method === 'resources/read') {
        const resource = promptLayers.readMcpResource(params.uri);
        return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text }] };
      }
      if (method && method.startsWith('notifications/')) return undefined;
      throw new Error(`Unknown MCP method: ${method}`);
    }
  };
}

function writeMessage(message) {
  const payload = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
}

function startStdioServer() {
  const handlers = createMcpHandlers();
  let buffer = Buffer.alloc(0);

  process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = buffer.slice(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + length;
      if (buffer.length < messageEnd) return;
      const raw = buffer.slice(messageStart, messageEnd).toString('utf8');
      buffer = buffer.slice(messageEnd);

      Promise.resolve()
        .then(() => JSON.parse(raw))
        .then(async request => {
          const result = await handlers.handle(request);
          if (request.id === undefined || result === undefined) return;
          writeMessage({ jsonrpc: '2.0', id: request.id, result });
        })
        .catch(error => {
          let id = null;
          try {
            id = JSON.parse(raw).id ?? null;
          } catch {
            // Keep id=null when the request body itself is invalid JSON.
          }
          writeMessage({ jsonrpc: '2.0', id, error: { code: -32000, message: error.message } });
        });
    }
  });
}

if (require.main === module) {
  startStdioServer();
}

module.exports = {
  DEFAULT_MCP_TOOL_PROFILE,
  MCP_TOOL_PROFILES,
  MCP_TOOLS,
  SERVER_INFO,
  callTool,
  createMcpHandlers,
  envContext,
  getMcpToolMetadata,
  getMcpToolProfileSummary,
  getMcpToolsForProfile,
  normalizeMcpToolProfile,
  startStdioServer,
  mcpAuth
};
