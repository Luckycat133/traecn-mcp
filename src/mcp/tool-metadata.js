'use strict';

const { RAW_MCP_TOOLS } = require('./tools');

const DEFAULT_MCP_TOOL_PROFILE = 'default';

const TOOL_METADATA = Object.freeze({
  traecn_submit: { layer: 'task', risk: 'delegate' },
  traecn_get_task: { layer: 'task', risk: 'read' },
  traecn_cancel_task: { layer: 'task', risk: 'delegate', destructive: true },
  traecn_list_conversations: { layer: 'conversation', risk: 'read' },
  traecn_manage_conversation: { layer: 'conversation', risk: 'write', destructive: true },
  traecn_resolve_interaction: { layer: 'interaction', risk: 'delegate', destructive: true }
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
    annotations: {
      ...(TOOL_ANNOTATIONS[metadata.risk] || TOOL_ANNOTATIONS.delegate),
      destructiveHint: DESTRUCTIVE_MCP_TOOLS.has(tool.name)
    }
  });
}

const MCP_TOOLS = Object.freeze(RAW_MCP_TOOLS.map(decorateTool));
const MCP_TOOL_PROFILES = Object.freeze({ default: Object.freeze(MCP_TOOLS.map(tool => tool.name)) });
const MCP_TOOL_PROFILE_DESCRIPTIONS = Object.freeze({
  default: 'Single compact Agent surface. Gateway-owned mechanics are intentionally not exposed as tools.'
});

function normalizeMcpToolProfile() {
  return DEFAULT_MCP_TOOL_PROFILE;
}

function getMcpToolsForProfile() {
  return MCP_TOOLS;
}

function getMcpToolProfileSummary() {
  return {
    default: {
      default: true,
      count: MCP_TOOLS.length,
      description: MCP_TOOL_PROFILE_DESCRIPTIONS.default,
      tools: MCP_TOOLS.map(tool => tool.name)
    }
  };
}

function envToolProfile() {
  return DEFAULT_MCP_TOOL_PROFILE;
}

module.exports = {
  DEFAULT_MCP_TOOL_PROFILE,
  MCP_TOOL_PROFILES,
  MCP_TOOL_PROFILE_DESCRIPTIONS,
  MCP_TOOLS,
  TOOL_METADATA,
  TOOL_ANNOTATIONS,
  DESTRUCTIVE_MCP_TOOLS,
  decorateTool,
  normalizeMcpToolProfile,
  getMcpToolsForProfile,
  getMcpToolMetadata,
  getMcpToolProfileSummary,
  envToolProfile
};
