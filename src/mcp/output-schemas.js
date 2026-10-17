'use strict';

/**
 * Reusable structured-output families for the contract-v5 MCP tools.
 *
 * Each schema declares only fields the gateway handlers actually return
 * (verified against src/http/handlers/* and src/http/gateway.js) and stays
 * open (`additionalProperties: true`) because gateway payloads may carry
 * diagnostic context such as queue details or audit metadata. Error bodies
 * share the common execution-error fields, so success and failure paths
 * validate against the same per-tool declaration.
 */

const COMMON_RESULT_FIELDS = Object.freeze({
  success: { type: 'boolean', description: 'Whether the operation succeeded.' },
  status: { type: 'string', description: 'Stable operation or task status.' },
  message: { type: 'string', description: 'Human-readable outcome summary.' },
  taskId: { type: 'string', description: 'Stable gateway task identifier.' },
  conversationId: { type: 'string', description: 'Stable TraeCN conversation identifier.' },
  changed: { type: 'boolean', description: 'Whether visible TraeCN state changed.' },
  retryable: { type: 'boolean', description: 'Whether retrying the same call can succeed later.' },
  code: { type: 'string', description: 'Stable machine-readable result or error code.' },
  nextAction: { type: 'string', description: 'Suggested next step after a failure.' },
  error: { type: 'string', description: 'Error identifier or diagnostic when the operation failed.' }
});

function toolOutputSchema(description, properties) {
  return Object.freeze({
    type: 'object',
    description,
    properties: Object.freeze({ ...COMMON_RESULT_FIELDS, ...properties }),
    additionalProperties: true
  });
}

const STRING_ARRAY = Object.freeze({ type: 'array', items: { type: 'string' } });

// TaskAcceptedResult — new acceptance, terminal idempotency replay, or rejection.
const TASK_ACCEPTED_PROPERTIES = {
  ok: { type: 'boolean', description: 'False when the gateway rejected the submission.' },
  taskId: { type: 'string', description: 'Stable identifier used by traecn_get_task and traecn_cancel_task.' },
  status: {
    type: 'string', enum: ['accepted', 'done', 'error', 'cancelled', 'queue_timeout', 'review_rejected'],
    description: 'Accepted for new work, or the original terminal status on an idempotent replay.'
  },
  terminal: { type: 'boolean', description: 'True when returning the original terminal task without submitting again.' },
  result: { type: ['object', 'null'], description: 'Original captured result on a terminal replay.' },
  error: { type: ['string', 'null'], description: 'Original task error on replay, or submission rejection diagnostic.' }
};

// TaskSnapshotResult — traecn_get_task status snapshots (active queue and history).
const TASK_SNAPSHOT_PROPERTIES = {
  taskId: { type: 'string', description: 'Echoed task identifier.' },
  status: { type: 'string', description: 'Task status such as queued, executing, done, error, cancelled, awaiting_review, approval_required.' },
  error: { type: ['string', 'null'], description: 'Original task error, or null when no execution error was recorded.' },
  historyStatus: { type: 'string', description: 'Internal history status when the task already left the active queue.' },
  createdAt: { type: ['number', 'null'], description: 'Epoch milliseconds when the task was created.' },
  elapsed: { type: ['number', 'null'], description: 'Milliseconds elapsed since creation.' },
  completedAt: {
    type: ['number', 'string', 'null'],
    format: 'date-time',
    description: 'Task completion time: epoch milliseconds, an ISO 8601 timestamp from persisted history, or null when unavailable.'
  },
  fromHistory: { type: 'boolean', description: 'True when served from persisted history instead of the active queue.' },
  metadata: { type: 'object', description: 'Gateway bookkeeping metadata recorded with the task.' },
  stepCount: { type: 'number', description: 'Number of recorded execution steps.' },
  result: {
    type: ['object', 'null'],
    description: 'Final agent answer payload: text, stable flag, elapsedMs; or code/error when unavailable.'
  },
  errorCode: { type: 'string', description: 'Stable code when the task itself failed.' },
  lastStep: { type: ['object', 'null'], description: 'Most recent execution step summary (trace level).' },
  detailLevel: { type: 'string', enum: ['result', 'trace'], description: 'Requested detail level.' },
  detailWarning: { type: 'string', description: 'Present when trace details could not be fully recovered.' }
};

// ListResult family — discovery tools returning arrays of visible TraeCN state.
const LIST_MODELS_PROPERTIES = {
  current: { type: 'string', description: 'Currently selected model name.' },
  models: STRING_ARRAY
};
const LIST_SECTIONS_PROPERTIES = {
  sections: { type: 'array', items: { type: 'string' }, description: 'Visible settings section names in UI order.' }
};
const LIST_SETTINGS_PROPERTIES = {
  section: { type: 'string', description: 'Section that was read.' },
  sections: { type: 'array', items: { type: 'string' }, description: 'All visible section names.' },
  items: { type: 'array', description: 'Settings in the section with their control types.' }
};
const LIST_OPTIONS_PROPERTIES = {
  section: { type: 'string', description: 'Section containing the setting.' },
  label: { type: 'string', description: 'Setting label whose choices were read.' },
  options: { type: 'array', items: { type: 'string' }, description: 'Selectable option texts in UI order.' }
};
const LIST_CONVERSATIONS_PROPERTIES = {
  mode: { type: 'string', description: 'TraeCN mode the list belongs to (solo, ide, unknown).' },
  conversations: {
    type: 'array',
    description: 'Conversations with stable identifiers.',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stable conversation identifier.' },
        title: { type: 'string', description: 'Conversation title shown in TraeCN.' },
        active: { type: 'boolean', description: 'Whether this conversation is currently active.' }
      },
      additionalProperties: true
    }
  }
};

// SelectionResult / MutationResult family — state-changing operations.
const SELECT_MODEL_PROPERTIES = {
  model: { type: 'string', description: 'Model now selected.' },
  requestedModel: { type: 'string', description: 'Model name that was requested.' },
  previousModel: { type: ['string', 'null'], description: 'Model selected before the switch.' },
  alreadySelected: { type: 'boolean', description: 'True when the requested model was already active (no-op).' },
  switchResult: { type: ['string', 'object'], description: 'Driver-level switch outcome summary.' },
  queued: { type: 'boolean', description: 'Whether the model queue is busy after switching.' },
  running: { type: 'boolean', description: 'Whether generation is running on the model after switching.' },
  canSubmit: { type: 'boolean', description: 'Whether a new task may be submitted immediately.' },
  queueDetails: { type: ['object', 'null'], description: 'Queue snapshot for the selected model.' }
};
const SELECT_MODE_PROPERTIES = {
  mode: { type: 'string', description: 'Active mode after the switch.' },
  previousMode: { type: 'string', description: 'Mode active before the switch.' },
  alreadyInMode: { type: 'boolean', description: 'True when the requested mode was already active (no-op).' }
};
const SETTINGS_WRITE_PROPERTIES = {
  label: { type: 'string', description: 'Setting label that was written.' },
  value: { description: 'Value applied to the setting.' },
  result: { type: 'string', description: 'Driver-reported write outcome, including already-in-desired-state.' },
  requestedValue: { description: 'Value requested by the caller.' },
  verified: { type: 'boolean', description: 'True only when the observed UI value equals the requested value.' },
  controlType: { type: 'string', enum: ['toggle', 'option', 'text'], description: 'UI control whose value was read back.' }
};
const CONVERSATION_ACTION_PROPERTIES = {
  action: { type: 'string', enum: ['create', 'select', 'delete'], description: 'Conversation operation performed.' },
  deleted: { type: 'number', description: 'Number of conversations removed (delete only).' },
  recoverable: { type: 'boolean', description: 'Always false for deletion; the gateway cannot restore conversations.' },
  expectedTitle: { type: 'string', description: 'Title compared against the visible conversation (delete mismatch only).' },
  actualTitle: { type: 'string', description: 'Title actually visible at decision time (delete mismatch only).' }
};

// InteractionResult — exceptional question/approval resolutions.
const INTERACTION_PROPERTIES = {
  resumedTaskIds: {
    type: 'array',
    items: { type: 'string' },
    description: 'Gateway tasks resumed automatically after the interaction resolved.'
  }
};

// Scoped stop — destructive control over visible generation.
const STOP_GENERATION_PROPERTIES = {
  scope: { type: 'string', const: 'active_solo_conversation', description: 'Verified stop scope.' },
  requestedConversationId: { type: 'string', description: 'Conversation ID supplied by the caller (mismatch path).' },
  activeConversationId: { type: ['string', 'null'], description: 'Conversation ID actually active (mismatch path).' },
  reason: { type: 'string', description: 'Driver-reported failure reason when the stop failed.' }
};

// Workspace verification.
const OPEN_WORKSPACE_PROPERTIES = {
  projectPath: { type: 'string', description: 'Absolute folder path that was opened.' },
  verifiedWorkspace: {
    type: ['string', 'object'],
    description: 'Workspace identity detected in the TraeCN window, or a compatible gateway path string.',
    properties: {
      folderName: { type: 'string', description: 'Folder name detected in the TraeCN window.' },
      rootPath: { type: ['string', 'null'], description: 'Detected absolute workspace root, or null when unavailable.' }
    },
    additionalProperties: true
  },
  alreadyRunning: { type: 'boolean', description: 'Whether TraeCN was already running.' },
  reusedWindow: { type: 'boolean', description: 'Whether an existing window was reused instead of spawning one.' },
  binPath: { type: 'string', description: 'TraeCN binary path used by the gateway.' },
  command: { type: 'string', description: 'Launch command when TraeCN had to be started.' },
  args: { type: 'array', items: { type: 'string' }, description: 'Launch arguments when TraeCN had to be started.' },
  cdp: { type: ['object', 'null'], description: 'CDP endpoint coordinates for gateway control.' }
};

// Cancel — gateway-side cancellation with optional stop outcome.
const CANCEL_TASK_PROPERTIES = {
  taskId: { type: 'string', description: 'Echoed task identifier.' },
  stopResult: { description: 'Outcome of stopping visible generation when the task was mid-flight.' }
};

// ErrorResult — shared shape of tool execution errors (isError responses).
const ERROR_RESULT_SCHEMA = Object.freeze({
  type: 'object',
  description: 'Tool execution error with actionable recovery fields.',
  properties: Object.freeze({
    error: { type: 'string', description: 'Human-readable error text (legacy field; kept for compatibility).' },
    code: { type: 'string', description: 'Stable machine-readable error code.' },
    message: { type: 'string', description: 'Human-readable error text.' },
    retryable: { type: 'boolean', description: 'Whether retrying the same call can succeed later.' },
    nextAction: { type: 'string', description: 'Concrete recovery step for the caller.' },
    required: { type: 'string', description: 'Required authorization scope when denied.' }
  }),
  additionalProperties: true
});

const TOOL_OUTPUT_SCHEMAS = Object.freeze({
  traecn_send_message: toolOutputSchema(
    'Accepted task identity, original terminal replay, or gateway rejection with reason.',
    TASK_ACCEPTED_PROPERTIES
  ),
  traecn_get_task: toolOutputSchema(
    'Task status snapshot with final result or diagnostics.',
    TASK_SNAPSHOT_PROPERTIES
  ),
  traecn_cancel_task: toolOutputSchema(
    'Cancelled task identity and any visible-generation stop outcome.',
    CANCEL_TASK_PROPERTIES
  ),
  traecn_stop_generation: toolOutputSchema(
    'Verified scoped stop outcome, or the active-conversation mismatch details.',
    STOP_GENERATION_PROPERTIES
  ),
  traecn_open_workspace: toolOutputSchema(
    'Opened workspace identity with launch and verification details.',
    OPEN_WORKSPACE_PROPERTIES
  ),
  traecn_list_models: toolOutputSchema(
    'Current model plus available model names.',
    LIST_MODELS_PROPERTIES
  ),
  traecn_select_model: toolOutputSchema(
    'Applied selection with before/after models and queue readiness.',
    SELECT_MODEL_PROPERTIES
  ),
  traecn_select_mode: toolOutputSchema(
    'Active mode after the switch.',
    SELECT_MODE_PROPERTIES
  ),
  traecn_list_setting_sections: toolOutputSchema(
    'Visible settings section names.',
    LIST_SECTIONS_PROPERTIES
  ),
  traecn_list_settings: toolOutputSchema(
    'Settings and control types within one section.',
    LIST_SETTINGS_PROPERTIES
  ),
  traecn_list_setting_options: toolOutputSchema(
    'Selectable choices for one dropdown setting.',
    LIST_OPTIONS_PROPERTIES
  ),
  traecn_set_setting_toggle: toolOutputSchema(
    'Applied toggle value and driver outcome.',
    SETTINGS_WRITE_PROPERTIES
  ),
  traecn_select_setting_option: toolOutputSchema(
    'Applied dropdown selection and driver outcome.',
    SETTINGS_WRITE_PROPERTIES
  ),
  traecn_set_setting_text: toolOutputSchema(
    'Applied text value and driver outcome.',
    SETTINGS_WRITE_PROPERTIES
  ),
  traecn_list_conversations: toolOutputSchema(
    'Conversations for the current mode with stable identifiers.',
    LIST_CONVERSATIONS_PROPERTIES
  ),
  traecn_create_conversation: toolOutputSchema(
    'Fresh conversation or empty draft awaiting a native identity.',
    {
      ...CONVERSATION_ACTION_PROPERTIES,
      conversationId: { type: ['string', 'null'], description: 'Native identity when allocated; null for an empty draft.' },
      creationDeferred: { type: 'boolean', description: 'True when TraeCN will allocate the conversation identity on its first message.' },
      fresh: { type: 'boolean', description: 'Whether the active context is ready for a first message.' }
    }
  ),
  traecn_select_conversation: toolOutputSchema(
    'Confirmed active conversation identity.',
    CONVERSATION_ACTION_PROPERTIES
  ),
  traecn_delete_conversation: toolOutputSchema(
    'Deletion outcome, or title/active-state mismatch details.',
    CONVERSATION_ACTION_PROPERTIES
  ),
  traecn_answer_question: toolOutputSchema(
    'Interaction resolution outcome with optionally resumed tasks.',
    INTERACTION_PROPERTIES
  ),
  traecn_decide_approval: toolOutputSchema(
    'Approval decision outcome with optionally resumed tasks.',
    INTERACTION_PROPERTIES
  )
});

function getMcpToolOutputSchema(toolName) {
  return TOOL_OUTPUT_SCHEMAS[toolName] || null;
}

module.exports = {
  COMMON_RESULT_FIELDS,
  ERROR_RESULT_SCHEMA,
  TOOL_OUTPUT_SCHEMAS,
  getMcpToolOutputSchema
};
