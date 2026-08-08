#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../../..');
const skillRoot = path.resolve(__dirname, '..');
const packageJson = require(path.join(repoRoot, 'package.json'));
const {
  MCP_CONTRACT_VERSION,
  MCP_TOOLS,
  getMcpToolMetadata
} = require(path.join(repoRoot, 'mcp-server'));

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(skillRoot, relativePath), 'utf8'));
}

function assertNoPrivateKeys(value, location = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPrivateKeys(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!key.startsWith('_'), `${location}.${key} is not valid client configuration`);
    assertNoPrivateKeys(child, `${location}.${key}`);
  }
}

function assertArgumentsMatchSchema(tool, args) {
  const schema = tool.inputSchema || {};
  for (const required of schema.required || []) {
    assert.ok(Object.prototype.hasOwnProperty.call(args, required), `${tool.name} example misses required argument ${required}`);
  }
  for (const [name, value] of Object.entries(args)) {
    const property = schema.properties?.[name];
    assert.ok(property, `${tool.name} example uses unknown argument ${name}`);
    if (property.enum) {
      assert.ok(property.enum.includes(value), `${tool.name}.${name} uses invalid enum value ${value}`);
    }
  }
}

function expectedContract() {
  return {
    source: 'mcp-server.js',
    contractVersion: MCP_CONTRACT_VERSION,
    toolCount: MCP_TOOLS.length,
    tools: MCP_TOOLS.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      metadata: getMcpToolMetadata(tool.name)
    }))
  };
}

const recommended = readJson('assets/mcp-client-config.json');
assertNoPrivateKeys(recommended);
assert.deepStrictEqual(Object.keys(recommended.mcpServers || {}), ['traecn']);
assert.deepStrictEqual(recommended.mcpServers.traecn.args, ['SKILL_DIR/scripts/start-mcp.js']);

const direct = readJson('assets/mcp-client-config.direct.json');
assertNoPrivateKeys(direct);
assert.deepStrictEqual(Object.keys(direct.mcpServers || {}), ['traecn']);
assert.deepStrictEqual(direct.mcpServers.traecn.args, ['/absolute/path/to/TRAECNclaw/mcp-server.js']);

const skillDocument = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
assert.match(
  skillDocument,
  /^    primaryEnv: TRAECN_GATEWAY_TOKEN$/m,
  'the gateway credential must be identified as the primary environment secret'
);
assert.match(
  skillDocument,
  /^    envVars:\n(?:.*\n)*?      - name: TRAECN_GATEWAY_TOKEN\n        required: false\n        description: .*never (?:read, )?print, log, or persist it\.$/m,
  'the optional gateway token must have a machine-readable declaration and handling restriction'
);
assert.doesNotMatch(
  skillDocument,
  /TRAECN_MCP_SERVER_PATH/,
  'the public Skill must not accept an environment-selected JavaScript entry point'
);

const toolsByName = new Map(MCP_TOOLS.map(tool => [tool.name, tool]));
const examples = readJson('references/mcp-call-examples.json');
for (const example of examples.calls) {
  const tool = toolsByName.get(example.tool);
  assert.ok(tool, `Unknown MCP tool in example: ${example.tool}`);
  assertArgumentsMatchSchema(tool, example.arguments || {});
}
const deleteExample = examples.calls.find(example => example.tool === 'traecn_delete_conversation');
assert.match(
  deleteExample?.precondition || '',
  /current user request.*explicitly/i,
  'permanent deletion example must require an explicit current user request'
);
assert.match(
  deleteExample?.warning || '',
  /permanent.*cannot.*restore/i,
  'permanent deletion example must warn that the conversation cannot be restored'
);

assert.deepStrictEqual(readJson('references/mcp-tool-contracts.json'), expectedContract());

const docs = [
  skillDocument,
  fs.readFileSync(path.join(skillRoot, 'references/mcp-surface.md'), 'utf8')
].join('\n');
assert.ok(!docs.includes('batch.runTasks'), 'JS SDK batch.runTasks must not be documented as an MCP tool');

for (const testFile of [
  'skills/traecnclaw-mcp/scripts/start-mcp.test.js',
  'skills/traecnclaw-mcp/scripts/setup-mcp.test.js',
  'skills/traecnclaw-mcp/scripts/mcp-stdio-smoke.test.js',
  'skills/traecnclaw-mcp/scripts/skill-contract.test.js'
]) {
  assert.ok(packageJson.scripts.test.includes(testFile), `${testFile} must run in npm test`);
}

const stdioSmoke = spawnSync('npm', ['run', 'test:mcp-stdio-smoke', '--silent'], {
  cwd: repoRoot,
  encoding: 'utf8'
});
assert.strictEqual(
  stdioSmoke.status,
  0,
  `npm run test:mcp-stdio-smoke must execute the protocol smoke test:\n${stdioSmoke.stderr || stdioSmoke.stdout}`
);
assert.match(stdioSmoke.stdout, /PASS \(20 focused tools\)/, 'stdio smoke command must report the focused tool count');

console.log('[skill-contract.test.js] PASS');
