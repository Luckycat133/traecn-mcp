'use strict';

const { execSync, spawn } = require('child_process');
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
      const result = execSync('pgrep -x "Trae CN" || pgrep -f "Trae CN.app" || true', { encoding: 'utf-8' });
      return result.trim().length > 0;
    }
    if (process.platform === 'win32') {
      const result = execSync('tasklist /FI "IMAGENAME eq Trae CN.exe"', { encoding: 'utf-8' });
      return result.includes('Trae CN.exe');
    }
  } catch {}
  return false;
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
    : getEnvWithFallback('TRAECN_QUICKSTART_USE_ISOLATED_PROFILE', 'TRAE_QUICKSTART_USE_ISOLATED_PROFILE', '1') === '1';
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

function getQuickstartConfig() {
  return {
    useIsolatedProfile: getEnvWithFallback('TRAECN_QUICKSTART_USE_ISOLATED_PROFILE', 'TRAE_QUICKSTART_USE_ISOLATED_PROFILE', '1') === '1',
    remoteDebuggingPort: getEnvWithFallback('TRAECN_QUICKSTART_REMOTE_DEBUGGING_PORT', 'TRAE_QUICKSTART_REMOTE_DEBUGGING_PORT', '9333'),
    gatewayPort: getEnvWithFallback('PORT', 'PORT', '8788'),
    gatewayHost: getEnvWithFallback('HOST', 'HOST', '127.0.0.1')
  };
}

module.exports = { buildStartCommand, findTraeCNBinary, isTraeCNRunning, startTraeCN, getQuickstartConfig };
