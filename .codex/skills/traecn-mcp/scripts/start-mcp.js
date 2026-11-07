#!/usr/bin/env node
'use strict';

/**
 * MCP server launcher for the traecn-mcp skill.
 *
 * Locates and starts the TRAECNclaw stdio MCP server, inheriting stdio
 * so JSON-RPC messages flow directly between the MCP client and server.
 *
 * Resolution order:
 *   1. In-repo relative path (skills/ or .codex/skills/ → repo root)
 *   2. Installed `@luckycat133/traecnclaw` package export
 *   3. Legacy installed `traecnclaw` package export
 *   4. `traecn-mcp` executable on PATH
 *
 * Usage from an MCP client config:
 *   "command": "node",
 *   "args": ["/path/to/skills/traecn-mcp/scripts/start-mcp.js"]
 */

const path = require('path');
const fs = require('fs');
const { constants: osConstants } = require('os');
const { spawn } = require('child_process');
const { createRequire } = require('module');

const SCRIPT_DIR = __dirname;

function repositoryServerPath(scriptDir) {
  const skillsDir = path.resolve(scriptDir, '../..');
  const isCodexSkill = path.basename(skillsDir) === 'skills'
    && path.basename(path.dirname(skillsDir)) === '.codex';
  return path.resolve(scriptDir, isCodexSkill ? '../../../..' : '../../..', 'mcp-server.js');
}

/**
 * Resolve the path to mcp-server.js.
 *
 * Checks the in-repo location, installed package export, and PATH launcher.
 * Each candidate is resolved to its real regular file so executable symlinks
 * retain the server's configuration directory, while directories and broken
 * symlinks are rejected. An environment-selected JavaScript
 * path is deliberately unsupported because the launcher executes the result.
 *
 * @param {object} [env=process.env] - environment variables (injectable for tests)
 * @param {string} [scriptDir=__dirname] - scripts dir (injectable for tests)
 * @param {object} [options] - process values (injectable for tests)
 * @returns {{path: string, executable: boolean}|null} resolved server entry
 */
function resolveServerTarget(env = process.env, scriptDir = SCRIPT_DIR, options = {}) {
  const cwd = options.cwd || process.cwd();
  const platform = options.platform || process.platform;
  const candidates = [repositoryServerPath(scriptDir)];

  try {
    const searchPaths = [cwd, scriptDir];
    if (env.NODE_PATH) searchPaths.push(...env.NODE_PATH.split(path.delimiter).filter(Boolean));
    for (const packageExport of ['@luckycat133/traecnclaw/mcp', 'traecnclaw/mcp']) {
      for (const searchPath of searchPaths) {
        try {
          const resolveFrom = createRequire(path.join(path.resolve(searchPath), 'package.json'));
          candidates.push(resolveFrom.resolve(packageExport));
          break;
        } catch {
          // Try the next package search root.
        }
      }
    }
  } catch {
    // The package channel is optional; continue to PATH resolution.
  }

  const pathEntries = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const executableNames = platform === 'win32'
    ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map(ext => `traecn-mcp${ext.toLowerCase()}`)
    : ['traecn-mcp'];
  for (const entry of pathEntries) {
    for (const executableName of executableNames) {
      candidates.push({ path: path.resolve(cwd, entry, executableName) });
    }
  }

  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate.path || candidate);
      if (!fs.statSync(resolved).isFile()) continue;
      const executable = Boolean(candidate.path && path.basename(resolved) !== 'mcp-server.js');
      if (executable && platform !== 'win32') fs.accessSync(resolved, fs.constants.X_OK);
      return { path: resolved, executable };
    } catch {
      // Ignore unreadable paths and try the next candidate.
    }
  }
  return null;
}

function resolveServerPath(env = process.env, scriptDir = SCRIPT_DIR, options = {}) {
  return resolveServerTarget(env, scriptDir, options)?.path || null;
}

/**
 * Execute PATH entries as programs, including Homebrew shell wrappers.
 * Inherited descriptors keep MCP bytes and diagnostics untouched. On POSIX a
 * separate process group lets shutdown reach non-exec wrappers and their server.
 * SIGKILL of this launcher cannot be intercepted; escaped/double-forked daemons
 * are outside the lifecycle of this local stdio launcher.
 */
function startExecutable(serverPath) {
  const grouped = process.platform !== 'win32';
  const child = spawn(serverPath, [], { stdio: 'inherit', shell: false, detached: grouped });
  let shutdownTimer;
  let groupPoll;
  let result;
  let spawnFailed = false;
  let forcedShutdown = false;

  function signalChild(signal) {
    if (!child.pid) return false;
    try {
      if (grouped) process.kill(-child.pid, signal);
      else child.kill(signal);
      return true;
    } catch (cause) {
      if (cause.code !== 'ESRCH') {
        console.error(`[traecn-mcp] Failed to signal executable: ${cause.message}`);
      }
      return false;
    }
  }

  function groupExists() {
    if (!grouped || !child.pid) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (cause) {
      return cause.code !== 'ESRCH';
    }
  }

  function finish() {
    clearTimeout(shutdownTimer);
    clearInterval(groupPoll);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    process.removeListener('exit', onExit);
    if (spawnFailed) process.exitCode = 1;
    else if (result.signal) {
      // Node ignores SIGPIPE and reserves SIGUSR1 for the inspector. Mirror
      // only lifecycle signals; encode all others as 128 + signal so child
      // termination cannot become success, debugger startup, or a new hang.
      if (['SIGINT', 'SIGTERM', 'SIGKILL'].includes(result.signal)) {
        process.kill(process.pid, result.signal);
      } else {
        const signalNumber = osConstants.signals[result.signal];
        process.exitCode = signalNumber ? 128 + signalNumber : 1;
      }
    } else process.exitCode = result.code;
  }

  function boundShutdown() {
    if (shutdownTimer) return;
    shutdownTimer = setTimeout(() => {
      forcedShutdown = true;
      signalChild('SIGKILL');
      // Wait for the direct child to be reaped; do not wait forever for an
      // orphaned descendant that only the operating system can reap.
      if (result) finish();
    }, 3000);
  }

  function forward(signal) {
    signalChild(signal);
    boundShutdown();
  }
  const onInterrupt = () => forward('SIGINT');
  const onTerminate = () => forward('SIGTERM');
  const onExit = () => signalChild('SIGKILL');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  process.once('exit', onExit);

  child.once('error', cause => {
    spawnFailed = true;
    console.error(`[traecn-mcp] Failed to start executable ${serverPath}: ${cause.message}`);
  });
  child.once('close', (code, signal) => {
    result = { code, signal };
    if (forcedShutdown || !groupExists()) return finish();
    // A wrapper can exit before its server. Clean up remaining group members
    // without replacing the wrapper's exit status or cutting off graceful I/O.
    signalChild('SIGTERM');
    boundShutdown();
    groupPoll = setInterval(() => {
      if (!groupExists()) finish();
    }, 25);
  });
}

/**
 * Locate and start the stdio MCP server.
 *
 * Exits with a diagnostic message on any startup failure so MCP clients
 * see a clear error instead of a raw stack trace.
 *
 * @returns {void}
 */
function main() {
  const target = resolveServerTarget();

  if (!target) {
    const tried = [repositoryServerPath(SCRIPT_DIR)];
    console.error('[traecn-mcp] mcp-server.js not found.');
    console.error('Tried: ' + tried.join(', '));
    console.error('Install the matching @luckycat133/traecnclaw package, add traecn-mcp to PATH,');
    console.error('or install this skill inside the repository.');
    process.exit(1);
  }

  if (target.executable) {
    startExecutable(target.path);
    return;
  }

  process.once('SIGINT', () => process.exit(0));
  process.once('SIGTERM', () => process.exit(0));
  const serverPath = target.path;

  // Chdir to repo root so .env and relative file reads resolve correctly.
  try {
    process.chdir(path.dirname(serverPath));
  } catch (cause) {
    console.error(`[traecn-mcp] Failed to set working directory: ${cause.message}`);
    process.exit(1);
  }

  let serverModule;
  try {
    serverModule = require(serverPath);
  } catch (cause) {
    console.error(`[traecn-mcp] Failed to load mcp-server.js: ${cause.message}`);
    process.exit(1);
  }

  if (typeof serverModule.startStdioServer !== 'function') {
    console.error('[traecn-mcp] mcp-server.js does not export startStdioServer().');
    process.exit(1);
  }

  serverModule.startStdioServer();
}

// Only run main when invoked directly, not when required for testing.
if (require.main === module) {
  main();
}

module.exports = { resolveServerPath, main };
