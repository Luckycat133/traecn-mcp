'use strict';

const path = require('path');
const { loadEnv } = require('./config/env');
const { parsePositiveInt } = require('./shared/utils');
const { readRuntimeEnv, runtimeDefault } = require('./config/runtime-schema');

const envPath = path.resolve(__dirname, '..', '.env');
loadEnv(envPath);

const { startGateway } = require('./http/gateway');

process.on('uncaughtException', (err) => {
  console.error('[TraeCN MCP] Uncaught exception:', err.message, err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[TraeCN MCP] Unhandled rejection at:', promise, 'reason:', reason);
});

const host = readRuntimeEnv('TRAECN_GATEWAY_HOST');
const port = parsePositiveInt(
  readRuntimeEnv('TRAECN_GATEWAY_PORT'),
  Number(runtimeDefault('TRAECN_GATEWAY_PORT'))
);
const mockBridge = readRuntimeEnv('TRAECN_ENABLE_MOCK_BRIDGE') === '1';

let gatewayInstance = null;

async function main() {
  try {
    const { server, gateway } = await startGateway({ host, port });
    gatewayInstance = gateway;
    const address = server.address();
    const isCloud = host === '0.0.0.0' || (process.env.RENDER_EXTERNAL_HOSTNAME || process.env.RAILWAY_STATIC_URL);
    console.log(`[TraeCN MCP] Gateway started on ${address.address}:${address.port}`);
    console.log(`[TraeCN MCP] Mode: ${mockBridge ? 'mock-bridge' : 'live'}`);
    console.log(`[TraeCN MCP] Host: ${host}, Port: ${port}`);
    if (isCloud) {
      console.log(`[TraeCN MCP] Cloud deployment detected. CDP must connect to an external Trae instance.`);
      console.log(`[TraeCN MCP] Set TRAECN_CDP_HOST to your local machine's public IP or tunnel endpoint.`);
    }
  } catch (err) {
    console.error('[TraeCN MCP] Failed to start gateway:', err.message);
    process.exit(1);
  }
}

async function gracefulShutdown(signal) {
  console.log(`[TraeCN MCP] Received ${signal}, shutting down gracefully...`);

  const forcedShutdownTimeout = setTimeout(() => {
    console.error('[TraeCN MCP] Forced shutdown after timeout');
    process.exit(1);
  }, 10000);

  if (gatewayInstance) {
    try {
      await gatewayInstance.gracefulShutdown();
      console.log('[TraeCN MCP] Gateway shutdown completed');
      clearTimeout(forcedShutdownTimeout);
      process.exit(0);
    } catch (err) {
      console.error('[TraeCN MCP] Error during graceful shutdown:', err.message);
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
