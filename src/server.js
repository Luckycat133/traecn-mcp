'use strict';

const path = require('path');
const { loadEnv } = require('./config/env');
const { parsePositiveInt } = require('./shared/utils');

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
const port = parsePositiveInt(process.env.PORT || '8788', 8788);
const mockBridge = process.env.TRAECN_ENABLE_MOCK_BRIDGE === '1';

let gatewayInstance = null;

async function main() {
  try {
    const { server, gateway } = await startGateway({ host, port });
    gatewayInstance = gateway;
    const address = server.address();
    const isCloud = host === '0.0.0.0' || (process.env.RENDER_EXTERNAL_HOSTNAME || process.env.RAILWAY_STATIC_URL);
    console.log(`[TRAECNclaw] Gateway started on ${address.address}:${address.port}`);
    console.log(`[TRAECNclaw] Mode: ${mockBridge ? 'mock-bridge' : 'live'}`);
    console.log(`[TRAECNclaw] Host: ${host}, Port: ${port}`);
    if (isCloud) {
      console.log(`[TRAECNclaw] Cloud deployment detected. CDP must connect to an external Trae instance.`);
      console.log(`[TRAECNclaw] Set TRAECN_CDP_HOST to your local machine's public IP or tunnel endpoint.`);
    }
  } catch (err) {
    console.error('[TRAECNclaw] Failed to start gateway:', err.message);
    process.exit(1);
  }
}

async function gracefulShutdown(signal) {
  console.log(`[TRAECNclaw] Received ${signal}, shutting down gracefully...`);
  
  let forcedShutdownTimeout = setTimeout(() => {
    console.error('[TRAECNclaw] Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
  
  if (gatewayInstance) {
    try {
      await gatewayInstance.gracefulShutdown();
      console.log('[TRAECNclaw] Gateway shutdown completed');
      clearTimeout(forcedShutdownTimeout);
      process.exit(0);
    } catch (err) {
      console.error('[TRAECNclaw] Error during graceful shutdown:', err.message);
      clearTimeout(forcedShutdownTimeout);
      process.exit(1);
    }
  } else {
    clearTimeout(forcedShutdownTimeout);
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

main();
