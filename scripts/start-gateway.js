'use strict';

async function main() {
  console.log('[TraeCN MCP] Starting HTTP gateway...');

  const path = require('path');
  const { loadEnv } = require('../src/config/env');
  loadEnv(path.resolve(__dirname, '..', '.env'));

  const { startGateway } = require('../src/http/gateway');
  const { server } = await startGateway();
  const address = server.address();

  console.log(`[TraeCN MCP] Gateway running at http://${address.address}:${address.port}`);
  console.log(`[TraeCN MCP] Chat UI available at http://${address.address}:${address.port}/`);
  console.log('[TraeCN MCP] Press Ctrl+C to stop');
}

main().catch(err => {
  console.error('[TraeCN MCP] Failed to start gateway:', err.message);
  process.exit(1);
});
