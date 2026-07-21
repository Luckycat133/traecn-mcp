#!/usr/bin/env node
'use strict';

/**
 * MCP server launcher for the traecnclaw-mcp skill.
 *
 * Locates and starts the TRAECNclaw stdio MCP server, inheriting stdio
 * so JSON-RPC messages flow directly between the MCP client and server.
 *
 * Resolution order:
 *   1. TRAECN_MCP_SERVER_PATH env var (absolute path to mcp-server.js)
 *   2. In-repo relative path (skill/scripts/ → repo root)
 *
 * Usage from an MCP client config:
 *   "command": "node",
 *   "args": ["/path/to/skills/traecnclaw-mcp/scripts/start-mcp.js"]
 */

const path = require('path');
const fs = require('fs');

const SCRIPT_DIR = __dirname;
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..');

const candidates = [
  process.env.TRAECN_MCP_SERVER_PATH,
  path.join(REPO_ROOT, 'mcp-server.js')
].filter(Boolean);

const serverPath = candidates.find(p => p && fs.existsSync(p));

if (!serverPath) {
  console.error('[traecnclaw-mcp] mcp-server.js not found.');
  console.error('Tried: ' + candidates.join(', '));
  console.error('Set TRAECN_MCP_SERVER_PATH to the absolute path of mcp-server.js,');
  console.error('or install this skill inside the TRAECNclaw repository.');
  process.exit(1);
}

// Chdir to repo root so .env and relative file reads resolve correctly.
process.chdir(path.dirname(serverPath));

const { startStdioServer } = require(serverPath);
startStdioServer();
