'use strict';

/**
 * MCP stdio 传输层 — 通过 stdin/stdout 与 MCP 客户端通信。
 * 从 mcp-server.js 拆分，保持单一职责。
 */

const { createMcpHandlers } = require('./handler');

function writeMessage(message) {
  const payload = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
}

function startStdioServer() {
  const handlers = createMcpHandlers();
  let buffer = Buffer.alloc(0);

  process.stdin.on('data', chunk => {
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
          if (request.id === undefined || result === undefined) return;
          writeMessage({ jsonrpc: '2.0', id: request.id, result });
        })
        .catch(error => {
          let id = null;
          try {
            id = JSON.parse(raw).id ?? null;
          } catch {
            // Keep id=null when the request body itself is invalid JSON.
          }
          writeMessage({ jsonrpc: '2.0', id, error: { code: -32000, message: error.message } });
        });
    }
  });
}

module.exports = {
  writeMessage,
  startStdioServer
};