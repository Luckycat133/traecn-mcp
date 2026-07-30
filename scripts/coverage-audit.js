'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const packageJson = require('../package.json');
const { generateOpenAPISpec } = require('../src/http/openapi');
const { buildCapabilities } = require('../src/capabilities');
const { listCommands } = require('../src/client/command-set');
const { MCP_TOOLS } = require('../mcp-server');
const openClawManifest = require('../integrations/openclaw-traecn-plugin/openclaw.plugin.json');

const commandNames = listCommands().map(command => command.command);
const spec = generateOpenAPISpec();
const specPaths = Object.keys(spec.paths);
const capabilities = buildCapabilities({ commands: listCommands(), mcpTools: MCP_TOOLS });

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function findTool(tools, name) {
  return tools.find(tool => tool.name === name);
}

function assertArrayIncludesAll(actual, expected, label) {
  for (const item of expected) {
    assert.ok(actual.includes(item), `${label} is missing ${item}`);
  }
}

function gatewayLiteralRoutes() {
  const source = read('src/http/gateway.js');
  const routes = new Set();
  for (const match of source.matchAll(/pathname === '([^']+)'/g)) {
    routes.add(match[1]);
  }
  // Driver routes are dispatched via a `driverRoute = { name: '/api/<name>', ... }` table
  // in gateway.js. Match `/api/<name>` literals inside that block so coverage tracks them.
  for (const match of source.matchAll(/'((?:\/api\/[a-z]+))'/g)) {
    routes.add(match[1]);
  }
  return Array.from(routes).filter(route => route !== '/debug/automation').sort();
}

function commandEnumFromOpenClawManifest() {
  const commandTool = findTool(openClawManifest.tools, 'traecn_command');
  return commandTool?.parameters?.properties?.command?.enum || [];
}

function commandEnumFromMcpTool() {
  const commandTool = findTool(MCP_TOOLS, 'traecn_run_command');
  return commandTool?.inputSchema?.properties?.command?.enum || [];
}

function packedFiles() {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return JSON.parse(output)[0].files.map(file => file.path);
}

assert.strictEqual(spec.info.version, packageJson.version, 'OpenAPI version must match package version');
assertArrayIncludesAll(specPaths, gatewayLiteralRoutes(), 'OpenAPI');

assert.deepStrictEqual(
  capabilities.commands.map(command => command.command),
  commandNames,
  'Capabilities command catalog must match command-set'
);
assert.deepStrictEqual(commandEnumFromOpenClawManifest(), commandNames, 'OpenClaw command enum must match command-set');
assert.deepStrictEqual(commandEnumFromMcpTool(), commandNames, 'MCP command enum must match command-set');

assert.strictEqual(capabilities.coverage.connection, true);
assert.strictEqual(capabilities.coverage.taskDelegation, true);
assert.strictEqual(capabilities.coverage.queueManagement, true);
assert.strictEqual(capabilities.coverage.codeReview, true);
assert.strictEqual(capabilities.coverage.operationConfirmation, true);
assert.strictEqual(capabilities.coverage.operationPreflight, true);
assert.strictEqual(capabilities.coverage.settingsAutomation, true);
assert.strictEqual(capabilities.coverage.modelAndModeControl, true);
assert.strictEqual(capabilities.coverage.projectOpening, true);
assert.strictEqual(capabilities.coverage.historyReplay, true);
assertArrayIncludesAll(capabilities.tokenStrategy.prefer, ['traecn_get_capabilities', 'traecn_preflight', 'traecn_queue_task', 'traecn_wait_task'], 'tokenStrategy.prefer');

assertArrayIncludesAll(MCP_TOOLS.map(tool => tool.name), [
  'traecn_get_capabilities',
  'traecn_list_commands',
  'traecn_run_command',
  'traecn_preflight',
  'traecn_plan_operation',
  'traecn_run_task',
  'traecn_queue_task',
  'traecn_poll_task',
  'traecn_cleanup_queue_probe_chats',
  'traecn_get_cleanup_watch_status',
  'traecn_review_code',
  'traecn_get_queue_status',
  'traecn_get_dialog_status'
], 'MCP tools');

assertArrayIncludesAll(openClawManifest.tools.map(tool => tool.name), [
  'traecn_capabilities',
  'traecn_command_set',
  'traecn_preflight',
  'traecn_command',
  'traecn_plan_operation',
  'traecn_delegate',
  'traecn_cleanup_queue',
  'traecn_cleanup_watch_status',
  'traecn_queue_status',
  'traecn_dialog_status'
], 'OpenClaw manifest tools');

const simpleApiSource = read('src/skill/simple-api.js');
assertArrayIncludesAll(simpleApiSource, [
  'runTask',
  'queueTask',
  'pollTask',
  'reviewCode',
  'getCapabilities',
  'preflight',
  'planOperation'
], 'simple API source');

const simpleTypes = read('src/skill/simple-api.d.ts');
assertArrayIncludesAll(simpleTypes, [
  'runTask',
  'queueTask',
  'pollTask',
  'reviewCode',
  'getCapabilities',
  'preflight',
  'planOperation'
], 'simple API types');

const cliSource = read('scripts/traecn-cli.js');
assertArrayIncludesAll(cliSource, [
  "case 'capabilities'",
  "case 'preflight'",
  "case 'plan'",
  "case 'cleanup-queue'",
  "case 'delegate'",
  "case 'batch'",
  "case 'logs'",
  '/api/preflight'
], 'CLI source');

assert.ok(packageJson.scripts.test.includes('scripts/traecn-cli.test.js'), 'npm test must include CLI tests');
assert.ok(packageJson.scripts['test:uat'].includes('coverage-audit'), 'test:uat must include coverage audit');
assert.ok(packageJson.scripts['test:uat'].includes('acceptance-audit'), 'test:uat must include acceptance audit');
assert.ok(packageJson.scripts['test:all'].includes('test:uat'), 'test:all must include UAT gate');
assert.ok(packageJson.scripts['audit:prod'], 'production audit script is required');

const docs = [
  read('README.md'),
  read('docs/MCP-SERVER-GUIDE.md'),
  read('docs/openclaw-command-set.md')
].join('\n');
assertArrayIncludesAll(docs, ['traecn_preflight', 'reviewCode', 'queueTask', 'traecn_plan_operation', 'traecn_run_command'], 'docs');
assert.ok(commandNames.includes('cleanup_foreign_solo_queue'), 'command-set must include cleanup_foreign_solo_queue');
assert.ok(commandNames.includes('cleanup_queue_watch_status'), 'command-set must include cleanup_queue_watch_status');
assert.ok(specPaths.includes('/api/solo/chats/cleanup-foreign-queue'), 'OpenAPI must include Solo cleanup route');

const files = packedFiles();
assertArrayIncludesAll(files, [
  'mcp-server.js',
  'scripts/acceptance-audit.js',
  'scripts/coverage-audit.js',
  'scripts/live-uat.js',
  'scripts/traecn-cli.js',
  'src/capabilities.js',
  'src/shared/operation-confirmation.js',
  'src/skill/review.js',
  'src/skill/simple-api.d.ts',
  'src/client/command-set.js'
], 'npm package');

console.log('[coverage-audit] PASS', JSON.stringify({
  routes: specPaths.length,
  commands: commandNames.length,
  mcpTools: MCP_TOOLS.length,
  openClawTools: openClawManifest.tools.length
}));
