'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_HOST = process.env.TRAECN_GATEWAY_HOST || process.env.TRAECN_HOST || '127.0.0.1';
const DEFAULT_PORT = Number(process.env.TRAECN_GATEWAY_PORT || process.env.TRAECN_PORT || 8788);
const DEFAULT_MODEL = 'GLM-5.2';
const DEFAULT_POLL_MS = 30000;
const DEFAULT_CLEANUP_INTERVAL_MS = 120000;
const DETACHED_PARENT_LOCK_GRACE_MS = 120000;
const TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled', 'queue_timeout', 'review_rejected', 'awaiting_review', 'approval_required', 'not_found']);
const QUOTA_APPROVAL_FLAG = '--allow-quota-spend';

function appSupportDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'TRAECNclaw');
  }
  return path.join(os.homedir(), '.traecnclaw');
}

function readArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function readNumberArg(name, fallback) {
  const value = readArg(name);
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function truthyEnv(...names) {
  return names.some(name => /^(1|true|yes|on)$/i.test(String(process.env[name] || '').trim()));
}

function readJsonIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return { error: err.message, path: filePath };
  }
}

function readJsonlTail(filePath, maxLines = 10) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\n+/).filter(Boolean);
    return lines.slice(-maxLines).map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return { parseError: true, line };
      }
    });
  } catch (err) {
    return [{ error: err.message, path: filePath }];
  }
}

function readJsonlEvents(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').split(/\n+/).filter(Boolean).map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return { parseError: true, line };
      }
    });
  } catch (err) {
    return [{ error: err.message, path: filePath }];
  }
}

function listFiles(dirPath, suffix) {
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath)
      .filter(file => file.endsWith(suffix))
      .map(file => path.join(dirPath, file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch {
    return [];
  }
}

function proofArtifactBase(filePath) {
  const fileName = path.basename(String(filePath || ''));
  if (fileName.endsWith('.final.json')) return fileName.replace(/\.final\.json$/, '');
  if (fileName.endsWith('.lock.json')) return fileName.replace(/\.lock\.json$/, '');
  if (fileName.endsWith('.jsonl')) return fileName.replace(/\.jsonl$/, '');
  return null;
}

function listProofArtifacts(outputDir) {
  return [
    ...listFiles(outputDir, '.final.json').map(file => ({ file, type: 'final' })),
    ...listFiles(outputDir, '.jsonl').map(file => ({ file, type: 'log' })),
    ...listFiles(outputDir, '.lock.json').map(file => ({ file, type: 'lock' }))
  ]
    .map(artifact => {
      try {
        return {
          ...artifact,
          marker: proofArtifactBase(artifact.file),
          mtimeMs: fs.statSync(artifact.file).mtimeMs
        };
      } catch {
        return null;
      }
    })
    .filter(artifact => artifact && artifact.marker)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function listScreens() {
  const result = spawnSync('screen', ['-ls'], { encoding: 'utf8' });
  return {
    ok: result.status === 0 || /No Sockets|No screen session/i.test(result.stdout || result.stderr || ''),
    text: `${result.stdout || ''}${result.stderr || ''}`.trim(),
    sessions: `${result.stdout || ''}${result.stderr || ''}`
      .split(/\n/)
      .map(line => line.trim())
      .filter(line => /\.\S+\s+\((Detached|Attached)\)/.test(line))
  };
}

function isCleanupWatcherScreen(line) {
  return /\btraecn_cleanup_queue(?:_|$)/.test(String(line || ''));
}

function isProofProcessCommand(command, marker = null) {
  const text = String(command || '');
  if (!/(?:^|\/)node(?:\S*)?\s+(?:(?:--[^\s]+\s+)*)\S*scripts\/long-queue-proof\.js\b/.test(text)) return false;
  if (!/\s--execute\b/.test(text)) return false;
  return marker ? text.includes(marker) : true;
}

function listProofProcesses(marker = null) {
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
      && isProofProcessCommand(item.command, marker));
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

function waitForPidExit(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return !isPidRunning(pid);
}

function terminateProcessGroup(pid, timeoutMs = 2000) {
  const processInfo = listProofProcesses(null).find(item => item.pid === Number(pid)) || null;
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed === process.pid) {
    return { pid: parsed || null, terminated: false, reason: 'invalid_or_current_pid' };
  }
  const targets = [];
  if (processInfo && Number.isInteger(processInfo.pgid) && processInfo.pgid > 1 && processInfo.pgid !== process.pid) {
    targets.push({ target: -processInfo.pgid, kind: 'process_group', pgid: processInfo.pgid });
  }
  targets.push({ target: parsed, kind: 'pid', pid: parsed });
  const signals = [];
  for (const item of targets) {
    try {
      process.kill(item.target, 'SIGTERM');
      signals.push({ ...item, signal: 'SIGTERM', ok: true });
    } catch (err) {
      signals.push({ ...item, signal: 'SIGTERM', ok: false, error: err.message });
    }
  }
  if (!waitForPidExit(parsed, timeoutMs)) {
    for (const item of targets) {
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
    process: processInfo,
    terminated: !isPidRunning(parsed),
    signals
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function appendJsonLine(filePath, payload) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`);
}

function proofLockPath(options) {
  if (!options?.marker) return null;
  return path.resolve(options.lockFile || path.join(options.outputDir, `${options.marker}.lock.json`));
}

function readProofLock(lockFile) {
  try {
    if (!lockFile || !fs.existsSync(lockFile)) return null;
    return JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch (err) {
    return { error: err.message, path: lockFile };
  }
}

function writeProofLock(lockFile, payload) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, `${JSON.stringify(payload, null, 2)}\n`);
}

function buildProofLock(options, role) {
  return {
    marker: options.marker,
    pid: process.pid,
    role,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    command: [process.execPath, __filename, ...process.argv.slice(2)].join(' '),
    evidenceLog: options.evidenceLog,
    finalFile: options.finalFile
  };
}

function isProofLockActive(lock, marker, now = Date.now()) {
  if (!lock || lock.error) return false;
  if (marker && lock.marker && lock.marker !== marker) return false;
  if (isPidRunning(lock.pid)) return true;
  const startedAt = Date.parse(lock.startedAt || '');
  if (lock.role === 'detached_parent' && Number.isFinite(startedAt) && now - startedAt < DETACHED_PARENT_LOCK_GRACE_MS) {
    return true;
  }
  return matchingProofScreens(marker).length > 0 || listProofProcesses(marker).length > 0;
}

function acquireProofLock(options, role, acquireOptions = {}) {
  const lockFile = proofLockPath(options);
  if (!lockFile) return { acquired: true, lockFile: null, lock: null };
  const nextLock = buildProofLock(options, role);
  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify(nextLock, null, 2)}\n`);
    fs.closeSync(fd);
    return { acquired: true, lockFile, lock: nextLock };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const existing = readProofLock(lockFile);
  const active = isProofLockActive(existing, options.marker);
  const canTakeoverParent = acquireOptions.takeoverDetachedParent === true
    && existing?.role === 'detached_parent'
    && existing.marker === options.marker;
  if (active && !canTakeoverParent && options.forceNew !== true) {
    return {
      acquired: false,
      lockFile,
      lock: existing,
      reason: 'proof_lock_active'
    };
  }
  writeProofLock(lockFile, nextLock);
  return {
    acquired: true,
    lockFile,
    lock: nextLock,
    replaced: existing || null
  };
}

function releaseProofLock(lockFile, lock = null, force = false) {
  if (!lockFile) return { released: false, reason: 'missing_lock_file' };
  const current = readProofLock(lockFile);
  if (!current) return { released: false, reason: 'missing_lock' };
  const ownsLock = force
    || current.pid === process.pid
    || (lock && current.pid === lock.pid && current.startedAt === lock.startedAt);
  if (!ownsLock) return { released: false, reason: 'lock_owned_by_other_process', current };
  try {
    fs.unlinkSync(lockFile);
    return { released: true };
  } catch (err) {
    return { released: false, reason: 'unlink_failed', error: err.message };
  }
}

function recordEvidence(options, evidence, payload) {
  const event = { at: new Date().toISOString(), ...payload };
  evidence.push(event);
  if (options.execute) appendJsonLine(options.evidenceLog, event);
  return event;
}

function compactProofLock(lock) {
  if (!lock) return null;
  return {
    marker: lock.marker || null,
    pid: Number.isFinite(Number(lock.pid)) ? Number(lock.pid) : null,
    role: lock.role || null,
    startedAt: lock.startedAt || null,
    error: lock.error || null
  };
}

function proofLockEvidencePayload(lockResult, role) {
  return {
    type: 'proof_lock_acquired',
    role,
    lockFile: lockResult?.lockFile || null,
    lock: compactProofLock(lockResult?.lock),
    replaced: Boolean(lockResult?.replaced),
    replacedLock: compactProofLock(lockResult?.replaced)
  };
}

function request(options, method, route, body = null, timeoutMs = 120000) {
  return new Promise(resolve => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      Accept: 'application/json',
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
    };
    const req = http.request({
      hostname: options.host,
      port: options.port,
      path: route,
      method,
      headers,
      timeout: timeoutMs,
      agent: false
    }, res => {
      let responseBody = '';
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => {
        let data = responseBody;
        try {
          data = responseBody ? JSON.parse(responseBody) : {};
        } catch {
          // Keep raw text for non-JSON responses.
        }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
      });
    });
    req.on('error', err => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: `${method} ${route} timed out` });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function isTransientGatewayFailure(response) {
  if (!response || response.ok) return false;
  const error = String(response.error || response.data?.error || response.data?.message || '');
  if (!response.status) return true;
  return /ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|socket hang up|timed out/i.test(error);
}

async function requestWithRetry(options, method, route, body = null, timeoutMs = 120000, evidence = null, context = 'gateway_request') {
  const requestFn = options.requestFn || request;
  const maxAttempts = Math.max(1, Number(options.gatewayRetryAttempts || 1));
  const delayMs = Math.max(0, Number(options.gatewayRetryDelayMs || 0));
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    last = await requestFn(options, method, route, body, timeoutMs);
    if (!isTransientGatewayFailure(last) || attempt >= maxAttempts) return last;
    recordEvidence(options, evidence || [], {
      type: 'gateway_transient_retry',
      context,
      method,
      route,
      attempt,
      maxAttempts,
      nextDelayMs: delayMs,
      status: last.status || null,
      error: last.error || last.data?.error || null
    });
    if (delayMs > 0) await sleep(delayMs);
  }
  return last;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildTask(marker, model) {
  return [
    marker,
    `Use ${model} for this TRAECNclaw unattended long-queue proof.`,
    'Do not create extra conversations or status-only queue-check tasks.',
    'Do not modify files. Do not run shell commands.',
    'When the request is ready, reply with exactly one final JSON object:',
    JSON.stringify({ token: marker, model, status: 'clean_long_queue_result' })
  ].join('\n');
}

function parseOptions() {
  const startedAt = Date.now();
  const status = hasFlag('--status');
  const cancel = hasFlag('--cancel');
  const resumeTaskId = readArg('--resume-task') || readArg('--task-id') || null;
  const marker = readArg('--marker') || ((status || cancel) ? null : `TRAECN_GLM52_CLEAN_${startedAt}`);
  const outputDir = path.resolve(readArg('--output-dir') || path.join(appSupportDir(), 'proofs'));
  const evidenceLog = marker ? path.resolve(readArg('--log') || path.join(outputDir, `${marker}.jsonl`)) : null;
  const finalFile = marker ? path.resolve(readArg('--final') || path.join(outputDir, `${marker}.final.json`)) : null;
  const stderrFile = marker ? path.resolve(readArg('--stderr') || path.join(outputDir, `${marker}.stderr.log`)) : null;
  const stdoutFile = marker ? path.resolve(readArg('--stdout') || `${finalFile}.stdout.log`) : null;
  const lockFile = marker ? path.resolve(readArg('--lock') || path.join(outputDir, `${marker}.lock.json`)) : null;
  return {
    host: readArg('--host', DEFAULT_HOST),
    port: readNumberArg('--port', DEFAULT_PORT),
    token: readArg('--token') || process.env.TRAECN_GATEWAY_TOKEN || '',
    model: readArg('--model', DEFAULT_MODEL),
    projectPath: readArg('--project') || process.cwd(),
    marker,
    status,
    cancel,
	    resumeTaskId,
	    execute: hasFlag('--execute'),
	    allowQuotaSpend: hasFlag(QUOTA_APPROVAL_FLAG) || truthyEnv('TRAECN_ALLOW_QUOTA_SPEND', 'TRAE_ALLOW_QUOTA_SPEND'),
	    detach: hasFlag('--detach'),
    child: hasFlag('--child'),
    forceNew: hasFlag('--force-new'),
    pollMs: Math.max(5000, readNumberArg('--poll-ms', DEFAULT_POLL_MS)),
    timeoutMs: readNumberArg('--timeout-ms', 0),
    cleanupIntervalMs: Math.max(30000, readNumberArg('--cleanup-interval-ms', DEFAULT_CLEANUP_INTERVAL_MS)),
    cleanupStabilizeChecks: Math.max(1, readNumberArg('--cleanup-stabilize-checks', 3)),
    cleanupStabilizeDelayMs: readNumberArg('--cleanup-stabilize-delay-ms', 1000),
    cleanupMaxAttempts: Math.max(1, readNumberArg('--cleanup-max-attempts', 10)),
    gatewayRetryAttempts: Math.max(1, readNumberArg('--gateway-retry-attempts', 12)),
    gatewayRetryDelayMs: readNumberArg('--gateway-retry-delay-ms', 5000),
    outputDir,
    evidenceLog,
    finalFile,
    stderrFile,
    stdoutFile,
    lockFile
  };
}

function extractTaskIdFromEvidence(finalReport, recentEvents) {
  if (finalReport?.taskId) return finalReport.taskId;
  if (finalReport?.result?.taskId) return finalReport.result.taskId;
  for (const event of recentEvents.slice().reverse()) {
    if (event.taskId) return event.taskId;
    if (event.data?.taskId) return event.data.taskId;
    if (event.data?.task?.taskId) return event.data.task.taskId;
  }
  return null;
}

function findProofScreens(sessions, marker = null) {
  return (Array.isArray(sessions) ? sessions : []).filter(line => {
    if (!String(line || '').includes('traecn_glm52_proof')) return false;
    return !marker || String(line).includes(marker);
  });
}

function matchingProofScreens(marker) {
  const screens = listScreens();
  return findProofScreens(screens.sessions, marker);
}

function quitScreenSession(line) {
  const match = String(line || '').match(/^(?:\d+\.)?(\S+)/);
  const session = match ? match[1] : null;
  if (!session) return { session: null, ok: false, error: 'unable_to_parse_screen_session' };
  const result = spawnSync('screen', ['-S', session, '-X', 'quit'], { encoding: 'utf8' });
  return {
    session,
    ok: result.status === 0,
    status: result.status,
    error: result.error ? result.error.message : (result.stderr || '').trim() || null
  };
}

function resolveStatusFiles(options) {
  if (options.marker) {
    return {
      marker: options.marker,
      evidenceLog: options.evidenceLog,
      finalFile: options.finalFile,
      stdoutFile: options.stdoutFile,
      stderrFile: options.stderrFile,
      lockFile: options.lockFile
    };
  }
  const newestArtifact = listProofArtifacts(options.outputDir)[0] || null;
  const base = newestArtifact?.marker || null;
  if (!base) {
    return { marker: null, evidenceLog: null, finalFile: null, stdoutFile: null, stderrFile: null, lockFile: null };
  }
  const finalFile = path.join(options.outputDir, `${base}.final.json`);
  return {
    marker: base,
    evidenceLog: path.join(options.outputDir, `${base}.jsonl`),
    finalFile,
    stdoutFile: `${finalFile}.stdout.log`,
    stderrFile: path.join(options.outputDir, `${base}.stderr.log`),
    lockFile: path.join(options.outputDir, `${base}.lock.json`)
  };
}

function statusReport(options) {
  const files = resolveStatusFiles(options);
  const finalReport = readJsonIfExists(files.finalFile);
  const allEvents = readJsonlEvents(files.evidenceLog);
  const recentEvents = readJsonlTail(files.evidenceLog, 12);
  const screens = listScreens();
  const taskId = extractTaskIdFromEvidence(finalReport, allEvents);
  const proofProcesses = listProofProcesses(files.marker);
  const lock = readProofLock(files.lockFile);
  const lockActive = isProofLockActive(lock, files.marker);
  const lockStatus = lock?.error ? 'lock_error' : lock ? (lockActive ? 'locked' : 'stale_lock') : 'missing';
  return {
    status: finalReport?.status || (recentEvents.length ? 'running_or_incomplete' : lockStatus),
    marker: files.marker,
    taskId,
    files,
    finalReport,
    recentEvents,
    eventCount: allEvents.length,
    screens: {
      sessions: screens.sessions.filter(line => !files.marker || line.includes(files.marker) || line.includes('traecn_glm52_proof')),
      cleanupWatcherRunning: screens.sessions.some(isCleanupWatcherScreen),
      raw: screens.text
    },
    lock: {
      file: files.lockFile,
      data: lock,
      active: lockActive
    },
    processes: {
      proofCount: proofProcesses.length,
      proofProcesses
    }
  };
}

function resolveExistingSubmission(options) {
  const report = statusReport(options);
  const finalStatus = String(report.finalReport?.status || '').toLowerCase();
  if (finalStatus === 'done') {
    return { action: 'return_final', taskId: report.taskId, statusReport: report, finalReport: report.finalReport };
  }
  if (!options.forceNew && report.taskId && !['cancel_requested', 'cancel_failed', 'cancelled'].includes(finalStatus)) {
    return { action: 'resume', taskId: report.taskId, statusReport: report };
  }
  return { action: 'submit', taskId: null, statusReport: report };
}

function requiresQuotaSpendApproval(options = {}, existing = null) {
  if (!options.execute) return false;
  if (options.allowQuotaSpend === true) return false;
  if (options.resumeTaskId) return false;
  return !existing || existing.action === 'submit';
}

function quotaApprovalRequiredReport(options = {}, existing = null, extra = {}) {
  return {
    status: 'quota_approval_required',
    marker: options.marker || null,
    model: options.model || DEFAULT_MODEL,
    execute: options.execute === true,
    allowQuotaSpend: options.allowQuotaSpend === true,
    existingAction: existing?.action || null,
    evidenceLog: options.evidenceLog || null,
    finalFile: options.finalFile || null,
    message: `Refusing to submit a new TraeCN proof task without explicit quota approval. Add ${QUOTA_APPROVAL_FLAG} only after the user approves real TraeCN quota usage, or use --resume-task to continue an existing task.`,
    quotaApprovalFlag: QUOTA_APPROVAL_FLAG,
    ...extra
  };
}

async function cancelProof(options) {
  const report = statusReport(options);
  const taskId = options.resumeTaskId || report.taskId;
  const events = [];
  let cancelResponse = null;
  if (taskId) {
    cancelResponse = await requestWithRetry(options, 'POST', `/api/task/${encodeURIComponent(taskId)}/cancel`, null, 120000, events, 'cancel_task');
    events.push({ at: new Date().toISOString(), type: 'cancel_task', taskId, status: cancelResponse.status || null, data: cancelResponse.data || null, error: cancelResponse.error || null });
  }
  const screenResults = matchingProofScreens(report.marker).map(quitScreenSession);
  const processResults = listProofProcesses(report.marker).map(processInfo => terminateProcessGroup(processInfo.pid, 5000));
  const lockResult = releaseProofLock(report.files.lockFile, null, true);
  events.push({ at: new Date().toISOString(), type: 'cancel_screens', screens: screenResults });
  events.push({ at: new Date().toISOString(), type: 'cancel_processes', processes: processResults });
  events.push({ at: new Date().toISOString(), type: 'cancel_lock', lock: lockResult });
  for (const event of events) appendJsonLine(report.files.evidenceLog, event);
  const cancelled = {
    status: taskId && cancelResponse && !cancelResponse.ok ? 'cancel_failed' : 'cancel_requested',
    marker: report.marker,
    taskId,
    cancelResponse,
    screenResults,
    processResults,
    lockResult,
    files: report.files,
    previousStatus: report
  };
  if (report.files.finalFile) {
    fs.mkdirSync(path.dirname(report.files.finalFile), { recursive: true });
    fs.writeFileSync(report.files.finalFile, `${JSON.stringify(cancelled, null, 2)}\n`);
  }
  return cancelled;
}

async function assertClean(options, evidence) {
  const requestFn = options.requestFn || request;
  const stabilizeChecks = options.execute ? Math.max(1, Number(options.cleanupStabilizeChecks || 3)) : 1;
  const stabilizeDelayMs = Math.max(0, Number(options.cleanupStabilizeDelayMs || 1000));
  const maxAttempts = Math.max(stabilizeChecks, Number(options.cleanupMaxAttempts || Math.max(10, stabilizeChecks * 3)));
  let cleanup = null;
  let cleanStreak = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    cleanup = await requestWithRetry({ ...options, requestFn }, 'POST', '/api/solo/chats/cleanup-foreign-queue', { dryRun: true }, 120000, evidence, 'cleanup_dry_run');
    const matched = cleanup.data?.matched || 0;
    const remainingMatched = cleanup.data?.remainingMatched || 0;
    if (matched === 0 && remainingMatched === 0) cleanStreak += 1;
    else cleanStreak = 0;
    recordEvidence(options, evidence, { type: 'cleanup_dry_run', attempt, cleanStreak, requiredCleanStreak: stabilizeChecks, status: cleanup.status || null, data: cleanup.data || null, error: cleanup.error || null });
    if (!cleanup.ok) {
      throw new Error(`cleanup dry-run failed: ${cleanup.error || cleanup.status}`);
    }
    if (cleanStreak >= stabilizeChecks) break;
    if (!options.execute) {
      throw new Error(`refusing to start proof while ${cleanup.data.matched} queue-probe Solo chat(s) remain`);
    }
    if (matched > 0 || remainingMatched > 0) {
      const cleanupExecute = await requestWithRetry({ ...options, requestFn }, 'POST', '/api/solo/chats/cleanup-foreign-queue', { execute: true, maxPasses: 20 }, 120000, evidence, 'cleanup_execute');
      recordEvidence(options, evidence, { type: 'cleanup_execute', attempt, status: cleanupExecute.status || null, data: cleanupExecute.data || null, error: cleanupExecute.error || null });
      if (!cleanupExecute.ok) {
        throw new Error(`cleanup execute failed: ${cleanupExecute.error || cleanupExecute.status}`);
      }
    }
    if (attempt < maxAttempts && stabilizeDelayMs > 0) await sleep(stabilizeDelayMs);
  }
  if (cleanStreak < stabilizeChecks) {
    throw new Error(`cleanup did not stabilize after ${maxAttempts} attempt(s); clean streak ${cleanStreak}/${stabilizeChecks}`);
  }

  const queue = await requestWithRetry({ ...options, requestFn }, 'GET', '/api/queue/status', null, 120000, evidence, 'queue_status');
  recordEvidence(options, evidence, { type: 'queue_status', status: queue.status || null, data: queue.data || null, error: queue.error || null });
  if (!queue.ok) throw new Error(`queue status failed: ${queue.error || queue.status}`);
  if (Array.isArray(queue.data.tasks) && queue.data.tasks.length > 0) {
    throw new Error(`refusing to start proof while ${queue.data.tasks.length} local task(s) are active`);
  }

  const preflight = await requestWithRetry({ ...options, requestFn }, 'POST', '/api/preflight', {}, 120000, evidence, 'preflight');
  recordEvidence(options, evidence, { type: 'preflight', status: preflight.status || null, data: preflight.data || null, error: preflight.error || null });
  if (!preflight.ok || preflight.data.ready !== true) {
    throw new Error(`preflight is not ready: ${preflight.error || preflight.data?.readiness?.reason || preflight.status}`);
  }

  return { cleanup: cleanup.data, queue: queue.data, preflight: preflight.data };
}

async function cleanupIfNeeded(options, evidence) {
  const cleanup = await requestWithRetry(options, 'POST', '/api/solo/chats/cleanup-foreign-queue', { dryRun: true }, 120000, evidence, 'wait_cleanup_dry_run');
  recordEvidence(options, evidence, { type: 'wait_cleanup_dry_run', status: cleanup.status || null, data: cleanup.data || null, error: cleanup.error || null });
  if (cleanup.ok && (cleanup.data.matched || 0) > 0) {
    const execute = await requestWithRetry(options, 'POST', '/api/solo/chats/cleanup-foreign-queue', { execute: true, maxPasses: 10 }, 120000, evidence, 'wait_cleanup_execute');
    recordEvidence(options, evidence, { type: 'wait_cleanup_execute', status: execute.status || null, data: execute.data || null, error: execute.error || null });
  }
}

async function submitProof(options, evidence) {
  const switchModel = await requestWithRetry(options, 'POST', '/api/switch-model', {
    model: options.model,
    waitForQueue: false
  }, 120000, evidence, 'switch_model');
  recordEvidence(options, evidence, { type: 'switch_model', status: switchModel.status || null, data: switchModel.data || null, error: switchModel.error || null });
  if (!switchModel.ok || switchModel.data.success !== true) {
    throw new Error(`model switch failed: ${switchModel.error || switchModel.data?.error || switchModel.status}`);
  }

  const task = buildTask(options.marker, options.model);
  const submit = await requestWithRetry(options, 'POST', '/api/delegate-async', {
    task,
    projectPath: options.projectPath,
    background: true,
    forceBackground: true,
    includeProcessText: true,
    waitForQueue: true,
    newChat: true,
    maxQueueWaitMs: options.timeoutMs > 0 ? options.timeoutMs : undefined,
    completionChecks: { textIncludes: [options.marker, 'clean_long_queue_result'] }
  }, 120000, evidence, 'submit');
  recordEvidence(options, evidence, { type: 'submit', status: submit.status || null, data: submit.data || null, error: submit.error || null });
  if (![200, 202].includes(submit.status)) {
    throw new Error(`proof submit failed: ${submit.error || submit.data?.error || submit.status}`);
  }
  const taskId = submit.data.taskId;
  if (!taskId && submit.data.status !== 'done') {
    throw new Error('proof submit did not return a taskId');
  }
  return { taskId, submit: submit.data };
}

async function waitForProof(options, taskId, evidence) {
  if (!taskId) return null;
  const startedAt = Date.now();
  let lastCleanupAt = 0;
  let attempts = 0;
  while (true) {
    attempts += 1;
    const now = Date.now();
    if (now - lastCleanupAt >= options.cleanupIntervalMs) {
      await cleanupIfNeeded(options, evidence);
      lastCleanupAt = now;
    }
    const status = await requestWithRetry(options, 'GET', `/api/task/${encodeURIComponent(taskId)}`, null, 120000, evidence, 'task_status');
    const data = status.data || {};
    recordEvidence(options, evidence, { type: 'task_status', taskId, status: status.status || null, data, error: status.error || null });
    const taskStatus = status.status === 404 ? 'not_found' : String(data.status || 'unknown').toLowerCase();
    if (TERMINAL_STATUSES.has(taskStatus)) {
      return { ...data, wait: { attempts, elapsedMs: Date.now() - startedAt } };
    }
    if (options.timeoutMs > 0 && Date.now() - startedAt >= options.timeoutMs) {
      return { taskId, status: 'wait_timeout', wait: { attempts, elapsedMs: Date.now() - startedAt, timedOut: true }, lastStatus: data };
    }
    await sleep(options.pollMs);
  }
}

function startDetached(options) {
  const lock = acquireProofLock(options, 'detached_parent');
  if (!lock.acquired) {
    return {
      detached: false,
      alreadyRunning: true,
      marker: options.marker,
      lockFile: lock.lockFile,
      lock: lock.lock,
      reason: lock.reason,
      message: 'A long-queue proof is already locked for this marker; use --status to inspect it or --force-new to intentionally start another.'
    };
  }
  const existingScreens = matchingProofScreens(options.marker);
  const existingProcesses = listProofProcesses(options.marker);
  if ((existingScreens.length > 0 || existingProcesses.length > 0) && options.forceNew !== true) {
    releaseProofLock(lock.lockFile, lock.lock, true);
    return {
      detached: false,
      alreadyRunning: true,
      marker: options.marker,
      sessions: existingScreens,
      processes: existingProcesses,
      message: 'A detached long-queue proof is already running for this marker; use --status to inspect it or --force-new to intentionally start another.'
    };
  }
  appendJsonLine(options.evidenceLog, { at: new Date().toISOString(), ...proofLockEvidencePayload(lock, 'detached_parent') });
  for (const filePath of [options.evidenceLog, options.finalFile, options.stderrFile, options.stdoutFile]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const args = process.argv.slice(2).filter(arg => arg !== '--detach');
	  if (!args.includes('--child')) args.push('--child');
	  if (!args.includes('--execute')) args.push('--execute');
	  if (options.allowQuotaSpend && !args.includes(QUOTA_APPROVAL_FLAG)) args.push(QUOTA_APPROVAL_FLAG);
	  const command = `cd ${shellQuote(process.cwd())} && ${shellQuote(process.execPath)} ${shellQuote(__filename)} ${args.map(shellQuote).join(' ')} > ${shellQuote(options.stdoutFile)} 2> ${shellQuote(options.stderrFile)}`;
  const sessionName = `traecn_glm52_proof_${options.marker}`.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
  const started = spawnSync('screen', ['-dmS', sessionName, '/bin/zsh', '-lc', command], { encoding: 'utf8' });
  if (started.error || started.status !== 0) {
    releaseProofLock(lock.lockFile, lock.lock, true);
    throw new Error(`detach failed: ${started.error ? started.error.message : started.stderr || started.status}`);
  }
  return { detached: true, sessionName, lockFile: lock.lockFile, evidenceLog: options.evidenceLog, finalFile: options.finalFile, stdoutFile: options.stdoutFile, stderrFile: options.stderrFile };
}

async function main() {
  const options = parseOptions();
  const evidence = [];
  if (options.status) {
    console.log(JSON.stringify(statusReport(options), null, 2));
    return;
  }
  if (options.cancel) {
    console.log(JSON.stringify(await cancelProof(options), null, 2));
    return;
  }
  const task = buildTask(options.marker, options.model);
  if (!options.execute) {
    const readiness = await assertClean(options, evidence);
    console.log(JSON.stringify({
      status: 'dry_run',
      executeRequired: true,
      marker: options.marker,
      model: options.model,
      projectPath: options.projectPath,
      evidenceLog: options.evidenceLog,
      finalFile: options.finalFile,
      stdoutFile: options.stdoutFile,
      stderrFile: options.stderrFile,
      readiness: {
        cleanupMatched: readiness.cleanup.matched || 0,
        localTasks: Array.isArray(readiness.queue.tasks) ? readiness.queue.tasks.length : null,
        ready: readiness.preflight.ready === true
      },
      taskPreview: task.slice(0, 240),
      quotaSpendRequired: true,
      quotaApprovalFlag: QUOTA_APPROVAL_FLAG,
      nextCommand: `node scripts/long-queue-proof.js --execute --detach ${QUOTA_APPROVAL_FLAG} --marker ${options.marker} --model ${shellQuote(options.model)}`,
      quotaApprovalCommand: `node scripts/long-queue-proof.js --execute --detach ${QUOTA_APPROVAL_FLAG} --marker ${options.marker} --model ${shellQuote(options.model)}`
    }, null, 2));
    return;
  }

	  if (options.detach && !options.child) {
	    const existing = options.resumeTaskId ? { action: 'resume', taskId: options.resumeTaskId } : resolveExistingSubmission(options);
	    if (requiresQuotaSpendApproval(options, existing)) {
	      console.log(JSON.stringify(quotaApprovalRequiredReport(options, existing, { detached: false }), null, 2));
	      process.exitCode = 1;
	      return;
	    }
	    console.log(JSON.stringify(startDetached(options), null, 2));
	    return;
	  }

  try {
    fs.mkdirSync(options.outputDir, { recursive: true });
    const lock = acquireProofLock(options, options.child ? 'child' : 'foreground', { takeoverDetachedParent: options.child });
    if (!lock.acquired) {
      const report = {
        status: 'already_running',
        marker: options.marker,
        model: options.model,
        lockFile: lock.lockFile,
        lock: lock.lock,
        evidenceLog: options.evidenceLog,
        stdoutFile: options.stdoutFile,
        stderrFile: options.stderrFile
      };
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = 1;
      return;
    }
    recordEvidence(options, evidence, proofLockEvidencePayload(lock, options.child ? 'child' : 'foreground'));
	    await assertClean(options, evidence);
	    const existing = options.resumeTaskId ? null : resolveExistingSubmission(options);
	    if (requiresQuotaSpendApproval(options, existing)) {
	      recordEvidence(options, evidence, { type: 'quota_approval_required', allowQuotaSpend: false, existingAction: existing?.action || null });
	      const report = quotaApprovalRequiredReport(options, existing);
	      fs.writeFileSync(options.finalFile, `${JSON.stringify(report, null, 2)}\n`);
	      console.log(JSON.stringify(report, null, 2));
	      releaseProofLock(lock.lockFile, lock.lock);
	      process.exitCode = 1;
	      return;
	    }
	    if (existing?.action === 'return_final') {
      recordEvidence(options, evidence, { type: 'proof_already_done', taskId: existing.taskId });
      console.log(JSON.stringify(existing.finalReport, null, 2));
      releaseProofLock(lock.lockFile, lock.lock);
      return;
    }
    const submitted = options.resumeTaskId
      ? { taskId: options.resumeTaskId, submit: { status: 'resumed', taskId: options.resumeTaskId } }
      : existing?.action === 'resume'
        ? { taskId: existing.taskId, submit: { status: 'resumed_existing', taskId: existing.taskId } }
        : await submitProof(options, evidence);
    if (options.resumeTaskId) {
      recordEvidence(options, evidence, { type: 'resume_task', taskId: options.resumeTaskId });
    } else if (existing?.action === 'resume') {
      recordEvidence(options, evidence, { type: 'resume_existing_task', taskId: existing.taskId, eventCount: existing.statusReport.eventCount || 0 });
    }
    const result = submitted.taskId ? await waitForProof(options, submitted.taskId, evidence) : submitted.submit;
    await cleanupIfNeeded(options, evidence);
    const report = {
      status: result?.status || submitted.submit.status || 'unknown',
      marker: options.marker,
      model: options.model,
      taskId: submitted.taskId || null,
      evidenceLog: options.evidenceLog,
      stdoutFile: options.stdoutFile,
      stderrFile: options.stderrFile,
      result
    };
    fs.writeFileSync(options.finalFile, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    releaseProofLock(lock.lockFile, lock.lock);
    if (String(report.status).toLowerCase() !== 'done') process.exitCode = 1;
  } catch (err) {
    const report = { status: 'error', marker: options.marker, model: options.model, error: err.message, evidenceLog: options.evidenceLog, stdoutFile: options.stdoutFile, stderrFile: options.stderrFile };
    fs.writeFileSync(options.finalFile, `${JSON.stringify(report, null, 2)}\n`);
    console.error(JSON.stringify(report, null, 2));
    const lockFile = proofLockPath(options);
    const lock = readProofLock(lockFile);
    if (lock?.pid === process.pid) releaseProofLock(lockFile, lock);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    appSupportDir,
    assertClean,
    buildTask,
    cancelProof,
    acquireProofLock,
    compactProofLock,
    extractTaskIdFromEvidence,
    findProofScreens,
    isProofLockActive,
    isPidRunning,
    isProofProcessCommand,
    listFiles,
    listProofArtifacts,
    listProofProcesses,
    isCleanupWatcherScreen,
    parseOptions,
    proofLockPath,
    proofLockEvidencePayload,
    readJsonIfExists,
    readJsonlEvents,
    readJsonlTail,
    readProofLock,
	    releaseProofLock,
	    quotaApprovalRequiredReport,
	    requestWithRetry,
	    requiresQuotaSpendApproval,
    resolveExistingSubmission,
    resolveStatusFiles,
    statusReport,
    terminateProcessGroup
  };
}
