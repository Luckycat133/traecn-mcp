'use strict';

const { TraeCNApiClient } = require('./lib/traecnapi-client');
const { COMMAND_DEFINITIONS, executeCommand, listCommands, mapSettingsAction } = require('./lib/command-set');

const PLUGIN_ID = 'traecnclaw';

const COMPLETION_CHECKS_SCHEMA = {
  type: 'object',
  properties: {
    requiredFiles: {
      type: 'array',
      items: { type: 'string' },
      description: 'Files that must exist before the gateway marks the task complete'
    },
    requiredText: {
      type: 'array',
      items: {
        type: 'object',
        required: ['filePath', 'includes'],
        properties: {
          filePath: { type: 'string' },
          includes: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } }
            ]
          }
        }
      },
      description: 'File text assertions that must pass before completion'
    }
  }
};

const VIBE_WORKFLOW_PARAMETERS = {
  type: 'object',
  required: ['task'],
  properties: {
    task: { type: 'string', description: 'The initial vibe coding task to delegate to TraeCN' },
    steps: {
      type: 'array',
      items: {
        oneOf: [
          { type: 'string' },
          { type: 'object' }
        ]
      },
      description: 'Follow-up workflow steps to auto-continue after the initial task'
    },
    followupTasks: {
      type: 'array',
      items: {
        oneOf: [
          { type: 'string' },
          { type: 'object' }
        ]
      },
      description: 'Alias for steps; included for compatibility with delegate_async workflow metadata'
    },
    completionChecks: COMPLETION_CHECKS_SCHEMA,
    projectPath: { type: 'string', description: 'Project path TraeCN should work inside' },
    chatId: { type: 'string', description: 'Optional OpenClaw chat id for notifications' },
    includeProcessText: { type: 'boolean', description: 'Include TraeCN process text in collected results', default: false },
    reviewRequired: { type: 'boolean', description: 'Mark workflow checkpoints reviewable while auto-continuing them', default: false },
    fallbackModels: {
      type: 'array',
      items: { type: 'string' },
      description: 'Ordered fallback models to probe while the selected model is queued'
    },
    autoModelFallback: { type: 'boolean', description: 'Use gateway default fallback model list while queued', default: false },
    modelProbeIntervalMs: { type: 'number', description: 'Minimum interval between fallback model probes' },
    notifyUrl: { type: 'string', description: 'Webhook URL to notify when workflow state changes' },
    maxQueueWaitMs: { type: 'number', description: 'Optional local queue wait cap; omit to wait indefinitely' }
  }
};

const toolDefinitions = [
  {
    name: 'traecn_capabilities',
    description: 'Return a compact agent-facing catalog of TraeCNclaw commands, HTTP endpoints, MCP surfaces, models, settings sections, and token-saving call order.',
    parameters: {
      type: 'object',
      properties: {}
    },
    handler: async (_params, context) => {
      const client = new TraeCNApiClient(context);
      const result = await executeCommand(client, 'capabilities', {});
      return result.data || result;
    }
  },
  {
    name: 'traecn_command_set',
    description: 'List the production command set OpenClaw can use to control TraeCN. Returns command names, summaries, and required/optional parameters.',
    parameters: {
      type: 'object',
      properties: {}
    },
    handler: async () => ({ commands: listCommands() })
  },
  {
    name: 'traecn_preflight',
    description: 'Return a compact one-call status/readiness/queue/dialog summary plus an optional command confirmation plan before side-effecting TraeCN work.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Optional command to assess, e.g. delegate_async or settings_set' },
        params: { type: 'object', description: 'Optional command parameters for confirmation planning' },
        forceConfirm: { type: 'boolean', description: 'Force confirmation planning even for lower-risk commands' }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      const result = await executeCommand(client, 'preflight', params || {});
      return result.data || result;
    }
  },
  {
    name: 'traecn_command',
    description: 'Execute a preset TraeCN command through the local TraeCNclaw gateway. Use traecn_command_set to discover available commands. Core commands include status, readiness, restart_trae_debug, new_chat, delegate, delegate_async, vibe_workflow, task_status, adopt_current_task, cancel_task, stop_generation, review_gate_status, resolve_review_gate, switch_mode, switch_model, queue_status, open_project, settings_read, settings_read_all, settings_set, settings_navigate, settings_back, dialog_status, approve_dialog, dismiss_dialog, batch_submit, batch_status, batch_cancel, and review_code.',
    parameters: {
      type: 'object',
      required: ['command'],
      properties: {
        command: {
          type: 'string',
          enum: COMMAND_DEFINITIONS.map(definition => definition.command),
          description: 'Preset command name from traecn_command_set'
        },
        params: {
          type: 'object',
          description: 'Command parameters. See traecn_command_set for required and optional keys.'
        }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      const result = await executeCommand(client, params.command, params.params || {});
      return result.data || result;
    }
  },
  {
    name: 'traecn_vibe_workflow',
    description: 'Run an unattended TraeCN vibe coding workflow: queue the initial task, auto-continue follow-up steps, survive model queues, and return a taskId for polling.',
    parameters: VIBE_WORKFLOW_PARAMETERS,
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      const result = await executeCommand(client, 'vibe_workflow', params || {});
      return result.data || result;
    }
  },
  {
    name: 'traecn_plan_operation',
    description: 'Create a compact side-effect and confirmation plan before executing a TraeCN command. This is a dry preflight and does not operate TraeCN.',
    parameters: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Command you intend to execute, e.g. settings_set or approve_dialog' },
        params: { type: 'object', description: 'Command-specific parameters to assess' },
        forceConfirm: { type: 'boolean', description: 'Force user confirmation even for lower-risk commands' }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      const result = await executeCommand(client, 'confirm_plan', params);
      return result.data || result;
    }
  },
  {
    name: 'traecn_task_status',
    description: 'Query the status of an async TraeCN task by taskId. Use after traecn_delegate returns a taskId with status "queued". Returns: done/queued/executing/error/cancelled/queue_timeout.',
    parameters: {
      type: 'object',
      required: ['taskId'],
      properties: {
        taskId: { type: 'string', description: 'The taskId returned from traecn_delegate when the model is queued' }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      const result = await client.getTaskStatus(params.taskId);
      return result.data || result;
    }
  },
  {
    name: 'traecn_cancel_task',
    description: 'Cancel a queued TraeCN task. Only works for tasks in "queued" state.',
    parameters: {
      type: 'object',
      required: ['taskId'],
      properties: {
        taskId: { type: 'string', description: 'The taskId returned from traecn_delegate when the model is queued' }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      const result = await client.cancelTask(params.taskId);
      return result.data || result;
    }
  },
  {
    name: 'traecn_settings_action',
    description: 'Perform supported actions on the TraeCN settings panel through implemented gateway routes. Actions: navigate/clickTab, read, readAll/readTables, type/toggle/dropdown/set, back. Section names: general(通用), account(账号), agents(智能体), mcp(MCP), flow(对话流), model(模型), context(上下文), rules(规则和技能), beta(Beta), about(关于 TRAE). Usage: {"action":"navigate","params":{"section":"MCP"}} then {"action":"read"} then {"action":"set","params":{"label":"Agent 名","value":"my-agent"}}.',
    parameters: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['navigate', 'read', 'readAll', 'type', 'clickTab', 'toggle', 'dropdown', 'set', 'readTables', 'back'],
          description: 'Action to perform on settings'
        },
        params: {
          type: 'object',
          description: 'Parameters for the action (varies by action type)',
          properties: {
            section: { type: 'string', description: 'Section to navigate to (for navigate action)' },
            label: { type: 'string', description: 'Label text of the setting item (for type/toggle/dropdown/set)' },
            text: { type: 'string', description: 'Text to type (for type) or element text to click (for click)' },
            value: { type: 'string', description: 'Value to set (for dropdown/set - selects option by text)' },
            enabled: { type: 'boolean', description: 'Toggle state (for toggle: true=on, false=off)' }
          }
        }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      const mapped = mapSettingsAction(params.action, params.params || {});
      const result = await executeCommand(client, mapped.command, mapped.params);
      return result.data || result;
    }
  },
  {
    name: 'traecn_settings_read',
    description: 'Read settings from the TraeCN settings panel. Optionally specify a section (canonical names: general, account, agents, mcp, flow/models, context, rules, about). Returns the settings panel content as text.',
    parameters: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Settings section to read. Leave empty for current section.' }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      const result = await client.settingsRead(params.section || null);
      return result.data || result;
    }
  },
  {
    name: 'traecn_settings_set',
    description: 'Change a setting in the TraeCN settings panel. Specify the label text and new value. Optionally specify a section to navigate to first.',
    parameters: {
      type: 'object',
      required: ['label', 'value'],
      properties: {
        label: { type: 'string', description: 'The label text of the setting to change (e.g. "Agent 名", "知识库")' },
        value: { type: 'string', description: 'The new value for the setting' },
        section: { type: 'string', description: 'Optional: settings section to navigate to first (canonical names: general, account, agents, mcp, flow/models, context, rules, about)' }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      const result = await client.settingsWrite(params.section || null, { label: params.label, value: params.value });
      return result.data || result;
    }
  },
  {
    name: 'traecn_status',
    description: 'Check if TraeCNclaw gateway is reachable and TraeCN automation is ready.',
    parameters: {
      type: 'object',
      properties: {
        allowAutoStart: { type: 'boolean', description: 'Allow automatically starting TraeCN if not running', default: false }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      return client.getStatus(params.allowAutoStart);
    }
  },
  {
    name: 'traecn_new_chat',
    description: 'Create a new chat in TraeCN and switch the UI to it.',
    parameters: {
      type: 'object',
      properties: {
        allowAutoStart: { type: 'boolean', description: 'Allow automatically starting TraeCN if not running', default: false }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      return client.newChat(params.allowAutoStart);
    }
  },
  {
    name: 'traecn_delegate',
    description: 'Delegate an IDE task to TraeCN desktop app and return the AI response. Queue-aware: if the model is busy/queued, returns { status: "queued", taskId, queueDetails } so you can use traecn_task_status to wait. If model is free, returns { status: "done", text, ... }. The taskId from a queued response lets you poll progress without burning tokens retrying.',
    parameters: {
      type: 'object',
      required: ['task'],
      properties: {
        task: { type: 'string', description: 'The task description to delegate to TraeCN' },
        projectPath: { type: 'string', description: 'Path to the project to open in TraeCN' },
        sessionId: { type: 'string', description: 'Existing session ID to use instead of creating a new one' },
        chatId: { type: 'string', description: 'Optional OpenClaw chat id for notifications' },
        allowAutoStart: { type: 'boolean', description: 'Allow automatically starting TraeCN if not running', default: false },
        includeProcessText: { type: 'boolean', description: 'Include process/thinking information in the response', default: false },
        waitForQueue: { type: 'boolean', description: 'If true (default), queue the task when model is busy. If false, return queue info immediately without waiting.', default: true },
        background: { type: 'boolean', description: 'Queue immediately in the gateway background worker', default: false },
        asyncPoll: { type: 'boolean', description: 'If true, always use async delegate path (returns taskId). Useful when you want to manage polling yourself.', default: false },
        reviewRequired: { type: 'boolean', description: 'Return successful results as review checkpoints before finalizing', default: false },
        autoContinue: { type: 'boolean', description: 'Automatically approve reviewable follow-up workflow checkpoints', default: false },
        followupTasks: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              { type: 'object' }
            ]
          },
          description: 'Follow-up tasks for unattended workflow continuation'
        },
        completionChecks: COMPLETION_CHECKS_SCHEMA,
        notifyUrl: { type: 'string', description: 'Webhook URL to notify when async task state changes' },
        fallbackModels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered model candidates to probe while queued. The gateway switches through them and uses the first model that can submit.'
        },
        autoModelFallback: { type: 'boolean', description: 'Use the gateway default fallback model list while queued.', default: false },
        modelProbeIntervalMs: { type: 'number', description: 'Minimum interval between background fallback model probes for this task.' }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);

      if (params.asyncPoll) {
        const result = await client.delegateAsync(params.task, {
          projectPath: params.projectPath,
          sessionId: params.sessionId,
          chatId: params.chatId,
          includeProcessText: params.includeProcessText,
          waitForQueue: params.waitForQueue !== false,
          background: params.background === true,
          reviewRequired: params.reviewRequired === true,
          autoContinue: params.autoContinue === true,
          followupTasks: params.followupTasks,
          notifyUrl: params.notifyUrl,
          fallbackModels: params.fallbackModels,
          autoModelFallback: params.autoModelFallback === true,
          modelProbeIntervalMs: params.modelProbeIntervalMs
        });
        return result.data || result;
      }

      // Try sync first (fast path when model is ready)
      let result = await client.delegate(params.task, {
        projectPath: params.projectPath,
        sessionId: params.sessionId,
        allowAutoStart: params.allowAutoStart,
        includeProcessText: params.includeProcessText,
        waitForQueue: params.waitForQueue,
        fallbackModels: params.fallbackModels,
        autoModelFallback: params.autoModelFallback === true,
        modelProbeIntervalMs: params.modelProbeIntervalMs
      });

      // If queued and waitForQueue is enabled, the delegate already handles
      // background waiting. If caller wants to manage it, return early.
      if (result && result.status === 'queued' && params.waitForQueue !== false) {
        const taskId = result.taskId;
        // Poll for completion (with reasonable limits)
        const maxPollAttempts = 40;
        const pollIntervalMs = 5000;
        for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
          await new Promise(r => setTimeout(r, pollIntervalMs));
          const pollResult = await client.getTaskStatus(taskId);
          const status = pollResult.data || pollResult;
          if (status.status === 'done') {
            return status.result || status;
          }
          if (status.status === 'error' || status.status === 'queue_timeout' || status.status === 'cancelled') {
            return status;
          }
          // Still queued or executing — keep waiting
        }
        return { status: 'queued', taskId, message: 'Task still in queue after max polling time. Use traecn_task_status to check later.' };
      }

      return result;
    }
  },
  {
    name: 'traecn_switch_mode',
    description: 'Switch TraeCN between SOLO and IDE modes.',
    parameters: {
      type: 'object',
      required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['solo', 'ide'], description: 'The mode to switch to' },
        allowAutoStart: { type: 'boolean', description: 'Allow automatically starting TraeCN if not running', default: false }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      return client.switchMode(params.mode, params.allowAutoStart);
    }
  },
  {
    name: 'traecn_switch_model',
    description: 'Switch the AI model used by TraeCN. Available models include: Doubao-Seed-2.0-Code, Doubao-Seed-1.8, GLM-5.1, DeepSeek-V3.1-Terminus, etc.',
    parameters: {
      type: 'object',
      required: ['model'],
      properties: {
        model: { type: 'string', description: 'The model name to switch to (e.g. "GLM-5.1", "DeepSeek-V3.1-Terminus")' },
        waitForQueue: { type: 'boolean', description: 'If false, return immediately after switching with queue details instead of waiting for the queue to clear.', default: true }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      return client.switchModel(params.model, { waitForQueue: params.waitForQueue });
    }
  },
  {
    name: 'traecn_queue_status',
    description: 'Check if the current TraeCN AI model is in a queued/busy state.',
    parameters: {
      type: 'object',
      properties: {}
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      return client.checkQueueStatus();
    }
  },
  {
    name: 'traecn_open_project',
    description: 'Open a project in TraeCN.',
    parameters: {
      type: 'object',
      required: ['projectPath'],
      properties: {
        projectPath: { type: 'string', description: 'Path to the project to open' }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      return client.openProject(params.projectPath);
    }
  },
  {
    name: 'traecn_chat',
    description: 'Quickly trigger a task via trae-cn chat CLI (fire-and-forget, does not return AI response). Use traecn_delegate instead when you need to read the response.',
    parameters: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'The prompt to send to TraeCN via CLI' },
        mode: { type: 'string', enum: ['ask', 'edit', 'agent'], description: 'CLI mode: ask, edit, or agent (default agent)' },
        addFile: { type: 'string', description: 'Add file as context' },
        maximize: { type: 'boolean', description: 'Maximize chat window', default: false },
        reuseWindow: { type: 'boolean', description: 'Reuse last window', default: false },
        newWindow: { type: 'boolean', description: 'Open new window', default: false }
      }
    },
    handler: async (params, context) => {
      const { spawn } = require('child_process');
      if (params.addFile && /[<>|&;$\r\n\t\0]/.test(params.addFile)) {
        return { launched: false, error: 'addFile contains invalid characters' };
      }
      if (typeof params.prompt !== 'string' || params.prompt.length === 0) {
        return { launched: false, error: 'prompt is required' };
      }
      const args = ['chat'];
      if (params.mode && ['ask', 'edit', 'agent'].includes(params.mode)) args.push('--mode', params.mode);
      if (params.maximize) args.push('--maximize');
      if (params.reuseWindow) args.push('--reuse-window');
      if (params.newWindow) args.push('--new-window');
      if (params.addFile) args.push('--add-file', params.addFile);
      args.push('--', params.prompt);

      const child = spawn('trae-cn', args, { stdio: 'pipe' });
      return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => stdout += d);
        child.stderr.on('data', d => stderr += d);
        child.on('close', (code) => {
          resolve({
            launched: true,
            exitCode: code,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            note: 'CLI mode does not return AI response. Use traecn_delegate for full interaction.'
          });
        });
        child.on('error', (err) => {
          resolve({ launched: false, error: err.message, note: 'trae-cn CLI not available' });
        });
      });
    }
  },
  {
    name: 'traecn_update_self',
    description: 'Update the TraeCNclaw plugin to the latest version.',
    parameters: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Force update even if already up to date', default: false }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      return client.updateSelf(params.force);
    }
  },
  {
    name: 'traecn_approve',
    description: 'Detect and approve/dismiss dialogs in TraeCN. Use when TraeCN shows a restricted mode, permission request, or confirmation dialog. Auto-detects the dialog type and clicks the appropriate button (trust, allow, confirm). Also supports deny/cancel actions.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['auto', 'trust', 'allow', 'confirm', 'approve', 'deny', 'cancel', 'dismiss'],
          description: '"auto" (default) auto-detects best action. "trust" for restricted mode folder trust. "allow"/"approve" for permission requests. "confirm" for execution confirmations. "deny"/"cancel"/"dismiss" to reject or cancel.',
          default: 'auto'
        },
        waitForDialog: {
          type: 'boolean',
          description: 'If true, waits up to 30 seconds for a dialog to appear before approving. Use when a dialog might appear with a delay.',
          default: false
        }
      }
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      const result = await client.approveDialog(params.action || 'auto');
      return result.data || result;
    }
  },
  {
    name: 'traecn_dialog_status',
    description: 'Check if there is a pending dialog (restricted mode, permission request, confirmation) in TraeCN. Returns hasDialog, dialogType (restricted_mode/approval/permission/command_execution/file_operation), question, and available buttons.',
    parameters: {
      type: 'object',
      properties: {}
    },
    handler: async (params, context) => {
      const client = new TraeCNApiClient(context);
      const result = await client.dialogStatus();
      return result.data || result;
    }
  }
];

const slashCommands = [
  {
    command: '/TraeCN',
    description: 'Create a new chat and delegate a task to TraeCN, returning only the final response',
    handler: async (args, context) => {
      const task = args.trim();
      if (!task) return 'Usage: /TraeCN <task>';
      const client = new TraeCNApiClient(context);
      const result = await client.delegate(task, { includeProcessText: false });
      return formatResult(result);
    }
  },
  {
    command: '/TraeCN process',
    description: 'Create a new chat and delegate a task to TraeCN, returning the full output including process information',
    handler: async (args, context) => {
      const task = args.trim();
      if (!task) return 'Usage: /TraeCN process <task>';
      const client = new TraeCNApiClient(context);
      const result = await client.delegate(task, { includeProcessText: true });
      return formatResult(result);
    }
  }
];

function formatResult(result) {
  if (result.error) {
    return `[TraeCN Error] ${result.error}`;
  }

  let output = result.text || 'No response from TraeCN';

  if (result.processText && result.processText !== result.text) {
    output += '\n\n--- Process ---\n' + result.processText;
  }

  if (result.timedOut) {
    output += '\n\n[Warning: Response timed out, result may be incomplete]';
  }

  return output;
}

function register(openClaw) {
  if (typeof openClaw.registerTool === 'function') {
    for (const tool of toolDefinitions) {
      openClaw.registerTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        handler: tool.handler
      });
    }
  }

  // registerSlashCommand was removed in OpenClaw 2026.4
  // Slash commands are handled via openclaw.plugin.json
  console.log(`[TraeCNclaw] Registered ${toolDefinitions.length} tools`);
}

module.exports = {
  PLUGIN_ID,
  toolDefinitions,
  slashCommands,
  formatResult,
  register
};
