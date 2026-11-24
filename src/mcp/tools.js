'use strict';

const { isGenericQueueProbeTask } = require('../shared/utils');

function schema(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const CONVERSATION_ID = {
  type: 'string',
  description: 'Stable identifier returned by traecn_list_conversations.'
};

const SECTION = {
  type: 'string',
  description: 'Section name exactly as returned by traecn_list_setting_sections.'
};

const LABEL = {
  type: 'string',
  description: 'Setting label exactly as returned by traecn_list_settings.'
};

const TASK_ID = {
  type: 'string',
  description: 'Stable task identifier returned by traecn_send_message.'
};

// Each tool represents one user intent. Queueing, waiting, recovery,
// notifications and routine non-command interactions remain gateway-owned mechanics.
// Descriptions answer four questions: what intent, when to call, side effects or
// boundaries, and which stable identity comes back.
const RAW_MCP_TOOLS = Object.freeze([
  {
    name: 'traecn_send_message',
    description: 'Delegate one instruction as durable background work; return taskId immediately. The gateway owns queueing, retries, recovery and persistence. Track that ID; never send progress probes.',
    inputSchema: schema({
      message: { type: 'string', description: 'The exact instruction to execute.' },
      conversationId: CONVERSATION_ID
    }, ['message'])
  },
  {
    name: 'traecn_get_task',
    description: 'Read task status and final result, or request trace for diagnosis. Read once on completion notification or after reconnecting; do not busy-poll.',
    inputSchema: schema({
      taskId: TASK_ID,
      detailLevel: {
        type: 'string',
        enum: ['result', 'trace'],
        description: 'result returns only the final answer (default); trace includes the full visible Trae execution process.'
      }
    }, ['taskId'])
  },
  {
    name: 'traecn_cancel_task',
    description: 'Cancel a tracked task at the next gateway control point. Return its ID and status; retain results already stored in task history.',
    inputSchema: schema({ taskId: TASK_ID }, ['taskId'])
  },
  {
    name: 'traecn_stop_generation',
    description: 'Stop visible generation in the named active conversation, with acknowledgement and an audit reason. It may belong to others; prefer traecn_cancel_task for tracked work.',
    inputSchema: schema({
      conversationId: CONVERSATION_ID,
      acknowledgeUntrackedWork: {
        type: 'boolean',
        description: 'Must be true to acknowledge that visible work may belong to the user or another agent.'
      },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description: 'Concise reason recorded in the local security audit log.'
      }
    }, ['conversationId', 'acknowledgeUntrackedWork', 'reason'])
  },
  {
    name: 'traecn_open_workspace',
    description: 'Open and verify a local workspace before project-dependent work. Do not repeat its path in the task message.',
    inputSchema: schema({ path: { type: 'string', description: 'Absolute local folder path.' } }, ['path'])
  },
  {
    name: 'traecn_list_models',
    description: 'Discover available models and the current selection before choosing one. Auto may report manualModelsHidden without changing modes.',
    inputSchema: schema()
  },
  {
    name: 'traecn_select_model',
    description: 'Select an exact discovered model and verify it. Already selected is a no-op; does not wait for capacity.',
    inputSchema: schema({
      model: { type: 'string', description: 'Exact model name as returned by traecn_list_models.' }
    }, ['model'])
  },
  {
    name: 'traecn_select_mode',
    description: 'Switch to Solo or IDE and verify the active mode. Call only when needed; already active is a no-op.',
    inputSchema: schema({
      mode: { type: 'string', enum: ['solo', 'ide'], description: 'Target UI mode.' }
    }, ['mode'])
  },
  {
    name: 'traecn_list_setting_sections',
    description: 'Discover visible settings sections before any settings operation. Never guess section names.',
    inputSchema: schema()
  },
  {
    name: 'traecn_list_settings',
    description: 'Discover settings and control types in a listed section before changing values. Never guess labels.',
    inputSchema: schema({ section: SECTION }, ['section'])
  },
  {
    name: 'traecn_list_setting_options',
    description: 'Discover dropdown choices before selecting a setting option. Use the listed section and label; never invent values.',
    inputSchema: schema({
      section: SECTION,
      label: LABEL
    }, ['section', 'label'])
  },
  {
    name: 'traecn_set_setting_toggle',
    description: 'Set a discovered toggle and read back its state. Applying the current value succeeds as a no-op.',
    inputSchema: schema({
      section: SECTION,
      label: LABEL,
      enabled: { type: 'boolean', description: 'Desired toggle state.' }
    }, ['section', 'label', 'enabled'])
  },
  {
    name: 'traecn_select_setting_option',
    description: 'Apply a discovered dropdown option and verify it. Only values from traecn_list_setting_options are valid.',
    inputSchema: schema({
      section: SECTION,
      label: LABEL,
      value: { type: 'string', description: 'Option value exactly as returned by traecn_list_setting_options.' }
    }, ['section', 'label', 'value'])
  },
  {
    name: 'traecn_set_setting_text',
    description: 'Set a discovered text setting by section and label, then read back the field to verify it.',
    inputSchema: schema({
      section: SECTION,
      label: LABEL,
      text: { type: 'string', description: 'Text content to enter into the field.' }
    }, ['section', 'label', 'text'])
  },
  {
    name: 'traecn_list_conversations',
    description: 'List current-mode conversations with stable IDs. Use when choosing or verifying conversation context.',
    inputSchema: schema()
  },
  {
    name: 'traecn_create_conversation',
    description: 'Prepare one new context, reusing an empty draft. Return its native ID when allocated; otherwise conversationId=null and creationDeferred=true until the first message. Call once per new context.',
    inputSchema: schema()
  },
  {
    name: 'traecn_select_conversation',
    description: 'Activate an existing conversation for subsequent visible interaction; return its confirmed ID.',
    inputSchema: schema({ conversationId: CONVERSATION_ID }, ['conversationId'])
  },
  {
    name: 'traecn_delete_conversation',
    description: 'Permanently delete an inactive conversation using its listed ID, exact title and irreversible-deletion acknowledgement. The gateway cannot restore it.',
    inputSchema: schema({
      conversationId: CONVERSATION_ID,
      expectedTitle: {
        type: 'string',
        minLength: 1,
        description: 'Exact title returned by traecn_list_conversations.'
      },
      acknowledgePermanentDeletion: {
        type: 'boolean',
        description: 'Must be true to acknowledge that the gateway cannot restore the deleted conversation.'
      }
    }, ['conversationId', 'expectedTitle', 'acknowledgePermanentDeletion'])
  },
  {
    name: 'traecn_answer_question',
    description: 'Answer a pending visible question with the user-authorized decision; return the outcome. Call only for an unresolved interaction.',
    inputSchema: schema({
      answer: { type: 'string', description: "The user's answer to the pending question." }
    }, ['answer'])
  },
  {
    name: 'traecn_decide_approval',
    description: 'Approve or deny the visible command card within user authorization. Approval revalidates expectedCommand and requires acknowledgeRisk plus an audit reason; denial needs only decision.',
    inputSchema: schema({
      decision: { type: 'string', enum: ['approve', 'deny'], description: 'The approval decision.' },
      expectedCommand: {
        type: 'string',
        description: 'For approve, the exact command returned with the pending interaction.'
      },
      acknowledgeRisk: {
        type: 'boolean',
        description: 'For approve, must be true after checking the command against the user-authorized scope.'
      },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description: 'For approve, a concise authorization reason recorded in the local security audit log.'
      }
    }, ['decision'])
  }
]);

const MCP_TOOL_INTERNAL_NAMES = Object.freeze({
  traecn_send_message: 'send_message',
  traecn_get_task: 'get_task',
  traecn_cancel_task: 'cancel_task',
  traecn_stop_generation: 'stop_generation',
  traecn_open_workspace: 'open_workspace',
  traecn_list_models: 'list_models',
  traecn_select_model: 'select_model',
  traecn_select_mode: 'select_mode',
  traecn_list_setting_sections: 'list_setting_sections',
  traecn_list_settings: 'list_settings',
  traecn_list_setting_options: 'list_setting_options',
  traecn_set_setting_toggle: 'set_setting_toggle',
  traecn_select_setting_option: 'select_setting_option',
  traecn_set_setting_text: 'set_setting_text',
  traecn_list_conversations: 'list_conversations',
  traecn_create_conversation: 'create_conversation',
  traecn_select_conversation: 'select_conversation',
  traecn_delete_conversation: 'delete_conversation',
  traecn_answer_question: 'answer_question',
  traecn_decide_approval: 'decide_approval'
});

function internalMcpToolName(toolName) {
  return Object.hasOwn(MCP_TOOL_INTERNAL_NAMES, toolName) ? MCP_TOOL_INTERNAL_NAMES[toolName] : null;
}

function asMcpContent(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: value,
    isError: false
  };
}

// Stable execution-error codes for valid calls that cannot complete. Protocol
// errors (malformed envelopes, unknown tools) never pass through here.
const TOOL_ERROR_PATTERNS = Object.freeze([
  { test: /timeout|ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket hang up/i, code: 'GATEWAY_UNREACHABLE', retryable: true, nextAction: 'Verify the local gateway is running (traecn-mcp doctor), then retry once.' },
  { test: /TRAECN_BIN|TraeCN binary|binary not found|launch TraeCN/i, code: 'TRAE_NOT_READY', retryable: true, nextAction: 'Start TraeCN or set TRAECN_BIN, then retry once.' },
  { test: /not found|unknown task|no such/i, code: 'STALE_IDENTITY', retryable: false, nextAction: 'Re-list with the corresponding traecn_list_* tool and use a fresh identifier.' },
  { test: /mismatch|changed;/i, code: 'IDENTITY_MISMATCH', retryable: false, nextAction: 'Re-read the current visible state before deciding again.' },
  { test: /required argument|must be|must contain|Unexpected argument|required/i, code: 'INVALID_ARGUMENTS', retryable: false, nextAction: 'Fix the arguments per the input schema and retry.' }
]);

const STABLE_ERROR_CODE_PATTERN = /^([A-Z][A-Z0-9_]+|[a-z][a-z0-9_]*)$/;
const TOOL_ERROR_GUIDANCE = Object.freeze({
  WINDOW_NOT_VISIBLE: {
    retryable: true,
    nextAction: 'Unlock the Mac and make the existing TraeCN window visible, then retry only the blocked UI operation. Keep any accepted taskId and read its status; do not resubmit that task.'
  }
});

function describeToolExecutionError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const fallback = { code: 'TRAECN_OPERATION_FAILED', message, retryable: false, nextAction: 'Check gateway diagnostics before retrying.' };
  // Preserve stable codes already attached by adapters (e.g.
  // TraeCNAutomationError or gateway rejection identifiers), along with any
  // characterized retry guidance carried on the error.
  if (error && typeof error.code === 'string'
      && STABLE_ERROR_CODE_PATTERN.test(error.code)) {
    const guidance = Object.hasOwn(TOOL_ERROR_GUIDANCE, error.code) ? TOOL_ERROR_GUIDANCE[error.code] : undefined;
    return {
      code: error.code,
      message,
      retryable: typeof error.retryable === 'boolean' ? error.retryable : guidance?.retryable || false,
      nextAction: typeof error.nextAction === 'string' && error.nextAction
        ? error.nextAction
        : guidance?.nextAction || fallback.nextAction
    };
  }
  const matched = TOOL_ERROR_PATTERNS.find(entry => entry.test.test(message));
  return matched
    ? { code: matched.code, message, retryable: matched.retryable, nextAction: matched.nextAction }
    : fallback;
}

// Gateway status classes for responses that are not successful tool outcomes.
const GATEWAY_STATUS_CLASSES = Object.freeze({
  400: { code: 'INVALID_ARGUMENTS', retryable: false, nextAction: 'Fix the arguments per the input schema and retry.' },
  401: { code: 'AUTHORIZATION_REQUIRED', retryable: false, nextAction: 'Supply the required gateway authorization and retry.' },
  403: { code: 'AUTHORIZATION_REQUIRED', retryable: false, nextAction: 'Supply the required gateway authorization and retry.' },
  404: { code: 'STALE_IDENTITY', retryable: false, nextAction: 'Re-list with the corresponding traecn_list_* tool and use a fresh identifier.' },
  409: { code: 'STATE_CONFLICT', retryable: false, nextAction: 'Re-read the current visible state before deciding again.' },
  503: { code: 'GATEWAY_UNAVAILABLE', retryable: true, nextAction: 'Verify gateway health (traecn-mcp doctor), then retry once.' }
});

// Gateway bodies carry the outcome as JSON. Non-2xx responses are execution
// failures of valid calls, so they must surface as structured tool errors
// instead of passing through as successful results.
function unwrapGatewayResult(result) {
  const envelope = result && typeof result === 'object' && !Array.isArray(result);
  const status = envelope && typeof result.status === 'number' ? result.status : undefined;
  const payload = envelope && 'data' in result ? result.data : result;
  if (status === undefined || status < 400) return payload;

  const body = payload && typeof payload === 'object' ? payload : {};
  const identifier = typeof body.error === 'string' ? body.error.trim() : '';
  const tokenLike = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(identifier);
  const explicitCode = typeof body.code === 'string' ? body.code.trim() : '';
  const hasExplicitCode = explicitCode.length <= 64 && STABLE_ERROR_CODE_PATTERN.test(explicitCode);
  const gatewayClass = GATEWAY_STATUS_CLASSES[status]
    || (status >= 500
      ? { code: 'GATEWAY_UNAVAILABLE', retryable: true, nextAction: 'Verify gateway health (traecn-mcp doctor), then retry once.' }
      : { code: 'TRAECN_OPERATION_FAILED', retryable: false, nextAction: 'Check gateway diagnostics before retrying.' });
  const failure = new Error(
    (typeof body.message === 'string' && body.message)
      || (!tokenLike && identifier)
      || `Gateway request failed with status ${status}`
  );
  failure.code = hasExplicitCode ? explicitCode : tokenLike ? identifier : gatewayClass.code;
  const guidance = Object.hasOwn(TOOL_ERROR_GUIDANCE, failure.code) ? TOOL_ERROR_GUIDANCE[failure.code] : gatewayClass;
  failure.retryable = guidance.retryable;
  failure.nextAction = guidance.nextAction;
  throw failure;
}

function asMcpError(error) {
  const detail = describeToolExecutionError(error);
  const payload = {
    error: detail.message,
    code: detail.code,
    message: detail.message,
    retryable: detail.retryable,
    nextAction: detail.nextAction
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true
  };
}

function validateMcpToolArguments(tool, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool arguments must be an object');
  }
  const args = value;
  const schema = tool && tool.inputSchema ? tool.inputSchema : {};
  const properties = schema.properties || {};
  for (const name of schema.required || []) {
    if (args[name] === undefined) throw new Error(`Missing required argument: ${name}`);
  }
  if (schema.additionalProperties === false) {
    const unexpected = Object.keys(args).find(name => !Object.hasOwn(properties, name));
    if (unexpected) throw new Error(`Unexpected argument: ${unexpected}`);
  }
  for (const [name, property] of Object.entries(properties)) {
    if (args[name] === undefined) continue;
    if (property.type && typeof args[name] !== property.type) {
      throw new Error(`Argument ${name} must be ${property.type}`);
    }
    if (property.enum && !property.enum.includes(args[name])) {
      throw new Error(`Argument ${name} must be one of: ${property.enum.join(', ')}`);
    }
    if (property.minLength && args[name].length < property.minLength) {
      throw new Error(`Argument ${name} must contain at least ${property.minLength} character(s)`);
    }
    if (property.maxLength && args[name].length > property.maxLength) {
      throw new Error(`Argument ${name} must contain at most ${property.maxLength} character(s)`);
    }
  }
  return args;
}

function checkGenericQueueProbe(task) {
  return isGenericQueueProbeTask(task);
}

module.exports = {
  RAW_MCP_TOOLS,
  MCP_TOOL_INTERNAL_NAMES,
  internalMcpToolName,
  asMcpContent,
  asMcpError,
  describeToolExecutionError,
  unwrapGatewayResult,
  validateMcpToolArguments,
  checkGenericQueueProbe
};
