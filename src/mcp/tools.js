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
    description: 'Submit one user instruction to TraeCN as durable background work and return its stable taskId immediately; the gateway owns queueing, retries, recovery, and result persistence. Use this for every delegated coding request, optionally targeting an existing conversation via conversationId. Do not send follow-up messages to probe progress — track the returned task instead.',
    inputSchema: schema({
      message: { type: 'string', description: 'The exact instruction to execute.' },
      conversationId: CONVERSATION_ID
    }, ['message'])
  },
  {
    name: 'traecn_get_task',
    description: "Read one known gateway task by ID: status plus final result, or the full execution trace with detailLevel 'trace' for diagnosis. Call once when notified of completion or once later when resuming after a disconnect. Not a progress primitive — do not poll in a tight loop.",
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
    description: 'Cancel one gateway-tracked task by ID. The gateway stops shepherding the work at its next control point and records the cancellation; results already produced remain in task history. Returns the task identity and post-cancellation status.',
    inputSchema: schema({ taskId: TASK_ID }, ['taskId'])
  },
  {
    name: 'traecn_stop_generation',
    description: 'Stop only the generation currently visible in the named active TraeCN conversation. Visible output may belong to the user or another agent, so this requires acknowledgeUntrackedWork=true plus an audit reason. Prefer cancel_task whenever a gateway task ID exists.',
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
    description: 'Open one absolute local folder path as the active TraeCN workspace and verify it became active before returning. Call before submitting work that depends on a specific project; afterwards do not repeat the path inside the task message.',
    inputSchema: schema({ path: { type: 'string', description: 'Absolute local folder path.' } }, ['path'])
  },
  {
    name: 'traecn_list_models',
    description: 'List the model names currently offered in the TraeCN UI together with the currently selected model. Read-only discovery; call before select_model whenever the model choice matters.',
    inputSchema: schema()
  },
  {
    name: 'traecn_select_model',
    description: 'Select one model by exact name from traecn_list_models and confirm the picker state before returning. Selecting the already-active model succeeds as a no-op. Does not wait for model availability or capacity.',
    inputSchema: schema({
      model: { type: 'string', description: 'Exact model name as returned by traecn_list_models.' }
    }, ['model'])
  },
  {
    name: 'traecn_select_mode',
    description: 'Switch TraeCN between Solo and IDE mode and confirm the resulting active mode. Switching to the current mode succeeds as a no-op. Call only when the requested mode differs.',
    inputSchema: schema({
      mode: { type: 'string', enum: ['solo', 'ide'], description: 'Target UI mode.' }
    }, ['mode'])
  },
  {
    name: 'traecn_list_setting_sections',
    description: "List the settings sections currently visible in TraeCN's settings UI. Required first step for any settings operation; never guess a section name.",
    inputSchema: schema()
  },
  {
    name: 'traecn_list_settings',
    description: 'List the individual settings and their control types within one section returned by traecn_list_setting_sections. Read-only discovery preceding any setting mutation; never guess a label.',
    inputSchema: schema({ section: SECTION }, ['section'])
  },
  {
    name: 'traecn_list_setting_options',
    description: 'List the visible choices of one dropdown-style setting identified by section and label. Required before select_setting_option; never invent an option value.',
    inputSchema: schema({
      section: SECTION,
      label: LABEL
    }, ['section', 'label'])
  },
  {
    name: 'traecn_set_setting_toggle',
    description: 'Enable or disable one toggle setting identified by section and label, then read back the applied state. Applying the already-current state succeeds as a no-op.',
    inputSchema: schema({
      section: SECTION,
      label: LABEL,
      enabled: { type: 'boolean', description: 'Desired toggle state.' }
    }, ['section', 'label', 'enabled'])
  },
  {
    name: 'traecn_select_setting_option',
    description: 'Select one previously listed option for a dropdown setting identified by section and label, and confirm the applied selection. Only values returned by traecn_list_setting_options are valid.',
    inputSchema: schema({
      section: SECTION,
      label: LABEL,
      value: { type: 'string', description: 'Option value exactly as returned by traecn_list_setting_options.' }
    }, ['section', 'label', 'value'])
  },
  {
    name: 'traecn_set_setting_text',
    description: 'Enter one text value into the setting field identified by section and label, and confirm what the field contains afterwards.',
    inputSchema: schema({
      section: SECTION,
      label: LABEL,
      text: { type: 'string', description: 'Text content to enter into the field.' }
    }, ['section', 'label', 'text'])
  },
  {
    name: 'traecn_list_conversations',
    description: 'List the conversations available in the current TraeCN mode with stable identifiers accepted by conversation-scoped tools. Read-only; call when choosing or verifying conversation context.',
    inputSchema: schema()
  },
  {
    name: 'traecn_create_conversation',
    description: 'Create a new TraeCN conversation and make it the active target. Every call creates an additional conversation, so call at most once per genuinely new context. Returns the created conversation identity.',
    inputSchema: schema()
  },
  {
    name: 'traecn_select_conversation',
    description: 'Make one existing conversation the active target for subsequent visible interaction. Returns the confirmed active conversation identity.',
    inputSchema: schema({ conversationId: CONVERSATION_ID }, ['conversationId'])
  },
  {
    name: 'traecn_delete_conversation',
    description: 'Permanently delete one inactive TraeCN conversation by stable identifier. Requires the exact expectedTitle returned by traecn_list_conversations plus an explicit irreversible-deletion acknowledgement; there is no gateway recovery path.',
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
    description: "Resolve an exceptional question from TraeCN that the gateway could not handle mechanically by supplying the user's decision. The gateway routes the answer to the pending visible prompt and reports the outcome. Only call when a pending interaction exists.",
    inputSchema: schema({
      answer: { type: 'string', description: "The user's answer to the pending question." }
    }, ['answer'])
  },
  {
    name: 'traecn_decide_approval',
    description: 'Approve or deny the unsafe or ambiguous command card currently visible in TraeCN. Approval revalidates the exact expectedCommand against the card and requires acknowledgeRisk plus an audit reason recorded locally; denial needs only the decision. Never approve beyond the scope the user authorized.',
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
  return MCP_TOOL_INTERNAL_NAMES[toolName] || null;
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
  { test: /timeout|ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket hang up/i, code: 'GATEWAY_UNREACHABLE', retryable: true, nextAction: 'Verify the local gateway is running (traecnclaw doctor), then retry once.' },
  { test: /TRAECN_BIN|TraeCN binary|binary not found|launch TraeCN/i, code: 'TRAE_NOT_READY', retryable: true, nextAction: 'Start TraeCN or set TRAECN_BIN, then retry once.' },
  { test: /not found|unknown task|no such/i, code: 'STALE_IDENTITY', retryable: false, nextAction: 'Re-list with the corresponding traecn_list_* tool and use a fresh identifier.' },
  { test: /mismatch|changed;/i, code: 'IDENTITY_MISMATCH', retryable: false, nextAction: 'Re-read the current visible state before deciding again.' },
  { test: /required argument|must be|must contain|Unexpected argument|required/i, code: 'INVALID_ARGUMENTS', retryable: false, nextAction: 'Fix the arguments per the input schema and retry.' }
]);

function describeToolExecutionError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const fallback = { code: 'TRAECN_OPERATION_FAILED', message, retryable: false, nextAction: 'Check gateway diagnostics before retrying.' };
  // Preserve stable codes already attached by adapters (e.g.
  // TraeCNAutomationError or gateway rejection identifiers), along with any
  // characterized retry guidance carried on the error.
  if (error && typeof error.code === 'string'
      && /^([A-Z][A-Z0-9_]+|[a-z][a-z0-9_]*)$/.test(error.code)) {
    return {
      code: error.code,
      message,
      retryable: typeof error.retryable === 'boolean' ? error.retryable : false,
      nextAction: typeof error.nextAction === 'string' && error.nextAction
        ? error.nextAction
        : fallback.nextAction
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
  503: { code: 'GATEWAY_UNAVAILABLE', retryable: true, nextAction: 'Verify gateway health (traecnclaw doctor), then retry once.' }
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
  const gatewayClass = GATEWAY_STATUS_CLASSES[status]
    || (status >= 500
      ? { code: 'GATEWAY_UNAVAILABLE', retryable: true, nextAction: 'Verify gateway health (traecnclaw doctor), then retry once.' }
      : { code: 'TRAECN_OPERATION_FAILED', retryable: false, nextAction: 'Check gateway diagnostics before retrying.' });
  const failure = new Error(
    (typeof body.message === 'string' && body.message)
      || (!tokenLike && identifier)
      || `Gateway request failed with status ${status}`
  );
  failure.code = tokenLike ? identifier : gatewayClass.code;
  failure.retryable = gatewayClass.retryable;
  failure.nextAction = gatewayClass.nextAction;
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
  const args = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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
