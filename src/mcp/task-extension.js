'use strict';

const crypto = require('crypto');
const { getEnvWithFallback, parsePositiveInt } = require('../shared/utils');
const { asMcpContent, asMcpError, validateMcpToolArguments } = require('./tools');
const { McpProtocolError, requestMeta } = require('./protocol');

const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';
const SUBSCRIPTION_ID_META_KEY = 'io.modelcontextprotocol/subscriptionId';
const DEFAULT_TASK_POLL_INTERVAL_MS = 5000;
const DEFAULT_TASK_TTL_MS = parsePositiveInt(
  getEnvWithFallback('TRAECN_MCP_TASK_TTL_MS', 'TRAE_MCP_TASK_TTL_MS', '604800000'),
  604800000
);

const TOOL_ERROR_STATUSES = new Set(['error', 'queue_timeout', 'review_rejected', 'not_found']);
const TERMINAL_GATEWAY_STATUSES = new Set([
  'done',
  'error',
  'cancelled',
  'queue_timeout',
  'review_rejected'
]);

function normalizedOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map(option => typeof option === 'string'
      ? option.trim()
      : String(option?.label || option?.description || option?.value || '').trim())
    .filter(Boolean);
}

function clientSupportsTaskExtension(message = {}) {
  const capabilities = requestMeta(message)?.['io.modelcontextprotocol/clientCapabilities'];
  return Boolean(
    capabilities
    && typeof capabilities === 'object'
    && !Array.isArray(capabilities)
    && capabilities.extensions
    && typeof capabilities.extensions === 'object'
    && !Array.isArray(capabilities.extensions)
    && capabilities.extensions[TASKS_EXTENSION_ID]
    && typeof capabilities.extensions[TASKS_EXTENSION_ID] === 'object'
    && !Array.isArray(capabilities.extensions[TASKS_EXTENSION_ID])
  );
}

function assertTaskExtension(message = {}) {
  if (clientSupportsTaskExtension(message)) return true;
  throw new McpProtocolError(-32021, 'Missing required client capability', {
    requiredCapabilities: {
      extensions: { [TASKS_EXTENSION_ID]: {} }
    }
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function taskIdempotencyKey(message = {}) {
  const meta = requestMeta(message) || {};
  const identity = meta['io.modelcontextprotocol/clientInfo'] || {};
  const payload = {
    arguments: message.params?.arguments || {},
    clientInfo: identity,
    method: message.method || '',
    requestId: message.id ?? null,
    toolName: message.params?.name || ''
  };
  return `mcp-task-${crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}

function isoTimestamp(value, fallback = Date.now()) {
  const parsed = typeof value === 'number' ? value : Date.parse(String(value || ''));
  return new Date(Number.isFinite(parsed) ? parsed : fallback).toISOString();
}

function gatewayToolResult(snapshot = {}) {
  const status = String(snapshot.status || '').toLowerCase();
  if (TOOL_ERROR_STATUSES.has(status)) {
    const failure = new Error(snapshot.error || snapshot.message || 'TraeCN task failed');
    if (typeof snapshot.errorCode === 'string') failure.code = snapshot.errorCode;
    if (status === 'queue_timeout') {
      failure.code = failure.code || 'queue_timeout';
      failure.retryable = true;
      failure.nextAction = 'Retry the delegated task later or select another available model.';
    }
    return asMcpError(failure);
  }
  const value = snapshot.result && typeof snapshot.result === 'object'
    ? snapshot.result
    : snapshot;
  return asMcpContent(value);
}

function hasPendingTaskPersistence(snapshot) {
  return Boolean(snapshot?.statePersistencePending || snapshot?.cancelPersistencePending);
}

function taskInputDescriptor(snapshot = {}) {
  if (hasPendingTaskPersistence(snapshot)) return null;
  const gatewayStatus = String(snapshot.status || '').toLowerCase();
  const result = snapshot.result && typeof snapshot.result === 'object' ? snapshot.result : {};
  let kind = null;
  let request = null;

  if (gatewayStatus === 'approval_required' && result.command) {
    kind = 'commandApproval';
    const risk = String(result.commandRisk || 'unknown');
    const reasons = normalizedOptions(result.riskReasons);
    request = {
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: [
          'TraeCN requests permission to run this exact command:',
          String(result.command),
          `Risk: ${risk}`,
          ...(reasons.length > 0 ? [`Reasons: ${reasons.join(', ')}`] : [])
        ].join('\n'),
        requestedSchema: {
          type: 'object',
          properties: {
            decision: { type: 'string', enum: ['approve', 'deny'] },
            acknowledgeRisk: { type: 'boolean' },
            reason: { type: 'string', minLength: 1, maxLength: 500 }
          },
          required: ['decision']
        }
      }
    };
  } else if (gatewayStatus === 'approval_required'
      && (result.dialogType === 'review_scope_question' || result.question)) {
    kind = 'question';
    const options = normalizedOptions(result.options);
    request = {
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: String(result.question || 'TraeCN requires an answer before continuing.'),
        requestedSchema: {
          type: 'object',
          properties: {
            answer: {
              type: 'string',
              ...(options.length > 0 ? { enum: options } : {})
            }
          },
          required: ['answer']
        }
      }
    };
  } else if (gatewayStatus === 'awaiting_review') {
    kind = 'review';
    request = {
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: String(result.text || 'Review the TraeCN result before continuing.'),
        requestedSchema: {
          type: 'object',
          properties: {
            decision: { type: 'string', enum: ['approve', 'continue', 'reject'] },
            notes: { type: 'string', maxLength: 4000 }
          },
          required: ['decision']
        }
      }
    };
  }

  if (!kind || !request) return null;
  const fallbackId = crypto.createHash('sha256').update(canonicalJson({
    taskId: snapshot.taskId || '',
    status: gatewayStatus,
    createdAt: snapshot.createdAt || null,
    dialogType: result.dialogType || null,
    question: result.question || null,
    command: result.command || null
  })).digest('hex').slice(0, 24);
  const interactionId = String(snapshot.interactionRequestId || fallbackId);
  return {
    kind,
    key: `traecn.${kind}.${interactionId}`,
    request
  };
}

function detailedTaskFromGateway(snapshot = {}) {
  const gatewayStatus = String(snapshot.status || '').toLowerCase();
  const createdAt = isoTimestamp(snapshot.createdAt);
  const metadata = {
    ...(snapshot.metadata && typeof snapshot.metadata === 'object' && !Array.isArray(snapshot.metadata)
      ? snapshot.metadata : {}),
    ...(typeof snapshot.workflowParentTaskId === 'string' && snapshot.workflowParentTaskId.trim()
      ? { workflowParentTaskId: snapshot.workflowParentTaskId } : {}),
    ...(typeof snapshot.nextTaskId === 'string' && snapshot.nextTaskId.trim()
      ? { nextTaskId: snapshot.nextTaskId } : {})
  };
  const task = {
    taskId: String(snapshot.taskId || ''),
    status: 'working',
    ...(snapshot.message ? { statusMessage: String(snapshot.message) } : {}),
    createdAt,
    lastUpdatedAt: isoTimestamp(
      snapshot.completedAt || snapshot.updatedAt || snapshot.submittedAt || snapshot.createdAt,
      Date.parse(createdAt)
    ),
    ttlMs: DEFAULT_TASK_TTL_MS,
    pollIntervalMs: DEFAULT_TASK_POLL_INTERVAL_MS,
    ...(Object.keys(metadata).length ? { metadata } : {})
  };

  if (hasPendingTaskPersistence(snapshot)) return task;

  if (gatewayStatus === 'done' || TOOL_ERROR_STATUSES.has(gatewayStatus)) {
    task.status = 'completed';
    task.result = gatewayToolResult(snapshot);
  } else if (gatewayStatus === 'cancelled') {
    task.status = 'cancelled';
  } else {
    const input = taskInputDescriptor(snapshot);
    if (input) {
      task.status = 'input_required';
      task.inputRequests = { [input.key]: input.request };
    }
  }
  return task;
}

function taskSubscriptionNotification(task, subscriptionId) {
  return {
    jsonrpc: '2.0',
    method: 'notifications/tasks',
    params: {
      ...task,
      _meta: {
        ...(task && task._meta && typeof task._meta === 'object' ? task._meta : {}),
        [SUBSCRIPTION_ID_META_KEY]: subscriptionId
      }
    }
  };
}

class McpTaskAdapter {
  constructor(options = {}) {
    if (!options.client) throw new Error('McpTaskAdapter requires a gateway client');
    this.client = options.client;
  }

  async _requestGateway(method, ...args) {
    try {
      return await this.client[method](...args);
    } catch {
      throw new McpProtocolError(-32603, 'Gateway task request could not complete');
    }
  }

  async create(submission = {}) {
    const taskId = String(submission.taskId || '').trim();
    if (!taskId) {
      throw new McpProtocolError(-32603, 'Gateway did not return a durable task identifier');
    }
    const task = await this.get(taskId);
    const seed = Object.fromEntries(
      Object.entries(task).filter(([key]) => !['result', 'error', 'inputRequests'].includes(key))
    );
    return { resultType: 'task', ...seed };
  }

  async _getGatewaySnapshot(taskId) {
    const normalizedTaskId = typeof taskId === 'string' ? taskId.trim() : '';
    if (!normalizedTaskId) throw new McpProtocolError(-32602, 'taskId is required');
    const response = await this._requestGateway('getTaskStatus', normalizedTaskId);
    if (Number(response?.status) === 404) {
      throw new McpProtocolError(-32602, `Failed to retrieve task: ${normalizedTaskId} was not found`);
    }
    if (Number(response?.status) >= 400) {
      throw new McpProtocolError(-32603, 'Failed to retrieve task from the gateway');
    }
    const snapshot = response && response.data !== undefined ? response.data : response;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new McpProtocolError(-32603, 'Gateway returned an invalid task snapshot');
    }
    if (snapshot.taskId !== undefined && snapshot.taskId !== normalizedTaskId) {
      throw new McpProtocolError(-32603, 'Gateway returned a mismatched task identifier');
    }
    return { ...snapshot, taskId: normalizedTaskId };
  }

  async get(taskId) {
    return detailedTaskFromGateway(await this._getGatewaySnapshot(taskId));
  }

  _assertMutationSucceeded(response, action) {
    if (Number(response?.status) >= 400 || response?.data?.success === false) {
      throw new McpProtocolError(-32603, `Gateway failed to ${action}`);
    }
  }

  async update(taskId, inputResponses = {}) {
    const snapshot = await this._getGatewaySnapshot(taskId);
    const input = taskInputDescriptor(snapshot);
    if (!input || !Object.prototype.hasOwnProperty.call(inputResponses, input.key)) return {};

    const response = inputResponses[input.key];
    if (!response || typeof response !== 'object' || Array.isArray(response)
        || !['accept', 'decline', 'cancel'].includes(response.action)) {
      throw new McpProtocolError(-32602, 'Task input requires an accept, decline, or cancel action');
    }
    const action = response.action;
    let content = {};
    if (action === 'accept') {
      try {
        content = validateMcpToolArguments({ inputSchema: input.request.params.requestedSchema }, response.content);
      } catch (error) {
        throw new McpProtocolError(-32602, error.message);
      }
    }
    let gatewayResponse;

    if (input.kind === 'commandApproval') {
      const decision = action === 'accept' ? String(content.decision || '').toLowerCase() : 'deny';
      if (!['approve', 'deny'].includes(decision)) {
        throw new McpProtocolError(-32602, 'Command approval decision must be approve or deny');
      }
      if (decision === 'approve') {
        const reason = (content.reason || '').trim();
        if (content.acknowledgeRisk !== true || !reason || reason.length > 500) {
          throw new McpProtocolError(
            -32602,
            'Command approval requires acknowledgeRisk=true and a reason of 1-500 characters'
          );
        }
        gatewayResponse = await this._requestGateway('resolveInteraction', {
          action: 'approve',
          expectedCommand: String(snapshot.result.command),
          acknowledgeRisk: true,
          reason
        });
      } else {
        gatewayResponse = await this._requestGateway('resolveInteraction', { action: 'deny' });
      }
    } else if (input.kind === 'question') {
      if (action !== 'accept') {
        gatewayResponse = await this._requestGateway('resolveInteraction', { action: 'dismiss' });
      } else {
        const answer = content.answer.trim();
        if (!answer) throw new McpProtocolError(-32602, 'Question response requires an answer');
        gatewayResponse = await this._requestGateway('resolveInteraction', { action: 'answer', answer });
      }
    } else {
      const decision = action === 'accept' ? String(content.decision || '').toLowerCase() : 'reject';
      if (!['approve', 'continue', 'reject'].includes(decision)) {
        throw new McpProtocolError(-32602, 'Review decision must be approve, continue, or reject');
      }
      gatewayResponse = await this._requestGateway(
        'resolveTaskReview',
        snapshot.taskId,
        decision,
        content.notes || ''
      );
    }

    this._assertMutationSucceeded(gatewayResponse, 'apply task input');
    return {};
  }

  async cancel(taskId) {
    const snapshot = await this._getGatewaySnapshot(taskId);
    const current = detailedTaskFromGateway(snapshot);
    // An unconfirmed task state must reach the gateway cancellation endpoint
    // before this cancellation request can be acknowledged.
    if (['completed', 'cancelled'].includes(current.status) && !hasPendingTaskPersistence(snapshot)) return {};
    const response = await this._requestGateway('cancelTask', current.taskId);
    const statusCode = Number(response?.status);
    if (statusCode === 404) {
      throw new McpProtocolError(-32602, `Failed to cancel task: ${taskId} was not found`);
    }
    if (statusCode >= 400 || response?.data?.success === false) {
      const gatewayStatus = String(response?.data?.status || '').toLowerCase();
      if (statusCode === 400 && !hasPendingTaskPersistence(snapshot)
          && !hasPendingTaskPersistence(response?.data)
          && TERMINAL_GATEWAY_STATUSES.has(gatewayStatus)) return {};
      const detail = typeof response?.data?.error === 'string'
        ? response.data.error.trim()
        : '';
      throw new McpProtocolError(
        -32603,
        detail
          ? `Failed to forward task cancellation to the gateway: ${detail}`
          : 'Failed to forward task cancellation to the gateway'
      );
    }
    return {};
  }
}

module.exports = {
  DEFAULT_TASK_POLL_INTERVAL_MS,
  DEFAULT_TASK_TTL_MS,
  SUBSCRIPTION_ID_META_KEY,
  TASKS_EXTENSION_ID,
  McpTaskAdapter,
  assertTaskExtension,
  clientSupportsTaskExtension,
  detailedTaskFromGateway,
  taskIdempotencyKey,
  taskSubscriptionNotification
};
