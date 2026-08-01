'use strict';

const crypto = require('crypto');
const { getEnvWithFallback, parsePositiveInt } = require('../shared/utils');
const { asMcpError } = require('./tools');
const { McpProtocolError, requestMeta } = require('./protocol');

const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';
const SUBSCRIPTION_ID_META_KEY = 'io.modelcontextprotocol/subscriptionId';
const DEFAULT_TASK_POLL_INTERVAL_MS = 5000;
const DEFAULT_TASK_TTL_MS = parsePositiveInt(
  getEnvWithFallback('TRAECN_MCP_TASK_TTL_MS', 'TRAE_MCP_TASK_TTL_MS', '604800000'),
  604800000
);

const TOOL_ERROR_STATUSES = new Set(['error', 'queue_timeout', 'review_rejected', 'not_found']);

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
    && capabilities.extensions
    && typeof capabilities.extensions === 'object'
    && capabilities.extensions[TASKS_EXTENSION_ID]
    && typeof capabilities.extensions[TASKS_EXTENSION_ID] === 'object'
  );
}

function assertTaskExtension(message = {}) {
  if (clientSupportsTaskExtension(message)) return true;
  throw new McpProtocolError(-32003, 'Missing required client capability', {
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
  if (TOOL_ERROR_STATUSES.has(String(snapshot.status || '').toLowerCase())) {
    return asMcpError(snapshot.error || snapshot.message || 'TraeCN task failed');
  }
  const value = snapshot.result && typeof snapshot.result === 'object'
    ? snapshot.result
    : snapshot;
  const text = typeof value.text === 'string' && value.text
    ? value.text
    : JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: value,
    isError: false
  };
}

function taskInputDescriptor(snapshot = {}) {
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
    pollIntervalMs: DEFAULT_TASK_POLL_INTERVAL_MS
  };

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
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) throw new McpProtocolError(-32602, 'taskId is required');
    const response = await this.client.getTaskStatus(normalizedTaskId);
    if (Number(response?.status) === 404) {
      throw new McpProtocolError(-32602, `Failed to retrieve task: ${normalizedTaskId} was not found`);
    }
    if (Number(response?.status) >= 400) {
      throw new McpProtocolError(-32603, 'Failed to retrieve task from the gateway');
    }
    const snapshot = response && response.data !== undefined ? response.data : response;
    if (!snapshot || typeof snapshot !== 'object') {
      throw new McpProtocolError(-32603, 'Gateway returned an invalid task snapshot');
    }
    return { taskId: normalizedTaskId, ...snapshot };
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
    if (!response || typeof response !== 'object' || Array.isArray(response)) return {};
    const action = String(response.action || '').toLowerCase();
    const content = response.content && typeof response.content === 'object'
      ? response.content
      : {};
    let gatewayResponse;

    if (input.kind === 'commandApproval') {
      const decision = action === 'accept' ? String(content.decision || '').toLowerCase() : 'deny';
      if (!['approve', 'deny'].includes(decision)) {
        throw new McpProtocolError(-32602, 'Command approval decision must be approve or deny');
      }
      if (decision === 'approve') {
        const reason = String(content.reason || '').trim();
        if (content.acknowledgeRisk !== true || !reason || reason.length > 500) {
          throw new McpProtocolError(
            -32602,
            'Command approval requires acknowledgeRisk=true and a reason of 1-500 characters'
          );
        }
        gatewayResponse = await this.client.resolveInteraction({
          action: 'approve',
          expectedCommand: String(snapshot.result.command),
          acknowledgeRisk: true,
          reason
        });
      } else {
        gatewayResponse = await this.client.resolveInteraction({ action: 'deny' });
      }
    } else if (input.kind === 'question') {
      if (action !== 'accept') {
        gatewayResponse = await this.client.resolveInteraction({ action: 'dismiss' });
      } else {
        const answer = String(content.answer || '').trim();
        if (!answer) throw new McpProtocolError(-32602, 'Question response requires an answer');
        gatewayResponse = await this.client.resolveInteraction({ action: 'answer', answer });
      }
    } else {
      const decision = action === 'accept' ? String(content.decision || '').toLowerCase() : 'reject';
      if (!['approve', 'continue', 'reject'].includes(decision)) {
        throw new McpProtocolError(-32602, 'Review decision must be approve, continue, or reject');
      }
      gatewayResponse = await this.client.resolveTaskReview(
        taskId,
        decision,
        String(content.notes || '').slice(0, 4000)
      );
    }

    this._assertMutationSucceeded(gatewayResponse, 'apply task input');
    return {};
  }

  async cancel(taskId) {
    const current = await this.get(taskId);
    if (['completed', 'cancelled'].includes(current.status)) return {};
    const response = await this.client.cancelTask(taskId);
    if (Number(response?.status) === 404) {
      throw new McpProtocolError(-32602, `Failed to cancel task: ${taskId} was not found`);
    }
    if (Number(response?.status) >= 500) {
      throw new McpProtocolError(-32603, 'Failed to forward task cancellation to the gateway');
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
