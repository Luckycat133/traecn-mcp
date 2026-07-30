'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { generateOpenAPISpec } = require('../src/http/openapi');
const { buildCapabilities } = require('../src/capabilities');
const { listCommands } = require('../src/client/command-set');
const { MCP_TOOLS } = require('../mcp-server');
const openClawManifest = require('../integrations/openclaw-traecn-plugin/openclaw.plugin.json');
const packageJson = require('../package.json');
const { resolveGatewayHostPort, resolveGatewayToken } = require('./lib/cli-config');

const root = path.resolve(__dirname, '..');
const requireComplete = process.argv.includes('--require-complete');
const includeLive = !process.argv.includes('--no-live');
const { host, port } = resolveGatewayHostPort({ useCliArgs: true, useLegacyEnv: false });
const token = resolveGatewayToken();

function resolveAppSupportPath(fileName) {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'TRAECNclaw', fileName);
  }
  return path.join(os.homedir(), '.traecnclaw', fileName);
}

function configuredPath(primaryEnv, fallbackEnv, defaultFileName) {
  return process.env[primaryEnv] || process.env[fallbackEnv] || resolveAppSupportPath(defaultFileName);
}

function readJsonIfExists(filePath, fallback) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return { error: err.message, path: filePath };
  }
}

function readFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function listJsonFiles(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath)
      .filter(file => file.endsWith('.json'))
      .map(file => path.join(dirPath, file));
  } catch {
    return [];
  }
}

function readJsonlIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split(/\n+/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch (err) {
          return { parseError: err.message, line };
        }
      });
  } catch (err) {
    return [{ error: err.message, path: filePath }];
  }
}

function summarizeCleanupWatchLog(logFile) {
  const events = readJsonlIfExists(logFile).filter(event => event && typeof event === 'object' && !event.parseError);
  const transientIndexes = [];
  events.forEach((event, index) => {
    if (event.transient === true || event.status === 0) transientIndexes.push(index);
  });
  const lastTransientIndex = transientIndexes.length ? transientIndexes[transientIndexes.length - 1] : -1;
  const recoveredAfterTransient = lastTransientIndex >= 0
    ? events.slice(lastTransientIndex + 1).some(event => event.status === 200 && event.matched === 0)
    : false;
  return {
    logFile: logFile || null,
    eventCount: events.length,
    transientErrors: transientIndexes.length,
    lastTransientAt: lastTransientIndex >= 0 ? events[lastTransientIndex].at || null : null,
    recoveredAfterTransient
  };
}

function hasAll(haystack, needles) {
  return needles.every(needle => haystack.includes(needle));
}

function packageJsonScript(name) {
  return packageJson.scripts && packageJson.scripts[name];
}

function listCleanupWatcherProcesses() {
  const result = spawnSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' });
  if (result.error) return { error: result.error.message, processes: [] };
  const processes = String(result.stdout || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => /scripts\/traecn-cli\.js cleanup-queue/.test(line) && /--watch-ms/.test(line))
    .map(line => {
      const match = line.match(/^(\d+)\s+(.*)$/);
      return match ? { pid: Number(match[1]), command: match[2] } : { pid: null, command: line };
    });
  return { processes };
}

function request(method, route, body = null, timeoutMs = 8000) {
  return new Promise(resolve => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      Accept: 'application/json',
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
    const req = http.request({
      hostname: host,
      port,
      path: route,
      method,
      headers,
      timeout: timeoutMs,
      agent: false
    }, res => {
      let responseBody = '';
      res.on('data', chunk => responseBody += chunk);
      res.on('end', () => {
        let data = responseBody;
        try {
          data = responseBody ? JSON.parse(responseBody) : {};
        } catch {
          // Keep the raw response body when the gateway returns non-JSON text.
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

function taskText(task) {
  return JSON.stringify(task || {});
}

function normalizeTasks(history) {
  if (!history || history.error) return [];
  if (Array.isArray(history.tasks)) return history.tasks;
  return Object.values(history.tasks || {});
}

function hasOwnedResult(task) {
  const text = taskText(task.result || task);
  const taskBody = String(task.task || '');
  const tokenMatch = taskBody.match(/\bTRAECN_[A-Z0-9_]+_\d+\b/);
  if (!tokenMatch) return Boolean(task.result || task.hasResult);
  return text.includes(tokenMatch[0]);
}

function hasQueueLifecycle(task) {
  const text = taskText(task);
  return /queueState|queuePosition|queueMessage|queued|submitted to Solo chat|adopted existing Trae request|排队|GLM-5\.2/i.test(text);
}

function proofEvidenceSummary(report) {
  const events = readJsonlIfExists(report.evidenceLog);
  const text = taskText(events);
  const hasEvent = type => events.some(event => event.type === type);
  const cleanupEvents = events.filter(event => /cleanup/.test(String(event.type || '')));
  const cleanCleanup = cleanupEvents.some(event => (event.data?.matched || 0) === 0 && (event.data?.remainingMatched || 0) === 0);
  const taskStatusEvents = events.filter(event => event.type === 'task_status');
  const doneTaskStatus = taskStatusEvents.some(event => String(event.data?.status || '').toLowerCase() === 'done');
  const submittedTaskId = events.find(event => event.type === 'submit')?.data?.taskId || null;
  const queueLifecycle = /queueState|queuePosition|queueMessage|queued|排队|GLM-5\.2/i.test(text);
  const parseErrors = events.filter(event => event.parseError || event.error).length;
  return {
    eventCount: events.length,
    parseErrors,
    hasCleanup: cleanupEvents.length > 0,
    cleanCleanup,
    hasPreflight: hasEvent('preflight'),
    hasSwitchModel: hasEvent('switch_model'),
    hasSubmit: hasEvent('submit'),
    submittedTaskId,
    hasTaskStatus: taskStatusEvents.length > 0,
    doneTaskStatus,
    queueLifecycle
  };
}

function hasForeignQueueProbeContamination(task) {
  return /Wait for Trae Queue|wait for Trae queue/i.test(taskText(task));
}

function hasForeignQueueProbeFinalResult(task) {
  return /Wait for Trae Queue|wait for Trae queue/i.test(taskText(task?.result || {}));
}

function hasCompletionCheckPassedResult(task) {
  return task?.result?.completionChecksPassed === true
    && String(task?.result?.text || '').includes('completion checks passed');
}

function isGlm52Task(task) {
  return /GLM-?5\.2/i.test(taskText(task));
}

function normalizeProofReports(proofsDir) {
  return listJsonFiles(proofsDir)
    .map(filePath => {
      const report = readJsonIfExists(filePath, null);
      if (!report || report.error) return null;
      return { ...report, path: filePath };
    })
    .filter(Boolean);
}

function scoreProofReports(proofReports) {
  const clean = proofReports.filter(report => {
    const text = taskText(report);
    const evidence = proofEvidenceSummary(report);
    return report.status === 'done'
      && /GLM-?5\.2/i.test(text)
      && typeof report.marker === 'string'
      && typeof report.taskId === 'string'
      && text.includes(report.marker)
      && text.includes('clean_long_queue_result')
      && evidence.parseErrors === 0
      && evidence.cleanCleanup
      && evidence.hasPreflight
      && evidence.hasSwitchModel
      && evidence.hasSubmit
      && evidence.submittedTaskId === report.taskId
      && evidence.doneTaskStatus
      && evidence.queueLifecycle
      && !hasForeignQueueProbeContamination(report);
  });
  if (clean.length === 0) return null;
  return {
    status: 'passed',
    summary: 'Found a completed dedicated GLM-5.2 long-queue proof with owned marker and no queue-probe contamination.',
    evidence: clean.slice(-3).map(report => ({
      path: report.path,
      taskId: report.taskId || null,
      marker: report.marker,
      model: report.model,
      status: report.status,
      evidenceLog: report.evidenceLog || null,
      evidence: proofEvidenceSummary(report)
    }))
  };
}

function scoreRealLongQueue(historyTasks, proofReports = []) {
  const proofScore = scoreProofReports(proofReports);
  if (proofScore) return proofScore;
  const candidates = historyTasks.filter(task => {
    return isGlm52Task(task)
      && ['completed', 'done'].includes(String(task.status || '').toLowerCase())
      && Number(task.elapsedMs || 0) > 600000
      && hasQueueLifecycle(task);
  });
  const clean = candidates.filter(task => hasOwnedResult(task) && !hasForeignQueueProbeContamination(task));
  const recoveredClean = candidates.filter(task => hasOwnedResult(task)
    && hasCompletionCheckPassedResult(task)
    && !hasForeignQueueProbeFinalResult(task));
  const contaminated = candidates.filter(task => hasForeignQueueProbeContamination(task));
  if (clean.length > 0) {
    return {
      status: 'passed',
      summary: 'Found a completed long-running GLM-5.2 task with owned result and no queue-probe contamination.',
      evidence: clean.slice(-3).map(taskSummary)
    };
  }
  if (recoveredClean.length > 0) {
    return {
      status: 'passed',
      summary: 'Found a completed long-running GLM-5.2 task whose final recovered result is owned and clean after completion-check validation.',
      evidence: recoveredClean.slice(-3).map(taskSummary)
    };
  }
  if (candidates.length > 0 || contaminated.length > 0) {
    const byId = new Map();
    for (const task of candidates.concat(contaminated)) {
      byId.set(task.taskId || `${task.createdAt}:${task.task}`, task);
    }
    return {
      status: 'partial',
      summary: 'Historical long-running GLM-5.2 tasks exist, but current evidence is contaminated, lacks ownership proof, or is not enough to prove clean queue-drain result retrieval.',
      evidence: Array.from(byId.values()).slice(-5).map(taskSummary)
    };
  }
  return {
    status: 'missing',
    summary: 'No completed real long-queue GLM-5.2 task with queue lifecycle and owned result was found in task history.',
    evidence: []
  };
}

function taskSummary(task) {
  return {
    taskId: task.taskId,
    status: task.status,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    elapsedMs: task.elapsedMs || null,
    contaminated: hasForeignQueueProbeContamination(task),
    finalResultContaminated: hasForeignQueueProbeFinalResult(task),
    completionChecksPassed: task?.result?.completionChecksPassed === true,
    ownedResult: hasOwnedResult(task),
    task: String(task.task || '').slice(0, 180)
  };
}

function add(results, name, status, summary, evidence = {}) {
  results.push({ name, status, summary, evidence });
}

async function main() {
  const results = [];
  const spec = generateOpenAPISpec();
  const capabilities = buildCapabilities({ commands: listCommands(), mcpTools: MCP_TOOLS });
  const commandNames = listCommands().map(command => command.command);
  const openClawTools = openClawManifest.tools.map(tool => tool.name);
  const openClawCommandTool = openClawManifest.tools.find(tool => tool.name === 'traecn_command');
  const openClawCommandEnum = openClawCommandTool?.parameters?.properties?.command?.enum || [];
  const mcpToolNames = MCP_TOOLS.map(tool => tool.name);
  const gatewaySource = readFile('src/http/gateway.js');
  const queueProbeSource = readFile('src/shared/queue-probe.js');
  const httpHandlerSource = [
    readFile('src/http/handlers/delegate.js'),
    readFile('src/http/handlers/sessions.js'),
    readFile('src/http/handlers/solo-chat.js'),
    readFile('src/http/handlers/batch.js')
  ].join('\n');
  const gatewayTestSource = readFile('src/http/gateway.test.js');
  const domDriverSource = readFile('src/cdp/dom-driver.js');
  const soloChatHandlerSource = readFile('src/cdp/dom-handlers/solo-chat.js');
  const soloCleanupSource = `${domDriverSource}\n${soloChatHandlerSource}`;
  const domDriverTestSource = readFile('src/cdp/dom-driver.test.js');
  const liveUatSource = readFile('scripts/live-uat.js');
  const longQueueProofSource = readFile('scripts/long-queue-proof.js');
  const cliSource = readFile('scripts/traecn-cli.js');
  const mcpSource = [
    readFile('mcp-server.js'),
    readFile('src/mcp/tools.js'),
    readFile('src/mcp/handler.js')
  ].join('\n');
  const mcpTestSource = readFile('mcp-server.test.js');
  const skillSource = readFile('src/skill/traecn-skill.js');
  const skillTestSource = readFile('src/skill/skill.test.js');
  const commandSetSource = readFile('src/client/command-set.js');

  add(results, 'agent_surfaces', (
    capabilities.commands.some(command => command.command === 'delegate_async')
      && commandNames.includes('cleanup_foreign_solo_queue')
      && commandNames.includes('cleanup_queue_watch_status')
      && hasAll(mcpToolNames, ['traecn_submit', 'traecn_get_task', 'traecn_cancel_task', 'traecn_list_conversations', 'traecn_manage_conversation', 'traecn_resolve_interaction'])
      && mcpToolNames.length === 6
      && openClawTools.includes('traecn_cleanup_queue')
      && openClawTools.includes('traecn_cleanup_watch_status')
  ) ? 'passed' : 'missing', 'MCP exposes only the compact Agent contract while HTTP, CLI, and OpenClaw retain operator controls.', {
    commands: commandNames.length,
    mcpTools: mcpToolNames.length,
    openClawTools: openClawTools.length
  });

  add(results, 'queue_probe_guard', (
    httpHandlerSource.includes('generic_queue_probe_task_rejected')
      && queueProbeSource.includes('function isGenericQueueProbeTask')
      && queueProbeSource.includes('isForeignQueueProbeText')
      && queueProbeSource.includes('isQueueProbeStatusSuffix')
      && liveUatSource.includes('queue-probe-guard')
      && liveUatSource.includes('Wait for Trae Queue 进行中 17:34')
      && liveUatSource.includes('--cleanup-queue-probes')
  ) ? 'passed' : 'missing', 'Queue-probe prompts are guarded before Trae submission and live UAT checks the guard.', {
    liveUatCleanup: liveUatSource.includes('--cleanup-queue-probes'),
    statusTitleVariant: liveUatSource.includes('Wait for Trae Queue 进行中 17:34')
  });

  const titleBeforeIndex = soloCleanupSource.indexOf('candidate.title') >= 0
    && soloCleanupSource.indexOf('candidate.index') >= 0
    && soloCleanupSource.indexOf('candidate.title') < soloCleanupSource.indexOf('candidate.index');
  add(results, 'solo_cleanup_full_scan', (
    hasAll(soloCleanupSource, ['async function listSoloChats', 'findScrollHost', 'scrollTop', 'awaitPromise: true', "scanned: 'scroll'"])
      && hasAll(soloCleanupSource, ['async function _locateCandidateRow', 'candidate.title', 'candidate.text', 'candidate.index'])
      && titleBeforeIndex
      && hasAll(domDriverTestSource, [
        'deleteSoloChats re-queries sidebar to verify deletion by title',
        'deleteSoloChats does not treat menu text insertion as deletion success',
        'findScrollHost',
        'scrollTop',
        'candidate.title'
      ])
      && gatewayTestSource.includes('Gateway cleanup endpoint repeats passes for queue probes revealed after deletion')
  ) ? 'passed' : 'missing', 'Solo queue cleanup scans beyond the currently visible sidebar rows and verifies deletion by stable title/text matching.', {
    listScrollScan: soloCleanupSource.includes('findScrollHost') && soloCleanupSource.includes('scrollTop') && soloCleanupSource.includes("scanned: 'scroll'"),
    asyncRuntimeEvaluation: soloCleanupSource.includes('awaitPromise: true'),
    titleBeforeIndex,
    deleteVerificationRegression: domDriverTestSource.includes('deleteSoloChats does not treat menu text insertion as deletion success'),
    repeatedCleanupPasses: gatewayTestSource.includes('Gateway cleanup endpoint repeats passes for queue probes revealed after deletion')
  });

  add(results, 'settings_and_sessions', (
    spec.paths['/api/settings/read']
      && spec.paths['/api/settings/read-all']
      && spec.paths['/api/settings/set']
      && spec.paths['/api/sessions']
      && spec.paths['/api/sessions/{sessionId}/delegate']
  ) ? 'passed' : 'missing', 'Settings and logical session APIs are present in OpenAPI.', {
    settingsRead: Boolean(spec.paths['/api/settings/read']),
    sessions: Boolean(spec.paths['/api/sessions'])
  });

  add(results, 'app_settings_control_contract', (
    spec.paths['/api/settings/read']
      && spec.paths['/api/settings/read-all']
      && spec.paths['/api/settings/set']
      && spec.paths['/api/settings/switch-tab']
      && spec.paths['/api/settings/back-to-chat']
      && spec.paths['/api/detect-mode']
      && spec.paths['/api/switch-mode']
      && spec.paths['/api/switch-model']
      && spec.paths['/api/confirm/plan']
      && capabilities.coverage.settingsAutomation === true
      && capabilities.coverage.modelAndModeControl === true
      && capabilities.coverage.operationConfirmation === true
      && hasAll(capabilities.apiFamilies.settings || [], ['/api/settings/read', '/api/settings/read-all', '/api/settings/set', '/api/settings/switch-tab', '/api/settings/back-to-chat'])
      && hasAll(capabilities.apiFamilies.control || [], ['/api/detect-mode', '/api/switch-mode', '/api/switch-model'])
      && hasAll(commandNames, ['settings_read', 'settings_read_all', 'settings_set', 'settings_navigate', 'settings_back', 'switch_mode', 'switch_model', 'confirm_plan'])
      && MCP_TOOLS.find(tool => tool.name === 'traecn_submit')?.inputSchema?.properties?.model
      && MCP_TOOLS.find(tool => tool.name === 'traecn_submit')?.inputSchema?.properties?.mode
      && hasAll(openClawTools, ['traecn_plan_operation', 'traecn_settings_action', 'traecn_settings_read', 'traecn_settings_set', 'traecn_switch_mode', 'traecn_switch_model'])
      && hasAll(openClawCommandEnum, ['settings_read', 'settings_read_all', 'settings_set', 'settings_navigate', 'settings_back', 'switch_mode', 'switch_model'])
      && liveUatSource.includes('settings-read-model')
      && liveUatSource.includes('confirmation-gate')
      && gatewayTestSource.includes('buildConfirmationPlan marks settings writes as high-risk confirmation operations')
      && gatewayTestSource.includes('Gateway switch-model can return immediately with queue details when waitForQueue is false')
      && hasAll(readFile('src/client/traecnapi-client.test.js'), ['settingsRead sends GET with section param', 'settingsWrite can send confirmation metadata', 'settingsAction maps navigate to implemented settings switch-tab endpoint', 'switchModel sends POST to /api/switch-model'])
  ) ? 'passed' : 'missing', 'Settings and confirmation controls remain operator APIs; MCP folds model/mode selection into unified submission.', {
    settingsPaths: ['/api/settings/read', '/api/settings/read-all', '/api/settings/set', '/api/settings/switch-tab', '/api/settings/back-to-chat']
      .filter(apiPath => Boolean(spec.paths[apiPath])),
    controlPaths: ['/api/detect-mode', '/api/switch-mode', '/api/switch-model'].filter(apiPath => Boolean(spec.paths[apiPath])),
    mcpTools: mcpToolNames,
    openClawTools: openClawTools.filter(name => ['traecn_plan_operation', 'traecn_settings_action', 'traecn_settings_read', 'traecn_settings_set', 'traecn_switch_mode', 'traecn_switch_model'].includes(name)),
    liveSettingsRead: liveUatSource.includes('settings-read-model'),
    liveConfirmationGate: liveUatSource.includes('confirmation-gate')
  });

  add(results, 'solo_multi_conversation_support', (
    spec.paths['/api/solo/chats']
      && spec.paths['/api/solo/chats/switch']
      && spec.paths['/api/solo/chats/submit']
      && capabilities.http.some(operation => operation.path === '/api/solo/chats/submit')
  ) ? 'passed' : 'missing', 'Solo chat list, switch, submit, and targeting surfaces are exposed.', {
    submitAccepts: capabilities.http.find(operation => operation.path === '/api/solo/chats/submit')?.accepts || []
  });

  add(results, 'multi_session_result_isolation', (
    gatewaySource.includes('_appendSessionMessage')
      && gatewaySource.includes('sessionResultRecorded')
      && gatewaySource.includes('_resultBelongsToSubmittedTask')
      && gatewayTestSource.includes('keeps parallel queued session Solo results isolated when completion is out of order')
      && gatewayTestSource.includes('TRAECN_SESSION_A_001')
      && gatewayTestSource.includes('TRAECN_SESSION_B_001')
      && gatewayTestSource.includes('assert.strictEqual(sessionA.messages[1].taskId, taskA.taskId)')
      && gatewayTestSource.includes('assert.strictEqual(sessionB.messages[1].taskId, taskB.taskId)')
  ) ? 'passed' : 'missing', 'Queued logical sessions retain separate Solo targets and owned results even when multiple waits complete out of order.', {
    sessionResultRecorded: gatewaySource.includes('sessionResultRecorded'),
    ownershipGuard: gatewaySource.includes('_resultBelongsToSubmittedTask'),
    outOfOrderRegression: gatewayTestSource.includes('keeps parallel queued session Solo results isolated when completion is out of order')
  });

  add(results, 'unattended_wait_task_flow', (
    mcpToolNames.includes('traecn_get_task')
      && readFile('src/mcp/stdio-server.js').includes('TaskEventPump')
      && openClawTools.includes('traecn_delegate')
      && hasAll(readFile('scripts/traecn-cli.js'), ['wait-task', 'autoApproveDialog', 'finalFile'])
  ) ? 'passed' : 'missing', 'The MCP server pushes task events automatically and keeps one optional task lookup; CLI waiting remains operator-side.', {
    getTaskMcp: mcpToolNames.includes('traecn_get_task')
  });

  const asyncDelegateAccepts = capabilities.http.find(operation => operation.path === '/api/delegate-async' && operation.method === 'POST')?.accepts || [];
  add(results, 'unattended_vibe_workflow_contract', (
    commandNames.includes('vibe_workflow')
      && MCP_TOOLS.find(tool => tool.name === 'traecn_submit')?.inputSchema?.properties?.steps
      && openClawTools.includes('traecn_vibe_workflow')
      && hasAll(asyncDelegateAccepts, ['autoContinue', 'followupTasks', 'completionChecks', 'autoApproveDialog', 'forceBackground'])
      && hasAll(mcpSource, ["name: 'traecn_submit'", 'steps', 'completionChecks'])
      && hasAll(commandSetSource, ['case COMMANDS.VIBE_WORKFLOW', 'const autoContinue = params.autoContinue !== false', 'followupTasks', 'completionChecks', 'autoApproveDialog'])
      && hasAll(skillSource, ['async vibeWorkflow', 'const autoContinue = input.autoContinue !== false', 'autoApproveDialog: input.autoApproveDialog === undefined ? \'auto\'', 'followupTasks'])
      && hasAll(cliSource, ['case \'vibe\'', 'autoContinue: true', 'completionChecks', 'followupTasks'])
      && mcpTestSource.includes('MCP exposes one compact tool surface')
      && skillTestSource.includes('vibeWorkflow queues unattended follow-up workflow')
      && gatewayTestSource.includes('Gateway auto-continues reviewable workflow followups without human review')
      && gatewayTestSource.includes('Gateway resubmits completed-looking task when completion checks fail')
  ) ? 'passed' : 'missing', 'Unified MCP submission folds in unattended follow-ups while operator surfaces retain their detailed workflow controls.', {
    command: commandNames.includes('vibe_workflow'),
    mcpTool: mcpToolNames.includes('traecn_submit'),
    openClawTool: openClawTools.includes('traecn_vibe_workflow'),
    delegateAsyncAccepts: asyncDelegateAccepts.filter(name => ['autoContinue', 'followupTasks', 'completionChecks', 'autoApproveDialog', 'forceBackground'].includes(name)),
    skillRegression: skillTestSource.includes('vibeWorkflow queues unattended follow-up workflow'),
    gatewayAutoContinueRegression: gatewayTestSource.includes('Gateway auto-continues reviewable workflow followups without human review')
  });

  add(results, 'long_queue_proof_runner', (
    packageJsonScript('proof:long-queue') === 'node scripts/long-queue-proof.js'
      && hasAll(longQueueProofSource, ['--execute', '--allow-quota-spend', '--detach', 'cleanup-foreign-queue', 'clean_long_queue_result', 'GLM-5.2'])
      && hasAll(longQueueProofSource, ['alreadyRunning', 'findProofScreens', 'listProofProcesses', 'cancel_processes', 'process.execPath'])
      && hasAll(longQueueProofSource, ['acquireProofLock', 'proof_lock_active', 'detached_parent', 'cancel_lock'])
      && hasAll(longQueueProofSource, ['proof_lock_acquired', 'proofLockEvidencePayload', 'stale_lock', 'lock_error'])
      && hasAll(longQueueProofSource, ['requestWithRetry', 'gateway_transient_retry', '--gateway-retry-attempts', '--gateway-retry-delay-ms'])
	      && hasAll(commandNames, ['long_queue_proof_start', 'long_queue_proof_status', 'long_queue_proof_cancel'])
	      && hasAll(openClawTools, ['traecn_long_queue_proof_start', 'traecn_long_queue_proof_status', 'traecn_long_queue_proof_cancel'])
	      && listCommands().find(command => command.command === 'long_queue_proof_start')?.optional?.includes('allowQuotaSpend')
	      && openClawManifest.tools.find(tool => tool.name === 'traecn_long_queue_proof_start')?.parameters?.properties?.allowQuotaSpend
	      && hasAll(cliSource, ['proof status', 'buildProofCliArgs', 'long-queue-proof.js'])
  ) ? 'passed' : 'missing', 'A guarded long-queue proof runner remains an operator/test facility and is not exposed as an Agent MCP tool.', {
    script: packageJsonScript('proof:long-queue') || null,
	    commands: commandNames.filter(name => name.startsWith('long_queue_proof_')),
	    mcpTools: mcpToolNames,
	    openClawTools: openClawTools.filter(name => name.startsWith('traecn_long_queue_proof_')),
    cliProof: cliSource.includes('buildProofCliArgs'),
    duplicateProofGuard: longQueueProofSource.includes('alreadyRunning') && longQueueProofSource.includes('findProofScreens'),
    proofProcessGuard: longQueueProofSource.includes('listProofProcesses') && longQueueProofSource.includes('cancel_processes'),
    proofLockGuard: longQueueProofSource.includes('acquireProofLock') && longQueueProofSource.includes('proof_lock_active'),
    proofLockEvidence: longQueueProofSource.includes('proof_lock_acquired') && longQueueProofSource.includes('proofLockEvidencePayload'),
    staleLockStatus: longQueueProofSource.includes('stale_lock') && longQueueProofSource.includes('lock_error'),
    gatewayTransientRetry: longQueueProofSource.includes('requestWithRetry') && longQueueProofSource.includes('gateway_transient_retry'),
    quotaSpendGuard: longQueueProofSource.includes('--allow-quota-spend') && longQueueProofSource.includes('quota_approval_required')
  });

  const activeQueuePath = configuredPath('TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH', 'TRAE_ACTIVE_QUEUE_PERSISTENCE_PATH', 'active-queue.json');
  const activeQueue = readJsonIfExists(activeQueuePath, { tasks: [] });
  const activeTasks = Array.isArray(activeQueue.tasks) ? activeQueue.tasks : [];
  add(results, 'active_queue_clean', activeTasks.length === 0 ? 'passed' : 'partial', 'Local persisted active queue should be empty before claiming current readiness.', {
    path: activeQueuePath,
    taskCount: activeTasks.length,
    taskIds: activeTasks.map(task => task.taskId).filter(Boolean)
  });

  const cleanupLockPath = resolveAppSupportPath('cleanup-watch.lock');
  const cleanupLock = readJsonIfExists(cleanupLockPath, null);
  const cleanupWatchers = listCleanupWatcherProcesses();
  const hasCleanupOrphanDetection = cliSource.includes('orphanProcesses') && cliSource.includes('listCleanupWatcherProcesses');
  const hasCleanupTransientRecovery = cliSource.includes('runCleanupWatchAttempt') && cliSource.includes('transientErrors') && cliSource.includes('cleanup_request_failed');
  const cleanupWatchLog = summarizeCleanupWatchLog(cleanupLock && !cleanupLock.error ? cleanupLock.logFile : null);
  add(results, 'cleanup_watcher_singleton', cleanupWatchers.processes.length <= 1 && hasCleanupOrphanDetection && hasCleanupTransientRecovery ? 'passed' : 'partial', 'At most one local cleanup watcher should be running and it should survive transient gateway restarts without duplicating background work.', {
    lockPath: cleanupLockPath,
    lockPid: cleanupLock && !cleanupLock.error ? cleanupLock.pid || null : null,
    watcherCount: cleanupWatchers.processes.length,
    watcherPids: cleanupWatchers.processes.map(process => process.pid).filter(Boolean),
    cliOrphanDetection: hasCleanupOrphanDetection,
    transientRecovery: hasCleanupTransientRecovery,
    logTransientErrors: cleanupWatchLog.transientErrors,
    logRecoveredAfterTransient: cleanupWatchLog.recoveredAfterTransient,
    logLastTransientAt: cleanupWatchLog.lastTransientAt,
    error: cleanupWatchers.error || cleanupLock?.error || null
  });

  const historyPath = configuredPath('TRAECN_TASK_HISTORY_PERSISTENCE_PATH', 'TRAE_TASK_HISTORY_PERSISTENCE_PATH', 'task-history.json');
  const history = readJsonIfExists(historyPath, { tasks: [] });
  const historyTasks = normalizeTasks(history);
  const proofDir = process.env.TRAECN_LONG_QUEUE_PROOF_DIR || path.join(path.dirname(historyPath), 'proofs');
  const proofReports = normalizeProofReports(proofDir);
  const longQueueScore = scoreRealLongQueue(historyTasks, proofReports);
  add(results, 'real_long_queue_result_retrieval', longQueueScore.status, longQueueScore.summary, {
    path: historyPath,
    proofDir,
    proofReports: proofReports.length,
    totalTasks: historyTasks.length,
    candidates: longQueueScore.evidence
  });

  if (includeLive) {
    const preflight = await request('POST', '/api/preflight', {});
    add(results, 'live_preflight_ready', preflight.ok && preflight.data.ready === true ? 'passed' : 'missing', 'Live gateway preflight should be connected and ready.', {
      status: preflight.status || null,
      error: preflight.error || null,
      ready: preflight.data?.ready === true,
      queue: preflight.data?.queue || null
    });

    const cleanup = await request('POST', '/api/solo/chats/cleanup-foreign-queue', { dryRun: true });
    const matched = cleanup.data?.matched || 0;
    add(results, 'live_queue_probe_cleanup_clean', cleanup.ok && matched === 0 ? 'passed' : (cleanup.ok ? 'partial' : 'missing'), 'Live Solo queue-probe cleanup dry-run should find no accidental queue-probe chats.', {
      status: cleanup.status || null,
      error: cleanup.error || null,
      matched,
      total: cleanup.data?.total || null
    });
  }

  const counts = results.reduce((acc, result) => {
    acc[result.status] = (acc[result.status] || 0) + 1;
    return acc;
  }, {});
  const overall = counts.missing ? 'missing' : (counts.partial ? 'partial' : 'passed');
  const report = {
    status: overall,
    generatedAt: new Date().toISOString(),
    requireComplete,
    liveChecked: includeLive,
    counts,
    results
  };

  console.log(JSON.stringify(report, null, 2));
  if (requireComplete && overall !== 'passed') {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(JSON.stringify({ status: 'error', error: err.message }, null, 2));
    process.exitCode = 1;
  });
} else {
  module.exports = {
    hasForeignQueueProbeContamination,
    hasForeignQueueProbeFinalResult,
    proofEvidenceSummary,
    readJsonlIfExists,
    scoreProofReports,
    scoreRealLongQueue
  };
}
