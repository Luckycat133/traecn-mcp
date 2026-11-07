#!/usr/bin/env node
'use strict';

/**
 * MCP 服务器入口 — 薄包装层，所有实现已迁移到 src/mcp/。
 * 保留此文件作为向后兼容的入口点和 CLI bin 入口。
 */

const mcp = require('./src/mcp');

if (require.main === module) {
  if (process.argv.length > 2) {
    require('./scripts/traecn-cli').main();
  } else {
    mcp.startStdioServer();
  }
}

// 向后兼容的导出 — 所有消费者从 mcp-server.js 导入的符号
module.exports = {
  MCP_CONTRACT_VERSION: mcp.MCP_CONTRACT_VERSION,
  MCP_TOOL_NAMES: mcp.MCP_TOOL_NAMES,
  MCP_TOOLS: mcp.MCP_TOOLS,
  SERVER_INFO: mcp.SERVER_INFO,
  callTool: mcp.callTool,
  createMcpHandlers: mcp.createMcpHandlers,
  envContext: mcp.envContext,
  getMcpToolMetadata: mcp.getMcpToolMetadata,
  startStdioServer: mcp.startStdioServer,
  mcpAuth: require('./src/shared/mcp-auth')
};
