'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const {
  appSupportDir,
  statusReport: proofStatusReport,
  listProofArtifacts
} = require('./long-queue-proof');
const {
  describeCleanupWatchStatus,
  defaultCleanupWatchLockFile
} = require('./traecn-cli');

const DEFAULT_HOST = process.env.TRAECN_GATEWAY_HOST || process.env.TRAECN_HOST || '127.0.0.1';
const DEFAULT_PORT = Number(process.env.TRAECN_GATEWAY_PORT || process.env.TRAECN_PORT || 8788);
const DEFAULT_GATEWAY_TIMEOUT_MS = 4000;
const STATUS_MARKER = 'TRAECN_GLM52_MEANINGFUL_STATUS_REPORT_1782000683181';
const REPORT_STATUS = 'meaningful_status_report_done';
const CLEAN_LONG_QUEUE_RESULT_TOKEN = 'clean_long_queue_result';

function hasFlag(name) {
  return process.argv.includes(name);
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
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveActiveQueuePath() {
  const configured = process.env.TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH
    || process.env.TRAE_ACTIVE_QUEUE_PERSISTENCE_PATH;
  if (configured) return path.resolve(configured);
  return path.join(appSupportDir(), 'active-queue.json');
}

function resolveProofDir() {
  return path.resolve(
    process.env.TRAECN_LONG_QUEUE_PROOF_DIR
    || path.join(appSupportDir(), 'proofs')
  );
}

function readJsonIfExists(filePath, fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return { error: err.message, path: filePath };
  }
}

function summarizeActiveQueue(activeQueuePath) {
  const data = readJsonIfExists(activeQueuePath, null);
  if (!data) {
    return { path: activeQueuePath, present: false, taskCount: 0, tasks: [] };
  }
  if (data.error) {
    return { path: activeQueuePath, present: true, error: data.error, taskCount: 0, tasks: [] };
  }
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  return {
    path: activeQueuePath,
    present: true,
    savedAt: data.savedAt || null,
    version: data.version || null,
    taskCount: tasks.length,
    tasks: tasks.map(task => ({
      taskId: task.taskId || null,
      status: task.status || null,
      createdAt: task.createdAt || null,
      model: task.model || null
    }))
  };
}

function summarizeCleanupWatcher(lockFile) {
  try {
    const status = describeCleanupWatchStatus({ lockFile });
    return {
      lockFile: status.lockFile,
      running: status.running,
      stale: status.stale,
      pid: status.pid || null,
      watcherCount: status.watcherCount,
      orphanCount: Array.isArray(status.orphanProcesses) ? status.orphanProcesses.length : 0,
      message: status.message
    };
  } catch (err) {
    return {
      lockFile,
      running: false,
      stale: false,
      pid: null,
      watcherCount: 0,
      orphanCount: 0,
      message: `cleanup watcher status unavailable: ${err.message}`,
      error: err.message
    };
  }
}

function summarizeLongQueueProof(proofDir) {
  const artifacts = listProofArtifacts(proofDir);
  if (!artifacts.length) {
    return {
      proofDir,
      present: false,
      artifactCount: 0,
      newest: null,
      status: null,
      marker: null,
      taskId: null,
      lockActive: false,
      eventCount: 0,
      cleanLongQueueResultSeen: false
    };
  }
  const newest = artifacts[0];
  let report;
  try {
    report = proofStatusReport({ marker: null, outputDir: proofDir });
  } catch (err) {
    return {
      proofDir,
      present: true,
      artifactCount: artifacts.length,
      newest: {
        marker: newest.marker,
        type: newest.type,
        file: newest.file,
        mtimeMs: newest.mtimeMs
      },
      status: 'error',
      marker: newest.marker,
      taskId: null,
      lockActive: false,
      eventCount: 0,
      cleanLongQueueResultSeen: false,
      error: err.message
    };
  }
  const finalReportJson = report.finalReport ? JSON.stringify(report.finalReport) : '';
  const cleanLongQueueResultSeen = finalReportJson.includes(CLEAN_LONG_QUEUE_RESULT_TOKEN);
  return {
    proofDir,
    present: true,
    artifactCount: artifacts.length,
    newest: {
      marker: newest.marker,
      type: newest.type,
      file: newest.file,
      mtimeMs: newest.mtimeMs
    },
    status: report.status,
    marker: report.marker,
    taskId: report.taskId || null,
    lockActive: report.lock ? report.lock.active === true : false,
    eventCount: report.eventCount || 0,
    cleanLongQueueResultSeen
  };
}

function gatewayRequest(options, method, route, body = null, timeoutMs = DEFAULT_GATEWAY_TIMEOUT_MS) {
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

async function probeGateway(options) {
  const startedAt = Date.now();
  const preflight = await gatewayRequest(
    options,
    'POST',
    '/api/preflight',
    {},
    DEFAULT_GATEWAY_TIMEOUT_MS
  );
  const elapsedMs = Date.now() - startedAt;
  if (!preflight.ok) {
    return {
      reachable: false,
      host: options.host,
      port: options.port,
      elapsedMs,
      status: preflight.status || null,
      error: preflight.error || `unexpected status ${preflight.status}`
    };
  }
  return {
    reachable: true,
    host: options.host,
    port: options.port,
    elapsedMs,
    status: preflight.status,
    ready: preflight.data?.ready === true,
    readiness: preflight.data?.readiness || null,
    queue: preflight.data?.queue || null
  };
}

async function collectReport(options = {}) {
  const activeQueuePath = options.activeQueuePath || resolveActiveQueuePath();
  const proofDir = options.proofDir || resolveProofDir();
  const cleanupLockFile = options.cleanupLockFile || defaultCleanupWatchLockFile();
  const gatewayOptions = {
    host: options.host || DEFAULT_HOST,
    port: options.port || DEFAULT_PORT,
    token: options.token || ''
  };
  const generatedAt = new Date().toISOString();
  const activeQueue = summarizeActiveQueue(activeQueuePath);
  const cleanupWatcher = summarizeCleanupWatcher(cleanupLockFile);
  const longQueueProof = summarizeLongQueueProof(proofDir);
  let gateway = null;
  if (options.skipGateway !== true) {
    if (typeof options.gatewayProbeFn === 'function') {
      gateway = await options.gatewayProbeFn(gatewayOptions);
    } else {
      gateway = await probeGateway(gatewayOptions);
    }
  }
  return {
    status: REPORT_STATUS,
    marker: STATUS_MARKER,
    generatedAt,
    activeQueue,
    cleanupWatcher,
    longQueueProof,
    gateway
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Unattended Status Report');
  lines.push('');
  lines.push(`- Generated: ${report.generatedAt}`);
  if (report.marker) lines.push(`- Marker: ${report.marker}`);
  if (report.status) lines.push(`- Status: ${report.status}`);
  lines.push('');

  lines.push('## Active Queue');
  const aq = report.activeQueue;
  if (!aq.present) {
    lines.push(`- Status: not present`);
    lines.push(`- Path: ${aq.path}`);
  } else {
    lines.push(`- Path: ${aq.path}`);
    lines.push(`- Saved at: ${aq.savedAt || 'unknown'}`);
    lines.push(`- Tasks: ${aq.taskCount}`);
    if (aq.error) lines.push(`- Error: ${aq.error}`);
    if (Array.isArray(aq.tasks) && aq.tasks.length) {
      lines.push('');
      lines.push('| Task ID | Status | Created |');
      lines.push('| --- | --- | --- |');
      for (const task of aq.tasks) {
        lines.push(`| ${task.taskId || 'n/a'} | ${task.status || 'n/a'} | ${task.createdAt || 'n/a'} |`);
      }
    }
  }
  lines.push('');

  lines.push('## Cleanup Watcher');
  const cw = report.cleanupWatcher;
  lines.push(`- Lock file: ${cw.lockFile}`);
  lines.push(`- Running: ${cw.running}`);
  lines.push(`- Stale: ${cw.stale}`);
  lines.push(`- PID: ${cw.pid || 'n/a'}`);
  lines.push(`- Watcher count: ${cw.watcherCount}`);
  lines.push(`- Orphan count: ${cw.orphanCount}`);
  lines.push(`- Message: ${cw.message}`);
  if (cw.error) lines.push(`- Error: ${cw.error}`);
  lines.push('');

  lines.push('## Long Queue Proof');
  const lp = report.longQueueProof;
  if (!lp.present) {
    lines.push(`- Status: not present`);
    lines.push(`- Proof dir: ${lp.proofDir}`);
  } else {
    lines.push(`- Proof dir: ${lp.proofDir}`);
    lines.push(`- Artifact count: ${lp.artifactCount}`);
    lines.push(`- Newest marker: ${lp.newest ? lp.newest.marker : 'n/a'}`);
    lines.push(`- Newest type: ${lp.newest ? lp.newest.type : 'n/a'}`);
    lines.push(`- Status: ${lp.status}`);
    lines.push(`- Task ID: ${lp.taskId || 'n/a'}`);
    lines.push(`- Lock active: ${lp.lockActive}`);
    lines.push(`- Event count: ${lp.eventCount}`);
    lines.push(`- Clean long queue result seen: ${lp.cleanLongQueueResultSeen}`);
    if (lp.error) lines.push(`- Error: ${lp.error}`);
  }
  lines.push('');

  lines.push('## Gateway');
  if (!report.gateway) {
    lines.push('- Skipped');
  } else if (!report.gateway.reachable) {
    lines.push(`- Reachable: false`);
    lines.push(`- Host: ${report.gateway.host}:${report.gateway.port}`);
    lines.push(`- Status: ${report.gateway.status || 'n/a'}`);
    lines.push(`- Error: ${report.gateway.error}`);
  } else {
    lines.push(`- Reachable: true`);
    lines.push(`- Host: ${report.gateway.host}:${report.gateway.port}`);
    lines.push(`- Status: ${report.gateway.status}`);
    lines.push(`- Ready: ${report.gateway.ready}`);
    if (report.gateway.queue) lines.push(`- Queue: ${JSON.stringify(report.gateway.queue)}`);
  }
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const markdown = hasFlag('--markdown');
  const json = hasFlag('--json');
  if (markdown && json) {
    console.error('Error: --markdown and --json are mutually exclusive');
    process.exitCode = 1;
    return;
  }
  const options = {
    host: readArg('--host', DEFAULT_HOST),
    port: readNumberArg('--port', DEFAULT_PORT),
    token: readArg('--token', process.env.TRAECN_GATEWAY_TOKEN || ''),
    activeQueuePath: readArg('--active-queue-path', null),
    proofDir: readArg('--proof-dir', null),
    cleanupLockFile: readArg('--cleanup-lock-file', null),
    skipGateway: hasFlag('--no-gateway')
  };
  const report = await collectReport(options);
  if (markdown) {
    console.log(renderMarkdown(report));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

module.exports = {
  CLEAN_LONG_QUEUE_RESULT_TOKEN,
  DEFAULT_GATEWAY_TIMEOUT_MS,
  REPORT_STATUS,
  STATUS_MARKER,
  collectReport,
  gatewayRequest,
  probeGateway,
  readJsonIfExists,
  renderMarkdown,
  resolveActiveQueuePath,
  resolveProofDir,
  summarizeActiveQueue,
  summarizeCleanupWatcher,
  summarizeLongQueueProof
};

if (require.main === module) {
  main();
}
