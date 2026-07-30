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
  'docs/MCP-SERVER-GUIDE.md',
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
assert.ok(fs.existsSync(path.join(root, 'scripts/acceptance-audit.js')), 'scripts/acceptance-audit.js is missing');
assert.ok(fs.existsSync(path.join(root, 'scripts/coverage-audit.js')), 'scripts/coverage-audit.js is missing');
assert.ok(fs.existsSync(path.join(root, 'scripts/long-queue-proof.js')), 'scripts/long-queue-proof.js is missing');
const liveUatSource = fs.readFileSync(path.join(root, 'scripts/live-uat.js'), 'utf8');
const acceptanceAuditSource = fs.readFileSync(path.join(root, 'scripts/acceptance-audit.js'), 'utf8');
const cliSource = fs.readFileSync(path.join(root, 'scripts/traecn-cli.js'), 'utf8');
const longQueueProofSource = fs.readFileSync(path.join(root, 'scripts/long-queue-proof.js'), 'utf8');
const gatewayTestSource = fs.readFileSync(path.join(root, 'src/http/gateway.test.js'), 'utf8');
const domDriverSource = fs.readFileSync(path.join(root, 'src/cdp/dom-driver.js'), 'utf8');
const soloChatHandlerSource = fs.readFileSync(path.join(root, 'src/cdp/dom-handlers/solo-chat.js'), 'utf8');
const soloCleanupSource = `${domDriverSource}\n${soloChatHandlerSource}`;
const domDriverTestSource = fs.readFileSync(path.join(root, 'src/cdp/dom-driver.test.js'), 'utf8');
const mcpTestSource = fs.readFileSync(path.join(root, 'mcp-server.test.js'), 'utf8');
const skillTestSource = fs.readFileSync(path.join(root, 'src/skill/skill.test.js'), 'utf8');
assert.ok(liveUatSource.includes('--require-ready'), 'scripts/live-uat.js must support --require-ready');
assert.ok(liveUatSource.includes('nextSteps'), 'scripts/live-uat.js must emit readiness diagnostics');
assert.ok(liveUatSource.includes('queue-probe-guard'), 'scripts/live-uat.js must check queue-probe guards');
assert.ok(liveUatSource.includes('cleanup-dry-run'), 'scripts/live-uat.js must check cleanup dry-run');
assert.ok(liveUatSource.includes('--cleanup-queue-probes'), 'scripts/live-uat.js must support queue-probe cleanup');
assert.ok(liveUatSource.includes('Found ${matched} accidental queue-probe Solo chat'), 'scripts/live-uat.js must fail strict UAT when queue-probe chats remain');
assert.ok(cliSource.includes("case 'capabilities'"), 'CLI must expose capabilities command');
assert.ok(cliSource.includes("case 'preflight'"), 'CLI must expose preflight command');
assert.ok(cliSource.includes("case 'plan'"), 'CLI must expose operation plan command');
assert.strictEqual(packageJson.scripts.doctor, 'node scripts/doctor.js');
assert.strictEqual(packageJson.scripts['acceptance:audit'], 'node scripts/acceptance-audit.js');
assert.strictEqual(packageJson.scripts['proof:long-queue'], 'node scripts/long-queue-proof.js');
assert.strictEqual(packageJson.scripts['proof:status'], 'node scripts/long-queue-proof.js --status');
assert.strictEqual(packageJson.scripts['proof:cancel'], 'node scripts/long-queue-proof.js --cancel');
assert.strictEqual(packageJson.scripts['test:coverage:audit'], 'node scripts/coverage-audit.js');
assert.ok(packageJson.scripts['test:uat'].includes('coverage-audit'), 'test:uat must include coverage audit');
assert.ok(packageJson.scripts['test:uat'].includes('acceptance-audit'), 'test:uat must include acceptance audit');
assert.strictEqual(packageJson.scripts['inspect:verify'], 'node scripts/inspect-traecn.js --verify');
assert.strictEqual(packageJson.scripts['test:live'], 'node scripts/live-uat.js');
assert.strictEqual(packageJson.bin['traecnclaw-mcp'], './mcp-server.js');
assert.strictEqual(packageJson.exports['./mcp'], './mcp-server.js');
assert.strictEqual(packageJson.types, 'src/skill/simple-api.d.ts');
assert.ok(openClawManifest.tools.some(tool => tool.name === 'traecn_capabilities'), 'OpenClaw manifest missing traecn_capabilities');
assert.ok(openClawManifest.tools.some(tool => tool.name === 'traecn_preflight'), 'OpenClaw manifest missing traecn_preflight');
assert.ok(openClawManifest.tools.some(tool => tool.name === 'traecn_plan_operation'), 'OpenClaw manifest missing traecn_plan_operation');
assert.ok(openClawManifest.tools.some(tool => tool.name === 'traecn_cleanup_queue'), 'OpenClaw manifest missing traecn_cleanup_queue');
assert.ok(openClawManifest.tools.some(tool => tool.name === 'traecn_cleanup_watch_status'), 'OpenClaw manifest missing traecn_cleanup_watch_status');
for (const toolName of ['traecn_long_queue_proof_start', 'traecn_long_queue_proof_status', 'traecn_long_queue_proof_cancel']) {
  assert.ok(openClawManifest.tools.some(tool => tool.name === toolName), `OpenClaw manifest missing ${toolName}`);
}
assert.ok(openClawManifest.tools.find(tool => tool.name === 'traecn_long_queue_proof_start')?.parameters?.properties?.allowQuotaSpend, 'OpenClaw proof start must expose allowQuotaSpend');

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
  '/api/solo/chats/cleanup-foreign-queue',
  '/api/solo/chats/submit',
  '/api/settings/read',
  '/api/settings/read-all',
  '/api/settings/set',
  '/api/settings/switch-tab',
  '/api/settings/back-to-chat',
  '/api/detect-mode',
  '/api/switch-mode',
  '/api/switch-model',
  '/api/dialog/status',
  '/api/update-self'
]) {
  assert.ok(spec.paths[apiPath], `${apiPath} is missing from OpenAPI`);
}

assert.ok(!spec.paths['/api/settings/action'], '/api/settings/action is documented but not implemented');
assert.strictEqual(spec.info.version, packageJson.version);
const { buildCapabilities } = require('../src/capabilities');
const { listCommands } = require('../src/client/command-set');
const capabilities = buildCapabilities({ commands: listCommands() });
assert.strictEqual(capabilities.contractVersion, 2);
assert.deepStrictEqual(capabilities.tokenStrategy.prefer, [
  'traecn_submit',
  'traecn_get_task',
  'traecn_list_conversations'
]);
assert.strictEqual(capabilities.tokenStrategy.gatewayManaged, true);
assert.strictEqual(capabilities.tokenStrategy.asyncPolling, false);
assert.ok(capabilities.commands.some(command => command.command === 'capabilities'), 'capabilities command is missing');
assert.ok(capabilities.commands.some(command => command.command === 'preflight'), 'preflight command is missing');
assert.ok(capabilities.commands.some(command => command.command === 'review_code'), 'review_code command is missing from capabilities');
for (const commandName of ['settings_read', 'settings_read_all', 'settings_set', 'settings_navigate', 'settings_back', 'switch_mode', 'switch_model']) {
  assert.ok(capabilities.commands.some(command => command.command === commandName), `${commandName} command is missing from capabilities`);
}
assert.ok(capabilities.commands.some(command => command.command === 'cleanup_foreign_solo_queue'), 'cleanup command is missing from capabilities');
assert.ok(capabilities.commands.some(command => command.command === 'cleanup_queue_watch_status'), 'cleanup watcher status command is missing from capabilities');
assert.ok(cliSource.includes('runCleanupWatchAttempt') && cliSource.includes('transientErrors') && cliSource.includes('cleanup_request_failed'), 'cleanup watcher must treat gateway restart/request errors as transient retries');
assert.ok(capabilities.http.some(operation => operation.path === '/api/capabilities'), '/api/capabilities operation is missing');
assert.ok(capabilities.http.some(operation => operation.path === '/api/preflight'), '/api/preflight operation is missing');
assert.ok(capabilities.http.some(operation => operation.path === '/api/solo/chats/cleanup-foreign-queue'), '/api/solo/chats/cleanup-foreign-queue operation is missing');
for (const unifiedPath of ['/api/tasks/submit', '/api/conversations', '/api/conversations/manage', '/api/interactions/resolve']) {
  assert.ok(capabilities.http.some(operation => operation.path === unifiedPath), `${unifiedPath} operation is missing`);
}
assert.ok(capabilities.apiFamilies.confirmationPlan.includes('/api/confirm/plan'), 'confirmation plan route is missing from capabilities');
assert.ok(capabilities.apiFamilies.settings.includes('/api/settings/switch-tab'), 'settings switch-tab route is missing from capabilities');
assert.ok(capabilities.apiFamilies.settings.includes('/api/settings/back-to-chat'), 'settings back-to-chat route is missing from capabilities');
assert.ok(capabilities.apiFamilies.control.includes('/api/switch-mode'), 'switch-mode route is missing from capabilities');
assert.ok(capabilities.apiFamilies.control.includes('/api/switch-model'), 'switch-model route is missing from capabilities');
assert.ok(capabilities.apiFamilies.discovery.includes('/api/preflight'), 'preflight route is missing from discovery capabilities');
assert.strictEqual(capabilities.coverage.operationConfirmation, true);
assert.strictEqual(capabilities.coverage.operationPreflight, true);
assert.strictEqual(capabilities.coverage.settingsAutomation, true);
assert.strictEqual(capabilities.coverage.modelAndModeControl, true);
const simpleApiSource = fs.readFileSync(path.join(root, 'src/skill/simple-api.js'), 'utf8');
assert.ok(simpleApiSource.includes('getCapabilities'), 'simple API must expose getCapabilities');
assert.ok(simpleApiSource.includes('preflight'), 'simple API must expose preflight');
assert.ok(simpleApiSource.includes('planOperation'), 'simple API must expose planOperation');
assert.ok(acceptanceAuditSource.includes('real_long_queue_result_retrieval'), 'acceptance audit must track real long-queue result retrieval');
assert.ok(acceptanceAuditSource.includes('GLM-5.2'), 'acceptance audit must distinguish GLM-5.2 evidence');
assert.ok(acceptanceAuditSource.includes('long_queue_proof_runner'), 'acceptance audit must track the guarded long-queue proof runner');
assert.ok(acceptanceAuditSource.includes('solo_cleanup_full_scan'), 'acceptance audit must track full-scan Solo cleanup coverage');
assert.ok(soloCleanupSource.includes('findScrollHost') && soloCleanupSource.includes('scrollTop') && soloCleanupSource.includes('awaitPromise: true'), 'Solo chat cleanup must scan scrollable sidebars, not only visible rows');
assert.ok(soloCleanupSource.includes('parentElement') && soloCleanupSource.includes('document.scrollingElement'), 'Solo chat cleanup must probe ancestor/document scroll containers, not only sidebar descendants');
assert.ok(soloCleanupSource.indexOf('candidate.title') >= 0 && soloCleanupSource.indexOf('candidate.title') < soloCleanupSource.indexOf('candidate.index'), 'Solo cleanup deletion should prefer stable title/text matching before index fallback');
assert.ok(domDriverTestSource.includes('deleteSoloChats does not treat menu text insertion as deletion success'), 'DOM driver tests must prevent menu-text false deletion success');
assert.ok(acceptanceAuditSource.includes('app_settings_control_contract'), 'acceptance audit must track app settings/model/mode control');
assert.ok(acceptanceAuditSource.includes('multi_session_result_isolation'), 'acceptance audit must track multi-session result isolation');
assert.ok(gatewayTestSource.includes('keeps parallel queued session Solo results isolated when completion is out of order'), 'gateway tests must prove out-of-order queued session result isolation');
assert.ok(gatewayTestSource.includes('TRAECN_SESSION_A_001') && gatewayTestSource.includes('TRAECN_SESSION_B_001'), 'gateway multi-session isolation test must use distinct ownership tokens');
assert.ok(acceptanceAuditSource.includes('unattended_vibe_workflow_contract'), 'acceptance audit must track the unattended vibe workflow contract');
assert.ok(mcpTestSource.includes('MCP exposes one compact tool surface'), 'MCP tests must lock the compact six-tool Agent surface');
assert.ok(skillTestSource.includes('vibeWorkflow queues unattended follow-up workflow'), 'Skill tests must prove vibe workflow queues follow-up steps');
assert.ok(gatewayTestSource.includes('Gateway auto-continues reviewable workflow followups without human review'), 'Gateway tests must prove auto-continued workflow followups');
assert.ok(acceptanceAuditSource.includes('proofLockEvidence'), 'acceptance audit must track proof lock acquisition evidence');
assert.ok(acceptanceAuditSource.includes('staleLockStatus'), 'acceptance audit must track stale proof lock status semantics');
assert.ok(longQueueProofSource.includes('--execute'), 'long-queue proof must require explicit --execute for real Trae submission');
assert.ok(longQueueProofSource.includes('--allow-quota-spend') && longQueueProofSource.includes('quota_approval_required'), 'long-queue proof must require explicit quota approval before new real Trae submission');
assert.ok(longQueueProofSource.includes('--detach'), 'long-queue proof must support detached unattended waits');
assert.ok(longQueueProofSource.includes('cleanup-foreign-queue'), 'long-queue proof must keep queue-probe cleanup in the wait loop');
assert.ok(longQueueProofSource.includes('cleanup_execute'), 'long-queue proof must auto-clean queue probes in execute mode before submitting');
assert.ok(longQueueProofSource.includes('--cleanup-stabilize-checks'), 'long-queue proof must expose a consecutive clean-readiness gate');
assert.ok(longQueueProofSource.includes('proof_lock_acquired'), 'long-queue proof must record proof lock acquisition evidence');
assert.ok(longQueueProofSource.includes('stale_lock'), 'long-queue proof must distinguish stale proof locks from missing proof state');
assert.ok(longQueueProofSource.includes('clean_long_queue_result'), 'long-queue proof must require owned result evidence');
assert.ok(!/Wait for Trae Queue|wait for Trae queue/i.test(longQueueProofSource), 'long-queue proof must not embed the accidental queue-probe title in real prompts');
assert.ok(longQueueProofSource.includes('recordEvidence'), 'long-queue proof must append evidence during long waits');
assert.ok(longQueueProofSource.includes('stdoutFile'), 'long-queue proof must keep detached stdout separate from final JSON');
assert.ok(longQueueProofSource.includes('--status'), 'long-queue proof must expose a status mode for detached runs');
assert.ok(longQueueProofSource.includes('recentEvents'), 'long-queue proof status must report recent evidence events');
assert.ok(longQueueProofSource.includes('--cancel'), 'long-queue proof must expose a cancellation mode for detached runs');
assert.ok(longQueueProofSource.includes('--resume-task'), 'long-queue proof must resume an existing task id');
assert.ok(longQueueProofSource.includes('--force-new'), 'long-queue proof must require an explicit force flag before duplicate submissions');
assert.ok(longQueueProofSource.includes('alreadyRunning'), 'long-queue proof detach must refuse duplicate proof screens by default');
assert.ok(longQueueProofSource.includes('listProofProcesses'), 'long-queue proof must detect orphan proof child processes');
assert.ok(longQueueProofSource.includes('cancel_processes'), 'long-queue proof cancel must record process cancellation attempts');
assert.ok(longQueueProofSource.includes('process.execPath'), 'long-queue proof detach must use the current Node executable');
assert.ok(longQueueProofSource.includes('/cancel'), 'long-queue proof cancel must call the gateway task cancel route');
assert.ok(longQueueProofSource.includes('requestWithRetry'), 'long-queue proof must retry transient gateway failures locally instead of resubmitting queue probes');
assert.ok(longQueueProofSource.includes('gateway_transient_retry'), 'long-queue proof must record transient gateway retry evidence');
assert.ok(longQueueProofSource.includes('--gateway-retry-attempts'), 'long-queue proof must expose retry-attempt tuning for gateway restarts');
assert.ok(longQueueProofSource.includes('--gateway-retry-delay-ms'), 'long-queue proof must expose retry-delay tuning for gateway restarts');

const packOutput = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
});
const packInfo = JSON.parse(packOutput)[0];
const packedFiles = packInfo.files.map(file => file.path);
for (const requiredFile of [
  'mcp-server.js',
  'scripts/acceptance-audit.js',
  'scripts/coverage-audit.js',
  'scripts/long-queue-proof.js',
  'scripts/live-uat.js',
  'src/shared/operation-confirmation.js',
  'src/skill/review.js',
  'src/skill/simple-api.d.ts',
  'src/client/command-set.js'
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
