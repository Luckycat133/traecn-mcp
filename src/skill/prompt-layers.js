'use strict';

const PROMPT_LAYER_ORDER = Object.freeze([
  'identity',
  'safety',
  'capability',
  'context',
  'workflow',
  'command',
  'output'
]);

const CORE_CAPABILITIES = Object.freeze({
  nlu: 'Parse Chinese and English intent precisely, preserve constraints, and ask only when required information is missing.',
  execution: 'Turn the request into concrete IDE/app actions with observable success criteria.',
  multitask: 'Break complex work into ordered sub-tasks, keep progress state, and avoid duplicate work.',
  context: 'Carry forward project, session, mode, model, queue, and dialog context without overwriting fresh user intent.',
  reliability: 'Prefer deterministic command routes, validate inputs before action, and report recoverable errors clearly.'
});

const COMMAND_PROFILES = Object.freeze({
  status: {
    title: 'Gateway and TraeCN status check',
    capabilities: ['context', 'reliability'],
    workflow: ['Read gateway status', 'Summarize connection, mock mode, version, and readiness next steps']
  },
  readiness: {
    title: 'TraeCN readiness inspection',
    capabilities: ['context', 'reliability'],
    workflow: ['Inspect UI readiness signals', 'Report missing composer, send button, response region, or mode state']
  },
  new_chat: {
    title: 'Create a fresh TraeCN chat',
    capabilities: ['execution', 'context', 'reliability'],
    workflow: ['Check current automation state', 'Create a new chat', 'Return the new session/navigation result']
  },
  delegate: {
    title: 'Synchronous TraeCN task delegation',
    capabilities: ['nlu', 'execution', 'multitask', 'context', 'reliability'],
    workflow: ['Normalize intent', 'Check status/readiness if available', 'Execute the requested task', 'Return final answer and blockers']
  },
  delegate_async: {
    title: 'Asynchronous TraeCN task delegation',
    capabilities: ['nlu', 'execution', 'multitask', 'context', 'reliability'],
    workflow: ['Normalize intent', 'Submit work without busy-waiting', 'Return taskId and polling instructions']
  },
  task_status: {
    title: 'Async task status polling',
    capabilities: ['multitask', 'context', 'reliability'],
    workflow: ['Read task status', 'Classify done/queued/executing/error/cancelled', 'Return the next recommended command']
  },
  cancel_task: {
    title: 'Cancel queued task',
    capabilities: ['execution', 'multitask', 'reliability'],
    workflow: ['Validate taskId', 'Cancel only cancellable queued work', 'Report final task state']
  },
  switch_mode: {
    title: 'Switch TraeCN mode',
    capabilities: ['execution', 'context', 'reliability'],
    workflow: ['Validate target mode', 'Switch mode', 'Confirm mode state before continuing']
  },
  switch_model: {
    title: 'Switch TraeCN model',
    capabilities: ['execution', 'context', 'reliability'],
    workflow: ['Resolve requested model name', 'Switch model', 'Confirm active model or explain fallback']
  },
  queue_status: {
    title: 'Model queue status check',
    capabilities: ['multitask', 'context', 'reliability'],
    workflow: ['Read queue state', 'Report running/queued/free state', 'Recommend wait, poll, or retry']
  },
  open_project: {
    title: 'Open project in TraeCN',
    capabilities: ['execution', 'context', 'reliability'],
    workflow: ['Validate project path', 'Open the project', 'Preserve project context for later commands']
  },
  settings_read: {
    title: 'Read settings',
    capabilities: ['context', 'reliability'],
    workflow: ['Navigate to requested section if provided', 'Read visible settings', 'Return structured setting items']
  },
  settings_read_all: {
    title: 'Read all settings',
    capabilities: ['context', 'reliability'],
    workflow: ['Iterate supported sections', 'Capture settings snapshot', 'Return section-keyed data']
  },
  settings_set: {
    title: 'Write setting',
    capabilities: ['execution', 'context', 'reliability'],
    workflow: ['Validate section, label, and value', 'Apply the setting', 'Confirm final value when possible']
  },
  settings_navigate: {
    title: 'Navigate settings',
    capabilities: ['execution', 'context', 'reliability'],
    workflow: ['Validate section name', 'Navigate to section', 'Return selected section']
  },
  settings_back: {
    title: 'Return to chat from settings',
    capabilities: ['execution', 'context', 'reliability'],
    workflow: ['Leave settings panel', 'Confirm chat/editor context is active']
  },
  dialog_status: {
    title: 'Dialog status inspection',
    capabilities: ['context', 'reliability'],
    workflow: ['Detect pending dialog', 'Classify dialog type', 'Return buttons and safe next action']
  },
  approve_dialog: {
    title: 'Dialog approval action',
    capabilities: ['execution', 'context', 'reliability'],
    workflow: ['Inspect dialog intent', 'Apply requested approve/deny/auto action', 'Report clicked button']
  },
  dismiss_dialog: {
    title: 'Dismiss dialog',
    capabilities: ['execution', 'context', 'reliability'],
    workflow: ['Dismiss current dialog', 'Report whether UI is clear']
  },
  batch_submit: {
    title: 'Submit batch tasks',
    capabilities: ['nlu', 'execution', 'multitask', 'context', 'reliability'],
    workflow: ['Validate task list', 'Choose strategy and concurrency', 'Submit batch', 'Return batchId and polling plan']
  },
  batch_status: {
    title: 'Batch status polling',
    capabilities: ['multitask', 'context', 'reliability'],
    workflow: ['Read batch state', 'Summarize completed/failed/pending/running counts', 'Return next action']
  },
  batch_cancel: {
    title: 'Cancel batch tasks',
    capabilities: ['execution', 'multitask', 'reliability'],
    workflow: ['Validate batchId', 'Cancel remaining work', 'Return cancellation state']
  },
  review_code: {
    title: 'Structured code review',
    capabilities: ['nlu', 'execution', 'context', 'reliability'],
    workflow: ['Parse review scope', 'Inspect code or diff for correctness, safety, performance, and test gaps', 'Return findings first with severity and actionable fixes']
  }
});

const MCP_PROMPTS = Object.freeze([
  {
    name: 'traecn_layered_command',
    title: 'TraeCN Layered Command',
    description: 'Builds a layered prompt for precise TraeCN app control.',
    arguments: [
      { name: 'command', description: 'Preset command name', required: true },
      { name: 'task', description: 'User task or instruction text', required: false },
      { name: 'projectPath', description: 'Optional project path context', required: false }
    ]
  },
  {
    name: 'traecn_skill_authoring',
    title: 'TraeCN Skill Authoring',
    description: 'Creates a concise, progressively disclosed skill plan for extending TraeCNclaw.',
    arguments: [
      { name: 'skillName', description: 'New skill module name', required: true },
      { name: 'capability', description: 'Capability the skill adds', required: true }
    ]
  }
]);

const MCP_RESOURCES = Object.freeze([
  {
    uri: 'traecn://docs/layered-architecture',
    name: 'layered-architecture',
    title: 'TraeCN Layered Architecture',
    description: 'Layer order, capability model, and extension rules for TraeCN prompts.',
    mimeType: 'text/markdown'
  },
  {
    uri: 'traecn://commands/catalog',
    name: 'command-catalog',
    title: 'TraeCN Command Catalog',
    description: 'Stable command names and command-specific capability profiles.',
    mimeType: 'application/json'
  }
]);

function getCommandProfile(command) {
  return COMMAND_PROFILES[command] || {
    title: `Custom TraeCN command: ${command}`,
    capabilities: ['nlu', 'execution', 'context', 'reliability'],
    workflow: ['Validate command inputs', 'Execute command through the registered route', 'Report result and next step']
  };
}

function normalizeTaskText(command, params = {}) {
  if (typeof params.task === 'string' && params.task.trim()) return params.task.trim();
  if (typeof params.prompt === 'string' && params.prompt.trim()) return params.prompt.trim();
  return `Execute TraeCN command "${command}" with the supplied parameters.`;
}

function compactJson(value) {
  // 紧凑序列化以节约 token；该模块的目标是 token 高效的提示词。
  return JSON.stringify(value);
}

function createLayers(command, params = {}, options = {}) {
  const profile = getCommandProfile(command);
  const task = normalizeTaskText(command, params);
  const activeCapabilities = profile.capabilities.map(name => `${name}: ${CORE_CAPABILITIES[name]}`);
  const appContext = {
    projectPath: params.projectPath || options.projectPath || null,
    sessionId: params.sessionId || options.sessionId || null,
    mode: params.mode || options.mode || null,
    model: params.model || options.model || null,
    taskId: params.taskId || null,
    batchId: params.batchId || null,
    queuePolicy: params.waitForQueue === false ? 'return-queue-state-without-waiting' : 'wait-or-queue-when-safe'
  };

  return [
    {
      id: 'identity',
      title: 'Role and Objective',
      content: [
        'You are TraeCN operating inside a controlled OpenClaw workflow.',
        'Optimize for precise app control, fast feedback, and stable project progress.'
      ]
    },
    {
      id: 'safety',
      title: 'Safety and Control Boundaries',
      content: [
        'Use only the command and app capabilities exposed by TraeCNclaw.',
        'Validate required inputs before acting. Do not invent unavailable UI state.',
        'For destructive, permission, or external side-effect actions, surface the pending decision instead of silently approving.'
      ]
    },
    {
      id: 'capability',
      title: 'Activated Core Capabilities',
      content: activeCapabilities
    },
    {
      id: 'context',
      title: 'Runtime Context',
      content: [
        `Command: ${command}`,
        `Command profile: ${profile.title}`,
        `Context: ${compactJson(appContext)}`
      ]
    },
    {
      id: 'workflow',
      title: 'Ordered Workflow',
      content: profile.workflow.map((step, index) => `${index + 1}. ${step}`)
    },
    {
      id: 'command',
      title: 'User Command Payload',
      content: [
        task,
        `Raw params: ${compactJson(params)}`
      ]
    },
    {
      id: 'output',
      title: 'Response Contract',
      content: [
        'Return the concise final result first.',
        'Include taskId or batchId when work continues asynchronously.',
        'If blocked, state the exact blocker and the next safe command to run.'
      ]
    }
  ];
}

function renderLayer(layer) {
  return [`## ${layer.title}`, ...layer.content].join('\n');
}

function composeTraeCNPrompt(command, params = {}, options = {}) {
  const requestedLayers = options.layers || PROMPT_LAYER_ORDER;
  const profile = getCommandProfile(command);
  const layers = createLayers(command, params, options)
    .filter(layer => requestedLayers.includes(layer.id))
    .sort((a, b) => PROMPT_LAYER_ORDER.indexOf(a.id) - PROMPT_LAYER_ORDER.indexOf(b.id));

  // 每层只渲染一次，prompt 与 messages 共用结果
  const rendered = layers.map(layer => ({ id: layer.id, text: renderLayer(layer) }));

  return {
    command,
    layerOrder: rendered.map(layer => layer.id),
    prompt: rendered.map(layer => layer.text).join('\n\n'),
    messages: rendered.map(layer => ({
      role: 'user',
      content: {
        type: 'text',
        text: layer.text
      }
    })),
    metadata: {
      mcpCompatible: true,
      promptName: 'traecn_layered_command',
      capabilities: profile.capabilities,
      generatedAt: new Date(0).toISOString()
    }
  };
}

function listMcpPrompts() {
  return MCP_PROMPTS.map(prompt => ({
    ...prompt,
    arguments: prompt.arguments.map(argument => ({ ...argument }))
  }));
}

function getMcpPrompt(name, args = {}) {
  if (name === 'traecn_layered_command') {
    if (!args.command) {
      throw new Error('Missing required prompt argument: command');
    }
    const composed = composeTraeCNPrompt(args.command, args);
    return {
      description: 'Layered TraeCN command prompt',
      messages: composed.messages
    };
  }

  if (name === 'traecn_skill_authoring') {
    if (!args.skillName || !args.capability) {
      throw new Error('Missing required prompt arguments: skillName, capability');
    }
    return {
      description: 'TraeCN skill authoring prompt',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Design a concise TraeCN skill named "${args.skillName}".`,
              `Capability: ${args.capability}`,
              'Use progressive disclosure: SKILL.md for workflow, references for details, scripts for deterministic steps.',
              'Expose any app action through a typed command instead of free-form UI instructions.'
            ].join('\n')
          }
        }
      ]
    };
  }

  throw new Error(`Unknown MCP prompt: ${name}`);
}

function listMcpResources() {
  return MCP_RESOURCES.map(resource => ({ ...resource }));
}

function readMcpResource(uri) {
  if (uri === 'traecn://docs/layered-architecture') {
    return {
      uri,
      mimeType: 'text/markdown',
      text: [
        '# TraeCN Layered Prompt Architecture',
        '',
        `Layer order: ${PROMPT_LAYER_ORDER.join(' -> ')}`,
        '',
        'Skills should keep SKILL.md concise, move detailed references out of the hot path, and use scripts for deterministic operations.',
        'MCP exposure should separate prompts, resources, and tools, with typed schemas and explicit consent for risky operations.'
      ].join('\n')
    };
  }

  if (uri === 'traecn://commands/catalog') {
    return {
      uri,
      mimeType: 'application/json',
      text: compactJson(COMMAND_PROFILES)
    };
  }

  throw new Error(`Unknown MCP resource: ${uri}`);
}

function getMcpCapabilities(options = {}) {
  const capabilities = {
    prompts: { listChanged: false },
    resources: { listChanged: false },
    tools: { listChanged: false }
  };
  if (options.modern !== true) capabilities.logging = {};
  return capabilities;
}

module.exports = {
  PROMPT_LAYER_ORDER,
  CORE_CAPABILITIES,
  COMMAND_PROFILES,
  composeTraeCNPrompt,
  getCommandProfile,
  getMcpCapabilities,
  getMcpPrompt,
  listMcpPrompts,
  listMcpResources,
  readMcpResource
};
