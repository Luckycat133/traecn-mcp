'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { generateOpenAPISpec } = require('../src/http/openapi');
const packageJson = require('../package.json');
const openClawManifest = require('../integrations/openclaw-traecn-plugin/openclaw.plugin.json');

const root = path.resolve(__dirname, '..');
const requiredDocs = [
  'README.md',
  'docs/user-manual.md',
  'docs/development.md',
  'docs/deployment.md',
  'CHANGELOG.md',
  '.env.example'
];

for (const docPath of requiredDocs) {
  const absolute = path.join(root, docPath);
  assert.ok(fs.existsSync(absolute), `${docPath} is missing`);
  assert.ok(fs.statSync(absolute).size > 200, `${docPath} is too small to be useful`);
}

const doctorPath = path.join(root, 'scripts/doctor.js');
assert.ok(fs.existsSync(doctorPath), 'scripts/doctor.js is missing');
assert.ok(fs.existsSync(path.join(root, 'scripts/coverage-audit.js')), 'scripts/coverage-audit.js is missing');
const liveUatSource = fs.readFileSync(path.join(root, 'scripts/live-uat.js'), 'utf8');
const cliSource = fs.readFileSync(path.join(root, 'scripts/traecn-cli.js'), 'utf8');
assert.ok(liveUatSource.includes('--require-ready'), 'scripts/live-uat.js must support --require-ready');
assert.ok(liveUatSource.includes('nextSteps'), 'scripts/live-uat.js must emit readiness diagnostics');
assert.ok(cliSource.includes("case 'capabilities'"), 'CLI must expose capabilities command');
assert.ok(cliSource.includes("case 'preflight'"), 'CLI must expose preflight command');
assert.ok(cliSource.includes("case 'plan'"), 'CLI must expose operation plan command');
assert.strictEqual(packageJson.scripts.doctor, 'node scripts/doctor.js');
assert.strictEqual(packageJson.scripts['test:coverage'], 'node scripts/coverage-audit.js');
assert.ok(packageJson.scripts['test:uat'].includes('coverage-audit'), 'test:uat must include coverage audit');
assert.strictEqual(packageJson.scripts['inspect:verify'], 'node scripts/inspect-traecn.js --verify');
assert.strictEqual(packageJson.scripts['test:live'], 'node scripts/live-uat.js');
assert.strictEqual(packageJson.bin['traecnclaw-mcp'], './mcp-server.js');
assert.strictEqual(packageJson.exports['./mcp'], './mcp-server.js');
assert.strictEqual(packageJson.types, 'src/skill/simple-api.d.ts');
assert.ok(openClawManifest.tools.some(tool => tool.name === 'traecn_capabilities'), 'OpenClaw manifest missing traecn_capabilities');
assert.ok(openClawManifest.tools.some(tool => tool.name === 'traecn_preflight'), 'OpenClaw manifest missing traecn_preflight');
assert.ok(openClawManifest.tools.some(tool => tool.name === 'traecn_plan_operation'), 'OpenClaw manifest missing traecn_plan_operation');

const spec = generateOpenAPISpec();
for (const apiPath of [
  '/api/capabilities',
  '/api/status',
  '/api/preflight',
  '/api/confirm/plan',
  '/api/config',
  '/api/sessions',
  '/api/delegate',
  '/api/delegate-async',
  '/api/detect-mode',
  '/api/switch-mode',
  '/api/switch-model',
  '/api/queue/status',
  '/api/tasks/history',
  '/api/tasks/batch',
  '/api/settings/read',
  '/api/settings/read-all',
  '/api/settings/set',
  '/api/dialog/status',
  '/api/update-self'
]) {
  assert.ok(spec.paths[apiPath], `${apiPath} is missing from OpenAPI`);
}

assert.ok(!spec.paths['/api/settings/action'], '/api/settings/action is documented but not implemented');
assert.strictEqual(spec.info.version, packageJson.version);
const { buildCapabilities } = require('../src/shared/capabilities');
const { listCommands } = require('../integrations/openclaw-traecn-plugin/lib/command-set');
const capabilities = buildCapabilities({ commands: listCommands() });
assert.strictEqual(capabilities.contractVersion, 1);
assert.ok(capabilities.commands.some(command => command.command === 'capabilities'), 'capabilities command is missing');
assert.ok(capabilities.commands.some(command => command.command === 'preflight'), 'preflight command is missing');
assert.ok(capabilities.commands.some(command => command.command === 'review_code'), 'review_code command is missing from capabilities');
assert.ok(capabilities.http.some(operation => operation.path === '/api/capabilities'), '/api/capabilities operation is missing');
assert.ok(capabilities.http.some(operation => operation.path === '/api/preflight'), '/api/preflight operation is missing');
assert.ok(capabilities.apiFamilies.confirmationPlan.includes('/api/confirm/plan'), 'confirmation plan route is missing from capabilities');
assert.ok(capabilities.apiFamilies.discovery.includes('/api/preflight'), 'preflight route is missing from discovery capabilities');
assert.strictEqual(capabilities.coverage.operationConfirmation, true);
assert.strictEqual(capabilities.coverage.operationPreflight, true);
const simpleApiSource = fs.readFileSync(path.join(root, 'src/skill/simple-api.js'), 'utf8');
assert.ok(simpleApiSource.includes('getCapabilities'), 'simple API must expose getCapabilities');
assert.ok(simpleApiSource.includes('preflight'), 'simple API must expose preflight');
assert.ok(simpleApiSource.includes('planOperation'), 'simple API must expose planOperation');

const packOutput = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
});
const packInfo = JSON.parse(packOutput)[0];
const packedFiles = packInfo.files.map(file => file.path);
for (const requiredFile of [
  'mcp-server.js',
  'scripts/coverage-audit.js',
  'scripts/live-uat.js',
  'src/shared/operation-confirmation.js',
  'src/skill/review.js',
  'src/skill/simple-api.d.ts',
  'integrations/openclaw-traecn-plugin/lib/command-set.js'
]) {
  assert.ok(packedFiles.includes(requiredFile), `${requiredFile} is missing from npm package`);
}
for (const packedFile of packedFiles) {
  assert.ok(!packedFile.startsWith('.agents/'), `${packedFile} should not be packed`);
  assert.ok(!packedFile.startsWith('.trae/'), `${packedFile} should not be packed`);
  assert.ok(!packedFile.startsWith('audit-logs/'), `${packedFile} should not be packed`);
  assert.ok(!packedFile.endsWith('.test.js'), `${packedFile} should not be packed`);
  assert.ok(!packedFile.startsWith('scripts/system-test'), `${packedFile} should not be packed`);
  assert.ok(!packedFile.startsWith('scripts/test-chat-ui'), `${packedFile} should not be packed`);
  assert.ok(!packedFile.startsWith('scripts/uat-checklist'), `${packedFile} should not be packed`);
}

console.log('[uat-checklist] PASS');
