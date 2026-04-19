'use strict';

async function main() {
  console.log('[TRAECNclaw] Starting HTTP gateway...');

  const { startGateway } = require('../src/http/gateway');
  const server = await startGateway();
  const address = server.address();

  console.log(`[TRAECNclaw] Gateway running at http://${address.address}:${address.port}`);
  console.log('[TRAECNclaw] Chat UI available at http://127.0.0.1:8788/');
  console.log('[TRAECNclaw] Press Ctrl+C to stop');
}

main().catch(err => {
  console.error('[TRAECNclaw] Failed to start gateway:', err.message);
  process.exit(1);
});
