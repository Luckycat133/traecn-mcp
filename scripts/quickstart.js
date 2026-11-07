'use strict';

const path = require('path');
const { findTraeCNBinary, isTraeCNRunning, startTraeCN } = require('../src/config/quickstart');
const { fetchCDPVersion, isTraeCNVersion } = require('../src/cdp/discovery');
const { loadEnv } = require('../src/config/env');
const { readRuntimeEnv } = require('../src/config/runtime-schema');

const DEFAULT_CDP_PROBE_TIMEOUT_MS = 5000;

loadEnv(path.resolve(__dirname, '..', '.env'));

async function probeTraeCNCDP(options = {}) {
  const host = options.host;
  const port = options.port;
  const fetchVersion = options.fetchVersion || fetchCDPVersion;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : DEFAULT_CDP_PROBE_TIMEOUT_MS;
  let timeout;

  try {
    const version = await Promise.race([
      Promise.resolve().then(() => fetchVersion(host, port)),
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`CDP /json/version request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
    if (!isTraeCNVersion(version)) {
      throw new Error(`CDP endpoint does not identify TraeCN (${version?.Browser || 'unknown product'})`);
    }
    return version;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function buildCdpRecoveryInstructions(traeRunning) {
  if (traeRunning) {
    return [
      'TraeCN is running, but its debug endpoint is unavailable.',
      'Quit TraeCN, then restart the logged-in profile with:',
      'TRAECN_QUICKSTART_PROFILE_MODE=existing npm run start:traecn -- --force-new --use-existing-profile'
    ];
  }
  return [
    'Start TraeCN with its debug endpoint enabled:',
    'TRAECN_QUICKSTART_PROFILE_MODE=existing npm run start:traecn -- --force-new --use-existing-profile'
  ];
}

async function main() {
  const args = process.argv.slice(2);
  // Default: do NOT auto-launch Trae CN. If the user has quit it, they
  // probably want it to stay quit. Set TRAECN_AUTO_START_TRAE=1 (or pass
  // --launch-trae) to opt in. This prevents
  // the "I quit Trae and it came back" footgun that bites every developer
  // the first time they run `npm run quickstart` after closing the IDE.
  const autoLaunch = readRuntimeEnv('TRAECN_AUTO_START_TRAE') === '1' || args.includes('--launch-trae');

  console.log('[TraeCN MCP] Checking TraeCN status...');

  const traeRunning = isTraeCNRunning();
  if (traeRunning) {
    console.log('[TraeCN MCP] TraeCN is already running.');
  } else if (!autoLaunch) {
    console.log('[TraeCN MCP] TraeCN is not running. Skipping auto-launch (opt-in).');
    console.log('[TraeCN MCP] To start it explicitly, run: npm run start:traecn');
    console.log('[TraeCN MCP] Or re-run with: npm run quickstart -- --launch-trae');
  } else {
    console.log('[TraeCN MCP] TraeCN is not running. Auto-launch enabled, starting...');
    const binPath = findTraeCNBinary();
    if (!binPath) {
      console.error('[TraeCN MCP] TraeCN binary not found.');
      console.error('[TraeCN MCP] Please set TRAECN_BIN environment variable or install TraeCN.');
      process.exit(1);
    }

    try {
      const result = await startTraeCN({ binPath });
      console.log(`[TraeCN MCP] TraeCN started (PID: ${result.pid})`);
      console.log('[TraeCN MCP] Waiting for TraeCN to initialize...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    } catch (err) {
      console.error(`[TraeCN MCP] Failed to start TraeCN: ${err.message}`);
      process.exit(1);
    }
  }

  const host = readRuntimeEnv('TRAECN_CDP_HOST');
  const port = readRuntimeEnv('TRAECN_REMOTE_DEBUGGING_PORT');

  console.log(`[TraeCN MCP] Checking CDP at ${host}:${port}...`);

  try {
    const info = await probeTraeCNCDP({ host, port });
    console.log(`[TraeCN MCP] CDP connected: ${info.Browser || 'Unknown'}`);
  } catch (err) {
    console.error(`[TraeCN MCP] CDP not available: ${err.message}`);
    for (const instruction of buildCdpRecoveryInstructions(traeRunning)) {
      console.error(`[TraeCN MCP] ${instruction}`);
    }
    process.exit(1);
  }

  console.log('[TraeCN MCP] Starting gateway...');
  const { startGateway } = require('../src/http/gateway');
  const { server } = await startGateway();
  const address = server.address();
  console.log(`[TraeCN MCP] Gateway running at http://${address.address}:${address.port}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[TraeCN MCP] Quickstart failed:', err.message);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_CDP_PROBE_TIMEOUT_MS,
  buildCdpRecoveryInstructions,
  main,
  probeTraeCNCDP
};
