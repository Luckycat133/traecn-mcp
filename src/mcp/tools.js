'use strict';

const { isGenericQueueProbeTask } = require('../shared/utils');

function schema(properties = {}, required = []) {
  return { type: 'object', properties, required };
}

const CONVERSATION_ID = {
  type: 'string',
  description: 'Stable identifier returned by traecn_list_conversations.'
};

// Each tool represents one user intent. Queueing, waiting, recovery,
// notifications and routine approvals remain gateway-owned mechanics.
const RAW_MCP_TOOLS = Object.freeze([
  {
    name: 'traecn_send_message',
    description: 'Send one message to TraeCN as a persistent background task. Optionally target an existing conversation.',
    inputSchema: schema({
      message: { type: 'string', description: 'The exact message to send.' },
      conversationId: CONVERSATION_ID
    }, ['message'])
  },
  {
    name: 'traecn_get_task',
    description: 'Read one known task when an explicit status or result check is needed.',
    inputSchema: schema({ taskId: { type: 'string' } }, ['taskId'])
  },
  {
    name: 'traecn_cancel_task',
    description: 'Cancel one task; the gateway chooses queued removal or active generation stop.',
    inputSchema: schema({ taskId: { type: 'string' } }, ['taskId'])
  },
  {
    name: 'traecn_open_workspace',
    description: 'Open one local folder in the active TraeCN window and verify it became the workspace.',
    inputSchema: schema({ path: { type: 'string', description: 'Absolute local folder path.' } }, ['path'])
  },
  {
    name: 'traecn_list_models',
    description: 'List the models currently offered by TraeCN and identify the selected model.',
    inputSchema: schema()
  },
  {
    name: 'traecn_select_model',
    description: 'Select one TraeCN model without waiting or polling for model availability.',
    inputSchema: schema({ model: { type: 'string' } }, ['model'])
  },
  {
    name: 'traecn_select_mode',
    description: 'Select TraeCN Solo or IDE mode.',
    inputSchema: schema({ mode: { type: 'string', enum: ['solo', 'ide'] } }, ['mode'])
  },
  {
    name: 'traecn_list_conversations',
    description: 'List conversations in the current TraeCN mode with stable identifiers.',
    inputSchema: schema()
  },
  {
    name: 'traecn_create_conversation',
    description: 'Create and select a new TraeCN conversation.',
    inputSchema: schema()
  },
  {
    name: 'traecn_select_conversation',
    description: 'Select one existing TraeCN conversation.',
    inputSchema: schema({ conversationId: CONVERSATION_ID }, ['conversationId'])
  },
  {
    name: 'traecn_delete_conversation',
    description: 'Delete one existing TraeCN conversation.',
    inputSchema: schema({ conversationId: CONVERSATION_ID }, ['conversationId'])
  },
  {
    name: 'traecn_answer_question',
    description: 'Answer an exceptional TraeCN question that the gateway could not resolve mechanically.',
    inputSchema: schema({ answer: { type: 'string' } }, ['answer'])
  },
  {
    name: 'traecn_decide_approval',
    description: 'Approve or deny an exceptional unsafe or ambiguous TraeCN approval card.',
    inputSchema: schema({ decision: { type: 'string', enum: ['approve', 'deny'] } }, ['decision'])
  }
]);

const MCP_TOOL_INTERNAL_NAMES = Object.freeze({
  traecn_send_message: 'send_message',
  traecn_get_task: 'get_task',
  traecn_cancel_task: 'cancel_task',
  traecn_open_workspace: 'open_workspace',
  traecn_list_models: 'list_models',
  traecn_select_model: 'select_model',
  traecn_select_mode: 'select_mode',
  traecn_list_conversations: 'list_conversations',
  traecn_create_conversation: 'create_conversation',
  traecn_select_conversation: 'select_conversation',
  traecn_delete_conversation: 'delete_conversation',
  traecn_answer_question: 'answer_question',
  traecn_decide_approval: 'decide_approval'
});

function internalMcpToolName(toolName) {
  return MCP_TOOL_INTERNAL_NAMES[toolName] || null;
}

function asMcpContent(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }] };
}

function checkGenericQueueProbe(task) {
  return isGenericQueueProbeTask(task);
}

module.exports = {
  RAW_MCP_TOOLS,
  MCP_TOOL_INTERNAL_NAMES,
  internalMcpToolName,
  asMcpContent,
  checkGenericQueueProbe
};
