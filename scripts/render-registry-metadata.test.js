'use strict';

const assert = require('assert');
const { renderRegistryMetadata } = require('./render-registry-metadata');

const packageInfo = {
  mcpName: 'io.github.Luckycat133/traecnclaw',
  version: '1.2.3'
};
const metadata = JSON.parse(renderRegistryMetadata({ packageInfo }));

assert.strictEqual(metadata.name, packageInfo.mcpName);
assert.strictEqual(metadata.version, packageInfo.version);
assert.deepStrictEqual(metadata.repository, {
  url: 'https://github.com/Luckycat133/traecnclaw-mcp-skill',
  source: 'github'
});
assert.strictEqual(metadata.packages.length, 1);
assert.strictEqual(metadata.packages[0].identifier, '@luckycat133/traecnclaw');
assert.strictEqual(metadata.packages[0].version, packageInfo.version);
assert.strictEqual(metadata.packages[0].transport.type, 'stdio');
assert.strictEqual(
  metadata.packages[0].environmentVariables.find((entry) => entry.name === 'TRAECN_GATEWAY_TOKEN').isSecret,
  true
);
assert.throws(
  () => renderRegistryMetadata({ packageInfo: { ...packageInfo, mcpName: 'wrong' } }),
  /mcpName/
);
assert.throws(
  () => renderRegistryMetadata({ packageInfo: { ...packageInfo, version: 'latest' } }),
  /release version/
);

console.log('[render-registry-metadata.test.js] PASS');
