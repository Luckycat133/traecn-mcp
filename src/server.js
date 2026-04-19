'use strict';

const path = require('path');
const { loadEnv } = require('./config/env');

const envPath = path.resolve(__dirname, '..', '.env');
loadEnv(envPath);

const { startGateway } = require('./http/gateway');

const host = process.env.HOST || '127.0.0.1';
const port = parseInt(process.env.PORT || '8788', 10);
const mockBridge = process.env.TRAECN_ENABLE_MOCK_BRIDGE === '1';

async function main() {
  try {
    const server = await startGateway({ host, port });
    const address = server.address();
    console.log(`[TRAECNclaw] Gateway started on ${address.address}:${address.port}`);
    console.log(`[TRAECNclaw] Mode: ${mockBridge ? 'mock-bridge' : 'live'}`);
    console.log(`[TRAECNclaw] Host: ${host}, Port: ${port}`);
  } catch (err) {
    console.error('[TRAECNclaw] Failed to start gateway:', err.message);
    process.exit(1);
  }
}

main();
