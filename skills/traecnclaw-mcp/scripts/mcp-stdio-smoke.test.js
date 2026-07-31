#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { MCP_CONTRACT_VERSION, MCP_TOOLS } = require('../../../mcp-server');

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
    env: { ...process.env },
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
    assert.strictEqual(MCP_CONTRACT_VERSION, 5);
    assert.strictEqual(tools.result.tools.length, MCP_TOOLS.length);
    assert.deepStrictEqual(tools.result.tools.map(tool => tool.name), [
      'traecn_send_message',
      'traecn_get_task',
      'traecn_cancel_task',
      'traecn_stop_generation',
      'traecn_open_workspace',
      'traecn_list_models',
      'traecn_select_model',
      'traecn_select_mode',
      'traecn_list_setting_sections',
      'traecn_list_settings',
      'traecn_list_setting_options',
      'traecn_set_setting_toggle',
      'traecn_select_setting_option',
      'traecn_set_setting_text',
      'traecn_list_conversations',
      'traecn_create_conversation',
      'traecn_select_conversation',
      'traecn_delete_conversation',
      'traecn_answer_question',
      'traecn_decide_approval'
    ]);
    console.log(`[mcp-stdio-smoke.test.js] PASS (${tools.result.tools.length} focused tools)`);
  } finally {
    child.kill('SIGTERM');
  }
})().catch(error => {
  console.error(`[mcp-stdio-smoke.test.js] FAIL: ${error.message}`);
  process.exitCode = 1;
});
