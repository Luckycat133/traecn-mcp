'use strict';

const MCP_CONTRACT_VERSION = 5;

const MCP_TOOL_NAMES = Object.freeze([
  'traecn_send_message',
  'traecn_get_task',
  'traecn_cancel_task',
  'traecn_stop_generation',
  'traecn_open_workspace',
  'traecn_list_models',
  'traecn_select_model',
  'traecn_select_mode',
  'traecn_list_setting_sections',
  'traecn_list_settings',
  'traecn_list_setting_options',
  'traecn_set_setting_toggle',
  'traecn_select_setting_option',
  'traecn_set_setting_text',
  'traecn_list_conversations',
  'traecn_create_conversation',
  'traecn_select_conversation',
  'traecn_delete_conversation',
  'traecn_answer_question',
  'traecn_decide_approval'
]);

function assertMcpContract(tools) {
  const actualNames = Array.isArray(tools) ? tools.map(tool => tool && tool.name) : [];
  if (actualNames.length !== MCP_TOOL_NAMES.length
      || actualNames.some((name, index) => name !== MCP_TOOL_NAMES[index])) {
    throw new Error(
      `MCP contract v${MCP_CONTRACT_VERSION} must expose exactly ${MCP_TOOL_NAMES.length} tools ` +
      `in the frozen order; received ${JSON.stringify(actualNames)}`
    );
  }
  return tools;
}

module.exports = {
  MCP_CONTRACT_VERSION,
  MCP_TOOL_NAMES,
  assertMcpContract
};
