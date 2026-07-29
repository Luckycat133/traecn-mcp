'use strict';

const packageInfo = require('../../package.json');

// shared/ is the lowest layer of the codebase. To keep the dependency direction
// strictly one-way (http/ and skill/ may depend on shared/, never the reverse),
// the modules that source capability data are NOT required here at module load.
// Instead they are injected by callers through `deps`. Every external caller that
// cannot or does not inject (scripts, the integration plugin, gateway.test.js) gets
// the exact same modules via lazy requires, so the produced capability document is
// byte-for-byte identical to the previous static-require implementation.
function loadOpenApiSpec() {
  return require('../http/openapi').generateOpenAPISpec;
}
function loadPromptLayers() {
  return require('../skill/prompt-layers');
}
function loadTraecnSkill() {
  return require('../skill/traecn-skill');
}

const API_FAMILIES = Object.freeze({
  discovery: ['/api/capabilities', '/api/preflight', '/api/status', '/openapi.json'],
  delegation: ['/api/delegate', '/api/delegate-async', '/api/task/adopt-current', '/api/task/{taskId}', '/api/task/{taskId}/review', '/api/task/{taskId}/cancel'],
  sessions: ['/api/sessions', '/api/sessions/{sessionId}', '/api/sessions/{sessionId}/delegate'],
  queue: ['/api/queue-status', '/api/queue/status', '/api/tasks/batch', '/api/tasks/batch/{batchId}'],
  review: ['/api/delegate', '/api/delegate-async'],
  control: ['/api/new-chat', '/api/solo/chats', '/api/solo/chats/switch', '/api/solo/chats/cleanup-foreign-queue', '/api/solo/chats/submit', '/api/trae/stop-generation', '/api/trae/review-gate', '/api/detect-mode', '/api/switch-mode', '/api/switch-model', '/api/open-project'],
  settings: ['/api/settings/read', '/api/settings/read-all', '/api/settings/set', '/api/settings/switch-tab', '/api/settings/back-to-chat'],
  confirmation: ['/api/dialog/status', '/api/dialog/approve', '/api/dialog/dismiss'],
  confirmationPlan: ['/api/confirm/plan'],
  history: ['/api/tasks/history', '/api/tasks/{taskId}', '/api/tasks/{taskId}/replay']
});

const OPERATION_HINTS = Object.freeze({
  status: 'Use first to decide whether live Trae CN is reachable.',
  preflight: 'Use first for a compact status/readiness/queue/dialog/confirmation summary.',
  readiness: 'Use before interactive operations that need the editor UI.',
  delegate: 'Best for one-off work where the caller can wait.',
  delegate_async: 'Best for token-efficient background delegation.',
  task_status: 'Poll async work without re-sending task context.',
  wait_task: 'Wait locally until terminal state after receiving taskId, avoiding repeated agent turns during long queues.',
  submit_solo_chat_task: 'Submit work into a real Solo conversation and track that conversation for later queued-result collection.',
  cleanup_foreign_solo_queue: 'Remove accidental queue-probe Solo conversations without sending more prompts to Trae.',
  cleanup_queue_watch_status: 'Read local cleanup watcher lock/PID/stale state without contacting Trae or creating chats.',
  long_queue_proof_start: 'Dry-run by default; use execute=true only with explicit approval to submit a clean GLM-5.2 long-queue proof.',
  long_queue_proof_status: 'Read current proof files and detached watcher state without sending prompts or creating chats.',
  long_queue_proof_cancel: 'Cancel the current proof watcher/task tracking without resubmitting prompt content.',
  adopt_current_task: 'Recover tracking for a Trae request that is already queued/running without resending prompt content.',
  review_task: 'Approve or reject a completed background result before continuing follow-up work.',
  queue_status: 'Check model busy/queue state before sending expensive work.',
  stop_generation: 'Stop the current Trae generation/queue request before recovering or switching tasks.',
  review_gate_status: 'Inspect whether Trae is waiting on its internal keep/revert review gate.',
  resolve_review_gate: 'Resolve Trae internal keep/revert gate so automation can continue.',
  review_code: 'Ask Trae CN for findings-first code review of code or diff.',
  vibe_workflow: 'Run an unattended initial task plus follow-up tasks with auto-continue checkpoints.',
  approve_dialog: 'Handle permission, restricted-mode, or confirmation prompts explicitly.'
});

function compactOperation(path, method, operation) {
  const required = [];
  const properties = operation.requestBody?.content?.['application/json']?.schema?.properties || {};
  const bodyRequired = operation.requestBody?.content?.['application/json']?.schema?.required || [];
  for (const item of bodyRequired) required.push(item);
  for (const parameter of operation.parameters || []) {
    if (parameter.required) required.push(parameter.name);
  }

  return {
    method: method.toUpperCase(),
    path,
    operationId: operation.operationId,
    auth: Array.isArray(operation.security) && operation.security.length > 0,
    required,
    accepts: Object.keys(properties)
  };
}

function buildHttpOperations(deps = {}) {
  const generateOpenAPISpec = (deps && deps.generateOpenAPISpec) || loadOpenApiSpec();
  const spec = generateOpenAPISpec();
  const operations = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      operations.push(compactOperation(path, method, operation));
    }
  }
  return operations.sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`));
}

function compactCommands(commands) {
  return commands.map(command => ({
    command: command.command,
    summary: command.summary,
    required: command.required || [],
    optional: command.optional || [],
    hint: OPERATION_HINTS[command.command]
  }));
}

function compactTools(tools = [], metadata = {}) {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    required: tool.inputSchema?.required || [],
    layer: metadata[tool.name]?.layer,
    profile: metadata[tool.name]?.profile,
    risk: metadata[tool.name]?.risk,
    alternative: metadata[tool.name]?.alternative,
    annotations: tool.annotations
  }));
}

function buildCapabilities(options = {}, deps = {}) {
  const generateOpenAPISpec = (deps && deps.generateOpenAPISpec) || loadOpenApiSpec();
  const promptLayers = (deps && deps.promptLayers) || loadPromptLayers();
  const traecnSkill = (deps && deps.traecnSkill) || loadTraecnSkill();
  const { KNOWN_MODELS, SETTINGS_SECTIONS } = traecnSkill;
  const commands = options.commands || [];
  const mcpTools = options.mcpTools || [];
  const mcpToolProfile = options.mcpToolProfile || 'public';
  const mcpToolProfiles = options.mcpToolProfiles || {};
  const mcpToolMetadata = options.mcpToolMetadata || {};
  const operations = options.includeHttpOperations === false ? undefined : buildHttpOperations({ generateOpenAPISpec });

  return {
    name: 'traecnclaw',
    version: packageInfo.version,
    contractVersion: 1,
    tokenStrategy: {
      prefer: ['traecn_get_capabilities', 'traecn_preflight', 'traecn_queue_task', 'traecn_wait_task', 'traecn_poll_task'],
      preflight: 'Call traecn_preflight once before side-effecting work instead of separate status/readiness/queue/dialog checks.',
      avoid: 'Fetch /openapi.json only when schema detail is needed.',
      maxTaskBytes: 100000,
      asyncPolling: true,
      compactResponses: true
    },
    coverage: {
      connection: true,
      taskDelegation: true,
      queueManagement: true,
      codeReview: true,
      operationConfirmation: true,
      operationPreflight: true,
      settingsAutomation: true,
      modelAndModeControl: true,
      soloMultiConversationControl: true,
      soloQueuedResultCollection: true,
      projectOpening: true,
      historyReplay: true,
      unattendedVibeWorkflow: true,
      fullSchema: '/openapi.json'
    },
    apiFamilies: API_FAMILIES,
    http: operations,
    commands: compactCommands(commands),
    mcp: {
      toolProfile: mcpToolProfile,
      toolProfiles: mcpToolProfiles,
      tools: compactTools(mcpTools, mcpToolMetadata),
      prompts: promptLayers.listMcpPrompts().map(prompt => ({ name: prompt.name, description: prompt.description })),
      resources: promptLayers.listMcpResources().map(resource => ({ uri: resource.uri, description: resource.description }))
    },
    traeCN: {
      modes: ['solo', 'ide'],
      knownModels: KNOWN_MODELS.slice(),
      settingsSections: { ...SETTINGS_SECTIONS }
    }
  };
}

module.exports = {
  API_FAMILIES,
  OPERATION_HINTS,
  buildCapabilities,
  buildHttpOperations
};
