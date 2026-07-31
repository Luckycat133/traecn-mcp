#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { MCP_CONTRACT_VERSION, MCP_TOOLS } = require('../../../mcp-server');

function frame(message) {
  return `${JSON.stringify(message)}\n`;
}

function readFrames(stream, expectedCount, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const messages = [];
    const timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);

    stream.on('data', chunk => {
      buffer += chunk.toString('utf8');
      while (true) {
        const lineEnd = buffer.indexOf('\n');
        if (lineEnd === -1) break;
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (!line) continue;
        messages.push(JSON.parse(line));
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
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'skill-smoke', version: '1' }
        }
      }
    }));
    child.stdin.write(frame({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    }));

    const responses = await responsesPromise;
    const discover = responses.find(item => item.id === 1);
    const tools = responses.find(item => item.id === 2);
    assert.ok(discover.result.supportedVersions.includes('2026-07-28'));
    assert.strictEqual(discover.result._meta['io.modelcontextprotocol/serverInfo'].name, 'traecnclaw');
    assert.strictEqual(tools.result.resultType, 'complete');
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
