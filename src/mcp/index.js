'use strict';

/**
 * MCP 模块入口 — 统一导出所有 MCP 相关功能。
 */

const {
  RAW_MCP_TOOLS,
  COMPLETION_CHECKS_SCHEMA,
  WORKFLOW_STEP_SCHEMA,
  MCP_TOOL_INTERNAL_NAMES,
  internalMcpToolName,
  asMcpContent,
  schema
} = require('./tools');

const {
  MCP_TOOLS,
  TOOL_METADATA,
  TOOL_ANNOTATIONS,
  DESTRUCTIVE_MCP_TOOLS,
  decorateTool,
  getMcpToolMetadata
} = require('./tool-metadata');
const { MCP_CONTRACT_VERSION, MCP_TOOL_NAMES } = require('./contract');

const {
  SERVER_INFO,
  callTool,
  createMcpHandlers,
  envContext
} = require('./handler');

const {
  TaskEventPump,
  stableMcpClientId,
  taskEventNotification,
  writeMessage,
  startStdioServer
} = require('./stdio-server');

module.exports = {
  // Tools
  RAW_MCP_TOOLS,
  MCP_TOOLS,
  MCP_CONTRACT_VERSION,
  MCP_TOOL_NAMES,
  MCP_TOOL_INTERNAL_NAMES,
  COMPLETION_CHECKS_SCHEMA,
  WORKFLOW_STEP_SCHEMA,
  internalMcpToolName,
  asMcpContent,
  schema,

  // Metadata
  TOOL_METADATA,
  TOOL_ANNOTATIONS,
  DESTRUCTIVE_MCP_TOOLS,
  decorateTool,
  getMcpToolMetadata,

  // Handler
  SERVER_INFO,
  callTool,
  createMcpHandlers,
  envContext,

  // Stdio
  TaskEventPump,
  stableMcpClientId,
  taskEventNotification,
  writeMessage,
  startStdioServer
};
