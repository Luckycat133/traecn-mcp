'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MCPB_CLI_PACKAGE,
  quoteNpmCallArg,
  buildMcpbNpmCall,
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
  assert.strictEqual(manifest.name, 'traecn-mcp');
  assert.strictEqual(manifest.display_name, 'TraeCN MCP');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(manifest.server.type, 'node');
  assert.strictEqual(manifest.server.entry_point, 'mcp-server.js');
  assert.deepStrictEqual(manifest.repository, {
    type: 'git',
    url: 'https://github.com/Luckycat133/traecn-mcp.git'
  });
  assert.strictEqual(manifest.support, 'https://github.com/Luckycat133/traecn-mcp/issues');
  assert.deepStrictEqual(manifest.compatibility.platforms, ['darwin']);
  assert.strictEqual(manifest.compatibility.runtimes.node, packageInfo.engines.node);
  assert.strictEqual(manifest.license, 'MIT');
  assert.strictEqual(MCPB_CLI_PACKAGE, '@anthropic-ai/mcpb@2.1.2');
  assert.strictEqual(quoteNpmCallArg("path with ' apostrophe"), "'path with '\"'\"' apostrophe'");
  assert.strictEqual(
    buildMcpbNpmCall(['validate', '/tmp/manifest path.json']),
    "'mcpb' 'validate' '/tmp/manifest path.json'"
  );
  assert.throws(() => quoteNpmCallArg('bad\0path'), /NUL/);
  assert.ok(packageInfo.files.includes('src/http/web-console/*.html'));
  assert.ok(packageInfo.files.includes('src/http/web-console/*.css'));
  assert.ok(packageInfo.files.includes('src/**/*.js'));

  // The 20-tool contract is advertised verbatim.
  assert.deepStrictEqual(manifest.tools.map(tool => tool.name), [...MCP_TOOL_NAMES]);
  assert.strictEqual(manifest.tools.length, 20);
  assert.ok(manifest.tools.every(tool => tool.description && typeof tool.description === 'string'));
  assert.strictEqual(manifest.tools_generated, false);
  assert.strictEqual(MCP_CONTRACT_VERSION, 5);

  // Smithery CLI 4.11.1 rejects valid MCPB 0.3 summary entries because it
  // expects full inputSchema objects. Its compatibility bundle omits only the
  // optional manifest summary; runtime discovery still supplies all 20 tools.
  const smitheryManifest = buildMcpbManifest({
    version: packageInfo.version,
    description: packageInfo.description,
    keywords: [...packageInfo.keywords],
    includeToolSummaries: false
  });
  assert.strictEqual(Object.hasOwn(smitheryManifest, 'tools'), false);
  assert.strictEqual(Object.hasOwn(smitheryManifest, 'tools_generated'), false);

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
