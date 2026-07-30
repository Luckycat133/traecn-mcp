'use strict';

/**
 * MCP 处理器 — callTool 路由和 createMcpHandlers。
 * 从 mcp-server.js 拆分，保持单一职责。
 */

const promptLayers = require('../skill/prompt-layers');
const { TraeCNApiClient } = require('../client/traecnapi-client');
const { getGatewayContext, parsePositiveInt } = require('../shared/utils');
const mcpAuth = require('../shared/mcp-auth');
const {
  internalMcpToolName,
  asMcpContent,
  checkGenericQueueProbe
} = require('./tools');
const {
  getMcpToolsForProfile,
  normalizeMcpToolProfile,
  envToolProfile
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

async function callTool(name, args = {}, context = envContext(), authContext = {}, _options = {}) {
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

  const client = new TraeCNApiClient(context);

  switch (internalName) {
    case 'send_message':
      if (checkGenericQueueProbe(args && args.message)) {
        return asMcpContent({
          ok: false,
          error: 'generic_queue_probe_task_rejected',
          message: 'The gateway already tracks queued work. Query the existing task instead of sending a queue-probe message.'
        });
      }
      return asMcpContent((await client.submitTask(args)).data);
    case 'get_task': {
      const result = await client.getTaskStatus(args.taskId);
      return asMcpContent(result.data || result);
    }
    case 'cancel_task': {
      const result = await client.cancelTask(args.taskId);
      return asMcpContent(result.data || result);
    }
    case 'open_workspace': {
      const result = await client.openProject(args.path);
      return asMcpContent(result.data || result);
    }
    case 'list_models': {
      const result = await client.listModels();
      return asMcpContent(result.data || result);
    }
    case 'select_model': {
      const result = await client.switchModel(args.model, { waitForQueue: false });
      return asMcpContent(result.data || result);
    }
    case 'select_mode': {
      const result = await client.switchMode(args.mode);
      return asMcpContent(result.data || result);
    }
    case 'list_conversations': {
      const result = await client.listConversations();
      return asMcpContent(result.data || result);
    }
    case 'create_conversation': {
      const result = await client.manageConversation({ action: 'create' });
      return asMcpContent(result.data || result);
    }
    case 'select_conversation': {
      const result = await client.manageConversation({ action: 'select', conversationId: args.conversationId });
      return asMcpContent(result.data || result);
    }
    case 'delete_conversation': {
      const result = await client.manageConversation({ action: 'delete', conversationId: args.conversationId });
      return asMcpContent(result.data || result);
    }
    case 'answer_question': {
      const result = await client.resolveInteraction({ action: 'answer', answer: args.answer });
      return asMcpContent(result.data || result);
    }
    case 'decide_approval': {
      const result = await client.resolveInteraction({ action: args.decision });
      return asMcpContent(result.data || result);
    }
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
