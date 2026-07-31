'use strict';

/**
 * MCP 处理器 — callTool 路由和 createMcpHandlers。
 * 从 mcp-server.js 拆分，保持单一职责。
 */

const promptLayers = require('../skill/prompt-layers');
const { buildConfirmationPlan } = require('../shared/operation-confirmation');
const { TraeCNApiClient } = require('../client/traecnapi-client');
const { getGatewayContext, parsePositiveInt } = require('../shared/utils');
const mcpAuth = require('../shared/mcp-auth');
const {
  internalMcpToolName,
  asMcpContent,
  asMcpError,
  validateMcpToolArguments,
  checkGenericQueueProbe
} = require('./tools');
const { MCP_TOOLS } = require('./tool-metadata');
const {
  SERVER_INFO,
  SUPPORTED_PROTOCOL_VERSIONS,
  McpProtocolError,
  assertModernRequest,
  isModernRequest,
  modernResult,
  negotiateLegacyProtocolVersion
} = require('./protocol');

function settingsWriteOptions(section, label, value) {
  const plan = buildConfirmationPlan({
    command: 'settings_set',
    params: { section, label, value }
  });
  return { restoreChat: true, confirmationId: plan.confirmationId };
}

function envContext() {
  const ctx = getGatewayContext();
  const env = process.env;
  return {
    host: ctx.host,
    port: ctx.port,
    token: env.TRAECN_GATEWAY_TOKEN || env.TRAECN_API_KEY || ctx.token,
    timeout: parsePositiveInt(env.TRAECN_TIMEOUT, ctx.timeout)
  };
}

async function callTool(name, args = {}, context = envContext(), authContext = {}) {
  const internalName = internalMcpToolName(name);
  if (!internalName) throw new McpProtocolError(-32602, `Unknown tool: ${name}`);
  const tool = MCP_TOOLS.find(candidate => candidate.name === name);
  args = validateMcpToolArguments(tool, args);

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
      structuredContent: {
        error: decision.message,
        code: decision.code,
        required: decision.required
      },
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
    case 'stop_generation': {
      const result = await client.stopGeneration({
        conversationId: args.conversationId,
        acknowledgeUntrackedWork: args.acknowledgeUntrackedWork,
        reason: args.reason
      });
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
    case 'list_setting_sections': {
      const result = await client.settingsListSections({ restoreChat: true });
      return asMcpContent(result.data || result);
    }
    case 'list_settings': {
      const result = await client.settingsRead(args.section, { restoreChat: true });
      return asMcpContent(result.data || result);
    }
    case 'list_setting_options': {
      const result = await client.settingsListOptions(args.section, args.label, { restoreChat: true });
      return asMcpContent(result.data || result);
    }
    case 'set_setting_toggle': {
      const result = await client.settingsWrite(args.section, {
        label: args.label,
        value: args.enabled,
        kind: 'toggle'
      }, settingsWriteOptions(args.section, args.label, args.enabled));
      return asMcpContent(result.data || result);
    }
    case 'select_setting_option': {
      const result = await client.settingsWrite(args.section, {
        label: args.label,
        value: args.value,
        kind: 'option'
      }, settingsWriteOptions(args.section, args.label, args.value));
      return asMcpContent(result.data || result);
    }
    case 'set_setting_text': {
      const result = await client.settingsWrite(args.section, {
        label: args.label,
        value: args.text,
        kind: 'text'
      }, settingsWriteOptions(args.section, args.label, args.text));
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
      const result = await client.manageConversation({
        action: 'delete',
        conversationId: args.conversationId,
        expectedTitle: args.expectedTitle,
        acknowledgePermanentDeletion: args.acknowledgePermanentDeletion
      });
      return asMcpContent(result.data || result);
    }
    case 'answer_question': {
      const result = await client.resolveInteraction({ action: 'answer', answer: args.answer });
      return asMcpContent(result.data || result);
    }
    case 'decide_approval': {
      const result = await client.resolveInteraction({
        action: args.decision,
        ...(args.expectedCommand ? { expectedCommand: args.expectedCommand } : {}),
        ...(args.acknowledgeRisk === true ? { acknowledgeRisk: true } : {}),
        ...(args.reason ? { reason: args.reason } : {})
      });
      return asMcpContent(result.data || result);
    }
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
          protocolVersion: negotiateLegacyProtocolVersion(params.protocolVersion),
          capabilities: promptLayers.getMcpCapabilities({ modern: false }),
          serverInfo: SERVER_INFO
        };
      }
      const modern = isModernRequest(message);
      if (modern) assertModernRequest(message);
      if (method === 'server/discover') {
        if (!modern) assertModernRequest(message);
        return modernResult({
          supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
          capabilities: promptLayers.getMcpCapabilities({ modern: true }),
          instructions: 'Use focused TraeCN tools; the gateway owns queueing, recovery, and safety controls.'
        }, { cacheable: true });
      }
      const finish = (result, options) => modern ? modernResult(result, options) : result;
      if (method === 'tools/list') return finish({ tools: MCP_TOOLS }, { cacheable: true });
      if (method === 'tools/call') {
        try {
          return finish(await callTool(params.name, params.arguments || {}, context, authContext));
        } catch (error) {
          if (error instanceof McpProtocolError) throw error;
          return finish(asMcpError(error));
        }
      }
      if (method === 'prompts/list') {
        return finish({ prompts: promptLayers.listMcpPrompts() }, { cacheable: true });
      }
      if (method === 'prompts/get') {
        return finish(promptLayers.getMcpPrompt(params.name, params.arguments || {}));
      }
      if (method === 'resources/list') {
        return finish({ resources: promptLayers.listMcpResources() }, { cacheable: true });
      }
      if (method === 'resources/read') {
        const resource = promptLayers.readMcpResource(params.uri);
        return finish({
          contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text }]
        }, { cacheable: true });
      }
      if (method && method.startsWith('notifications/')) return undefined;
      throw new McpProtocolError(-32601, `Unknown MCP method: ${method}`);
    }
  };
}

module.exports = {
  SERVER_INFO,
  callTool,
  createMcpHandlers,
  envContext
};
