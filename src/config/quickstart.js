'use strict';

const { execFile, execSync, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { getEnvWithFallback } = require('../shared/utils');

function findTraeCNBinary() {
  const envBin = getEnvWithFallback('TRAECN_BIN', 'TRAE_BIN', '');
  if (envBin) return envBin;

  const platform = process.platform;

  if (platform === 'darwin') {
    const candidates = [
      '/Applications/Trae CN.app',
      '/Applications/TraeCN.app',
      path.join(process.env.HOME || '', 'Applications', 'Trae CN.app'),
      path.join(process.env.HOME || '', 'Applications', 'TraeCN.app')
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  if (platform === 'win32') {
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Trae CN', 'Trae CN.exe'),
      path.join(process.env['ProgramFiles'] || '', 'Trae CN', 'Trae CN.exe')
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function isTraeCNRunning() {
  try {
    if (process.platform === 'darwin') {
      const result = execSync('pgrep -f "/Trae CN\\.app/Contents/MacOS/Electron" || pgrep -f "/TraeCN\\.app/Contents/MacOS/Electron" || true', { encoding: 'utf-8' });
      return result.trim().length > 0;
    }
    if (process.platform === 'win32') {
      const result = execSync('tasklist /FI "IMAGENAME eq Trae CN.exe"', { encoding: 'utf-8' });
      return result.includes('Trae CN.exe');
    }
  } catch {}
  return false;
}

function isTraeCNMainProcessCommand(command = '') {
  return /\/Trae CN\.app\/Contents\/MacOS\/Electron/.test(command)
    || /\/TraeCN\.app\/Contents\/MacOS\/Electron/.test(command);
}

function execFilePromise(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForTraeCNExit(timeoutMs = 15000, pollMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isTraeCNRunning()) return true;
    await sleep(pollMs);
  }
  return !isTraeCNRunning();
}

async function quitTraeCN(options = {}) {
  if (!isTraeCNRunning()) {
    return { ok: true, alreadyStopped: true };
  }

  if (process.platform === 'darwin') {
    await execFilePromise('osascript', ['-e', 'tell application "Trae CN" to quit']);
  } else if (process.platform === 'win32') {
    await execFilePromise('taskkill', ['/IM', 'Trae CN.exe']);
  } else {
    throw new Error(`Graceful Trae CN quit is not implemented for ${process.platform}`);
  }

  const stopped = await waitForTraeCNExit(options.timeoutMs || 15000, options.pollMs || 500);
  if (!stopped) {
    throw new Error('Timed out waiting for Trae CN to quit');
  }
  return { ok: true, alreadyStopped: false };
}

function resolveMacExecutable(binPath) {
  const executablePath = path.join(binPath, 'Contents', 'MacOS', 'Electron');
  return fs.existsSync(executablePath) ? executablePath : null;
}

function buildStartCommand(binPath, args, options = {}) {
  const platform = options.platform || process.platform;

  if (platform === 'darwin') {
    const directExecutable = options.newInstance ? resolveMacExecutable(binPath) : null;
    if (directExecutable) {
      return { command: directExecutable, commandArgs: args };
    }
    return { command: 'open', commandArgs: [options.newInstance ? '-na' : '-a', binPath, '--args', ...args] };
  }

  if (platform === 'win32') {
    return { command: binPath, commandArgs: args };
  }

  return { command: binPath, commandArgs: args };
}

function startTraeCN(options = {}) {
  const binPath = options.binPath || findTraeCNBinary();
  if (!binPath) {
    throw new Error('TraeCN binary not found. Set TRAECN_BIN environment variable.');
  }

  const args = [];
  const remotePort = getEnvWithFallback('TRAECN_REMOTE_DEBUGGING_PORT', 'TRAE_REMOTE_DEBUGGING_PORT', '9222');
  args.push(`--remote-debugging-port=${remotePort}`);

  const extraArgs = getEnvWithFallback('TRAECN_ARGS', 'TRAE_ARGS', '');
  if (extraArgs) {
    args.push(...extraArgs.split(' '));
  }

  const useIsolatedProfile = options.useIsolatedProfile !== undefined
    ? options.useIsolatedProfile
    : getEnvWithFallback('TRAECN_QUICKSTART_USE_ISOLATED_PROFILE', 'TRAE_QUICKSTART_USE_ISOLATED_PROFILE', '0') === '1';
  const userDataDir = options.userDataDir || getEnvWithFallback('TRAECN_USER_DATA_DIR', 'TRAE_USER_DATA_DIR', '');
  if (options.newInstance && useIsolatedProfile) {
    args.push(`--user-data-dir=${userDataDir || path.join(os.tmpdir(), `traecnclaw-profile-${remotePort}`)}`);
  }

  const projectPath = options.projectPath || getEnvWithFallback('TRAECN_PROJECT_PATH', 'TRAE_PROJECT_PATH', '');
  if (projectPath) {
    args.push(projectPath);
  }

  const { command, commandArgs } = buildStartCommand(binPath, args, options);

  const child = spawn(command, commandArgs, {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  return { pid: child.pid, command, args: commandArgs };
}

async function restartTraeCNWithDebug(options = {}) {
  const binPath = options.binPath || findTraeCNBinary();
  if (!binPath) {
    throw new Error('TraeCN binary not found. Set TRAECN_BIN environment variable.');
  }

  const quickstart = getQuickstartConfig();
  const quit = await quitTraeCN({
    timeoutMs: options.quitTimeoutMs,
    pollMs: options.pollMs
  });
  const launched = startTraeCN({
    binPath,
    projectPath: options.projectPath,
    newInstance: quickstart.profileMode === 'isolated',
    useIsolatedProfile: quickstart.useIsolatedProfile
  });
  return { ok: true, quit, launched, profileMode: quickstart.profileMode };
}

function getQuickstartConfig() {
  const profileModeRaw = getEnvWithFallback('TRAECN_QUICKSTART_PROFILE_MODE', 'TRAE_QUICKSTART_PROFILE_MODE', 'existing');
  const profileMode = String(profileModeRaw || '').trim().toLowerCase();
  const isolatedProfilePreferred = profileMode === 'isolated';
  const existingProfilePreferred = !isolatedProfilePreferred;
  return {
    useIsolatedProfile: existingProfilePreferred
      ? false
      : getEnvWithFallback('TRAECN_QUICKSTART_USE_ISOLATED_PROFILE', 'TRAE_QUICKSTART_USE_ISOLATED_PROFILE', '1') === '1',
    profileMode: existingProfilePreferred ? 'existing' : 'isolated',
    remoteDebuggingPort: getEnvWithFallback('TRAECN_QUICKSTART_REMOTE_DEBUGGING_PORT', 'TRAE_QUICKSTART_REMOTE_DEBUGGING_PORT', '9334'),
    gatewayPort: getEnvWithFallback('PORT', 'PORT', '8788'),
    gatewayHost: getEnvWithFallback('HOST', 'HOST', '127.0.0.1')
  };
}

module.exports = {
  buildStartCommand,
  findTraeCNBinary,
  isTraeCNMainProcessCommand,
  isTraeCNRunning,
  quitTraeCN,
  restartTraeCNWithDebug,
  startTraeCN,
  getQuickstartConfig
};
