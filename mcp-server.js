#!/usr/bin/env node
'use strict';

const { TraeCNSkill } = require('./src/skill/traecn-skill');
const promptLayers = require('./src/skill/prompt-layers');
const { buildCodeReviewTask } = require('./src/skill/review');
const { buildCapabilities } = require('./src/shared/capabilities');
const { buildConfirmationPlan } = require('./src/shared/operation-confirmation');
const { executeCommand, listCommands } = require('./integrations/openclaw-traecn-plugin/lib/command-set');
const { TraeCNApiClient } = require('./integrations/openclaw-traecn-plugin/lib/traecnapi-client');
const mcpAuth = require('./src/shared/mcp-auth');

const SERVER_INFO = Object.freeze({ name: 'traecnclaw', version: require('./package.json').version });

function envContext() {
  return {
    host: process.env.TRAECN_HOST || process.env.HOST || '127.0.0.1',
    port: Number(process.env.TRAECN_PORT || process.env.PORT || 8788),
    token: process.env.TRAECN_GATEWAY_TOKEN || process.env.TRAECN_API_KEY || '',
    timeout: Number(process.env.TRAECN_TIMEOUT || 120000)
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

const MCP_TOOLS = Object.freeze([
  {
    name: 'traecn_capabilities',
    description: 'Return a compact agent-facing capability catalog for low-token discovery.',
    inputSchema: schema()
  },
  {
    name: 'traecn_command_set',
    description: 'List every stable TraeCNclaw command exposed to agents.',
    inputSchema: schema()
  },
  {
    name: 'traecn_command',
    description: 'Execute any stable TraeCNclaw command by name. Use traecn_command_set for parameters.',
    inputSchema: schema({
      command: { type: 'string', enum: listCommands().map(item => item.command) },
      params: { type: 'object', description: 'Command-specific parameters.' }
    }, ['command'])
  },
  {
    name: 'plan_operation',
    description: 'Create a compact confirmation/preflight plan before executing a side-effecting TraeCN command.',
    inputSchema: schema({
      command: { type: 'string' },
      params: { type: 'object' },
      forceConfirm: { type: 'boolean' }
    }, ['command'])
  },
  {
    name: 'preflight',
    description: 'Return one compact status/readiness/queue/dialog summary plus optional command confirmation plan.',
    inputSchema: schema({
      command: { type: 'string' },
      params: { type: 'object' },
      forceConfirm: { type: 'boolean' }
    })
  },
  {
    name: 'run_task',
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
    name: 'queue_task',
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
    name: 'poll_task',
    description: 'Poll a queued TraeCN task by taskId.',
    inputSchema: schema({ taskId: { type: 'string' } })
  },
  {
    name: 'wait_task',
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
    name: 'adopt_current_task',
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
    name: 'cancel_task',
    description: 'Cancel a queued or review-waiting TraeCN background task.',
    inputSchema: schema({ taskId: { type: 'string' } }, ['taskId'])
  },
  {
    name: 'stop_generation',
    description: 'Stop the current TraeCN generation or queued model request.',
    inputSchema: schema()
  },
  {
    name: 'review_gate_status',
    description: 'Inspect whether TraeCN is blocked on its internal keep/revert review gate.',
    inputSchema: schema()
  },
  {
    name: 'resolve_review_gate',
    description: 'Resolve TraeCN internal keep/revert review gate.',
    inputSchema: schema({ action: { type: 'string', enum: ['keep_all', 'revert_all', 'keep', 'discard'] } })
  },
  {
    name: 'dismiss_dialog',
    description: 'Dismiss the current TraeCN dialog.',
    inputSchema: schema()
  },
  {
    name: 'restart_trae_debug',
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
    name: 'review_code',
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
    name: 'check_status',
    description: 'Check whether the TraeCN gateway is connected.',
    inputSchema: schema()
  },
  {
    name: 'switch_model',
    description: 'Switch the active TraeCN model with fuzzy matching.',
    inputSchema: schema({
      name: { type: 'string' },
      waitForQueue: { type: 'boolean' }
    }, ['name'])
  },
  {
    name: 'switch_mode',
    description: 'Switch TraeCN between SOLO and IDE modes.',
    inputSchema: schema({ mode: { type: 'string', enum: ['solo', 'ide'] } }, ['mode'])
  },
  {
    name: 'new_chat',
    description: 'Create a new TraeCN chat.',
    inputSchema: schema()
  },
  {
    name: 'list_solo_chats',
    description: 'List real Solo-mode TraeCN conversations from the Solo sidebar.',
    inputSchema: schema()
  },
  {
    name: 'switch_solo_chat',
    description: 'Switch to a real Solo-mode TraeCN conversation by index or visible text.',
    inputSchema: schema({
      index: { type: 'number' },
      titleIncludes: { type: 'string' },
      textIncludes: { type: 'string' }
    })
  },
  {
    name: 'cleanup_foreign_solo_queue',
    description: 'Find and optionally delete accidental queue-probe Solo conversations without sending another prompt to TraeCN.',
    inputSchema: schema({
      dryRun: { type: 'boolean' },
      execute: { type: 'boolean' },
      maxPasses: { type: 'number' },
      settleMs: { type: 'number' }
    })
  },
  {
    name: 'cleanup_queue_watch_status',
    description: 'Read local cleanup watcher lock/PID/stale status without contacting TraeCN or creating conversations.',
    inputSchema: schema({
      lockFile: { type: 'string' }
    })
  },
  {
    name: 'long_queue_proof_start',
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
    name: 'long_queue_proof_status',
    description: 'Read the latest or marker-scoped GLM-5.2 proof status without sending any TraeCN prompt.',
    inputSchema: schema({
      marker: { type: 'string' },
      outputDir: { type: 'string' }
    })
  },
  {
    name: 'long_queue_proof_cancel',
    description: 'Cancel the latest or marker-scoped GLM-5.2 proof watcher/task tracking without resubmitting a prompt.',
    inputSchema: schema({
      marker: { type: 'string' },
      taskId: { type: 'string' },
      outputDir: { type: 'string' }
    })
  },
  {
    name: 'submit_solo_chat_task',
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
    name: 'get_settings',
    description: 'Read TraeCN settings from the current or named section.',
    inputSchema: schema({ section: { type: 'string' } })
  },
  {
    name: 'set_setting',
    description: 'Set a TraeCN setting by label.',
    inputSchema: schema({ label: { type: 'string' }, value: {}, section: { type: 'string' } }, ['label', 'value'])
  },
  {
    name: 'approve_dialog',
    description: 'Approve, deny, confirm, or dismiss the current TraeCN dialog.',
    inputSchema: schema({ action: { type: 'string' }, wait: { type: 'boolean' } })
  },
  {
    name: 'check_dialog',
    description: 'Check whether TraeCN is showing a dialog that needs user confirmation.',
    inputSchema: schema()
  },
  {
    name: 'check_queue',
    description: 'Check current model queue/busy status.',
    inputSchema: schema()
  },
  {
    name: 'open_project',
    description: 'Open a local project path in TraeCN.',
    inputSchema: schema({ projectPath: { type: 'string' } }, ['projectPath'])
  },
  {
    name: 'vibe_workflow',
    description: 'Start an unattended vibe coding workflow: initial task plus auto-continued follow-up tasks.',
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

function asMcpContent(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

async function callTool(name, args = {}, context = envContext(), authContext = {}) {
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

  switch (name) {
    case 'traecn_capabilities':
      return asMcpContent(buildCapabilities({ commands: listCommands(), mcpTools: MCP_TOOLS }));
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
      return asMcpContent(await skill.run(args.task, args));
    case 'queue_task':
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

function createMcpHandlers(context = envContext(), authContext = {}) {
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
      if (method === 'tools/list') return { tools: MCP_TOOLS };
      if (method === 'tools/call') return callTool(params.name, params.arguments || {}, context, authContext);
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
          try { id = JSON.parse(raw).id ?? null; } catch {}
          writeMessage({ jsonrpc: '2.0', id, error: { code: -32000, message: error.message } });
        });
    }
  });
}

if (require.main === module) {
  startStdioServer();
}

module.exports = {
  MCP_TOOLS,
  SERVER_INFO,
  callTool,
  createMcpHandlers,
  envContext,
  startStdioServer,
  mcpAuth
};
