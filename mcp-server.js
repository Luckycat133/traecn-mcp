#!/usr/bin/env node
'use strict';

/**
 * MCP 服务器入口 — 薄包装层，所有实现已迁移到 src/mcp/。
 * 保留此文件作为向后兼容的入口点和 CLI bin 入口。
 */

const mcp = require('./src/mcp');

// 直接运行（stdio MCP 服务器）
if (require.main === module) {
  mcp.startStdioServer();
}

// 向后兼容的导出 — 所有消费者从 mcp-server.js 导入的符号
module.exports = {
  DEFAULT_MCP_TOOL_PROFILE: mcp.DEFAULT_MCP_TOOL_PROFILE,
  MCP_TOOL_PROFILES: mcp.MCP_TOOL_PROFILES,
  MCP_TOOLS: mcp.MCP_TOOLS,
  SERVER_INFO: mcp.SERVER_INFO,
  callTool: mcp.callTool,
  createMcpHandlers: mcp.createMcpHandlers,
  envContext: mcp.envContext,
  getMcpToolMetadata: mcp.getMcpToolMetadata,
  getMcpToolProfileSummary: mcp.getMcpToolProfileSummary,
  getMcpToolsForProfile: mcp.getMcpToolsForProfile,
  normalizeMcpToolProfile: mcp.normalizeMcpToolProfile,
  startStdioServer: mcp.startStdioServer,
  mcpAuth: require('./src/shared/mcp-auth')
};