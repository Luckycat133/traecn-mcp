'use strict';

/**
 * MCP 处理器 — callTool 路由和 createMcpHandlers。
 * 从 mcp-server.js 拆分，保持单一职责。
 */

const { TraeCNSkill } = require('../skill/traecn-skill');
const promptLayers = require('../skill/prompt-layers');
const { executeCommand, listCommands } = require('../client/command-set');
const { TraeCNApiClient } = require('../client/traecnapi-client');
const { getGatewayContext, parsePositiveInt } = require('../shared/utils');
const mcpAuth = require('../shared/mcp-auth');
const {
  internalMcpToolName,
  asMcpContent,
  buildMcpCapabilities,
  buildMcpCodeReviewTask,
  buildMcpConfirmationPlan,
  checkGenericQueueProbe
} = require('./tools');
const {
  getMcpToolsForProfile,
  getMcpToolMetadata,
  getMcpToolProfileSummary,
  normalizeMcpToolProfile,
  envToolProfile,
  MCP_TOOLS
} = require('./tool-metadata');

const SERVER_INFO = Object.freeze({ name: 'traecnclaw', version: require('../../package.json').version });

function envContext() {
  const ctx = getGatewayContext();
  const env = process.env;
  return {
    host: env.TRAECN_HOST || ctx.host,
    port: parsePositiveInt(env.TRAECN_PORT || env.PORT, 8788),
    token: env.TRAECN_GATEWAY_TOKEN || env.TRAECN_API_KEY || ctx.token,
    timeout: parsePositiveInt(env.TRAECN_TIMEOUT, 120000)
  };
}

async function callTool(name, args = {}, context = envContext(), authContext = {}, options = {}) {
  const internalName = internalMcpToolName(name);
  if (!internalName) throw new Error(`Unknown tool: ${name}`);

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
      return asMcpContent(buildMcpCapabilities({
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
      return asMcpContent(buildMcpConfirmationPlan(args));
    case 'preflight':
      return asMcpContent(await skill.preflight(args));
    case 'run_task':
      if (checkGenericQueueProbe(args && args.task)) {
        return asMcpContent({
          ok: false,
          error: 'generic_queue_probe_task_rejected',
          message: 'Do not send queue probe prompts to Trae. Use traecn_preflight, queue_status, or traecn_wait_task for local waiting.'
        });
      }
      return asMcpContent(await skill.run(args.task, args));
    case 'queue_task':
      if (checkGenericQueueProbe(args && args.task)) {
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
      return asMcpContent(args.queue ? await skill.queue(buildMcpCodeReviewTask(args), args) : await skill.reviewCode(args, args));
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

module.exports = {
  SERVER_INFO,
  callTool,
  createMcpHandlers,
  envContext
};