'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const EXPECTED_TOOLS = [
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
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: 'utf8'
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return result;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function requestStatus(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/status' }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.setTimeout(1000, () => request.destroy(new Error('status timeout')));
  });
}

async function waitForGateway(port, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`gateway exited with ${child.exitCode}`);
    try {
      if (await requestStatus(port) === 200) return;
    } catch {
      // Gateway startup is still in progress.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('gateway did not become ready');
}

function createJsonLineClient(child) {
  let nextId = 1;
  let buffer = '';
  const pending = new Map();
  const notifications = [];
  const notificationWaiters = [];
  const deliverNotification = message => {
    const index = notificationWaiters.findIndex(waiter => waiter.predicate(message));
    if (index === -1) {
      notifications.push(message);
      return;
    }
    const [waiter] = notificationWaiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  };
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    while (buffer.includes('\n')) {
      const lineEnd = buffer.indexOf('\n');
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) {
        deliverNotification(message);
        continue;
      }
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  });

  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request timed out: ${method}`));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    openSubscription(params) {
      const id = nextId++;
      const acknowledged = this.waitForNotification(message => (
        message.method === 'notifications/subscriptions/acknowledged'
        && String(message.params?._meta?.['io.modelcontextprotocol/subscriptionId']) === String(id)
      ));
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id, method: 'subscriptions/listen', params
      })}\n`);
      return { id, acknowledged };
    },
    waitForNotification(predicate, timeoutMs = 30000) {
      const existingIndex = notifications.findIndex(predicate);
      if (existingIndex !== -1) {
        return Promise.resolve(notifications.splice(existingIndex, 1)[0]);
      }
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = notificationWaiters.indexOf(waiter);
          if (index !== -1) notificationWaiters.splice(index, 1);
          reject(new Error('MCP notification timed out'));
        }, timeoutMs);
        notificationWaiters.push(waiter);
      });
    },
    cancelSubscription(id, meta) {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: id, _meta: meta }
      })}\n`);
    }
  };
}

function modernParams(extra = {}, options = {}) {
  return {
    ...extra,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': options.tasks === true
        ? { extensions: { 'io.modelcontextprotocol/tasks': {} } }
        : {},
      'io.modelcontextprotocol/clientInfo': { name: 'clean-room-test', version: '1' }
    }
  };
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2000))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'traecnclaw-clean-room-'));
  const cleanHome = path.join(root, 'home');
  const codexHome = path.join(cleanHome, '.codex');
  const runtime = path.join(root, 'runtime');
  const skillRoot = path.join(codexHome, 'skills');
  let gateway;
  let mcp;
  let gatewayStdout = '';
  let gatewayStderr = '';
  let mcpStderr = '';

  try {
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.mkdirSync(runtime, { recursive: true });
    run(process.execPath, [path.join(__dirname, 'package-skill.js')]);
    const manifest = JSON.parse(fs.readFileSync(
      path.join(repoRoot, 'dist', 'traecnclaw-mcp-release.json'),
      'utf8'
    ));
    run('tar', [
      '-xzf',
      path.join(repoRoot, manifest.artifacts.find(item => item.path.endsWith('.tgz')).path),
      '-C',
      skillRoot
    ]);
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefix',
      runtime,
      path.join(repoRoot, manifest.serverPackage.artifact.path)
    ], { cwd: runtime });

    const operatorEnv = {
      ...process.env,
      HOME: cleanHome,
      CODEX_HOME: codexHome
    };
    const cli = path.join(
      runtime,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'traecnclaw.cmd' : 'traecnclaw'
    );
    const help = run(cli, ['--help'], { cwd: runtime, env: operatorEnv });
    assert.match(help.stdout, /setup-mcp/);
    assert.match(help.stdout, /service start/);
    const setup = run(cli, ['setup-mcp'], { cwd: runtime, env: operatorEnv });
    const setupConfig = JSON.parse(setup.stdout);
    assert.ok(setupConfig.mcpServers?.traecn);
    assert.match(setupConfig.mcpServers.traecn.args[0], /start-mcp\.js$/);

    const port = await freePort();
    const env = {
      ...process.env,
      HOME: cleanHome,
      CODEX_HOME: codexHome,
      TRAECN_ENABLE_MOCK_BRIDGE: '1',
      TRAECN_GATEWAY_HOST: '127.0.0.1',
      TRAECN_GATEWAY_PORT: String(port),
      TRAECN_GATEWAY_TIMEOUT_MS: '5000',
      TRAECN_RESPONSE_TIMEOUT_MS: '5000',
      TRAECN_QUIET_LOG: '1'
    };
    const installedPackage = path.join(runtime, 'node_modules', '@luckycat133', 'traecnclaw');
    gateway = spawn(process.execPath, [path.join(installedPackage, 'scripts', 'start-gateway.js')], {
      cwd: runtime,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    gateway.stdout.on('data', chunk => { gatewayStdout += chunk.toString('utf8'); });
    gateway.stderr.on('data', chunk => { gatewayStderr += chunk.toString('utf8'); });
    await waitForGateway(port, gateway);

    const launcher = path.join(skillRoot, 'traecnclaw-mcp', 'scripts', 'start-mcp.js');
    mcp = spawn(process.execPath, [launcher], {
      cwd: runtime,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    mcp.stderr.on('data', chunk => { mcpStderr += chunk.toString('utf8'); });
    const client = createJsonLineClient(mcp);

    const discovery = await client.request('server/discover', modernParams());
    assert.ok(discovery.supportedVersions.includes('2026-07-28'));
    const tools = await client.request('tools/list', modernParams());
    assert.deepStrictEqual(tools.tools.map(tool => tool.name), EXPECTED_TOOLS);

    const submitted = await client.request('tools/call', modernParams({
      name: 'traecn_send_message',
      arguments: { message: 'Return the clean-room mock response.' }
    }, { tasks: true }));
    assert.strictEqual(submitted.resultType, 'task');
    assert.strictEqual(submitted.status, 'working');
    const taskId = submitted.taskId;
    assert.ok(taskId);

    const taskMeta = modernParams({}, { tasks: true })._meta;
    const subscription = client.openSubscription({
      notifications: { taskIds: [taskId] },
      _meta: taskMeta
    });
    const acknowledged = await subscription.acknowledged;
    assert.deepStrictEqual(acknowledged.params.notifications.taskIds, [taskId]);
    const completed = await client.waitForNotification(message => (
      message.method === 'notifications/tasks'
      && message.params?.taskId === taskId
      && message.params?.status === 'completed'
    ));
    assert.match(completed.params.result.content[0].text, /Mock response from TraeCN/);
    client.cancelSubscription(subscription.id, taskMeta);
    console.log('[clean-room-install.test.js] PASS');
  } catch (error) {
    if (gatewayStdout) console.error(`[gateway stdout]\n${gatewayStdout}`);
    if (gatewayStderr) console.error(`[gateway stderr]\n${gatewayStderr}`);
    if (mcpStderr) console.error(`[mcp stderr]\n${mcpStderr}`);
    throw error;
  } finally {
    await stop(mcp);
    await stop(gateway);
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(`[clean-room-install.test.js] FAIL: ${error.stack || error.message}`);
  process.exitCode = 1;
});
