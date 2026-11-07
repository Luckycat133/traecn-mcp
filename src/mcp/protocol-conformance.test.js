'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
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

function startFakeGateway(taskResult) {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/task/conformance-task') {
      response.writeHead(200);
      response.end(JSON.stringify(taskResult ? taskResult() : {
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
  constructor(options = {}) {
    this.buffer = Buffer.alloc(0);
    this.frames = [];
    this.waiters = [];
    this.child = spawn(process.execPath, [serverEntry], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: serverEnvironment(options.env),
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
        assert.strictEqual(client.getServerVersion().name, 'traecn-mcp');
        assert.strictEqual(client.getServerVersion().title, 'TraeCN MCP');
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

  await asyncTest('official SDK accepts persisted ISO completion times and preserves epoch/null compatibility', async () => {
    let completedAt = '2026-10-02T16:31:44.993Z';
    const gateway = await startFakeGateway(() => ({
      taskId: 'conformance-task', status: 'done', createdAt: 1790958672386,
      completedAt, fromHistory: typeof completedAt === 'string',
      result: { text: 'durable task answer', stable: true }
    }));
    try {
      await withOfficialClient({
        name: 'conformance-history-timestamps',
        supportedProtocolVersions: ['2026-07-28'],
        versionNegotiation: { mode: { pin: '2026-07-28' }, probe: { timeoutMs: 2000 } },
        env: { TRAECN_GATEWAY_PORT: String(gateway.address().port), TRAECN_GATEWAY_TOKEN: '' }
      }, async client => {
        const listing = await client.listTools(undefined, { cacheMode: 'bypass' });
        assertSurface(listing);
        const toolDefinition = listing.tools.find(tool => tool.name === 'traecn_get_task');
        for (const value of ['2026-10-02T16:31:44.993Z', 1790958704993, null]) {
          completedAt = value;
          const result = await client.callTool({
            name: 'traecn_get_task', arguments: { taskId: 'conformance-task' }
          }, { timeout: 3000, toolDefinition });
          assert.strictEqual(result.isError, false);
          assert.strictEqual(result.structuredContent.completedAt, value);
          assert.strictEqual(result.structuredContent.result.text, 'durable task answer');
          assert.deepStrictEqual(JSON.parse(result.content[0].text), result.structuredContent);
        }
      });
    } finally { await new Promise(resolve => gateway.close(resolve)); }
  });

  await asyncTest('official SDK validates workspace identity without inventing an unknown root path', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-workspace-schema-')));
    const workspacePath = path.join(root, 'workspace');
    fs.mkdirSync(workspacePath);
    const requests = [];
    let gatewayPayload;
    const gateway = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST' && request.url === '/api/open-project') {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
          requests.push(JSON.parse(body));
          response.end(JSON.stringify(gatewayPayload));
        });
        return;
      }
      response.writeHead(404);
      response.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
    try {
      await withOfficialClient({
        name: 'conformance-workspace-output',
        supportedProtocolVersions: ['2026-07-28'],
        versionNegotiation: { mode: { pin: '2026-07-28' }, probe: { timeoutMs: 2000 } },
        env: { TRAECN_GATEWAY_PORT: String(gateway.address().port), TRAECN_GATEWAY_TOKEN: '' }
      }, async client => {
        const listing = await client.listTools(undefined, { cacheMode: 'bypass' });
        const toolDefinition = listing.tools.find(tool => tool.name === 'traecn_open_workspace');
        assert.ok(toolDefinition);
        for (const payload of [
          { alreadyRunning: true, reusedWindow: true,
            verifiedWorkspace: { folderName: 'workspace', rootPath: null } },
          { alreadyRunning: true, alreadyOpen: true, reusedWindow: false,
            verifiedWorkspace: { folderName: 'workspace', rootPath: workspacePath } },
          { verifiedWorkspace: workspacePath },
          { started: true, cdpReady: true }
        ]) {
          gatewayPayload = { success: true, projectPath: workspacePath, ...payload };
          const result = await client.callTool({
            name: 'traecn_open_workspace', arguments: { path: workspacePath }
          }, { timeout: 3000, toolDefinition });
          assert.strictEqual(result.isError, false);
          assert.deepStrictEqual(result.structuredContent, gatewayPayload);
          assert.deepStrictEqual(JSON.parse(result.content[0].text), gatewayPayload);
        }
      });
      assert.strictEqual(requests.length, 4);
      assert.ok(requests.every(request => request.projectPath === workspacePath));
    } finally {
      gateway.closeAllConnections();
      await new Promise(resolve => gateway.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
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

  await asyncTest('modern stdio task cancellation closes its subscription and aborts the HTTP long poll', async () => {
    let beginLongPoll;
    let finishLongPoll;
    const started = new Promise(resolve => { beginLongPoll = resolve; });
    const aborted = new Promise(resolve => { finishLongPoll = resolve; });
    const gateway = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/task/task-subscribed') {
        response.end(JSON.stringify({
          taskId: 'task-subscribed', status: 'done',
          result: { text: 'subscription result', stable: true }
        }));
        return;
      }
      if (url.pathname === '/api/task-events') {
        if (Number(url.searchParams.get('waitMs')) > 0) {
          beginLongPoll();
          response.once('close', finishLongPoll);
        } else {
          response.end(JSON.stringify({ events: [], clientKnown: true, hasMore: false }));
        }
        return;
      }
      response.writeHead(404);
      response.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
    const peer = new RawStdioPeer({ env: {
      TRAECN_GATEWAY_PORT: String(gateway.address().port),
      TRAECN_GATEWAY_TIMEOUT_MS: '5000'
    } });
    const metadata = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {
        extensions: { 'io.modelcontextprotocol/tasks': {} }
      }
    };
    const withTimeout = promise => {
      let timer;
      return Promise.race([
        promise,
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Task subscription HTTP lifecycle timed out')), 3000);
        })
      ]).finally(() => clearTimeout(timer));
    };
    try {
      peer.send({
        jsonrpc: '2.0', id: 'listen-modern', method: 'subscriptions/listen',
        params: { notifications: { taskIds: ['task-subscribed'] }, _meta: metadata }
      });
      await peer.waitFor(frame => frame.message.method === 'notifications/subscriptions/acknowledged');
      const snapshot = await peer.waitFor(frame => frame.message.method === 'notifications/tasks');
      assert.strictEqual(snapshot.message.params.status, 'completed');
      assert.deepStrictEqual(
        JSON.parse(snapshot.message.params.result.content[0].text),
        snapshot.message.params.result.structuredContent
      );
      await withTimeout(started);
      peer.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {
        requestId: 'listen-modern', _meta: metadata
      } });
      const closed = await peer.waitFor(frame => frame.message.id === 'listen-modern');
      assert.strictEqual(closed.message.result.resultType, 'complete');
      await withTimeout(aborted);
    } finally {
      await peer.close();
      gateway.closeAllConnections();
      await new Promise(resolve => gateway.close(resolve));
    }
  });

  await pendingAsyncTests();
  summary();
  if (runner.failed > 0) process.exitCode = 1;
})();
