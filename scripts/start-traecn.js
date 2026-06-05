'use strict';

const { findTraeCNBinary, isTraeCNRunning, startTraeCN } = require('../src/config/quickstart');
const { getEnvWithFallback } = require('../src/shared/utils');

async function main() {
  const args = process.argv.slice(2);
  const forceNew = args.includes('--force-new');
  const projectPath = args.find(arg => arg !== '--force-new') || getEnvWithFallback('TRAECN_PROJECT_PATH', 'TRAE_PROJECT_PATH', '');

  if (isTraeCNRunning() && !forceNew) {
    console.log('[TRAECNclaw] TraeCN is already running.');
    console.log('[TRAECNclaw] If CDP is unavailable, run: npm run start:traecn -- --force-new');
    return;
  }

  const binPath = findTraeCNBinary();
  if (!binPath) {
    console.error('[TRAECNclaw] TraeCN binary not found. Set TRAECN_BIN environment variable.');
    process.exit(1);
  }

  try {
    const result = startTraeCN({ binPath, projectPath, newInstance: forceNew });
    console.log(`[TRAECNclaw] TraeCN started (PID: ${result.pid})`);
    if (forceNew) {
      console.log('[TRAECNclaw] Started a new TraeCN instance for remote debugging.');
    }
    if (projectPath) {
      console.log(`[TRAECNclaw] Project: ${projectPath}`);
    }
  } catch (err) {
    console.error(`[TRAECNclaw] Failed to start TraeCN: ${err.message}`);
    process.exit(1);
  }
}

main();
