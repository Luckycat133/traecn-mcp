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
  unwrapGatewayResult,
  validateMcpToolArguments,
  checkGenericQueueProbe
} = require('./tools');
const { MCP_TOOLS } = require('./tool-metadata');
const {
  TASKS_EXTENSION_ID,
  McpTaskAdapter,
  assertTaskExtension,
  clientSupportsTaskExtension,
  taskIdempotencyKey
} = require('./task-extension');
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

function authorizeTool(name, args, authContext) {
  return mcpAuth.authorizeTool({
    apiKeyManager: authContext.apiKeyManager,
    keyId: authContext.keyId,
    toolName: name,
    args
  });
}

async function callTool(name, args = {}, context = envContext(), authContext = {}) {
  if (typeof name !== 'string' || !name) {
    throw new McpProtocolError(-32602, 'Tool name must be a non-empty string');
  }
  const internalName = internalMcpToolName(name);
  if (!internalName) throw new McpProtocolError(-32602, `Unknown tool: ${name}`);
  const tool = MCP_TOOLS.find(candidate => candidate.name === name);
  args = validateMcpToolArguments(tool, args);

  const decision = authorizeTool(name, args, authContext);
  if (!decision.ok) {
    return {
      ...asMcpContent({
        error: decision.message,
        code: decision.code,
        message: decision.message,
        required: decision.required,
        retryable: false,
        nextAction: `Authenticate with an API key that grants '${decision.required}' permission, then retry.`
      }),
      isError: true
    };
  }

  const client = new TraeCNApiClient(context);

  switch (internalName) {
    case 'send_message':
      if (checkGenericQueueProbe(args && args.message)) {
        const probeRejection = new Error(
          'The gateway already tracks queued work. Query the existing task instead of sending a queue-probe message.'
        );
        probeRejection.code = 'generic_queue_probe_task_rejected';
        probeRejection.retryable = false;
        probeRejection.nextAction = 'Query the existing task with traecn_get_task instead.';
        return asMcpError(probeRejection);
      }
      return asMcpContent(unwrapGatewayResult(await client.submitTask(args, {
        idempotencyKey: authContext.idempotencyKey
      })));
    case 'get_task': {
      const result = await client.getTaskStatus(args.taskId, { detailLevel: args.detailLevel });
      return asMcpContent(unwrapGatewayResult(result));
    }
    case 'cancel_task': {
      const result = await client.cancelTask(args.taskId);
      return asMcpContent(unwrapGatewayResult(result));
    }
    case 'stop_generation': {
      const result = await client.stopGeneration({
        conversationId: args.conversationId,
        acknowledgeUntrackedWork: args.acknowledgeUntrackedWork,
        reason: args.reason
      });
      return asMcpContent(unwrapGatewayResult(result));
    }
    case 'open_workspace': {
      const result = await client.openProject(args.path);
      return asMcpContent(unwrapGatewayResult(result));
    }
    case 'list_models': {
      const result = await client.listModels();
      return asMcpContent(unwrapGatewayResult(result));
    }
    case 'select_model': {
      const result = await client.switchModel(args.model, { waitForQueue: false });
      return asMcpContent(unwrapGatewayResult(result));
    }
    case 'select_mode': {
      const result = await client.switchMode(args.mode);
      return asMcpContent(unwrapGatewayResult(result));
    }
    case 'list_setting_sections': {
      const result = await client.settingsListSections({ restoreChat: true });
      return asMcpContent(unwrapGatewayResult(result));
    }
    case 'list_settings': {
      const result = await client.settingsRead(args.section, { restoreChat: true });
      return asMcpContent(unwrapGatewayResult(result));
    }
    case 'list_setting_options': {
      const result = await client.settingsListOptions(args.section, args.label, { restoreChat: true });
      return asMcpContent(unwrapGatewayResult(result));
    }
    case 'set_setting_toggle': {
      const result = await client.settingsWrite(args.section, {
        label: args.label,
        value: args.enabled,
        kind: 'toggle'
      }, settingsWriteOptions(args.section, args.label, args.enabled));
      return asMcpContent(unwrapGatewayResult(result));
    }
    case 'select_setting_option': {
      const result = await client.settingsWrite(args.section, {
        label: args.label,
        value: args.value,
        kind: 'option'
      }, settingsWriteOptions(args.section, args.label, args.value));
      return asMcpContent(unwrapGatewayResult(result));
    }
    case 'set_setting_text': {
      const result = await client.settingsWrite(args.section, {
        label: args.label,
        value: args.text,
        kind: 'text'
      }, settingsWriteOptions(args.section, args.label, args.text));
      return asMcpContent(unwrapGatewayResult(result));
    }
    case 'list_conversations': {
      const result = await client.listConversations();
      return asMcpContent(unwrapGatewayResult(result));
    }
    case 'create_conversation': {
      const result = await client.manageConversation({ action: 'create' });
      return asMcpContent(unwrapGatewayResult(result));
    }
    case 'select_conversation': {
      const result = await client.manageConversation({ action: 'select', conversationId: args.conversationId });
      return asMcpContent(unwrapGatewayResult(result));
    }
    case 'delete_conversation': {
      const result = await client.manageConversation({
        action: 'delete',
        conversationId: args.conversationId,
        expectedTitle: args.expectedTitle,
        acknowledgePermanentDeletion: args.acknowledgePermanentDeletion
      });
      return asMcpContent(unwrapGatewayResult(result));
    }
    case 'answer_question': {
      const result = await client.resolveInteraction({ action: 'answer', answer: args.answer });
      return asMcpContent(unwrapGatewayResult(result));
    }
    case 'decide_approval': {
      const result = await client.resolveInteraction({
        action: args.decision,
        ...(args.expectedCommand ? { expectedCommand: args.expectedCommand } : {}),
        ...(args.acknowledgeRisk === true ? { acknowledgeRisk: true } : {}),
        ...(args.reason ? { reason: args.reason } : {})
      });
      return asMcpContent(unwrapGatewayResult(result));
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function createMcpHandlers(context = envContext(), authContext = {}) {
  const gatewayClient = authContext.gatewayClient || new TraeCNApiClient(context);
  const taskAdapter = authContext.taskAdapter || new McpTaskAdapter({ client: gatewayClient });
  const assertAuthorized = (toolName, args = {}) => {
    const decision = authorizeTool(toolName, args, authContext);
    if (!decision.ok) {
      throw new McpProtocolError(-32000, decision.message, {
        code: decision.code,
        required: decision.required
      });
    }
  };
  return {
    subscribe(message) {
      assertModernRequest(message);
      assertTaskExtension(message);
      assertAuthorized('traecn_get_task');
      const notifications = message.params?.notifications;
      if (!notifications || typeof notifications !== 'object' || Array.isArray(notifications)) {
        throw new McpProtocolError(-32602, 'notifications must be an object');
      }
      const requested = message.params?.notifications?.taskIds;
      if (requested !== undefined && !Array.isArray(requested)) {
        throw new McpProtocolError(-32602, 'notifications.taskIds must be an array');
      }
      if ((requested || []).some(value => typeof value !== 'string' || !value.trim())) {
        throw new McpProtocolError(-32602, 'notifications.taskIds must contain non-empty strings');
      }
      const taskIds = [...new Set((requested || []).map(value => value.trim()))];
      return { taskIds };
    },
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
          capabilities: {
            ...promptLayers.getMcpCapabilities({ modern: true }),
            extensions: { [TASKS_EXTENSION_ID]: {} }
          },
          instructions: 'Use focused TraeCN tools; the gateway owns queueing, recovery, and safety controls.'
        }, { cacheable: true });
      }
      const finish = (result, options) => modern ? modernResult(result, options) : result;
      if (method === 'ping') return finish({});
      if (method === 'logging/setLevel') {
        if (modern) throw new McpProtocolError(-32601, 'logging/setLevel is unavailable in MCP 2026-07-28');
        const levels = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];
        if (!levels.includes(params.level)) {
          throw new McpProtocolError(-32602, 'Invalid logging level');
        }
        return {};
      }
      if (['tasks/get', 'tasks/update', 'tasks/cancel'].includes(method)) {
        assertModernRequest(message);
        assertTaskExtension(message);
      }
      if (method === 'tasks/get') {
        assertAuthorized('traecn_get_task', { taskId: params.taskId });
        return finish(await taskAdapter.get(params.taskId));
      }
      if (method === 'tasks/update') {
        assertAuthorized('traecn_decide_approval');
        if (!params.inputResponses || typeof params.inputResponses !== 'object' || Array.isArray(params.inputResponses)) {
          throw new McpProtocolError(-32602, 'inputResponses must be an object');
        }
        return finish(await taskAdapter.update(params.taskId, params.inputResponses));
      }
      if (method === 'tasks/cancel') {
        assertAuthorized('traecn_cancel_task', { taskId: params.taskId });
        return finish(await taskAdapter.cancel(params.taskId));
      }
      if (method === 'tools/list') return finish({ tools: MCP_TOOLS }, { cacheable: true });
      if (method === 'tools/call') {
        try {
          const taskAugmented = modern
            && params.name === 'traecn_send_message'
            && clientSupportsTaskExtension(message);
          const toolResult = await callTool(
            params.name,
            params.arguments === undefined ? {} : params.arguments,
            context,
            taskAugmented
              ? { ...authContext, idempotencyKey: taskIdempotencyKey(message) }
              : authContext
          );
          if (taskAugmented && toolResult.isError !== true && toolResult.structuredContent?.taskId) {
            return finish(await taskAdapter.create(toolResult.structuredContent));
          }
          return finish(toolResult);
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
