'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repoRoot, 'dist', 'traecnclaw-mcp-release.json');

const packaged = spawnSync(process.execPath, [path.join(__dirname, 'package-skill.js')], {
  cwd: repoRoot,
  encoding: 'utf8'
});
assert.strictEqual(packaged.status, 0, packaged.stderr || packaged.stdout);

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.ok(manifest.serverPackage, 'release manifest must describe the complete server package');
assert.strictEqual(manifest.serverPackage.name, 'traecnclaw');
assert.strictEqual(manifest.serverPackage.version, require('../package.json').version);
assert.match(manifest.serverPackage.artifact.path, /^dist\/traecnclaw-\d+\.\d+\.\d+\.tgz$/);
assert.match(manifest.serverPackage.artifact.sha256, /^[a-f0-9]{64}$/);

const serverArchive = path.join(repoRoot, manifest.serverPackage.artifact.path);
assert.ok(fs.statSync(serverArchive).isFile());
const listed = spawnSync('tar', ['-tzf', serverArchive], { encoding: 'utf8' });
assert.strictEqual(listed.status, 0, listed.stderr);
const entries = listed.stdout.trim().split('\n');
for (const required of [
  'package/mcp-server.js',
  'package/src/mcp/contract.js',
  'package/scripts/start-gateway.js'
]) {
  assert.ok(entries.includes(required), `${required} missing from server package`);
}

console.log('[package-skill.test.js] PASS');
