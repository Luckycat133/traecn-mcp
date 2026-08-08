#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const {
  TraeCNApiClient,
  DEFAULT_TASK_POLL_MS,
  isTerminalTaskStatus
} = require('../src/client/traecnapi-client');
const { DEFAULT_HOST, DEFAULT_PORT, resolveGatewayToken } = require('./lib/cli-config');

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m'
};

const CONFIG_FILE = process.env.TRAECN_CONFIG_FILE || path.join(os.homedir(), '.traecnrc');

let config = null;

function color(col, text) {
  return COLORS[col] + text + COLORS.reset;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readNumberOption(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function readStringOption(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith('-') ? value : fallback;
}

function loadConfig() {
  if (config) return config;

  const defaults = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    token: resolveGatewayToken()
  };

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(content);
      config = { ...defaults, ...parsed };
    } else {
      config = defaults;
    }
  } catch {
    config = defaults;
  }

  if (Object.prototype.hasOwnProperty.call(process.env, 'TRAECN_GATEWAY_HOST')) {
    config.host = process.env.TRAECN_GATEWAY_HOST;
  } else if (Object.prototype.hasOwnProperty.call(process.env, 'TRAECN_HOST')) {
    config.host = process.env.TRAECN_HOST;
  }
  if (Object.prototype.hasOwnProperty.call(process.env, 'TRAECN_GATEWAY_PORT')) {
    config.port = parseInt(process.env.TRAECN_GATEWAY_PORT, 10);
  } else if (Object.prototype.hasOwnProperty.call(process.env, 'TRAECN_PORT')) {
    config.port = parseInt(process.env.TRAECN_PORT, 10);
  }
  if (Object.prototype.hasOwnProperty.call(process.env, 'TRAECN_GATEWAY_TOKEN')) config.token = process.env.TRAECN_GATEWAY_TOKEN;

  return config;
}

function saveConfig(newConfig) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2));
    return true;
  } catch {
    return false;
  }
}

// Thin compatibility shim. The TraeCNApiClient (openclaw integration lib)
// owns the canonical HTTP client; this wrapper just adapts the CLI's
// loadConfig() shape to the client constructor so the rest of the file
// keeps its (method, endpoint, body) call sites unchanged.
function apiRequest(method, endpoint, body) {
  const cfg = loadConfig();
  const client = new TraeCNApiClient({
    host: cfg.host,
    port: cfg.port,
    token: cfg.token,
    timeout: 60000
  });
  return client._request(method, endpoint, body);
}

function showProgress(current, total, label = '') {
  const width = 30;
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const percent = Math.round((current / total) * 100);
  process.stdout.write(`\r${color('cyan', label)} [${bar}] ${percent}% (${current}/${total})`);
  if (current === total) {
    process.stdout.write('\n');
  }
}

function showHelp() {
  console.log(`
${color('bold', 'TraeCN CLI')} - Command line interface for TraeCN Gateway

${color('bold', 'USAGE:')}
  traecn <command> [options]

${color('bold', 'COMMANDS:')}
  ${color('green', 'delegate')} <task>      Execute a task
  ${color('green', 'delegate')} -f <file>    Execute task from file
  ${color('green', 'vibe')} <task>          Start unattended vibe coding workflow
  ${color('green', 'wait')} <taskId>        Wait locally for a queued task to finish
  ${color('green', 'status')}                Show gateway status
  ${color('green', 'capabilities')}          Show compact agent capability catalog
  ${color('green', 'preflight')} [cmd] [json] One-call readiness/queue/dialog preflight
  ${color('green', 'cleanup-queue')}          Find and delete queue-probe Solo chats
  ${color('green', 'cleanup-queue')} --status Show cleanup watcher lock/process status
  ${color('green', 'proof')} status|start|cancel  Manage guarded GLM-5.2 long-queue proof
  ${color('green', 'plan')} <command> [json] Create operation confirmation plan
  ${color('green', 'models')}                List available models
  ${color('green', 'config')} get <key>      Get config value
  ${color('green', 'config')} set <key> <value>  Set config value
  ${color('green', 'batch')} submit <file>   Submit batch tasks from JSON file
  ${color('green', 'batch')} status <id>     Check batch status
  ${color('green', 'batch')} cancel <id>    Cancel batch
  ${color('green', 'logs')} [lines]          View recent logs
  ${color('green', 'help')}                 Show this help

${color('bold', 'OPTIONS:')}
  -h, --help              Show help
  -o, --output <format>   Output format (json, text) [default: text]
  -w, --wait              Wait for result (default for delegate)
  --no-wait               Return immediately without waiting
  -p, --priority <n>      Task priority (1-10) for batch [default: 5]
  -s, --strategy <mode>   Batch strategy: parallel, sequential, priority
  -c, --concurrency <n>   Max concurrent tasks for batch [default: 5]
  --callback <url>        Callback URL for batch completion
  --check-file <path>     Vibe: require file before marking complete
  --check-text <f:t>      Vibe: require text t in file f before marking complete
  --completion-checks-json <json> Vibe: raw completionChecks object
  --poll-ms <ms>          Wait: task polling interval [default: ${DEFAULT_TASK_POLL_MS}]
  --timeout-ms <ms>       Wait: max local wait; 0 means forever [default: 0]
  --log <file>            Wait: append JSONL status evidence to file
  --final <file>          Wait: write final JSON result to file in --detach mode
  --stderr <file>         Wait: write wait errors to file in --detach mode
  --detach                Wait: run locally in a detached screen session
  --session <name>        Wait: screen session name for --detach
  --quiet                 Wait: only print final result
  --auto-approve-dialog [action] Wait: handle an eligible non-command dialog

${color('bold', 'EXAMPLES:')}
  traecn delegate "Write a hello world program"
  traecn delegate -f task.txt
  traecn vibe "Implement feature" --step "Run tests" --step "Fix failures"
  traecn vibe "Ship report" --check-file FINAL_REPORT.md --check-text WORKFLOW_STATUS.md:Follow-up
  traecn wait task_123 --poll-ms 30000 --timeout-ms 0 --log evidence.jsonl --quiet -o json
  traecn wait task_123 --detach --log evidence.jsonl
  traecn status
  traecn capabilities
  traecn preflight delegate_async '{"task":"..."}'
  traecn cleanup-queue --execute --max-passes 10
  traecn cleanup-queue --status --json
  traecn cleanup-queue --execute --watch-ms 600000 --stable-ms 120000
  traecn cleanup-queue --execute --watch-ms 7200000 --stable-ms 1800000 --detach --log cleanup-watch.jsonl
  traecn proof status
  traecn proof start --marker TRAECN_GLM52_CLEAN_1
  traecn proof start --execute --detach --allow-quota-spend --marker TRAECN_GLM52_CLEAN_1
  traecn proof cancel --marker TRAECN_GLM52_CLEAN_1
  traecn plan settings_set '{"label":"Auto Save","value":true}'
  traecn models
  traecn config get host
  traecn config set host 192.168.1.100
  traecn batch submit tasks.json
  traecn batch status batch_123456_abc
  traecn logs 100

${color('bold', 'CONFIG FILE:')}
  Config is stored at ${CONFIG_FILE}
  Supported keys: host, port, token

${color('bold', 'ENVIRONMENT:')}
  TRAECN_GATEWAY_HOST, TRAECN_GATEWAY_PORT, TRAECN_GATEWAY_TOKEN
`);
}

function parseJsonArg(raw, label) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    console.error(color('red', `Error: ${label} must be valid JSON`));
    process.exit(1);
  }
}

function parseCompletionChecksArg(raw, label = 'completion checks') {
  const parsed = parseJsonArg(raw, label);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(color('red', `Error: ${label} must be a JSON object`));
    process.exit(1);
  }
  return parsed;
}

function addRequiredFileCheck(completionChecks, filePath) {
  if (!filePath) return;
  if (!Array.isArray(completionChecks.requiredFiles)) completionChecks.requiredFiles = [];
  completionChecks.requiredFiles.push(filePath);
}

function addRequiredTextCheck(completionChecks, spec) {
  if (!spec) return;
  const separator = spec.indexOf(':');
  if (separator <= 0 || separator === spec.length - 1) {
    console.error(color('red', 'Error: --check-text must be in filePath:required text format'));
    process.exit(1);
  }
  const filePath = spec.slice(0, separator);
  const includes = spec.slice(separator + 1);
  if (!Array.isArray(completionChecks.requiredText)) completionChecks.requiredText = [];
  completionChecks.requiredText.push({ filePath, includes });
}

function hasCompletionChecks(completionChecks) {
  return (Array.isArray(completionChecks.requiredFiles) && completionChecks.requiredFiles.length > 0)
    || (Array.isArray(completionChecks.requiredText) && completionChecks.requiredText.length > 0);
}

function parsePositiveMs(raw, fallback, { allowZero = false } = {}) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (allowZero && parsed === 0) return 0;
  return parsed > 0 ? parsed : fallback;
}

function parseWaitArgs(args) {
  const options = {
    taskId: '',
    outputFormat: 'text',
    pollMs: DEFAULT_TASK_POLL_MS,
    timeoutMs: 0,
    logFile: null,
    finalFile: null,
    stderrFile: null,
    detach: false,
    sessionName: null,
    quiet: false,
    autoApproveDialog: null
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-o' || arg === '--output') {
      options.outputFormat = args[++i] || 'text';
    } else if (arg === '--poll-ms') {
      options.pollMs = parsePositiveMs(args[++i], DEFAULT_TASK_POLL_MS);
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = parsePositiveMs(args[++i], 0, { allowZero: true });
    } else if (arg === '--log') {
      options.logFile = args[++i] || null;
    } else if (arg === '--final') {
      options.finalFile = args[++i] || null;
    } else if (arg === '--stderr') {
      options.stderrFile = args[++i] || null;
    } else if (arg === '--detach') {
      options.detach = true;
    } else if (arg === '--session') {
      options.sessionName = args[++i] || null;
    } else if (arg === '--quiet') {
      options.quiet = true;
    } else if (arg === '--auto-approve-dialog') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        options.autoApproveDialog = next;
        i++;
      } else {
        options.autoApproveDialog = true;
      }
    } else if (!arg.startsWith('-') && !options.taskId) {
      options.taskId = arg;
    } else if (!arg.startsWith('-')) {
      // Ignore extra positional text so shell completion or copied notes do not
      // accidentally change the task being waited on.
    } else {
      console.error(color('red', `Error: Unknown wait option ${arg}`));
      process.exit(1);
    }
  }

  return options;
}

function appendJsonLine(filePath, value) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(value) + '\n');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function defaultWaitSessionName(taskId) {
  return 'traecn_wait_' + String(taskId || 'task').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
}

function defaultWaitOutputPath(logFile, filename) {
  if (!logFile) return null;
  return path.join(path.dirname(path.resolve(logFile)), filename);
}

function buildDetachedWaitCommand(options, cwd = process.cwd()) {
  const logFile = options.logFile ? path.resolve(options.logFile) : null;
  const sessionName = options.sessionName || defaultWaitSessionName(options.taskId);
  const safeTaskName = String(options.taskId || 'task').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const finalFile = path.resolve(options.finalFile || defaultWaitOutputPath(logFile, 'wait-final.json') || `wait-${safeTaskName}-final.json`);
  const stderrFile = path.resolve(options.stderrFile || defaultWaitOutputPath(logFile, 'wait.stderr') || `wait-${safeTaskName}.stderr`);
  const args = [
    process.execPath,
    __filename,
    'wait',
    options.taskId,
    '--poll-ms',
    String(options.pollMs),
    '--timeout-ms',
    String(options.timeoutMs),
    '--quiet',
    '-o',
    'json'
  ];
  if (logFile) args.push('--log', logFile);
  if (options.autoApproveDialog) {
    args.push('--auto-approve-dialog');
    if (typeof options.autoApproveDialog === 'string') args.push(options.autoApproveDialog);
  }

  return {
    sessionName,
    logFile,
    finalFile,
    stderrFile,
    screenArgs: [
      '-dmS',
      sessionName,
      '/bin/zsh',
      '-lc',
      `cd ${shellQuote(cwd)} && ${args.map(shellQuote).join(' ')} > ${shellQuote(finalFile)} 2> ${shellQuote(stderrFile)}`
    ]
  };
}

function defaultCleanupSessionName() {
  return `traecn_cleanup_queue_${Date.now()}`;
}

function appSupportDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'TRAECNclaw');
  }
  return path.join(os.homedir(), '.traecnclaw');
}

function defaultCleanupWatchLockFile() {
  return path.join(appSupportDir(), 'cleanup-watch.lock');
}

function isPidRunning(pid) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0) return false;
  try {
    process.kill(parsed, 0);
    return true;
  } catch {
    return false;
  }
}

function processInfoForPid(pid) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  const result = spawnSync('ps', ['-o', 'pid=', '-o', 'pgid=', '-o', 'command=', '-p', String(parsed)], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const line = result.stdout.trim();
  const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    pgid: Number(match[2]),
    command: match[3]
  };
}

function waitForPidExit(pid, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return !isPidRunning(pid);
}

function terminateCleanupWatcher(pid, options = {}) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed === process.pid) {
    return { pid: parsed || null, terminated: false, reason: 'invalid_or_current_pid' };
  }
  const info = processInfoForPid(parsed);
  const signals = [];
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 1000;
  const signalTargets = [];
  if (info && Number.isInteger(info.pgid) && info.pgid > 1 && info.pgid !== process.pid) {
    signalTargets.push({ target: -info.pgid, kind: 'process_group', pgid: info.pgid });
  }
  signalTargets.push({ target: parsed, kind: 'pid', pid: parsed });

  for (const item of signalTargets) {
    try {
      process.kill(item.target, 'SIGTERM');
      signals.push({ ...item, signal: 'SIGTERM', ok: true });
    } catch (err) {
      signals.push({ ...item, signal: 'SIGTERM', ok: false, error: err.message });
    }
  }
  if (!waitForPidExit(parsed, timeoutMs)) {
    for (const item of signalTargets) {
      try {
        process.kill(item.target, 'SIGKILL');
        signals.push({ ...item, signal: 'SIGKILL', ok: true });
      } catch (err) {
        signals.push({ ...item, signal: 'SIGKILL', ok: false, error: err.message });
      }
    }
  }
  return {
    pid: parsed,
    process: info,
    terminated: !isPidRunning(parsed),
    signals
  };
}

function listCleanupWatcherProcesses() {
  const result = spawnSync('ps', ['-axo', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'etime=', '-o', 'command='], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        elapsed: match[4],
        command: match[5]
      };
    })
    .filter(item => item
      && item.pid !== process.pid
      && /(?:^|\/)node(?:\S*)?\s+.*scripts\/traecn-cli\.js cleanup-queue\b/.test(item.command)
      && /\s--watch-ms\s/.test(item.command));
}

function readCleanupWatchLock(lockFile = defaultCleanupWatchLockFile()) {
  try {
    if (!fs.existsSync(lockFile)) return null;
    return JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch {
    return { error: 'invalid_lock_file', lockFile };
  }
}

function describeCleanupWatchStatus(options = {}) {
  const lockFile = path.resolve(options.lockFile || defaultCleanupWatchLockFile());
  const lock = readCleanupWatchLock(lockFile);
  const running = Boolean(lock && !lock.error && isPidRunning(lock.pid));
  const stale = Boolean(lock && !lock.error && !running);
  const watcherProcesses = listCleanupWatcherProcesses();
  const lockPid = lock && !lock.error ? lock.pid || null : null;
  const orphanProcesses = watcherProcesses.filter(processInfo => processInfo.pid !== lockPid);
  return {
    mode: 'watch_status',
    lockFile,
    running,
    stale,
    pid: lock && !lock.error ? lock.pid || null : null,
    lock,
    watcherCount: watcherProcesses.length,
    watcherProcesses,
    orphanProcesses,
    message: running
      ? `Cleanup watcher is running with pid ${lock.pid}${orphanProcesses.length ? `; ${orphanProcesses.length} orphan watcher(s) also detected` : ''}`
      : stale
        ? `Cleanup watcher lock is stale for pid ${lock.pid}`
        : orphanProcesses.length
          ? `Cleanup watcher lock is not running, but ${orphanProcesses.length} orphan watcher(s) are active`
          : 'Cleanup watcher is not running'
  };
}

function acquireCleanupWatchLock(options = {}) {
  const lockFile = path.resolve(options.lockFile || defaultCleanupWatchLockFile());
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const existing = readCleanupWatchLock(lockFile);
  if (existing && !existing.error && isPidRunning(existing.pid) && existing.pid !== process.pid) {
    if (options.replace === true) {
      terminateCleanupWatcher(existing.pid, { timeoutMs: options.replaceTimeoutMs || 1000 });
    } else {
      return {
        ok: false,
        alreadyRunning: true,
        lockFile,
        existing
      };
    }
  }
  if (existing && (!isPidRunning(existing.pid) || options.replace === true || existing.error)) {
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // Best-effort stale lock cleanup.
    }
  }

  const payload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    command: 'cleanup-queue',
    watchMs: options.watchMs,
    stableMs: options.stableMs,
    intervalMs: options.intervalMs,
    logFile: options.logFile || null,
    finalFile: options.finalFile || null
  };
  try {
    fs.writeFileSync(lockFile, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const current = readCleanupWatchLock(lockFile);
      if (current && current.pid === process.pid) {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          // Best-effort lock release.
        }
      }
    };
    return {
      ok: true,
      lockFile,
      owner: payload,
      release
    };
  } catch (err) {
    const current = readCleanupWatchLock(lockFile);
    return {
      ok: false,
      alreadyRunning: Boolean(current && !current.error && isPidRunning(current.pid)),
      lockFile,
      existing: current,
      error: err.message
    };
  }
}

function buildDetachedCleanupCommand(options, cwd = process.cwd()) {
  const logFile = options.logFile ? path.resolve(options.logFile) : null;
  const sessionName = options.sessionName || defaultCleanupSessionName();
  const finalFile = path.resolve(options.finalFile || defaultWaitOutputPath(logFile, 'cleanup-final.json') || 'cleanup-final.json');
  const stderrFile = path.resolve(options.stderrFile || defaultWaitOutputPath(logFile, 'cleanup.stderr') || 'cleanup.stderr');
  const args = [
    process.execPath,
    __filename,
    'cleanup-queue',
    '--execute',
    '--json',
    '--max-passes',
    String(options.maxPasses),
    '--watch-ms',
    String(options.watchMs),
    '--stable-ms',
    String(options.stableMs),
    '--interval-ms',
    String(options.intervalMs)
  ];
  if (logFile) args.push('--log', logFile);
  if (finalFile) args.push('--final', finalFile);
  if (stderrFile) args.push('--stderr', stderrFile);
  if (options.lockFile) args.push('--lock-file', path.resolve(options.lockFile));
  if (options.replace === true) args.push('--replace');
  return {
    sessionName,
    logFile,
    finalFile,
    stderrFile,
    screenArgs: [
      '-dmS',
      sessionName,
      '/bin/zsh',
      '-lc',
      `cd ${shellQuote(cwd)} && ${args.map(shellQuote).join(' ')} > ${shellQuote(finalFile)} 2> ${shellQuote(stderrFile)}`
    ]
  };
}

async function runCleanupWatchAttempt(cleanupOnce, options = {}) {
  const lockFile = options.lockFile || null;
  const intervalMs = Number.isFinite(Number(options.intervalMs)) ? Number(options.intervalMs) : 15000;
  const transientDelayMs = Math.max(1000, intervalMs);
  try {
    const result = await cleanupOnce();
    if (![200, 501].includes(result.status)) {
      return {
        result,
        iteration: {
          at: new Date().toISOString(),
          status: result.status || 0,
          error: result.data?.error || result.data?.message || 'cleanup_request_failed',
          matched: 0,
          remainingMatched: 0,
          deleted: 0,
          stopped: 0,
          passes: 0,
          lockFile,
          transient: true,
          nextDelayMs: transientDelayMs
        },
        clean: false,
        transient: true
      };
    }
    const matched = result.data.matched || 0;
    const remainingMatched = result.data.remainingMatched || 0;
    const hasResidualMatches = matched > 0 || remainingMatched > 0;
    const nextDelayMs = hasResidualMatches ? 1000 : Math.max(1000, intervalMs);
    return {
      result,
      iteration: {
        at: new Date().toISOString(),
        status: result.status,
        matched,
        remainingMatched,
        deleted: result.data.deleted || 0,
        stopped: result.data.stopped || 0,
        passes: result.data.passes || 1,
        lockFile,
        nextDelayMs
      },
      clean: !hasResidualMatches,
      transient: false
    };
  } catch (err) {
    return {
      result: {
        status: 0,
        data: {
          error: err.message || 'cleanup_request_failed'
        }
      },
      iteration: {
        at: new Date().toISOString(),
        status: 0,
        error: err.message || 'cleanup_request_failed',
        matched: 0,
        remainingMatched: 0,
        deleted: 0,
        stopped: 0,
        passes: 0,
        lockFile,
        transient: true,
        nextDelayMs: transientDelayMs
      },
      clean: false,
      transient: true
    };
  }
}

async function cmdDelegate(args) {
  let task = '';
  let waitForResult = true;
  let outputFormat = 'text';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-f' || args[i] === '--file') {
      const filePath = args[++i];
      try {
        task = fs.readFileSync(filePath, 'utf8');
      } catch {
        console.error(color('red', `Error: Cannot read file ${filePath}`));
        process.exit(1);
      }
    } else if (args[i] === '-o' || args[i] === '--output') {
      outputFormat = args[++i] || 'text';
    } else if (args[i] === '--no-wait') {
      waitForResult = false;
    } else if (!args[i].startsWith('-')) {
      task = args.slice(i).join(' ');
      break;
    }
  }

  if (!task.trim()) {
    console.error(color('red', 'Error: Task is required'));
    console.error(color('gray', 'Usage: traecn delegate <task>'));
    process.exit(1);
  }

  console.log(color('cyan', 'Executing task...'));
  console.log(color('dim', task.substring(0, 200) + (task.length > 200 ? '...' : '')));

  try {
    const result = await apiRequest('POST', '/api/delegate-async', {
      task,
      waitForQueue: waitForResult
    });

    if (result.status === 202 && result.data.status === 'queued') {
      console.log(color('yellow', '⚠ Task queued, use traecn status to check progress'));
      console.log(color('dim', `Task ID: ${result.data.taskId}`));
      if (outputFormat === 'json') {
        console.log(JSON.stringify(result.data, null, 2));
      }
      return;
    }

    if (result.status === 202 && result.data.status === 'running') {
      console.log(color('yellow', '⚠ Trae is busy, task queued'));
      console.log(color('dim', `Task ID: ${result.data.taskId}`));
      if (outputFormat === 'json') {
        console.log(JSON.stringify(result.data, null, 2));
      }
      return;
    }

    if (result.data.status === 'done') {
      console.log(color('green', '✓ Task completed'));
      if (outputFormat === 'json') {
        console.log(JSON.stringify(result.data, null, 2));
      } else {
        console.log(color('white', result.data.text || result.data.message));
        if (result.data.elapsedMs) {
          console.log(color('dim', `Elapsed: ${result.data.elapsedMs}ms`));
        }
      }
      if (result.data.needsApproval) {
        console.log(color('yellow', `⚠ Requires approval: ${result.data.question}`));
      }
    } else {
      console.error(color('red', `Error: ${result.data.error || 'Unknown error'}`));
      if (outputFormat === 'json') {
        console.log(JSON.stringify(result.data, null, 2));
      }
      process.exit(1);
    }
  } catch (err) {
    console.error(color('red', `Request failed: ${err.message}`));
    process.exit(1);
  }
}

async function cmdVibe(args) {
  let task = '';
  let projectPath = null;
  let outputFormat = 'text';
  const steps = [];
  let completionChecks = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-f' || args[i] === '--file') {
      const filePath = args[++i];
      try {
        task = fs.readFileSync(filePath, 'utf8');
      } catch {
        console.error(color('red', `Error: Cannot read file ${filePath}`));
        process.exit(1);
      }
    } else if (args[i] === '--step') {
      const step = args[++i];
      if (step) steps.push(step);
    } else if (args[i] === '--check-file') {
      addRequiredFileCheck(completionChecks, args[++i]);
    } else if (args[i] === '--check-text') {
      addRequiredTextCheck(completionChecks, args[++i]);
    } else if (args[i] === '--completion-checks-json') {
      completionChecks = parseCompletionChecksArg(args[++i], '--completion-checks-json');
    } else if (args[i] === '--project' || args[i] === '--project-path') {
      projectPath = args[++i] || null;
    } else if (args[i] === '-o' || args[i] === '--output') {
      outputFormat = args[++i] || 'text';
    } else if (!args[i].startsWith('-')) {
      positional.push(args[i]);
    }
  }

  if (!task && positional.length > 0) {
    task = positional.join(' ');
  }

  if (!task.trim()) {
    console.error(color('red', 'Error: Task is required'));
    console.error(color('gray', 'Usage: traecn vibe <task> [--step <task>] [--project <path>]'));
    process.exit(1);
  }

  try {
    const result = await apiRequest('POST', '/api/delegate-async', {
      task,
      projectPath,
      background: true,
      autoContinue: true,
      followupTasks: steps.map(step => ({ task: step, reviewRequired: false, autoContinue: true })),
      completionChecks: hasCompletionChecks(completionChecks) ? completionChecks : undefined,
      waitForQueue: true
    });

    if (![200, 202].includes(result.status)) {
      console.error(color('red', `Error: ${result.data.error || 'Workflow submission failed'}`));
      if (outputFormat === 'json') console.log(JSON.stringify(result.data, null, 2));
      process.exit(1);
    }

    if (outputFormat === 'json') {
      console.log(JSON.stringify(result.data, null, 2));
      return;
    }

    console.log(color('green', '✓ Vibe workflow submitted'));
    console.log(color('dim', `Task ID: ${result.data.taskId || '(completed immediately)'}`));
    console.log(color('dim', `Follow-up steps: ${steps.length}`));
  } catch (err) {
    console.error(color('red', `Request failed: ${err.message}`));
    process.exit(1);
  }
}

async function cmdWait(args) {
  const options = parseWaitArgs(args);
  if (!options.taskId) {
    console.error(color('red', 'Error: taskId is required'));
    console.error(color('gray', 'Usage: traecn wait <taskId> [--poll-ms <ms>] [--timeout-ms <ms>] [--log <file>]'));
    process.exit(1);
  }

  if (options.detach) {
    const detached = buildDetachedWaitCommand(options);
    for (const filePath of [detached.logFile, detached.finalFile, detached.stderrFile]) {
      if (filePath) fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    const started = spawnSync('screen', detached.screenArgs, { encoding: 'utf8' });
    if (started.error || started.status !== 0) {
      console.error(color('red', `Detach failed: ${started.error ? started.error.message : started.stderr || 'screen exited with status ' + started.status}`));
      process.exit(1);
    }
    const payload = {
      detached: true,
      taskId: options.taskId,
      sessionName: detached.sessionName,
      logFile: detached.logFile,
      finalFile: detached.finalFile,
      stderrFile: detached.stderrFile
    };
    if (options.outputFormat === 'json') {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(color('green', `Detached wait started: ${detached.sessionName}`));
      if (detached.logFile) console.log(color('dim', `Evidence log: ${detached.logFile}`));
      console.log(color('dim', `Final JSON: ${detached.finalFile}`));
      console.log(color('dim', `Errors: ${detached.stderrFile}`));
    }
    return;
  }

  const cfg = loadConfig();
  const client = new TraeCNApiClient({
    host: cfg.host,
    port: cfg.port,
    token: cfg.token,
    timeout: Math.max(60000, options.pollMs + 30000)
  });

  try {
    const result = await client.waitForTask(options.taskId, {
      pollMs: options.pollMs,
      timeoutMs: options.timeoutMs,
      autoApproveDialog: options.autoApproveDialog,
      onSnapshot: async event => {
        appendJsonLine(options.logFile, event);
        if (options.quiet || options.outputFormat === 'json') return;
        if (event.type === 'task_status') {
          const queue = event.data && event.data.queueDetails ? event.data.queueDetails : {};
          const queueText = queue.queuePosition ? ` queue=${queue.queuePosition}` : '';
          console.log(color('dim', `[${event.at}] ${event.taskId} ${event.status}${queueText}`));
        } else if (event.type === 'dialog_status') {
          console.log(color('yellow', `[${event.at}] dialog detected while waiting`));
        } else if (event.type === 'dialog_approval') {
          console.log(color('yellow', `[${event.at}] dialog approval sent: ${event.action}`));
        }
      }
    });

    if (options.outputFormat === 'json') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const wait = result.wait || {};
      const status = result.status || 'unknown';
      const statusColor = status === 'done' ? 'green' : isTerminalTaskStatus(status) ? 'yellow' : 'cyan';
      console.log(color(statusColor, `Task ${options.taskId} ended at status: ${status}`));
      console.log(color('dim', `Attempts: ${wait.attempts || 0}, elapsed: ${wait.elapsedMs || 0}ms`));
      if (options.logFile) console.log(color('dim', `Evidence log: ${path.resolve(options.logFile)}`));
      const text = result.result && result.result.text ? result.result.text : result.text;
      if (text) {
        console.log('');
        console.log(color('white', text));
      }
      if (result.error) {
        console.error(color('red', result.error));
      }
    }

    if (result.wait && result.wait.timedOut) process.exit(2);
    if (['error', 'queue_timeout', 'review_rejected', 'not_found'].includes(String(result.status || '').toLowerCase())) {
      process.exit(1);
    }
  } catch (err) {
    console.error(color('red', `Wait failed: ${err.message}`));
    process.exit(1);
  }
}

async function cmdCapabilities(args) {
  const outputFormat = args.includes('--json') || args.includes('-o') && args[args.indexOf('-o') + 1] === 'json'
    ? 'json'
    : 'text';
  try {
    const result = await apiRequest('GET', '/api/capabilities');
    if (result.status !== 200) {
      console.error(color('red', `Error: ${result.data.error || 'Unable to read capabilities'}`));
      process.exit(1);
    }
    if (outputFormat === 'json') {
      console.log(JSON.stringify(result.data, null, 2));
      return;
    }

    console.log(`\n${color('bold', '═══ TraeCN Capabilities ═══')}\n`);
    console.log(`  ${color('cyan', 'Version:')} ${result.data.version}`);
    console.log(`  ${color('cyan', 'Commands:')} ${result.data.commands.length}`);
    console.log(`  ${color('cyan', 'HTTP ops:')} ${result.data.http.length}`);
    console.log(`  ${color('cyan', 'Token flow:')} ${result.data.tokenStrategy.prefer.join(' → ')}`);
    console.log(`  ${color('cyan', 'Coverage:')} ${Object.entries(result.data.coverage).filter(([, value]) => value === true).map(([key]) => key).join(', ')}`);
    console.log('');
  } catch (err) {
    console.error(color('red', `Request failed: ${err.message}`));
    process.exit(1);
  }
}

async function cmdPlan(args) {
  const command = args[0];
  if (!command) {
    console.error(color('red', 'Error: command is required'));
    console.error(color('gray', 'Usage: traecn plan <command> [params-json] [--force-confirm]'));
    process.exit(1);
  }
  const params = args[1] && !args[1].startsWith('-') ? parseJsonArg(args[1], 'params') : {};
  const forceConfirm = args.includes('--force-confirm');

  try {
    const result = await apiRequest('POST', '/api/confirm/plan', {
      command,
      params,
      forceConfirm
    });
    if (result.status !== 200) {
      console.error(color('red', `Error: ${result.data.error || 'Unable to create plan'}`));
      process.exit(1);
    }

    const plan = result.data;
    console.log(`\n${color('bold', '═══ Operation Plan ═══')}\n`);
    console.log(`  ${color('cyan', 'Command:')} ${plan.command}`);
    console.log(`  ${color('cyan', 'Risk:')}    ${plan.risk === 'high' ? color('red', plan.risk) : plan.risk === 'medium' ? color('yellow', plan.risk) : color('green', plan.risk)}`);
    console.log(`  ${color('cyan', 'Confirm:')} ${plan.requiresConfirmation ? color('yellow', 'required') : color('dim', 'not required')}`);
    console.log(`  ${color('cyan', 'ID:')}      ${plan.confirmationId}`);
    if (plan.sideEffects && plan.sideEffects.length) {
      console.log(`\n${color('bold', 'Side effects:')}`);
      plan.sideEffects.forEach(item => console.log(`  - ${item}`));
    }
    if (plan.preflight && plan.preflight.length) {
      console.log(`\n${color('bold', 'Preflight:')}`);
      plan.preflight.forEach(item => console.log(`  - ${item}`));
    }
    console.log(`\n${color('dim', plan.tokenHint || '')}\n`);
  } catch (err) {
    console.error(color('red', `Request failed: ${err.message}`));
    process.exit(1);
  }
}

async function cmdPreflight(args) {
  const command = args[0] && !args[0].startsWith('-') ? args[0] : null;
  const paramsArg = command && args[1] && !args[1].startsWith('-') ? args[1] : null;
  const params = paramsArg ? parseJsonArg(paramsArg, 'params') : {};
  const forceConfirm = args.includes('--force-confirm');
  const outputFormat = args.includes('--json') || args.includes('-o') && args[args.indexOf('-o') + 1] === 'json'
    ? 'json'
    : 'text';

  try {
    const result = await apiRequest('POST', '/api/preflight', {
      ...(command ? { command } : {}),
      ...(Object.keys(params).length ? { params } : {}),
      forceConfirm
    });
    if (result.status !== 200) {
      console.error(color('red', `Error: ${result.data.error || 'Unable to run preflight'}`));
      process.exit(1);
    }
    if (outputFormat === 'json') {
      console.log(JSON.stringify(result.data, null, 2));
      return;
    }

    const data = result.data;
    console.log(`\n${color('bold', '═══ TraeCN Preflight ═══')}\n`);
    console.log(`  ${color('cyan', 'Connected:')} ${data.connected ? color('green', 'yes') : color('yellow', 'no')}`);
    console.log(`  ${color('cyan', 'Ready:')}     ${data.ready ? color('green', 'yes') : color('yellow', 'no')}`);
    console.log(`  ${color('cyan', 'Delegate:')}  ${data.canDelegate ? color('green', 'ready') : color('yellow', 'not yet')}`);
    console.log(`  ${color('cyan', 'Next:')}      ${data.nextAction}`);
    if (data.queue) {
      console.log(`  ${color('cyan', 'Queue:')}     ${data.queue.queued ? 'queued' : data.queue.running ? 'running' : 'idle'}`);
    }
    if (data.dialog) {
      console.log(`  ${color('cyan', 'Dialog:')}    ${data.dialog.hasDialog ? data.dialog.dialogType || 'present' : 'clear'}`);
    }
    if (data.commandPlan) {
      console.log(`  ${color('cyan', 'Command:')}   ${data.commandPlan.command} (${data.commandPlan.risk}, confirm=${data.commandPlan.requiresConfirmation})`);
      console.log(`  ${color('cyan', 'Plan ID:')}   ${data.commandPlan.confirmationId}`);
    }
    console.log(`\n${color('dim', data.tokenHint || '')}\n`);
  } catch (err) {
    console.error(color('red', `Request failed: ${err.message}`));
    process.exit(1);
  }
}

async function cmdCleanupQueue(args) {
  const outputFormat = args.includes('--json') || args.includes('-o') && args[args.indexOf('-o') + 1] === 'json'
    ? 'json'
    : 'text';
  const lockFile = readStringOption(args, '--lock-file', null);

  if (args.includes('--status')) {
    cleanupQueueStatus({ outputFormat, lockFile });
    return;
  }

  const execute = args.includes('--execute');
  const dryRun = args.includes('--dry-run') || !execute;
  const maxPasses = readNumberOption(args, '--max-passes', 10);
  const watchMs = readNumberOption(args, '--watch-ms', 0);
  const stableMs = readNumberOption(args, '--stable-ms', 120000);
  const intervalMs = readNumberOption(args, '--interval-ms', 15000);
  const detach = args.includes('--detach');
  const sessionName = readStringOption(args, '--session', null);
  const logFile = readStringOption(args, '--log', null);
  const finalFile = readStringOption(args, '--final', null);
  const stderrFile = readStringOption(args, '--stderr', null);
  const replace = args.includes('--replace');

  try {
    if (detach) {
      cleanupQueueDetach({
        outputFormat,
        lockFile,
        execute,
        dryRun,
        maxPasses,
        watchMs,
        stableMs,
        intervalMs,
        sessionName,
        logFile,
        finalFile,
        stderrFile,
        replace
      });
      return;
    }

    let result;
    if (execute && watchMs > 0) {
      result = await cleanupQueueWatch({
        outputFormat,
        lockFile,
        execute,
        dryRun,
        maxPasses,
        watchMs,
        stableMs,
        intervalMs,
        logFile,
        finalFile,
        replace
      });
      if (result === undefined) return;
    } else {
      result = await cleanupQueueDryRun({
        outputFormat,
        lockFile,
        execute,
        dryRun,
        maxPasses
      });
    }

    if (![200, 501].includes(result.status)) {
      console.error(color('red', `Error: ${result.data.error || 'Unable to cleanup Solo queue probes'}`));
      if (outputFormat === 'json') console.log(JSON.stringify(result.data, null, 2));
      process.exit(1);
    }
    if (outputFormat === 'json') {
      console.log(JSON.stringify(result.data, null, 2));
      return;
    }
    console.log(`\n${color('bold', '═══ Solo Queue Cleanup ═══')}\n`);
    console.log(`  ${color('cyan', 'Matched:')} ${result.data.matched || 0}/${result.data.total || 0}`);
    if (typeof result.data.remainingMatched === 'number') {
      console.log(`  ${color('cyan', 'Remaining:')} ${result.data.remainingMatched}`);
    }
    console.log(`  ${color('cyan', 'Deleted:')} ${result.data.deleted || 0}`);
    console.log(`  ${color('cyan', 'Mode:')}    ${result.data.mode || 'unknown'}`);
    console.log(`  ${color('cyan', 'Support:')} ${result.data.support || 'unknown'}`);
    if (dryRun && (result.data.matched || 0) > 0) {
      console.log(color('yellow', '\nDry run only. Re-run with --execute to delete matched queue-probe chats.'));
    }
  } catch (err) {
    console.error(color('red', `Request failed: ${err.message}`));
    process.exit(1);
  }
}

function cleanupQueueStatus({ outputFormat, lockFile }) {
  const status = describeCleanupWatchStatus({ lockFile });
  if (outputFormat === 'json') {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(`\n${color('bold', '═══ Cleanup Watcher Status ═══')}\n`);
    console.log(`  ${color('cyan', 'Running:')} ${status.running ? color('green', 'yes') : color('yellow', 'no')}`);
    console.log(`  ${color('cyan', 'PID:')}     ${status.pid || 'none'}`);
    console.log(`  ${color('cyan', 'Lock:')}    ${status.lockFile}`);
    if (status.stale) console.log(`  ${color('cyan', 'Stale:')}   yes`);
    console.log(`\n${color('dim', status.message)}\n`);
  }
}

function cleanupQueueDetach({
  outputFormat,
  lockFile,
  execute,
  maxPasses,
  watchMs,
  stableMs,
  intervalMs,
  sessionName,
  logFile,
  finalFile,
  stderrFile,
  replace
}) {
  if (!execute || watchMs <= 0) {
    console.error(color('red', 'Error: cleanup-queue --detach requires --execute and --watch-ms'));
    process.exit(1);
  }
  const detached = buildDetachedCleanupCommand({
    maxPasses,
    watchMs,
    stableMs,
    intervalMs,
    sessionName,
    logFile,
    finalFile,
    stderrFile,
    lockFile,
    replace
  });
  const cleanupLockFile = path.resolve(lockFile || defaultCleanupWatchLockFile());
  const existingLock = readCleanupWatchLock(cleanupLockFile);
  if (existingLock && !existingLock.error && isPidRunning(existingLock.pid) && replace !== true) {
    const payload = {
      detached: false,
      alreadyRunning: true,
      lockFile: cleanupLockFile,
      existing: existingLock,
      message: 'Cleanup watcher is already running; use --replace to terminate the existing watcher and start a new one.'
    };
    if (outputFormat === 'json') {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(color('yellow', `Cleanup watcher already running: pid ${existingLock.pid}`));
      console.log(color('dim', `Lock: ${payload.lockFile}`));
    }
    return;
  }
  if (existingLock && !existingLock.error && isPidRunning(existingLock.pid) && replace === true) {
    const terminated = terminateCleanupWatcher(existingLock.pid, { timeoutMs: 5000 });
    if (!terminated.terminated) {
      const payload = {
        detached: false,
        alreadyRunning: true,
        lockFile: cleanupLockFile,
        existing: existingLock,
        terminate: terminated,
        error: 'unable_to_replace_running_cleanup_watcher'
      };
      if (outputFormat === 'json') {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.error(color('red', `Unable to replace cleanup watcher pid ${existingLock.pid}`));
      }
      process.exit(1);
    }
  }
  if (replace === true) {
    for (const processInfo of listCleanupWatcherProcesses()) {
      if (existingLock && processInfo.pid === existingLock.pid) continue;
      const terminated = terminateCleanupWatcher(processInfo.pid, { timeoutMs: 5000 });
      if (!terminated.terminated) {
        const payload = {
          detached: false,
          alreadyRunning: true,
          lockFile: cleanupLockFile,
          orphan: processInfo,
          terminate: terminated,
          error: 'unable_to_replace_orphan_cleanup_watcher'
        };
        if (outputFormat === 'json') {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          console.error(color('red', `Unable to replace orphan cleanup watcher pid ${processInfo.pid}`));
        }
        process.exit(1);
      }
    }
  }
  if (existingLock && (replace === true || existingLock.error || !isPidRunning(existingLock.pid))) {
    try {
      fs.unlinkSync(cleanupLockFile);
    } catch {
      // Best-effort stale lock cleanup.
    }
  }
  for (const filePath of [detached.logFile, detached.finalFile, detached.stderrFile]) {
    if (filePath) fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const started = spawnSync('screen', detached.screenArgs, { encoding: 'utf8' });
  if (started.error || started.status !== 0) {
    console.error(color('red', `Detach failed: ${started.error ? started.error.message : started.stderr || 'screen exited with status ' + started.status}`));
    process.exit(1);
  }
  const payload = {
    detached: true,
    sessionName: detached.sessionName,
    logFile: detached.logFile,
    finalFile: detached.finalFile,
    stderrFile: detached.stderrFile,
    lockFile: path.resolve(lockFile || defaultCleanupWatchLockFile()),
    watchMs,
    stableMs,
    intervalMs
  };
  if (outputFormat === 'json') {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(color('green', `Detached cleanup watcher started: ${detached.sessionName}`));
    if (detached.logFile) console.log(color('dim', `Evidence log: ${detached.logFile}`));
    console.log(color('dim', `Final JSON: ${detached.finalFile}`));
    console.log(color('dim', `Errors: ${detached.stderrFile}`));
  }
}

async function cleanupQueueWatch({
  outputFormat,
  lockFile,
  execute,
  dryRun,
  maxPasses,
  watchMs,
  stableMs,
  intervalMs,
  logFile,
  finalFile,
  replace
}) {
  const cleanupOnce = () => apiRequest('POST', '/api/solo/chats/cleanup-foreign-queue', {
    execute,
    dryRun,
    ...(execute && Number.isFinite(maxPasses) && maxPasses > 0 ? { maxPasses } : {})
  });
  let result;
  const lock = acquireCleanupWatchLock({
    lockFile,
    replace,
    watchMs,
    stableMs,
    intervalMs,
    logFile,
    finalFile
  });
  if (!lock.ok) {
    result = {
      status: 200,
      data: {
        mode: 'watch_already_running',
        alreadyRunning: lock.alreadyRunning === true,
        lockFile: lock.lockFile,
        existing: lock.existing || null,
        error: lock.error || null
      }
    };
    if (outputFormat === 'json') {
      console.log(JSON.stringify(result.data, null, 2));
    } else {
      console.log(color('yellow', `Cleanup watcher already running: pid ${lock.existing?.pid || 'unknown'}`));
      console.log(color('dim', `Lock: ${lock.lockFile}`));
    }
    return;
  }
  const startedAt = Date.now();
  let cleanSince = null;
  const iterations = [];
  const releaseAndExit = () => {
    lock.release();
    process.exit(0);
  };
  process.once('SIGINT', releaseAndExit);
  process.once('SIGTERM', releaseAndExit);
  try {
    while (Date.now() - startedAt <= watchMs) {
      const attempt = await runCleanupWatchAttempt(cleanupOnce, { lockFile: lock.lockFile, intervalMs });
      result = attempt.result;
      iterations.push(attempt.iteration);
      appendJsonLine(logFile, iterations[iterations.length - 1]);
      if (attempt.transient) {
        cleanSince = null;
      } else if (!attempt.clean) {
        cleanSince = null;
      } else {
        cleanSince = cleanSince || Date.now();
        if (Date.now() - cleanSince >= stableMs) break;
      }
      await delay(attempt.iteration.nextDelayMs);
    }
  } finally {
    process.removeListener('SIGINT', releaseAndExit);
    process.removeListener('SIGTERM', releaseAndExit);
    lock.release();
  }
  let verify;
  try {
    verify = await apiRequest('POST', '/api/solo/chats/cleanup-foreign-queue', { dryRun: true });
  } catch (err) {
    verify = {
      status: 0,
      data: {
        error: err.message || 'cleanup_verify_failed'
      }
    };
  }
  result = {
    status: verify.status,
    data: {
      mode: 'watch',
      lockFile: lock.lockFile,
      matched: verify.data?.matched || 0,
      remainingMatched: verify.data?.matched || 0,
      total: verify.data?.total || null,
      deleted: iterations.reduce((sum, item) => sum + item.deleted, 0),
      stopped: iterations.reduce((sum, item) => sum + item.stopped, 0),
      support: verify.data?.support || result?.data?.support || 'unknown',
      watchMs,
      stableMs,
      intervalMs,
      elapsedMs: Date.now() - startedAt,
      iterations,
      transientErrors: iterations.filter(item => item.transient === true).length,
      finalDryRun: verify.data
    }
  };
  return result;
}

async function cleanupQueueDryRun({
  execute,
  dryRun,
  maxPasses
}) {
  const cleanupOnce = () => apiRequest('POST', '/api/solo/chats/cleanup-foreign-queue', {
    execute,
    dryRun,
    ...(execute && Number.isFinite(maxPasses) && maxPasses > 0 ? { maxPasses } : {})
  });
  const result = await cleanupOnce();
  return result;
}

async function cmdStatus() {
  try {
    const result = await apiRequest('GET', '/api/status');
    const cfg = loadConfig();

    console.log(`\n${color('bold', '═══ TraeCN Gateway Status ═══')}\n`);
    console.log(`  ${color('cyan', 'Service:')}    traecn-cdp-http-bridge`);
    console.log(`  ${color('cyan', 'Version:')}    ${result.data.version || 'unknown'}`);
    console.log(`  ${color('cyan', 'Endpoint:')}   ${cfg.host}:${cfg.port}`);
    console.log(`  ${color('cyan', 'Status:')}     ${result.data.status === 'connected' ? color('green', '● Connected') : color('yellow', '● Disconnected')}`);
    console.log(`  ${color('cyan', 'Mock:')}       ${result.data.mockBridge ? color('yellow', 'Enabled') : color('dim', 'Disabled')}`);
    console.log(`  ${color('cyan', 'Uptime:')}     ${Math.round(result.data.uptime || 0)}s`);

    if (result.data.cdp) {
      console.log(`  ${color('cyan', 'CDP Browser:')} ${result.data.cdp.browser || 'unknown'}`);
    }

    console.log('');
  } catch (err) {
    console.error(color('red', `Error: ${err.message}`));
    process.exit(1);
  }
}

async function cmdModels() {
  try {
    const settings = await apiRequest('GET', '/api/settings/read?section=model');
    const readiness = await apiRequest('GET', '/api/readiness');

    console.log(`\n${color('bold', '═══ Available Models ═══')}\n`);

    if (settings.data.options) {
      const models = Array.isArray(settings.data.options)
        ? settings.data.options
        : [settings.data.options];

      models.forEach((model, _index) => {
        const isActive = readiness.data.currentModel === model ||
                        (typeof model === 'object' && readiness.data.currentModel === model.id);
        const marker = isActive ? color('green', ' ● ') : '   ';
        const name = typeof model === 'string' ? model : model.name || model.id || JSON.stringify(model);
        console.log(`  ${marker} ${name}`);
      });
    } else if (settings.data.data) {
      console.log(color('dim', '  Model settings available, check UI for options'));
    } else {
      console.log(color('dim', '  No model information available'));
    }

    if (readiness.data.currentModel) {
      console.log(`\n  ${color('cyan', 'Current Model:')} ${color('white', readiness.data.currentModel)}`);
    }

    console.log('');
  } catch (err) {
    console.error(color('red', `Error: ${err.message}`));
    process.exit(1);
  }
}

async function cmdConfig(args) {
  const cfg = loadConfig();

  if (args.length === 0) {
    console.log(`\n${color('bold', '═══ TraeCN Configuration ═══')}\n`);
    console.log(`  ${color('cyan', 'host:')}   ${cfg.host}`);
    console.log(`  ${color('cyan', 'port:')}   ${cfg.port}`);
    console.log(`  ${color('cyan', 'token:')}  ${cfg.token ? color('green', '[set]') : color('dim', '[not set]')}`);
    console.log(`  ${color('dim', '\n  Config file:')} ${CONFIG_FILE}`);
    console.log('');
    return;
  }

  const action = args[0];

  if (action === 'get') {
    const key = args[1];
    if (!key) {
      console.error(color('red', 'Error: Key required'));
      console.error(color('gray', 'Usage: traecn config get <key>'));
      process.exit(1);
    }
    const value = cfg[key];
    if (value !== undefined) {
      console.log(value);
    } else {
      console.error(color('red', `Error: Key "${key}" not found`));
      process.exit(1);
    }
    return;
  }

  if (action === 'set') {
    const key = args[1];
    const value = args[2];

    if (!key || value === undefined) {
      console.error(color('red', 'Error: Key and value required'));
      console.error(color('gray', 'Usage: traecn config set <key> <value>'));
      process.exit(1);
    }

    if (!['host', 'port', 'token'].includes(key)) {
      console.error(color('red', `Error: Unknown config key "${key}"`));
      console.error(color('gray', 'Supported keys: host, port, token'));
      process.exit(1);
    }

    const newConfig = { ...cfg };
    if (key === 'port') {
      newConfig.port = parseInt(value, 10);
      if (isNaN(newConfig.port)) {
        console.error(color('red', 'Error: Port must be a number'));
        process.exit(1);
      }
    } else {
      newConfig[key] = value;
    }

    if (saveConfig(newConfig)) {
      console.log(color('green', `✓ ${key} set to "${value}"`));
    } else {
      console.error(color('red', `Error: Failed to save config`));
      process.exit(1);
    }
    return;
  }

  console.error(color('red', `Error: Unknown config command "${action}"`));
  console.error(color('gray', 'Usage: traecn config [get <key> | set <key> <value>]'));
  process.exit(1);
}

async function cmdBatch(args) {
  if (args.length === 0) {
    console.error(color('red', 'Error: Batch command required'));
    console.error(color('gray', 'Usage: traecn batch [submit|status|cancel] [args]'));
    process.exit(1);
  }

  const action = args[0];

  if (action === 'submit') {
    const filePath = args[1];
    if (!filePath) {
      console.error(color('red', 'Error: File path required'));
      console.error(color('gray', 'Usage: traecn batch submit <file.json>'));
      process.exit(1);
    }

    let tasksData;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      tasksData = JSON.parse(content);
    } catch {
      console.error(color('red', `Error: Cannot read or parse ${filePath}`));
      process.exit(1);
    }

    let strategy = 'parallel';
    let maxConcurrency = 5;
    let callbackUrl = null;

    for (let i = 2; i < args.length; i++) {
      if (args[i] === '-s' || args[i] === '--strategy') {
        strategy = args[++i] || 'parallel';
      } else if (args[i] === '-c' || args[i] === '--concurrency') {
        maxConcurrency = parseInt(args[++i], 10) || 5;
      } else if (args[i] === '--callback') {
        callbackUrl = args[++i];
      }
    }

    let tasks;
    if (Array.isArray(tasksData)) {
      tasks = tasksData.map(t => typeof t === 'string' ? { task: t } : t);
    } else if (tasksData.tasks) {
      tasks = tasksData.tasks;
      strategy = tasksData.strategy || strategy;
      maxConcurrency = tasksData.maxConcurrency || maxConcurrency;
      callbackUrl = tasksData.onComplete || callbackUrl;
    } else {
      console.error(color('red', 'Error: Invalid batch file format'));
      process.exit(1);
    }

    console.log(color('cyan', `Submitting ${tasks.length} tasks...`));
    console.log(color('dim', `Strategy: ${strategy}, Concurrency: ${maxConcurrency}`));

    try {
      const result = await apiRequest('POST', '/api/tasks/batch', {
        tasks,
        strategy,
        maxConcurrency,
        onComplete: callbackUrl
      });

      if (result.status === 202) {
        console.log(color('green', `✓ Batch submitted successfully`));
        console.log(color('dim', `Batch ID: ${result.data.batchId}`));
        console.log(color('dim', `Status: ${result.data.status}`));

        let completed = 0;
        const total = tasks.length;

        while (true) {
          await new Promise(r => setTimeout(r, 1000));
          const status = await apiRequest('GET', `/api/tasks/batch/${result.data.batchId}`);
          completed = status.data.completedCount + status.data.failedCount;
          showProgress(completed, total, 'Progress');

          if (status.data.status === 'completed' || status.data.status === 'cancelled') {
            console.log(color('green', `\n✓ Batch ${status.data.status}`));
            console.log(color('dim', `Completed: ${status.data.completedCount}, Failed: ${status.data.failedCount}`));
            break;
          }
        }
      } else {
        console.error(color('red', `Error: ${result.data.error || 'Submission failed'}`));
        process.exit(1);
      }
    } catch (err) {
      console.error(color('red', `Request failed: ${err.message}`));
      process.exit(1);
    }
    return;
  }

  if (action === 'status') {
    const batchId = args[1];
    if (!batchId) {
      console.error(color('red', 'Error: Batch ID required'));
      console.error(color('gray', 'Usage: traecn batch status <batchId>'));
      process.exit(1);
    }

    try {
      const result = await apiRequest('GET', `/api/tasks/batch/${batchId}`);

      if (result.status === 404) {
        console.error(color('red', `Error: Batch ${batchId} not found`));
        process.exit(1);
      }

      const batch = result.data;
      console.log(`\n${color('bold', `═══ Batch ${batch.batchId} ═══`)}\n`);
      console.log(`  ${color('cyan', 'Status:')}     ${batch.status === 'completed' ? color('green', '● Completed') : batch.status === 'cancelled' ? color('red', '● Cancelled') : color('yellow', '● ' + batch.status)}`);
      console.log(`  ${color('cyan', 'Strategy:')}   ${batch.strategy}`);
      console.log(`  ${color('cyan', 'Total:')}      ${batch.totalCount}`);
      console.log(`  ${color('green', 'Completed:')} ${batch.completedCount}`);
      console.log(`  ${color('red', 'Failed:')}      ${batch.failedCount}`);
      console.log(`  ${color('yellow', 'Pending:')} ${batch.pendingCount || 0}`);
      console.log(`  ${color('cyan', 'Running:')}    ${batch.executingCount || 0}`);

      console.log(`\n${color('bold', 'Tasks:')}`);
      batch.tasks.forEach((task, _i) => {
        const statusIcon = task.status === 'done' ? color('green', '✓') : task.status === 'error' ? color('red', '✗') : task.status === 'executing' ? color('yellow', '▶') : color('dim', '○');
        const priorityLabel = task.priority ? color('dim', `[P${task.priority}]`) : '';
        console.log(`  ${statusIcon} ${priorityLabel} ${task.taskId}`);
        if (task.result && task.result.text) {
          console.log(color('dim', `    → ${task.result.text.substring(0, 100)}...`));
        }
        if (task.error) {
          console.log(color('red', `    → Error: ${task.error}`));
        }
      });
      console.log('');
    } catch (err) {
      console.error(color('red', `Request failed: ${err.message}`));
      process.exit(1);
    }
    return;
  }

  if (action === 'cancel') {
    const batchId = args[1];
    if (!batchId) {
      console.error(color('red', 'Error: Batch ID required'));
      console.error(color('gray', 'Usage: traecn batch cancel <batchId>'));
      process.exit(1);
    }

    try {
      const result = await apiRequest('DELETE', `/api/tasks/batch/${batchId}`);

      if (result.status === 404) {
        console.error(color('red', `Error: Batch ${batchId} not found`));
        process.exit(1);
      }

      if (result.status === 400) {
        console.error(color('yellow', `Warning: ${result.data.error}`));
        process.exit(1);
      }

      console.log(color('green', `✓ Batch ${batchId} cancelled`));
    } catch (err) {
      console.error(color('red', `Request failed: ${err.message}`));
      process.exit(1);
    }
    return;
  }

  console.error(color('red', `Error: Unknown batch command "${action}"`));
  console.error(color('gray', 'Usage: traecn batch [submit|status|cancel]'));
  process.exit(1);
}

async function cmdLogs(args) {
  const lines = parseInt(args[0], 10) || 50;

  try {
    const result = await apiRequest('GET', '/api/queue/status');

    console.log(`\n${color('bold', `═══ Recent Activity (${lines} entries) ═══`)}\n`);

    if (result.data.tasks && result.data.tasks.length > 0) {
      result.data.tasks.slice(-lines).forEach(task => {
        const time = new Date(task.createdAt).toLocaleTimeString();
        const statusColor = task.status === 'done' ? 'green' : task.status === 'error' ? 'red' : task.status === 'executing' ? 'yellow' : 'dim';
        console.log(`  ${color('dim', time)} ${color(statusColor, task.status.padEnd(12))} ${task.taskId}`);
        if (task.result && task.result.text) {
          console.log(color('dim', `    → ${task.result.text.substring(0, 100)}`));
        }
        if (task.error) {
          console.log(color('red', `    → ${task.error}`));
        }
      });
    } else {
      console.log(color('dim', '  No recent activity'));
    }
    console.log('');
  } catch (err) {
    console.error(color('red', `Error: ${err.message}`));
    process.exit(1);
  }
}

function buildProofCliArgs(args) {
  const subcommand = args[0] && !args[0].startsWith('-') ? args[0] : 'status';
  const rest = subcommand === args[0] ? args.slice(1) : args.slice();
  const proofArgs = [path.join(__dirname, 'long-queue-proof.js')];
  if (subcommand === 'status') {
    proofArgs.push('--status');
  } else if (subcommand === 'cancel') {
    proofArgs.push('--cancel');
  } else if (subcommand === 'start' || subcommand === 'run') {
    // No --execute is added here. The proof runner stays dry-run by default.
  } else {
    throw new Error(`Unknown proof command "${subcommand}"`);
  }
  proofArgs.push(...rest);
  return proofArgs;
}

async function cmdProof(args) {
  let proofArgs;
  try {
    proofArgs = buildProofCliArgs(args);
  } catch (err) {
    console.error(color('red', `Error: ${err.message}`));
    console.error(color('gray', 'Usage: traecn proof status|start|cancel [long-queue-proof options]'));
    process.exit(1);
  }
  const result = spawnSync(process.execPath, proofArgs, {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit'
  });
  if (result.error) {
    console.error(color('red', `Proof command failed: ${result.error.message}`));
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    return;
  }

  const command = args[0];

  try {
    switch (command) {
      case 'delegate':
        await cmdDelegate(args.slice(1));
        break;
      case 'vibe':
      case 'vibe-workflow':
        await cmdVibe(args.slice(1));
        break;
      case 'wait':
      case 'wait-task':
        await cmdWait(args.slice(1));
        break;
      case 'status':
        await cmdStatus();
        break;
      case 'capabilities':
        await cmdCapabilities(args.slice(1));
        break;
      case 'preflight':
        await cmdPreflight(args.slice(1));
        break;
      case 'cleanup-queue':
        await cmdCleanupQueue(args.slice(1));
        break;
      case 'proof':
        await cmdProof(args.slice(1));
        break;
      case 'plan':
        await cmdPlan(args.slice(1));
        break;
      case 'models':
        await cmdModels();
        break;
      case 'config':
        await cmdConfig(args.slice(1));
        break;
      case 'batch':
        await cmdBatch(args.slice(1));
        break;
      case 'logs':
        await cmdLogs(args.slice(1));
        break;
      default:
        console.error(color('red', `Error: Unknown command "${command}"`));
        console.error(color('gray', 'Run "traecn help" for usage'));
        process.exit(1);
    }
  } catch (err) {
    console.error(color('red', `Fatal error: ${err.message}`));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  apiRequest,
  loadConfig,
  saveConfig,
  CONFIG_FILE,
  COLORS,
  parseCompletionChecksArg,
  addRequiredFileCheck,
  addRequiredTextCheck,
  hasCompletionChecks,
  parseWaitArgs,
  appendJsonLine,
  shellQuote,
  defaultWaitSessionName,
  buildDetachedWaitCommand,
  buildProofCliArgs,
  appSupportDir,
  defaultCleanupWatchLockFile,
  isPidRunning,
  processInfoForPid,
  waitForPidExit,
  terminateCleanupWatcher,
  listCleanupWatcherProcesses,
  readCleanupWatchLock,
  describeCleanupWatchStatus,
  acquireCleanupWatchLock,
  buildDetachedCleanupCommand,
  runCleanupWatchAttempt
};
