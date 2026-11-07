'use strict';

/**
 * MCP stdio 传输层 — 通过 stdin/stdout 与 MCP 客户端通信。
 * 从 mcp-server.js 拆分，保持单一职责。
 */

const { createMcpHandlers, envContext } = require('./handler');
const { setTimeout: sleep } = require('timers/promises');
const { TraeCNApiClient } = require('../client/traecnapi-client');
const { McpProtocolError, assertModernRequest, isModernRequest, modernResult, requestMeta } = require('./protocol');
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
        const match = header.match(/^Content-Length:\s*(\d+)\s*$/im);
        const bodyStart = headerEnd + 4;
        const bodyLength = match ? Number(match[1]) : NaN;
        if (!Number.isSafeInteger(bodyLength)) {
          this.buffer = this.buffer.slice(bodyStart);
          decoded.push({ framing: 'content-length', error: new SyntaxError('Invalid Content-Length frame') });
          continue;
        }
        const bodyEnd = bodyStart + bodyLength;
        if (this.buffer.length < bodyEnd) break;
        const payload = this.buffer.slice(bodyStart, bodyEnd).toString('utf8');
        this.buffer = this.buffer.slice(bodyEnd);
        decoded.push(this.parseFrame(payload, 'content-length'));
        continue;
      }
      const lineEnd = this.buffer.indexOf('\n');
      if (lineEnd === -1) break;
      const line = this.buffer.slice(0, lineEnd).toString('utf8').replace(/\r$/, '');
      this.buffer = this.buffer.slice(lineEnd + 1);
      if (!line.trim()) continue;
      decoded.push(this.parseFrame(line, 'newline'));
    }
    return decoded;
  }

  parseFrame(payload, framing) {
    try {
      return { framing, message: JSON.parse(payload) };
    } catch (error) {
      // A bad payload must not discard neighboring messages or stay buffered.
      return { framing, error };
    }
  }
}

function nextProtocolEra(currentEra, request = {}) {
  const requestedEra = request.method === 'initialize'
    ? 'legacy'
    : (isModernRequest(request) ? 'modern' : null);
  if (requestedEra === 'modern') assertModernRequest(request);
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
  if (message.id !== undefined && typeof message.id !== 'string' && !Number.isInteger(message.id)) {
    throw new McpProtocolError(-32600, 'Invalid JSON-RPC request id');
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

function assertTaskEventResponse(response, operation) {
  if (response?.status !== undefined && Number(response.status) !== 200) {
    throw new Error(`Task event ${operation} failed with HTTP ${response.status}`);
  }
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
    this.historyPrimed = false;
    this.running = false;
    this.stopped = false;
    this.abortController = new AbortController();
    this.loopPromise = null;
  }

  async primeCursor() {
    if (this.stopped) return this.cursor;
    if (this.historyPrimed) return this.cursor;
    let cursor = this.cursor;
    while (true) {
      const request = { limit: 100, waitMs: 0 };
      if (this.running) request.signal = this.abortController.signal;
      if (cursor) request.after = cursor;
      const response = await this.client.listTaskEvents(this.clientId, request);
      if (this.stopped) return this.cursor;
      assertTaskEventResponse(response, 'request');
      const payload = response && response.data !== undefined ? response.data : response;
      if (payload?.clientKnown !== false) {
        this.historyPrimed = true;
        return this.cursor;
      }
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
        throw new Error('Task event cursor did not advance while priming MCP client');
      }
    }
    if (cursor) {
      if (this.stopped) return this.cursor;
      const ack = await this.client.ackTaskEvent(this.clientId, cursor);
      assertTaskEventResponse(ack, 'acknowledgement');
    }
    this.cursor = cursor;
    this.historyPrimed = true;
    return this.cursor;
  }

  async pollOnce() {
    if (this.stopped) return 0;
    const request = { limit: this.limit, waitMs: this.waitMs };
    if (this.running) request.signal = this.abortController.signal;
    if (this.cursor) request.after = this.cursor;
    const response = await this.client.listTaskEvents(this.clientId, request);
    if (this.stopped) return 0;
    assertTaskEventResponse(response, 'request');
    const payload = response && response.data !== undefined ? response.data : response;
    const events = payload && Array.isArray(payload.events) ? payload.events : [];
    let delivered = 0;
    for (const event of events) {
      if (this.stopped) break;
      if (!event.eventId) throw new Error('Task event is missing eventId');
      delivered += await this._deliverEvent(event);
      if (this.stopped) break;
      const ack = await this.client.ackTaskEvent(this.clientId, event.eventId);
      assertTaskEventResponse(ack, 'acknowledgement');
      this.cursor = event.eventId;
    }
    return delivered;
  }

  async _deliverEvent(event) {
    await Promise.resolve(this.write(taskEventNotification(event)));
    return 1;
  }

  start() {
    if (this.stopped) return this.loopPromise || Promise.resolve();
    if (this.running) return this.loopPromise;
    this.running = true;
    this.loopPromise = (async () => {
      while (this.running) {
        try {
          await this.primeCursor();
          await this.deliverInitialSnapshots?.();
          await this.pollOnce();
        } catch {
          if (this.running) {
            await sleep(this.retryMs, undefined, { signal: this.abortController.signal }).catch(() => {});
          }
        }
      }
    })();
    return this.loopPromise;
  }

  stop() {
    this.running = false;
    this.stopped = true;
    this.abortController.abort();
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
    if (this.stopped) return this.cursor;
    if (this.historyPrimed) return this.cursor;
    let cursor = this.cursor;
    while (true) {
      const request = { limit: 100, waitMs: 0 };
      if (this.running) request.signal = this.abortController.signal;
      if (cursor) request.after = cursor;
      const response = await this.client.listTaskEvents(this.clientId, request);
      if (this.stopped) return this.cursor;
      assertTaskEventResponse(response, 'request');
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
    if (this.stopped) return 0;
    if (this.initialSnapshotsDelivered) return 0;
    let delivered = 0;
    for (const taskId of this.taskIds) {
      if (this.stopped) break;
      if (this.deliveredInitialTaskIds.has(taskId)) continue;
      const task = await this.taskAdapter.get(taskId);
      if (this.stopped) break;
      await Promise.resolve(this.write(taskSubscriptionNotification(task, this.subscriptionId)));
      this.deliveredInitialTaskIds.add(taskId);
      delivered += 1;
    }
    this.initialSnapshotsDelivered = this.deliveredInitialTaskIds.size === this.taskIds.size;
    return delivered;
  }

  async _deliverEvent(event) {
    if (!this.taskIds.has(String(event.taskId))) return 0;
    const task = await this.taskAdapter.get(event.taskId);
    if (this.stopped) return 0;
    await Promise.resolve(this.write(taskSubscriptionNotification(task, this.subscriptionId)));
    return 1;
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
  let stopped = false;
  let protocolEra = null;
  let initializedClientId = null;
  const decoder = new McpStdioDecoder();
  let legacyFraming = 'newline';
  const startTaskEventPump = () => {
    if (stopped || taskEventPump || !initializedClientId) return;
    taskEventPump = new TaskEventPump({
      client: clientFactory(envContext()),
      clientId: initializedClientId,
      write: message => write(message, legacyFraming)
    });
    taskEventPump.start();
  };

  const writeError = async (error, framing, id = null) => {
    try {
      await Promise.resolve(write({
        jsonrpc: '2.0',
        id,
        error: {
          code: Number.isInteger(error.code) ? error.code : -32000,
          message: error.message,
          ...(error.data === undefined ? {} : { data: error.data })
        }
      }, framing));
    } catch {
      // The transport is already closed; no further response is possible.
    }
  };

  const closeSubscription = subscription => {
    if (subscription.closing) return subscription.closing;
    if (subscription.pump) subscription.pump.stop();
    subscription.closing = (async () => {
      try {
        // Never deliver the final response ahead of its acknowledgement.
        await subscription.acknowledgement;
        await Promise.resolve(write(
          subscriptionClosedResult(subscription.subscriptionId),
          subscription.framing
        ));
      } catch {
        // A failed acknowledgement or closed transport cannot be completed.
      }
    })();
    return subscription.closing;
  };

  const input = options.input || process.stdin;
  const onData = chunk => {
    if (stopped) return;
    let decoded;
    try {
      decoded = decoder.push(chunk);
    } catch {
      void writeError(new McpProtocolError(-32700, 'Parse error'), legacyFraming);
      return;
    }
    for (const frame of decoded) {
      const request = frame.message;
      Promise.resolve()
        .then(async () => {
          if (stopped) return;
          if (frame.error) throw new McpProtocolError(-32700, 'Parse error');
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
            const key = subscriptionId;
            if (taskSubscriptions.has(key)) {
              throw new McpProtocolError(-32600, 'Subscription request id is already active');
            }
            const { taskIds } = handlers.subscribe(request);
            const subscription = {
              pump: null,
              framing: frame.framing,
              subscriptionId,
              acknowledgement: null,
              closing: null
            };
            // Reserve before the first await so cancellation, shutdown and
            // duplicate IDs can all observe the accepted subscription.
            taskSubscriptions.set(key, subscription);
            try {
              subscription.acknowledgement = Promise.resolve(write(
                subscriptionAcknowledgedNotification(taskIds, subscriptionId),
                frame.framing
              ));
              await subscription.acknowledgement;
              if (stopped || taskSubscriptions.get(key) !== subscription) return;
              if (taskIds.length === 0) return;
              const gatewayClient = clientFactory(envContext());
              const clientInfo = requestMeta(request)?.['io.modelcontextprotocol/clientInfo'] || {};
              const clientId = `${stableMcpClientId(clientInfo)}:task-sub:${typeof subscriptionId}:${String(subscriptionId)}`.slice(0, 200);
              subscription.pump = taskSubscriptionPumpFactory({
                client: gatewayClient,
                taskAdapter: taskAdapterFactory(gatewayClient),
                clientId,
                subscriptionId,
                taskIds,
                write: message => write(message, frame.framing)
              });
              subscription.pump.start();
            } catch (error) {
              if (taskSubscriptions.get(key) === subscription) taskSubscriptions.delete(key);
              if (subscription.pump) subscription.pump.stop();
              throw error;
            }
            return;
          }
          if (request.method === 'notifications/cancelled' && request.params?.requestId !== undefined) {
            const key = request.params.requestId;
            const subscription = taskSubscriptions.get(key);
            if (subscription) {
              taskSubscriptions.delete(key);
              await closeSubscription(subscription);
              return;
            }
          }
          const result = await handlers.handle(request);
          if (stopped) return;
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
          if (stopped || isJsonRpcNotification(request)) return;
          const id = typeof request?.id === 'string' || Number.isInteger(request?.id)
            ? request.id
            : null;
          await writeError(error, frame.framing, id);
        });
    }
  };
  input.on('data', onData);
  const onEnd = () => { void stop(); };
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    input.off('data', onData);
    input.off('end', onEnd);
    input.off('close', onEnd);
    stopPromise = (async () => {
      if (taskEventPump) taskEventPump.stop();
      const subscriptions = [...taskSubscriptions.values()];
      taskSubscriptions.clear();
      await Promise.all(subscriptions.map(closeSubscription));
    })();
    return stopPromise;
  };
  input.on('end', onEnd);
  input.on('close', onEnd);
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
