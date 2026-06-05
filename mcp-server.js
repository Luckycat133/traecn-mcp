#!/usr/bin/env node
'use strict';

const { TraeCNSkill } = require('./src/skill/traecn-skill');
const promptLayers = require('./src/skill/prompt-layers');
const { buildCodeReviewTask } = require('./src/skill/review');
const { buildCapabilities } = require('./src/shared/capabilities');
const { buildConfirmationPlan } = require('./src/shared/operation-confirmation');
const { executeCommand, listCommands } = require('./integrations/openclaw-traecn-plugin/lib/command-set');
const { TraeCNApiClient } = require('./integrations/openclaw-traecn-plugin/lib/traecnapi-client');

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
      includeProcess: { type: 'boolean' },
      autoWait: { type: 'boolean', default: true },
      mode: { type: 'string', enum: ['solo', 'ide'] }
    }, ['task'])
  },
  {
    name: 'queue_task',
    description: 'Submit a task for queue-aware background processing and return a taskId.',
    inputSchema: schema({ task: { type: 'string' }, projectPath: { type: 'string' } }, ['task'])
  },
  {
    name: 'poll_task',
    description: 'Poll a queued TraeCN task by taskId.',
    inputSchema: schema({ taskId: { type: 'string' } })
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
      queue: { type: 'boolean' }
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
    inputSchema: schema({ name: { type: 'string' } }, ['name'])
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
  }
]);

function asMcpContent(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

async function callTool(name, args = {}, context = envContext()) {
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
    case 'review_code':
      return asMcpContent(args.queue ? await skill.queue(buildCodeReviewTask(args), args) : await skill.reviewCode(args, args));
    case 'check_status':
      return asMcpContent(await skill.status(args.allowAutoStart === true));
    case 'switch_model':
      return asMcpContent(await skill.switchModel(args.name));
    case 'switch_mode':
      return asMcpContent(await skill.switchMode(args.mode));
    case 'new_chat':
      return asMcpContent(await skill.newChat());
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
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function createMcpHandlers(context = envContext()) {
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
      if (method === 'tools/call') return callTool(params.name, params.arguments || {}, context);
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
  startStdioServer
};
