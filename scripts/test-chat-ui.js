'use strict';

async function main() {
  const { startGateway } = require('../src/http/gateway');

  process.env.TRAECN_ENABLE_MOCK_BRIDGE = '1';

  const server = await startGateway();
  const address = server.address();

  console.log(`[test-chat-ui] Mock gateway running at http://${address.address}:${address.port}`);
  console.log('[test-chat-ui] Open http://127.0.0.1:8788/ in your browser');
  console.log('[test-chat-ui] Press Ctrl+C to stop');
}

main().catch(err => {
  console.error('[test-chat-ui] Failed:', err.message);
  process.exit(1);
});
