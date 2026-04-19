'use strict';

const { findTraeCNBinary, isTraeCNRunning, startTraeCN } = require('../src/config/quickstart');

function _getEnvWithFallback(traecnKey, traeKey, defaultValue) {
  return process.env[traecnKey] || process.env[traeKey] || defaultValue;
}

async function main() {
  console.log('[TRAECNclaw] Checking TraeCN status...');

  if (isTraeCNRunning()) {
    console.log('[TRAECNclaw] TraeCN is already running.');
  } else {
    console.log('[TRAECNclaw] TraeCN is not running. Attempting to start...');
    const binPath = findTraeCNBinary();
    if (!binPath) {
      console.error('[TRAECNclaw] TraeCN binary not found.');
      console.error('[TRAECNclaw] Please set TRAECN_BIN environment variable or install TraeCN.');
      process.exit(1);
    }

    try {
      const result = startTraeCN({ binPath });
      console.log(`[TRAECNclaw] TraeCN started (PID: ${result.pid})`);
      console.log('[TRAECNclaw] Waiting for TraeCN to initialize...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    } catch (err) {
      console.error(`[TRAECNclaw] Failed to start TraeCN: ${err.message}`);
      process.exit(1);
    }
  }

  const host = _getEnvWithFallback('TRAECN_CDP_HOST', 'TRAE_CDP_HOST', '127.0.0.1');
  const port = _getEnvWithFallback('TRAECN_REMOTE_DEBUGGING_PORT', 'TRAE_REMOTE_DEBUGGING_PORT', '9222');

  console.log(`[TRAECNclaw] Checking CDP at ${host}:${port}...`);

  try {
    const http = require('http');
    await new Promise((resolve, reject) => {
      http.get(`http://${host}:${port}/json/version`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const info = JSON.parse(data);
            console.log(`[TRAECNclaw] CDP connected: ${info.Browser || 'Unknown'}`);
            resolve();
          } catch {
            reject(new Error('Invalid CDP response'));
          }
        });
      }).on('error', reject);
    });
  } catch (err) {
    console.error(`[TRAECNclaw] CDP not available: ${err.message}`);
    console.error('[TRAECNclaw] Make sure TraeCN is started with --remote-debugging-port');
    process.exit(1);
  }

  console.log('[TRAECNclaw] Starting gateway...');
  const { startGateway } = require('../src/http/gateway');
  const server = await startGateway();
  const address = server.address();
  console.log(`[TRAECNclaw] Gateway running at http://${address.address}:${address.port}`);
}

main().catch(err => {
  console.error('[TRAECNclaw] Quickstart failed:', err.message);
  process.exit(1);
});
