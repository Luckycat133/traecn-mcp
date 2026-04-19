'use strict';

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function _getEnvWithFallback(traecnKey, traeKey, defaultValue) {
  return process.env[traecnKey] || process.env[traeKey] || defaultValue;
}

function findTraeCNBinary() {
  const envBin = _getEnvWithFallback('TRAECN_BIN', 'TRAE_BIN', '');
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

function startTraeCN(options = {}) {
  const binPath = options.binPath || findTraeCNBinary();
  if (!binPath) {
    throw new Error('TraeCN binary not found. Set TRAECN_BIN environment variable.');
  }

  const args = [];
  const remotePort = _getEnvWithFallback('TRAECN_REMOTE_DEBUGGING_PORT', 'TRAE_REMOTE_DEBUGGING_PORT', '9222');
  args.push(`--remote-debugging-port=${remotePort}`);

  const extraArgs = _getEnvWithFallback('TRAECN_ARGS', 'TRAE_ARGS', '');
  if (extraArgs) {
    args.push(...extraArgs.split(' '));
  }

  const projectPath = options.projectPath || _getEnvWithFallback('TRAECN_PROJECT_PATH', 'TRAE_PROJECT_PATH', '');
  if (projectPath) {
    args.push(projectPath);
  }

  const platform = process.platform;
  let command, commandArgs;

  if (platform === 'darwin') {
    command = 'open';
    commandArgs = ['-a', binPath, '--args', ...args];
  } else if (platform === 'win32') {
    command = binPath;
    commandArgs = args;
  } else {
    command = binPath;
    commandArgs = args;
  }

  const child = spawn(command, commandArgs, {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  return { pid: child.pid, command, args: commandArgs };
}

function getQuickstartConfig() {
  return {
    useIsolatedProfile: _getEnvWithFallback('TRAECN_QUICKSTART_USE_ISOLATED_PROFILE', 'TRAE_QUICKSTART_USE_ISOLATED_PROFILE', '1') === '1',
    remoteDebuggingPort: _getEnvWithFallback('TRAECN_QUICKSTART_REMOTE_DEBUGGING_PORT', 'TRAE_QUICKSTART_REMOTE_DEBUGGING_PORT', '9333'),
    gatewayPort: _getEnvWithFallback('PORT', 'PORT', '8788'),
    gatewayHost: _getEnvWithFallback('HOST', 'HOST', '127.0.0.1')
  };
}

module.exports = { findTraeCNBinary, isTraeCNRunning, startTraeCN, getQuickstartConfig };
