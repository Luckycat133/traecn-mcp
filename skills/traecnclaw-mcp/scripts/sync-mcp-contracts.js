#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  MCP_CONTRACT_VERSION,
  MCP_TOOLS,
  getMcpToolMetadata
} = require('../../../mcp-server');

const outputPath = path.resolve(__dirname, '../references/mcp-tool-contracts.json');

function buildContract() {
  return {
    source: 'mcp-server.js',
    contractVersion: MCP_CONTRACT_VERSION,
    toolCount: MCP_TOOLS.length,
    tools: MCP_TOOLS.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      metadata: getMcpToolMetadata(tool.name)
    }))
  };
}

function serialize(contract) {
  return `${JSON.stringify(contract, null, 2)}\n`;
}

function main() {
  const expected = serialize(buildContract());
  if (process.argv.includes('--check')) {
    const actual = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
    if (actual !== expected) {
      console.error('[sync-mcp-contracts] Generated MCP contract is stale.');
      console.error('Run: npm run sync:skill-contracts');
      process.exit(1);
    }
    console.log('[sync-mcp-contracts] MCP contract is current.');
    return;
  }

  fs.writeFileSync(outputPath, expected);
  console.log(`[sync-mcp-contracts] Wrote ${path.relative(process.cwd(), outputPath)}`);
}

if (require.main === module) main();

module.exports = { buildContract, serialize };
