'use strict';

const { findTraeCNBinary, isTraeCNRunning, startTraeCN } = require('../src/config/quickstart');
const { getEnvWithFallback } = require('../src/shared/utils');

async function main() {
  const projectPath = process.argv[2] || getEnvWithFallback('TRAECN_PROJECT_PATH', 'TRAE_PROJECT_PATH', '');

  if (isTraeCNRunning()) {
    console.log('[TRAECNclaw] TraeCN is already running.');
    return;
  }

  const binPath = findTraeCNBinary();
  if (!binPath) {
    console.error('[TRAECNclaw] TraeCN binary not found. Set TRAECN_BIN environment variable.');
    process.exit(1);
  }

  try {
    const result = startTraeCN({ binPath, projectPath });
    console.log(`[TRAECNclaw] TraeCN started (PID: ${result.pid})`);
    if (projectPath) {
      console.log(`[TRAECNclaw] Project: ${projectPath}`);
    }
  } catch (err) {
    console.error(`[TRAECNclaw] Failed to start TraeCN: ${err.message}`);
    process.exit(1);
  }
}

main();
