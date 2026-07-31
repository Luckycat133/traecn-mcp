'use strict';

/**
 * MCP stdio 传输层 — 通过 stdin/stdout 与 MCP 客户端通信。
 * 从 mcp-server.js 拆分，保持单一职责。
 */

const { createMcpHandlers, envContext } = require('./handler');
const { TraeCNApiClient } = require('../client/traecnapi-client');
const { McpProtocolError, isModernRequest } = require('./protocol');

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
          protocolEra = nextProtocolEra(protocolEra, request);
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
    if (taskEventPump) taskEventPump.stop();
  };
  input.on('end', stop);
  input.on('close', stop);
  return { stop, getTaskEventPump: () => taskEventPump };
}

module.exports = {
  McpStdioDecoder,
  TaskEventPump,
  encodeMessage,
  nextProtocolEra,
  stableMcpClientId,
  taskEventNotification,
  writeMessage,
  startStdioServer
};
