'use strict';

const { RAW_MCP_TOOLS } = require('./tools');
const { assertMcpContract } = require('./contract');

const TOOL_METADATA = Object.freeze({
  traecn_send_message: { layer: 'task', risk: 'delegate' },
  traecn_get_task: { layer: 'task', risk: 'read' },
  traecn_cancel_task: { layer: 'task', risk: 'delegate', destructive: true },
  traecn_stop_generation: { layer: 'task', risk: 'delegate', destructive: true },
  traecn_open_workspace: { layer: 'context', risk: 'delegate' },
  traecn_list_models: { layer: 'context', risk: 'read' },
  traecn_select_model: { layer: 'context', risk: 'write' },
  traecn_select_mode: { layer: 'context', risk: 'write' },
  traecn_list_setting_sections: { layer: 'settings', risk: 'read' },
  traecn_list_settings: { layer: 'settings', risk: 'read' },
  traecn_list_setting_options: { layer: 'settings', risk: 'read' },
  traecn_set_setting_toggle: { layer: 'settings', risk: 'write' },
  traecn_select_setting_option: { layer: 'settings', risk: 'write' },
  traecn_set_setting_text: { layer: 'settings', risk: 'write' },
  traecn_list_conversations: { layer: 'conversation', risk: 'read' },
  traecn_create_conversation: { layer: 'conversation', risk: 'write' },
  traecn_select_conversation: { layer: 'conversation', risk: 'write' },
  traecn_delete_conversation: { layer: 'conversation', risk: 'delegate', destructive: true },
  traecn_answer_question: { layer: 'interaction', risk: 'delegate' },
  traecn_decide_approval: { layer: 'interaction', risk: 'delegate', destructive: true }
});

const TOOL_ANNOTATIONS = Object.freeze({
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  delegate: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
});

const DESTRUCTIVE_MCP_TOOLS = new Set(
  Object.entries(TOOL_METADATA)
    .filter(([, metadata]) => metadata.destructive === true)
    .map(([name]) => name)
);

function getMcpToolMetadata(toolName) {
  return TOOL_METADATA[toolName] || { layer: 'misc', risk: 'delegate' };
}

function decorateTool(tool) {
  const metadata = getMcpToolMetadata(tool.name);
  return Object.freeze({
    ...tool,
    outputSchema: {
      type: 'object',
      additionalProperties: true
    },
    annotations: {
      ...(TOOL_ANNOTATIONS[metadata.risk] || TOOL_ANNOTATIONS.delegate),
      destructiveHint: DESTRUCTIVE_MCP_TOOLS.has(tool.name)
    }
  });
}

const MCP_TOOLS = Object.freeze(assertMcpContract(RAW_MCP_TOOLS.map(decorateTool)));

module.exports = {
  MCP_TOOLS,
  TOOL_METADATA,
  TOOL_ANNOTATIONS,
  DESTRUCTIVE_MCP_TOOLS,
  decorateTool,
  getMcpToolMetadata
};
