'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
const { MCP_TOOL_NAMES } = require('./contract');
const { createRunner } = require('../shared/test-runner');

const runner = createRunner('protocol-conformance.test.js');
const { asyncTest, pendingAsyncTests, summary } = runner;
const serverEntry = path.resolve(__dirname, '..', '..', 'mcp-server.js');

function serverEnvironment(extra = {}) {
  return {
    ...process.env,
    TRAECN_GATEWAY_HOST: '127.0.0.1',
    TRAECN_GATEWAY_TIMEOUT_MS: '1000',
    ...extra
  };
}

async function withOfficialClient(options, callback) {
  const client = new Client(
    { name: options.name, version: '1.0.0' },
    {
      capabilities: options.capabilities || {},
      supportedProtocolVersions: options.supportedProtocolVersions,
      versionNegotiation: options.versionNegotiation
    }
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: path.resolve(__dirname, '..', '..'),
    env: serverEnvironment(options.env),
    stderr: 'pipe'
  });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  try {
    await client.connect(transport, { timeout: 5000 });
    await callback(client);
  } catch (error) {
    if (stderr.trim()) error.message += `\nserver stderr: ${stderr.trim()}`;
    throw error;
  } finally {
    await client.close().catch(() => {});
  }
}

function startFakeGateway() {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/task/conformance-task') {
      response.writeHead(200);
      response.end(JSON.stringify({
        taskId: 'conformance-task',
        status: 'done',
        result: { text: 'independent client result', stable: true }
      }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

class RawStdioPeer {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.frames = [];
    this.waiters = [];
    this.child = spawn(process.execPath, [serverEntry], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: serverEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.stderr = '';
    this.child.stderr.on('data', chunk => { this.stderr += chunk.toString('utf8'); });
    this.child.stdout.on('data', chunk => this._decode(chunk));
  }

  _decode(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (this.buffer.length > 0) {
      let framing = 'newline';
      let payload;
      if (this.buffer.toString('utf8', 0, 15).toLowerCase().startsWith('content-length:')) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const header = this.buffer.slice(0, headerEnd).toString('utf8');
        const match = header.match(/^Content-Length:\s*(\d+)$/im);
        if (!match) throw new Error(`Invalid server Content-Length header: ${header}`);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + Number(match[1]);
        if (this.buffer.length < bodyEnd) return;
        payload = this.buffer.slice(bodyStart, bodyEnd).toString('utf8');
        this.buffer = this.buffer.slice(bodyEnd);
        framing = 'content-length';
      } else {
        const lineEnd = this.buffer.indexOf('\n');
        if (lineEnd === -1) return;
        payload = this.buffer.slice(0, lineEnd).toString('utf8').replace(/\r$/, '');
        this.buffer = this.buffer.slice(lineEnd + 1);
        if (!payload.trim()) continue;
      }
      const frame = { framing, message: JSON.parse(payload) };
      this.frames.push(frame);
      this._flushWaiters();
    }
  }

  _flushWaiters() {
    for (const waiter of [...this.waiters]) {
      const index = this.frames.findIndex(waiter.predicate);
      if (index === -1) continue;
      clearTimeout(waiter.timer);
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(this.frames.splice(index, 1)[0]);
    }
  }

  waitFor(predicate, timeoutMs = 3000) {
    const index = this.frames.findIndex(predicate);
    if (index !== -1) return Promise.resolve(this.frames.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`Timed out waiting for stdio frame; stderr=${this.stderr.trim() || '<empty>'}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  send(message, framing = 'newline') {
    const payload = JSON.stringify(message);
    const frame = framing === 'content-length'
      ? `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`
      : `${payload}\n`;
    this.child.stdin.write(frame);
  }

  async close() {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    await Promise.race([
      new Promise(resolve => this.child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 500))
    ]);
    if (this.child.exitCode === null) this.child.kill('SIGTERM');
  }
}

function assertSurface(result) {
  assert.deepStrictEqual(result.tools.map(tool => tool.name), MCP_TOOL_NAMES);
}

(async () => {
  await asyncTest('official SDK negotiates the legacy 2024 newline lifecycle', async () => {
    await withOfficialClient({
      name: 'conformance-2024',
      supportedProtocolVersions: ['2024-11-05']
    }, async client => {
      assert.strictEqual(client.getProtocolEra(), 'legacy');
      assert.strictEqual(client.getNegotiatedProtocolVersion(), '2024-11-05');
      assertSurface(await client.listTools(undefined, { cacheMode: 'bypass' }));
      assert.ok((await client.listPrompts(undefined, { cacheMode: 'bypass' })).prompts.length > 0);
      assert.ok((await client.listResources(undefined, { cacheMode: 'bypass' })).resources.length > 0);
      await client.ping({ timeout: 2000 });
    });
  });

  await asyncTest('official SDK negotiates legacy 2025 and advertised logging', async () => {
    await withOfficialClient({
      name: 'conformance-2025',
      supportedProtocolVersions: ['2025-11-25']
    }, async client => {
      assert.strictEqual(client.getProtocolEra(), 'legacy');
      assert.strictEqual(client.getNegotiatedProtocolVersion(), '2025-11-25');
      assert.ok(client.getServerCapabilities().logging);
      await client.setLoggingLevel('notice', { timeout: 2000 });
      assertSurface(await client.listTools(undefined, { cacheMode: 'bypass' }));
    });
  });

  await asyncTest('official SDK pins modern 2026 discovery and typed results', async () => {
    const gateway = await startFakeGateway();
    try {
      await withOfficialClient({
        name: 'conformance-2026',
        supportedProtocolVersions: ['2026-07-28'],
        versionNegotiation: { mode: { pin: '2026-07-28' }, probe: { timeoutMs: 2000 } },
        env: { TRAECN_GATEWAY_PORT: String(gateway.address().port) }
      }, async client => {
        assert.strictEqual(client.getProtocolEra(), 'modern');
        assert.strictEqual(client.getNegotiatedProtocolVersion(), '2026-07-28');
        assert.strictEqual(client.getServerVersion().name, 'traecnclaw');
        const discovery = client.getDiscoverResult();
        assert.ok(discovery.supportedVersions.includes('2026-07-28'));
        assert.strictEqual(discovery.cacheScope, 'private');
        assert.ok(discovery.ttlMs > 0);
        assertSurface(await client.listTools(undefined, { cacheMode: 'bypass' }));
        const result = await client.callTool({
          name: 'traecn_get_task',
          arguments: { taskId: 'conformance-task' }
        }, { timeout: 3000 });
        assert.strictEqual(result.isError, false);
        assert.deepStrictEqual(JSON.parse(result.content[0].text), result.structuredContent);
      });
    } finally {
      await new Promise(resolve => gateway.close(resolve));
    }
  });

  await asyncTest('official client observes strict missing and extra tool arguments', async () => {
    await withOfficialClient({
      name: 'conformance-arguments',
      supportedProtocolVersions: ['2025-11-25']
    }, async client => {
      await client.listTools(undefined, { cacheMode: 'bypass' });
      const missing = await client.callTool({ name: 'traecn_get_task', arguments: {} });
      assert.strictEqual(missing.isError, true);
      assert.match(missing.content[0].text, /Missing required argument: taskId/);
      const extra = await client.callTool({
        name: 'traecn_get_task',
        arguments: { taskId: 'task-1', unexpected: true }
      });
      assert.strictEqual(extra.isError, true);
      assert.match(extra.content[0].text, /Unexpected argument: unexpected/);
    });
  });

  await asyncTest('independent transcript client verifies Content-Length and era pinning', async () => {
    const peer = new RawStdioPeer();
    try {
      peer.send({
        jsonrpc: '2.0',
        id: 'init-cl',
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'raw-content-length', version: '1.0.0' }
        }
      }, 'content-length');
      const initialized = await peer.waitFor(frame => frame.message.id === 'init-cl');
      assert.strictEqual(initialized.framing, 'content-length');
      assert.strictEqual(initialized.message.result.protocolVersion, '2025-11-25');

      peer.send({ jsonrpc: '2.0', method: 'notifications/initialized' }, 'content-length');
      peer.send({ jsonrpc: '2.0', id: 'list-cl', method: 'tools/list', params: {} }, 'content-length');
      const listed = await peer.waitFor(frame => frame.message.id === 'list-cl');
      assert.strictEqual(listed.framing, 'content-length');
      assert.deepStrictEqual(listed.message.result.tools.map(tool => tool.name), MCP_TOOL_NAMES);

      peer.send({
        jsonrpc: '2.0',
        id: 'switch-era',
        method: 'server/discover',
        params: { _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {}
        } }
      }, 'content-length');
      const switched = await peer.waitFor(frame => frame.message.id === 'switch-era');
      assert.strictEqual(switched.framing, 'content-length');
      assert.strictEqual(switched.message.error.code, -32600);
    } finally {
      await peer.close();
    }
  });

  await asyncTest('independent transcript client verifies JSON-RPC errors and recovery', async () => {
    const peer = new RawStdioPeer();
    try {
      peer.child.stdin.write('{malformed json}\n');
      const malformed = await peer.waitFor(frame => frame.message.id === null);
      assert.strictEqual(malformed.message.error.code, -32700);

      peer.send({ jsonrpc: '2.0', id: 'invalid-start', params: {} });
      const invalidStart = await peer.waitFor(frame => frame.message.id === 'invalid-start');
      assert.strictEqual(invalidStart.message.error.code, -32600);

      peer.send({
        jsonrpc: '2.0',
        id: 'init-after-error',
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'raw-errors', version: '1.0.0' }
        }
      });
      const initialized = await peer.waitFor(frame => frame.message.id === 'init-after-error');
      assert.strictEqual(initialized.message.result.protocolVersion, '2025-11-25');

      peer.send({ jsonrpc: '1.0', id: 'bad-version', method: 'tools/list', params: {} });
      const invalidVersion = await peer.waitFor(frame => frame.message.id === 'bad-version');
      assert.strictEqual(invalidVersion.message.error.code, -32600);

      peer.send({ jsonrpc: '2.0', id: 'unknown-method', method: 'unknown/method', params: {} });
      const unknown = await peer.waitFor(frame => frame.message.id === 'unknown-method');
      assert.strictEqual(unknown.message.error.code, -32601);
    } finally {
      await peer.close();
    }
  });

  await pendingAsyncTests();
  summary();
  if (runner.failed > 0) process.exitCode = 1;
})();
