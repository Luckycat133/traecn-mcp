'use strict';

const { execFile, execSync } = require('child_process');

/**
 * stop-traecn — kill both Trae CN and TRAE SOLO CN cleanly.
 *
 * Trae's ecosystem ships two separate macOS apps:
 *   - /Applications/Trae CN.app        (cn.trae.app)
 *   - /Applications/TRAE SOLO CN.app   (cn.trae.solo.app)
 *
 * Quitting one does NOT close the other, which causes the
 * "I quit Trae but it keeps coming back" confusion: you close the
 * main window, the SOLO window is still on screen, and the Dock
 * still shows the Trae CN icon because its helper process is alive.
 *
 * This script kills the main process of both apps (and their Electron
 * helper processes), so nothing comes back. Use this when you actually
 * want Trae fully gone for a while.
 *
 * Usage:
 *   node scripts/stop-traecn.js
 *   npm run stop:traecn
 */

function isRunning(processPattern) {
  try {
    const out = execSync(`pgrep -f "${processPattern}" || true`, { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function tryQuit(appName) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', `tell application "${appName}" to quit`], () => resolve());
  });
}

function forceKill(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // process already gone
  }
}

async function main() {
  console.log('[TRAECNclaw] Stopping Trae CN + TRAE SOLO CN...');

  // Phase 1: polite AppleScript quit (lets the app save state).
  await Promise.all([
    tryQuit('Trae CN'),
    tryQuit('TRAE SOLO CN')
  ]);
  await new Promise(resolve => setTimeout(resolve, 1500));

  // Phase 2: SIGKILL any stragglers (Electron helper processes often
  // outlive the main process when force-killed).
  const targets = [
    { name: 'Trae CN main',     pattern: '/Trae CN\\.app/Contents/MacOS/Electron' },
    { name: 'Trae CN helper',   pattern: '/Trae CN\\.app/Contents/Frameworks/' },
    { name: 'TRAE SOLO CN main',   pattern: '/TRAE SOLO CN\\.app/Contents/MacOS/Electron' },
    { name: 'TRAE SOLO CN helper', pattern: '/TRAE SOLO CN\\.app/Contents/Frameworks/' }
  ];

  let killed = 0;
  for (const t of targets) {
    const pids = isRunning(t.pattern);
    if (pids.length === 0) {
      console.log(`[TRAECNclaw]   ${t.name}: already gone`);
      continue;
    }
    pids.forEach(forceKill);
    killed += pids.length;
    console.log(`[TRAECNclaw]   ${t.name}: killed ${pids.length} pid(s) (${pids.join(', ')})`);
  }

  await new Promise(resolve => setTimeout(resolve, 500));

  // Phase 3: verify.
  const remaining = [
    ...isRunning('/Trae CN\\.app/Contents/MacOS/Electron'),
    ...isRunning('/TRAE SOLO CN\\.app/Contents/MacOS/Electron')
  ];
  if (remaining.length === 0) {
    console.log(`[TRAECNclaw] All Trae processes stopped. (killed ${killed} pid(s))`);
  } else {
    console.log(`[TRAECNclaw] Warning: ${remaining.length} Trae process(es) still alive: ${remaining.join(', ')}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[TRAECNclaw] stop-traecn failed:', err.message);
  process.exit(1);
});
