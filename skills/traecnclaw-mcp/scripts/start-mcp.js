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

/**
 * Resolve the path to mcp-server.js.
 *
 * Checks TRAECN_MCP_SERVER_PATH first, then falls back to the in-repo
 * location. Each candidate is validated as an existing regular file so
 * directories or broken symlinks are rejected silently.
 *
 * @param {object} [env=process.env] - environment variables (injectable for tests)
 * @param {string} [scriptDir=__dirname] - scripts dir (injectable for tests)
 * @returns {string|null} absolute path to mcp-server.js, or null if not found
 */
function resolveServerPath(env = process.env, scriptDir = SCRIPT_DIR) {
  const repoRoot = path.resolve(scriptDir, '../../..');
  const candidates = [
    env.TRAECN_MCP_SERVER_PATH,
    path.join(repoRoot, 'mcp-server.js')
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return path.resolve(candidate);
      }
    } catch {
      // Ignore unreadable paths and try the next candidate.
    }
  }
  return null;
}

/**
 * Locate and start the stdio MCP server.
 *
 * Exits with a diagnostic message on any startup failure so MCP clients
 * see a clear error instead of a raw stack trace.
 *
 * @returns {void}
 */
function main() {
  const serverPath = resolveServerPath();

  if (!serverPath) {
    const repoRoot = path.resolve(SCRIPT_DIR, '../../..');
    const tried = [
      process.env.TRAECN_MCP_SERVER_PATH,
      path.join(repoRoot, 'mcp-server.js')
    ].filter(Boolean);
    console.error('[traecnclaw-mcp] mcp-server.js not found.');
    console.error('Tried: ' + tried.join(', '));
    console.error('Set TRAECN_MCP_SERVER_PATH to the absolute path of mcp-server.js,');
    console.error('or install this skill inside the TRAECNclaw repository.');
    process.exit(1);
  }

  // Chdir to repo root so .env and relative file reads resolve correctly.
  try {
    process.chdir(path.dirname(serverPath));
  } catch (cause) {
    console.error(`[traecnclaw-mcp] Failed to set working directory: ${cause.message}`);
    process.exit(1);
  }

  let serverModule;
  try {
    serverModule = require(serverPath);
  } catch (cause) {
    console.error(`[traecnclaw-mcp] Failed to load mcp-server.js: ${cause.message}`);
    process.exit(1);
  }

  if (typeof serverModule.startStdioServer !== 'function') {
    console.error('[traecnclaw-mcp] mcp-server.js does not export startStdioServer().');
    process.exit(1);
  }

  serverModule.startStdioServer();
}

// Graceful shutdown: MCP clients (Cursor, Claude Desktop, etc.) send SIGTERM
// or SIGINT when closing the connection. Exit cleanly so no zombie processes
// or broken stdio pipes are left behind.
process.once('SIGINT', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));

// Only run main when invoked directly, not when required for testing.
if (require.main === module) {
  main();
}

module.exports = { resolveServerPath, main };
