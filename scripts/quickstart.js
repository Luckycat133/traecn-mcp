'use strict';

const path = require('path');
const { findTraeCNBinary, isTraeCNRunning, startTraeCN } = require('../src/config/quickstart');
const { loadEnv } = require('../src/config/env');
const { getEnvWithFallback } = require('../src/shared/utils');

loadEnv(path.resolve(__dirname, '..', '.env'));

async function main() {
  const args = process.argv.slice(2);
  // Default: do NOT auto-launch Trae CN. If the user has quit it, they
  // probably want it to stay quit. Set TRAECN_AUTOSTART=1 (or pass
  // --launch-trae) to restore the old auto-start behavior. This prevents
  // the "I quit Trae and it came back" footgun that bites every developer
  // the first time they run `npm run quickstart` after closing the IDE.
  const autoLaunch = process.env.TRAECN_AUTOSTART === '1' || args.includes('--launch-trae');

  console.log('[TRAECNclaw] Checking TraeCN status...');

  if (isTraeCNRunning()) {
    console.log('[TRAECNclaw] TraeCN is already running.');
  } else if (!autoLaunch) {
    console.log('[TRAECNclaw] TraeCN is not running. Skipping auto-launch (opt-in).');
    console.log('[TRAECNclaw] To start it explicitly, run: npm run start:traecn');
    console.log('[TRAECNclaw] Or re-run with: npm run quickstart -- --launch-trae');
  } else {
    console.log('[TRAECNclaw] TraeCN is not running. Auto-launch enabled, starting...');
    const binPath = findTraeCNBinary();
    if (!binPath) {
      console.error('[TRAECNclaw] TraeCN binary not found.');
      console.error('[TRAECNclaw] Please set TRAECN_BIN environment variable or install TraeCN.');
      process.exit(1);
    }

    try {
      const result = await startTraeCN({ binPath });
      console.log(`[TRAECNclaw] TraeCN started (PID: ${result.pid})`);
      console.log('[TRAECNclaw] Waiting for TraeCN to initialize...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    } catch (err) {
      console.error(`[TRAECNclaw] Failed to start TraeCN: ${err.message}`);
      process.exit(1);
    }
  }

  const host = getEnvWithFallback('TRAECN_CDP_HOST', 'TRAE_CDP_HOST', '127.0.0.1');
  const port = getEnvWithFallback('TRAECN_REMOTE_DEBUGGING_PORT', 'TRAE_REMOTE_DEBUGGING_PORT', '9222');

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
  const { server } = await startGateway();
  const address = server.address();
  console.log(`[TRAECNclaw] Gateway running at http://${address.address}:${address.port}`);
}

main().catch(err => {
  console.error('[TRAECNclaw] Quickstart failed:', err.message);
  process.exit(1);
});
