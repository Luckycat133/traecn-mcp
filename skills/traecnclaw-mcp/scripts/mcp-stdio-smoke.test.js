#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { getMcpToolsForProfile } = require('../../../mcp-server');

function frame(message) {
  const payload = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
}

function readFrames(stream, expectedCount, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const messages = [];
    const timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);

    stream.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const header = buffer.slice(0, headerEnd).toString('utf8');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) return reject(new Error(`Missing Content-Length header: ${header}`));
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + Number(match[1]);
        if (buffer.length < bodyEnd) break;
        messages.push(JSON.parse(buffer.slice(bodyStart, bodyEnd).toString('utf8')));
        buffer = buffer.slice(bodyEnd);
        if (messages.length === expectedCount) {
          clearTimeout(timeout);
          resolve(messages);
          return;
        }
      }
    });
    stream.on('error', reject);
  });
}

(async () => {
  const launcher = path.join(__dirname, 'start-mcp.js');
  const child = spawn(process.execPath, [launcher], {
    cwd: path.resolve(__dirname, '../../..'),
    env: { ...process.env, TRAECN_MCP_TOOL_PROFILE: 'public' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });

  try {
    const responsesPromise = readFrames(child.stdout, 2);
    child.stdin.write(frame({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'skill-smoke', version: '1' } }
    }));
    child.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));

    const responses = await responsesPromise;
    const initialize = responses.find(item => item.id === 1);
    const tools = responses.find(item => item.id === 2);
    assert.strictEqual(initialize.result.serverInfo.name, 'traecnclaw');
    assert.strictEqual(tools.result.tools.length, getMcpToolsForProfile('public').length);
    assert.ok(tools.result.tools.some(tool => tool.name === 'traecn_preflight'));
    console.log(`[mcp-stdio-smoke.test.js] PASS (${tools.result.tools.length} public tools)`);
  } finally {
    child.kill('SIGTERM');
  }
})().catch(error => {
  console.error(`[mcp-stdio-smoke.test.js] FAIL: ${error.message}`);
  process.exitCode = 1;
});
