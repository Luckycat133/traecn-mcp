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
} = require('./tool-metadata');

const {
  SERVER_INFO,
  callTool,
  createMcpHandlers,
  envContext
} = require('./handler');

const {
  writeMessage,
  startStdioServer
} = require('./stdio-server');

module.exports = {
  // Tools
  RAW_MCP_TOOLS,
  MCP_TOOLS,
  MCP_TOOL_INTERNAL_NAMES,
  COMPLETION_CHECKS_SCHEMA,
  WORKFLOW_STEP_SCHEMA,
  internalMcpToolName,
  asMcpContent,
  schema,

  // Metadata
  DEFAULT_MCP_TOOL_PROFILE,
  MCP_TOOL_PROFILES,
  MCP_TOOL_PROFILE_DESCRIPTIONS,
  TOOL_METADATA,
  TOOL_ANNOTATIONS,
  DESTRUCTIVE_MCP_TOOLS,
  decorateTool,
  normalizeMcpToolProfile,
  getMcpToolsForProfile,
  getMcpToolMetadata,
  getMcpToolProfileSummary,
  envToolProfile,

  // Handler
  SERVER_INFO,
  callTool,
  createMcpHandlers,
  envContext,

  // Stdio
  writeMessage,
  startStdioServer
};