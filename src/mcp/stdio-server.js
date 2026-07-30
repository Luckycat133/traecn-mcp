'use strict';

/**
 * MCP stdio 传输层 — 通过 stdin/stdout 与 MCP 客户端通信。
 * 从 mcp-server.js 拆分，保持单一职责。
 */

const { createMcpHandlers, envContext } = require('./handler');
const { TraeCNApiClient } = require('../client/traecnapi-client');

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

function writeMessage(message) {
  const payload = JSON.stringify(message);
  const frame = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
  return new Promise((resolve, reject) => {
    process.stdout.write(frame, error => {
      if (error) reject(error);
      else resolve();
    });
  });
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

function startStdioServer(options = {}) {
  const handlers = options.handlers || createMcpHandlers();
  const write = options.write || writeMessage;
  const clientFactory = options.clientFactory || (context => new TraeCNApiClient(context));
  let taskEventPump = null;
  let initializedClientId = null;
  let buffer = Buffer.alloc(0);
  const startTaskEventPump = () => {
    if (taskEventPump || !initializedClientId) return;
    taskEventPump = new TaskEventPump({
      client: clientFactory(envContext()),
      clientId: initializedClientId,
      write
    });
    taskEventPump.start();
  };

  const input = options.input || process.stdin;
  input.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = buffer.slice(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + length;
      if (buffer.length < messageEnd) return;
      const raw = buffer.slice(messageStart, messageEnd).toString('utf8');
      buffer = buffer.slice(messageEnd);

      Promise.resolve()
        .then(() => JSON.parse(raw))
        .then(async request => {
          const result = await handlers.handle(request);
          if (request.method === 'initialize') {
            initializedClientId = stableMcpClientId(request.params && request.params.clientInfo);
          }
          if (request.id !== undefined && result !== undefined) {
            await Promise.resolve(write({ jsonrpc: '2.0', id: request.id, result }));
          }
          if (request.method === 'notifications/initialized') startTaskEventPump();
        })
        .catch(async error => {
          let id = null;
          try {
            id = JSON.parse(raw).id ?? null;
          } catch {
            // Keep id=null when the request body itself is invalid JSON.
          }
          try {
            await Promise.resolve(write({ jsonrpc: '2.0', id, error: { code: -32000, message: error.message } }));
          } catch {
            // The transport is already closed; no further response is possible.
          }
        });
    }
  });
  const stop = () => {
    if (taskEventPump) taskEventPump.stop();
  };
  input.on('end', stop);
  input.on('close', stop);
  return { stop, getTaskEventPump: () => taskEventPump };
}

module.exports = {
  TaskEventPump,
  stableMcpClientId,
  taskEventNotification,
  writeMessage,
  startStdioServer
};
