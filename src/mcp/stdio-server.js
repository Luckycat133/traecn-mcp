'use strict';

/**
 * MCP stdio 传输层 — 通过 stdin/stdout 与 MCP 客户端通信。
 * 从 mcp-server.js 拆分，保持单一职责。
 */

const { createMcpHandlers, envContext } = require('./handler');
const { TraeCNApiClient } = require('../client/traecnapi-client');
const { McpProtocolError, isModernRequest, modernResult, requestMeta } = require('./protocol');
const {
  SUBSCRIPTION_ID_META_KEY,
  McpTaskAdapter,
  taskSubscriptionNotification
} = require('./task-extension');

const TASK_EVENT_FIELDS = Object.freeze([
  'eventId',
  'type',
  'taskId',
  'status',
  'createdAt',
  'terminal',
  'attentionRequired',
  'resultAvailable',
  'sessionId',
  'summary'
]);

function encodeMessage(message, framing = 'newline') {
  const payload = JSON.stringify(message);
  if (framing === 'content-length') {
    return `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
  }
  return `${payload}\n`;
}

function writeMessage(message, framing = 'newline') {
  const frame = encodeMessage(message, framing);
  return new Promise((resolve, reject) => {
    process.stdout.write(frame, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

class McpStdioDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const decoded = [];
    while (this.buffer.length > 0) {
      if (/^Content-Length:/i.test(this.buffer.toString('utf8', 0, Math.min(this.buffer.length, 15)))) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const header = this.buffer.slice(0, headerEnd).toString('utf8');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) throw new Error('Invalid Content-Length frame');
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + Number(match[1]);
        if (this.buffer.length < bodyEnd) break;
        decoded.push({
          framing: 'content-length',
          message: JSON.parse(this.buffer.slice(bodyStart, bodyEnd).toString('utf8'))
        });
        this.buffer = this.buffer.slice(bodyEnd);
        continue;
      }
      const lineEnd = this.buffer.indexOf('\n');
      if (lineEnd === -1) break;
      const line = this.buffer.slice(0, lineEnd).toString('utf8').replace(/\r$/, '');
      this.buffer = this.buffer.slice(lineEnd + 1);
      if (!line.trim()) continue;
      decoded.push({ framing: 'newline', message: JSON.parse(line) });
    }
    return decoded;
  }
}

function nextProtocolEra(currentEra, request = {}) {
  const requestedEra = request.method === 'initialize'
    ? 'legacy'
    : (isModernRequest(request) ? 'modern' : null);
  if (!currentEra && !requestedEra) {
    throw new McpProtocolError(
      -32600,
      'Start with initialize or modern metadata'
    );
  }
  if (currentEra === 'modern' && !requestedEra) {
    throw new McpProtocolError(-32602, 'Modern MCP requests require per-request metadata');
  }
  if (currentEra && requestedEra && currentEra !== requestedEra) {
    throw new McpProtocolError(-32600, 'This stdio process cannot switch protocol era');
  }
  return currentEra || requestedEra;
}

function assertJsonRpcRequest(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new McpProtocolError(-32600, 'Invalid JSON-RPC request');
  }
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !message.method) {
    throw new McpProtocolError(-32600, 'Invalid JSON-RPC request');
  }
  if (message.params !== undefined
      && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params))) {
    throw new McpProtocolError(-32600, 'Invalid JSON-RPC params');
  }
  return message;
}

function isJsonRpcNotification(message) {
  return Boolean(
    message
    && typeof message === 'object'
    && !Array.isArray(message)
    && message.jsonrpc === '2.0'
    && typeof message.method === 'string'
    && message.method
    && message.id === undefined
  );
}

function stableMcpClientId(clientInfo = {}, env = process.env) {
  const configured = String(env.TRAECN_MCP_CLIENT_ID || '').trim();
  if (configured) return configured;
  const name = String(clientInfo.name || '').trim().toLowerCase();
  const normalized = name
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'traecn-mcp-client';
}

function taskEventNotification(event = {}) {
  const data = { kind: 'traecn_task_event' };
  for (const field of TASK_EVENT_FIELDS) {
    if (event[field] !== undefined && event[field] !== null) data[field] = event[field];
  }
  return {
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: {
      level: event.attentionRequired ? 'warning' : (event.status === 'error' ? 'error' : 'notice'),
      logger: 'traecnclaw.tasks',
      data
    }
  };
}

function subscriptionAcknowledgedNotification(taskIds, subscriptionId) {
  return {
    jsonrpc: '2.0',
    method: 'notifications/subscriptions/acknowledged',
    params: {
      notifications: { taskIds: [...taskIds] },
      _meta: { [SUBSCRIPTION_ID_META_KEY]: subscriptionId }
    }
  };
}

function subscriptionClosedResult(subscriptionId) {
  return {
    jsonrpc: '2.0',
    id: subscriptionId,
    result: modernResult({
      _meta: { [SUBSCRIPTION_ID_META_KEY]: subscriptionId }
    })
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class TaskEventPump {
  constructor(options = {}) {
    this.client = options.client;
    this.clientId = options.clientId;
    this.write = options.write || writeMessage;
    this.waitMs = Number.isFinite(options.waitMs) ? options.waitMs : 25000;
    this.limit = Number.isFinite(options.limit) ? options.limit : 20;
    this.retryMs = Number.isFinite(options.retryMs) ? options.retryMs : 1000;
    this.cursor = options.after || null;
    this.running = false;
    this.loopPromise = null;
  }

  async pollOnce() {
    const request = { limit: this.limit, waitMs: this.waitMs };
    if (this.cursor) request.after = this.cursor;
    const response = await this.client.listTaskEvents(this.clientId, request);
    if (response && Number(response.status) >= 400) {
      throw new Error(`Task event request failed with HTTP ${response.status}`);
    }
    const payload = response && response.data !== undefined ? response.data : response;
    const events = payload && Array.isArray(payload.events) ? payload.events : [];
    for (const event of events) {
      if (!event.eventId) throw new Error('Task event is missing eventId');
      await Promise.resolve(this.write(taskEventNotification(event)));
      const ack = await this.client.ackTaskEvent(this.clientId, event.eventId);
      if (ack && Number(ack.status) >= 400) {
        throw new Error(`Task event acknowledgement failed with HTTP ${ack.status}`);
      }
      this.cursor = event.eventId;
    }
    return events.length;
  }

  start() {
    if (this.running) return this.loopPromise;
    this.running = true;
    this.loopPromise = (async () => {
      while (this.running) {
        try {
          await this.pollOnce();
        } catch {
          if (this.running) await sleep(this.retryMs);
        }
      }
    })();
    return this.loopPromise;
  }

  stop() {
    this.running = false;
  }
}

class TaskSubscriptionPump extends TaskEventPump {
  constructor(options = {}) {
    super(options);
    this.taskAdapter = options.taskAdapter;
    this.subscriptionId = options.subscriptionId;
    this.taskIds = new Set((options.taskIds || []).map(value => String(value)));
    this.deliveredInitialTaskIds = new Set();
    this.initialSnapshotsDelivered = false;
    this.historyPrimed = false;
  }

  async primeCursor() {
    if (this.historyPrimed) return this.cursor;
    let cursor = this.cursor;
    while (true) {
      const request = { limit: 100, waitMs: 0 };
      if (cursor) request.after = cursor;
      const response = await this.client.listTaskEvents(this.clientId, request);
      if (response && Number(response.status) >= 400) {
        throw new Error(`Task event request failed with HTTP ${response.status}`);
      }
      const payload = response && response.data !== undefined ? response.data : response;
      const events = payload && Array.isArray(payload.events) ? payload.events : [];
      for (const event of events) {
        if (!event.eventId) throw new Error('Task event is missing eventId');
      }
      const nextCursor = events.length > 0
        ? events[events.length - 1].eventId
        : (payload?.cursor || cursor);
      const progressed = Boolean(nextCursor && nextCursor !== cursor);
      if (nextCursor) cursor = nextCursor;
      if (payload?.hasMore !== true) break;
      if (!progressed) {
        throw new Error('Task event cursor did not advance while priming subscription');
      }
    }
    this.cursor = cursor;
    this.historyPrimed = true;
    return this.cursor;
  }

  async deliverInitialSnapshots() {
    if (this.initialSnapshotsDelivered) return 0;
    let delivered = 0;
    for (const taskId of this.taskIds) {
      if (this.deliveredInitialTaskIds.has(taskId)) continue;
      const task = await this.taskAdapter.get(taskId);
      await Promise.resolve(this.write(taskSubscriptionNotification(task, this.subscriptionId)));
      this.deliveredInitialTaskIds.add(taskId);
      delivered += 1;
    }
    this.initialSnapshotsDelivered = this.deliveredInitialTaskIds.size === this.taskIds.size;
    return delivered;
  }

  async pollOnce() {
    const request = { limit: this.limit, waitMs: this.waitMs };
    if (this.cursor) request.after = this.cursor;
    const response = await this.client.listTaskEvents(this.clientId, request);
    if (response && Number(response.status) >= 400) {
      throw new Error(`Task event request failed with HTTP ${response.status}`);
    }
    const payload = response && response.data !== undefined ? response.data : response;
    const events = payload && Array.isArray(payload.events) ? payload.events : [];
    let delivered = 0;
    for (const event of events) {
      if (!event.eventId) throw new Error('Task event is missing eventId');
      if (this.taskIds.has(String(event.taskId))) {
        const task = await this.taskAdapter.get(event.taskId);
        await Promise.resolve(this.write(taskSubscriptionNotification(task, this.subscriptionId)));
        delivered += 1;
      }
      const ack = await this.client.ackTaskEvent(this.clientId, event.eventId);
      if (ack && Number(ack.status) >= 400) {
        throw new Error(`Task event acknowledgement failed with HTTP ${ack.status}`);
      }
      this.cursor = event.eventId;
    }
    return delivered;
  }

  start() {
    if (this.running) return this.loopPromise;
    this.running = true;
    this.loopPromise = (async () => {
      while (this.running) {
        try {
          await this.primeCursor();
          await this.deliverInitialSnapshots();
          await this.pollOnce();
        } catch {
          if (this.running) await sleep(this.retryMs);
        }
      }
    })();
    return this.loopPromise;
  }
}

function startStdioServer(options = {}) {
  const handlers = options.handlers || createMcpHandlers();
  const write = options.write || writeMessage;
  const clientFactory = options.clientFactory || (context => new TraeCNApiClient(context));
  const taskAdapterFactory = options.taskAdapterFactory || (client => new McpTaskAdapter({ client }));
  const taskSubscriptionPumpFactory = options.taskSubscriptionPumpFactory
    || (pumpOptions => new TaskSubscriptionPump(pumpOptions));
  let taskEventPump = null;
  const taskSubscriptions = new Map();
  let stopPromise = null;
  let protocolEra = null;
  let initializedClientId = null;
  const decoder = new McpStdioDecoder();
  let legacyFraming = 'newline';
  const startTaskEventPump = () => {
    if (taskEventPump || !initializedClientId) return;
    taskEventPump = new TaskEventPump({
      client: clientFactory(envContext()),
      clientId: initializedClientId,
      write: message => write(message, legacyFraming)
    });
    taskEventPump.start();
  };

  const input = options.input || process.stdin;
  input.on('data', chunk => {
    let decoded;
    try {
      decoded = decoder.push(chunk);
    } catch (error) {
      Promise.resolve(write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: error.message } }));
      return;
    }
    for (const frame of decoded) {
      const request = frame.message;
      Promise.resolve()
        .then(async () => {
          assertJsonRpcRequest(request);
          protocolEra = nextProtocolEra(protocolEra, request);
          if (request.method === 'subscriptions/listen') {
            if (request.id === undefined || request.id === null) {
              throw new McpProtocolError(-32600, 'subscriptions/listen requires a request id');
            }
            if (typeof handlers.subscribe !== 'function') {
              throw new McpProtocolError(-32601, 'Task subscriptions are unavailable');
            }
            const subscriptionId = request.id;
            const key = String(subscriptionId);
            if (taskSubscriptions.has(key)) {
              throw new McpProtocolError(-32600, 'Subscription request id is already active');
            }
            const { taskIds } = handlers.subscribe(request);
            await Promise.resolve(write(
              subscriptionAcknowledgedNotification(taskIds, subscriptionId),
              frame.framing
            ));
            const gatewayClient = clientFactory(envContext());
            const clientInfo = requestMeta(request)?.['io.modelcontextprotocol/clientInfo'] || {};
            const clientId = `${stableMcpClientId(clientInfo)}:task-sub:${String(subscriptionId)}`.slice(0, 200);
            const pump = taskSubscriptionPumpFactory({
              client: gatewayClient,
              taskAdapter: taskAdapterFactory(gatewayClient),
              clientId,
              subscriptionId,
              taskIds,
              write: message => write(message, frame.framing)
            });
            taskSubscriptions.set(key, {
              pump,
              framing: frame.framing,
              subscriptionId
            });
            pump.start();
            return;
          }
          if (request.method === 'notifications/cancelled' && request.params?.requestId !== undefined) {
            const key = String(request.params.requestId);
            const subscription = taskSubscriptions.get(key);
            if (subscription) {
              subscription.pump.stop();
              taskSubscriptions.delete(key);
              await Promise.resolve(write(
                subscriptionClosedResult(subscription.subscriptionId),
                subscription.framing
              ));
              return;
            }
          }
          const result = await handlers.handle(request);
          if (request.method === 'initialize') {
            legacyFraming = frame.framing;
            initializedClientId = stableMcpClientId(request.params && request.params.clientInfo);
          }
          if (request.id !== undefined && result !== undefined) {
            await Promise.resolve(write(
              { jsonrpc: '2.0', id: request.id, result },
              frame.framing
            ));
          }
          if (request.method === 'notifications/initialized') startTaskEventPump();
        })
        .catch(async error => {
          if (isJsonRpcNotification(request)) return;
          try {
            await Promise.resolve(write({
              jsonrpc: '2.0',
              id: request.id ?? null,
              error: {
                code: Number.isInteger(error.code) ? error.code : -32000,
                message: error.message,
                ...(error.data === undefined ? {} : { data: error.data })
              }
            }, frame.framing));
          } catch {
            // The transport is already closed; no further response is possible.
          }
        });
    }
  });
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (taskEventPump) taskEventPump.stop();
      const subscriptions = [...taskSubscriptions.values()];
      taskSubscriptions.clear();
      for (const subscription of subscriptions) {
        subscription.pump.stop();
        try {
          await Promise.resolve(write(
            subscriptionClosedResult(subscription.subscriptionId),
            subscription.framing
          ));
        } catch {
          // The transport may already be gone during process teardown.
        }
      }
    })();
    return stopPromise;
  };
  input.on('end', () => { void stop(); });
  input.on('close', () => { void stop(); });
  return {
    stop,
    getTaskEventPump: () => taskEventPump,
    getTaskSubscriptions: () => new Map(
      [...taskSubscriptions].map(([key, subscription]) => [key, subscription.pump])
    )
  };
}

module.exports = {
  McpStdioDecoder,
  TaskEventPump,
  TaskSubscriptionPump,
  assertJsonRpcRequest,
  encodeMessage,
  nextProtocolEra,
  stableMcpClientId,
  subscriptionAcknowledgedNotification,
  subscriptionClosedResult,
  taskEventNotification,
  writeMessage,
  startStdioServer
};
