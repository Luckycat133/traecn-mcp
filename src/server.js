'use strict';

const path = require('path');
const { loadEnv } = require('./config/env');

const envPath = path.resolve(__dirname, '..', '.env');
loadEnv(envPath);

const { startGateway } = require('./http/gateway');

process.on('uncaughtException', (err) => {
  console.error('[TRAECNclaw] Uncaught exception:', err.message, err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[TRAECNclaw] Unhandled rejection at:', promise, 'reason:', reason);
});

const host = process.env.HOST || '127.0.0.1';
const port = parseInt(process.env.PORT || '8788', 10);
const mockBridge = process.env.TRAECN_ENABLE_MOCK_BRIDGE === '1';

let server = null;

async function main() {
  try {
    server = await startGateway({ host, port });
    const address = server.address();
    console.log(`[TRAECNclaw] Gateway started on ${address.address}:${address.port}`);
    console.log(`[TRAECNclaw] Mode: ${mockBridge ? 'mock-bridge' : 'live'}`);
    console.log(`[TRAECNclaw] Host: ${host}, Port: ${port}`);
  } catch (err) {
    console.error('[TRAECNclaw] Failed to start gateway:', err.message);
    process.exit(1);
  }
}

function gracefulShutdown(signal) {
  console.log(`[TRAECNclaw] Received ${signal}, shutting down gracefully...`);
  if (server) {
    server.close(() => {
      console.log('[TRAECNclaw] Server closed');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('[TRAECNclaw] Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

main();
