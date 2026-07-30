'use strict';

const { isGenericQueueProbeTask } = require('../shared/utils');

function schema(properties = {}, required = []) {
  return { type: 'object', properties, required };
}

const WORKFLOW_STEP_SCHEMA = Object.freeze({
  anyOf: [
    { type: 'string' },
    {
      type: 'object',
      required: ['message'],
      properties: {
        message: { type: 'string' },
        completionChecks: { type: 'object' }
      }
    }
  ]
});

/**
 * The MCP surface is deliberately small. Queueing, preflight, recovery,
 * approval-card handling, mode/model switching and event delivery are gateway
 * responsibilities rather than choices every calling agent must repeatedly
 * reason about.
 */
const RAW_MCP_TOOLS = Object.freeze([
  {
    name: 'traecn_submit',
    description: 'Submit work to TraeCN. The gateway prepares the workspace, model, mode and conversation, then owns queueing, recovery and completion delivery.',
    inputSchema: schema({
      message: { type: 'string', description: 'The exact message to send to TraeCN.' },
      model: { type: 'string', description: 'Optional preferred model.' },
      mode: { type: 'string', enum: ['solo', 'ide'], description: 'Optional preferred TraeCN mode.' },
      workspace: { type: 'string', description: 'Optional local folder to open before submission. It is never added to the message.' },
      conversationId: { type: 'string', description: 'Optional conversation returned by traecn_list_conversations.' },
      newConversation: { type: 'boolean', description: 'Create a conversation before sending.' },
      steps: { type: 'array', items: WORKFLOW_STEP_SCHEMA, description: 'Optional follow-up work automatically continued by the gateway.' },
      completionChecks: { type: 'object' }
    }, ['message'])
  },
  {
    name: 'traecn_get_task',
    description: 'Read one task only when an explicit progress or final-result check is needed.',
    inputSchema: schema({ taskId: { type: 'string' } }, ['taskId'])
  },
  {
    name: 'traecn_cancel_task',
    description: 'Cancel a task. The gateway removes queued work or stops the active TraeCN generation as appropriate.',
    inputSchema: schema({ taskId: { type: 'string' } }, ['taskId'])
  },
  {
    name: 'traecn_list_conversations',
    description: 'List TraeCN conversations in the current mode with stable gateway conversation identifiers.',
    inputSchema: schema()
  },
  {
    name: 'traecn_manage_conversation',
    description: 'Create, select or delete a TraeCN conversation.',
    inputSchema: schema({
      action: { type: 'string', enum: ['create', 'select', 'delete'] },
      conversationId: { type: 'string' }
    }, ['action'])
  },
  {
    name: 'traecn_resolve_interaction',
    description: 'Resolve only an exceptional TraeCN question or unsafe approval that the gateway cannot safely handle automatically.',
    inputSchema: schema({
      action: { type: 'string', enum: ['approve', 'deny', 'answer', 'dismiss'] },
      answer: { type: 'string' }
    }, ['action'])
  }
]);

const MCP_TOOL_INTERNAL_NAMES = Object.freeze({
  traecn_submit: 'submit',
  traecn_get_task: 'get_task',
  traecn_cancel_task: 'cancel_task',
  traecn_list_conversations: 'list_conversations',
  traecn_manage_conversation: 'manage_conversation',
  traecn_resolve_interaction: 'resolve_interaction'
});

function internalMcpToolName(toolName) {
  return MCP_TOOL_INTERNAL_NAMES[toolName] || null;
}

function asMcpContent(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
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
