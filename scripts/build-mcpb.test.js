'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildMcpbManifest,
  assertNoSecrets,
  sortedStagedFiles
} = require('./build-mcpb');
const { MCP_CONTRACT_VERSION, MCP_TOOL_NAMES } = require('../src/mcp/contract');

const packageInfo = require('../package.json');

try {
  const manifest = buildMcpbManifest({
    version: packageInfo.version,
    description: packageInfo.description,
    keywords: [...packageInfo.keywords]
  });

  // Spec conformance for the fields hosts validate.
  assert.strictEqual(manifest.manifest_version, '0.3');
  assert.strictEqual(manifest.name, 'traecnclaw-mcp');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(manifest.server.type, 'node');
  assert.strictEqual(manifest.server.entry_point, 'mcp-server.js');
  assert.deepStrictEqual(manifest.compatibility.platforms, ['darwin']);
  assert.strictEqual(manifest.compatibility.runtimes.node, packageInfo.engines.node);
  assert.strictEqual(manifest.license, 'MIT');

  // The 20-tool contract is advertised verbatim.
  assert.deepStrictEqual(manifest.tools, [...MCP_TOOL_NAMES]);
  assert.strictEqual(MCP_CONTRACT_VERSION, 5);

  // Every ${user_config.*} reference maps to a declared option, and every
  // declared option is referenced; only the token is sensitive.
  const envValues = Object.values(manifest.server.mcp_config.env);
  const referencedKeys = envValues
    .map(value => (value.match(/^\$\{user_config\.([a-z_]+)\}$/) || [])[1])
    .filter(Boolean);
  const declaredKeys = Object.keys(manifest.user_config).sort();
  assert.deepStrictEqual(referencedKeys.sort(), declaredKeys);
  for (const [key, option] of Object.entries(manifest.user_config)) {
    assert.ok(option.title && option.description, `${key} lacks display metadata`);
    assert.ok(Object.hasOwn(option, 'default'), `${key} lacks a default`);
    assert.strictEqual(option.required, false, `${key} must stay optional`);
    assert.strictEqual(option.sensitive === true, key === 'gateway_token');
  }
  assert.strictEqual(manifest.user_config.gateway_host.default, '127.0.0.1');
  assert.strictEqual(manifest.user_config.gateway_port.default, '8788');

  // Secret scanning blocks credential-looking files and contents.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-scan-'));
  try {
    fs.writeFileSync(path.join(staging, '.env'), 'TRAECN_GATEWAY_TOKEN=abc\n', 'utf8');
    assert.throws(() => assertNoSecrets(staging), /credential-looking filename/);
    fs.rmSync(path.join(staging, '.env'));
    fs.writeFileSync(
      path.join(staging, 'leak.js'),
      "const token = 'sk-abcdefghijklmnopqrstuvwx';",
      'utf8'
    );
    assert.throws(() => assertNoSecrets(staging), /credential-looking content/);
    fs.rmSync(path.join(staging, 'leak.js'));
    fs.writeFileSync(path.join(staging, '.env.example'), 'TRAECN_GATEWAY_TOKEN=\n', 'utf8');
    fs.writeFileSync(path.join(staging, 'clean.js'), 'const port = 8788;', 'utf8');
    assertNoSecrets(staging);
    assert.deepStrictEqual(sortedStagedFiles(staging), ['.env.example', 'clean.js']);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  console.log('[build-mcpb.test.js] PASS');
} catch (error) {
  console.error('[build-mcpb.test.js] FAIL');
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
