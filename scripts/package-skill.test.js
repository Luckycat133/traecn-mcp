'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repoRoot, 'dist', 'traecn-mcp-release.json');

const packaged = spawnSync(process.execPath, [path.join(__dirname, 'package-skill.js')], {
  cwd: repoRoot,
  encoding: 'utf8'
});
assert.strictEqual(packaged.status, 0, packaged.stderr || packaged.stdout);

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.ok(manifest.serverPackage, 'release manifest must describe the complete server package');
assert.strictEqual(manifest.serverPackage.name, '@luckycat133/traecnclaw');
assert.strictEqual(manifest.serverPackage.version, require('../package.json').version);
assert.strictEqual(manifest.serverPackage.mcpName, 'io.github.Luckycat133/traecnclaw');
assert.match(manifest.serverPackage.artifact.path, /^dist\/traecnclaw-\d+\.\d+\.\d+\.tgz$/);
assert.match(manifest.serverPackage.artifact.sha256, /^[a-f0-9]{64}$/);

const serverArchive = path.join(repoRoot, manifest.serverPackage.artifact.path);
assert.ok(fs.statSync(serverArchive).isFile());
const listed = spawnSync('tar', ['-tzf', serverArchive], { encoding: 'utf8' });
assert.strictEqual(listed.status, 0, listed.stderr);
const entries = listed.stdout.trim().split('\n');
for (const required of [
  'package/mcp-server.js',
  'package/LICENSE',
  'package/scripts/gateway-service.js',
  'package/src/mcp/contract.js',
  'package/scripts/start-gateway.js'
]) {
  assert.ok(entries.includes(required), `${required} missing from server package`);
}

const packageJson = spawnSync('tar', ['-xOf', serverArchive, 'package/package.json'], {
  encoding: 'utf8'
});
assert.strictEqual(packageJson.status, 0, packageJson.stderr);
const published = JSON.parse(packageJson.stdout);
assert.strictEqual(published.name, '@luckycat133/traecnclaw');
assert.strictEqual(Object.hasOwn(published, 'private'), false);
assert.deepStrictEqual(published.os, ['darwin']);
assert.deepStrictEqual(published.publishConfig, { access: 'public' });
assert.strictEqual(Object.hasOwn(published.scripts, 'test'), false);

const publicReadme = spawnSync('tar', ['-xOf', serverArchive, 'package/README.md'], {
  encoding: 'utf8'
});
assert.strictEqual(publicReadme.status, 0, publicReadme.stderr);
assert.ok(publicReadme.stdout.includes(`/releases/download/v${manifest.version}/traecnclaw-${manifest.version}.tgz`));
assert.doesNotMatch(publicReadme.stdout, /Luckycat133\/TRAECNclaw/);
for (const excluded of [
  'package/docs/CHANNEL-LEDGER.md',
  'package/docs/DISTRIBUTION.md',
  'package/docs/LAUNCH-KIT.md'
]) {
  assert.ok(!entries.includes(excluded), `${excluded} must not ship in the public npm package`);
}

const mcpb = manifest.artifacts.find(item => item.path.endsWith('.mcpb'));
assert.ok(mcpb, 'release manifest must include the MCPB bundle');
assert.match(mcpb.sha256, /^[a-f0-9]{64}$/);
const mcpbEntries = spawnSync('unzip', ['-Z1', path.join(repoRoot, mcpb.path)], {
  encoding: 'utf8'
});
assert.strictEqual(mcpbEntries.status, 0, mcpbEntries.stderr);
assert.ok(mcpbEntries.stdout.trim().split('\n').includes('LICENSE'));
const mcpbPackageJson = spawnSync('unzip', [
  '-p',
  path.join(repoRoot, mcpb.path),
  'package.json'
], { encoding: 'utf8' });
assert.strictEqual(mcpbPackageJson.status, 0, mcpbPackageJson.stderr);
const mcpbPublished = JSON.parse(mcpbPackageJson.stdout);
assert.strictEqual(mcpbPublished.name, '@luckycat133/traecnclaw');
assert.strictEqual(Object.hasOwn(mcpbPublished, 'private'), false);
assert.strictEqual(
  mcpbPublished.repository.url,
  'https://github.com/Luckycat133/traecn-mcp.git'
);
const mcpbReadme = spawnSync('unzip', [
  '-p',
  path.join(repoRoot, mcpb.path),
  'README.md'
], { encoding: 'utf8' });
assert.strictEqual(mcpbReadme.status, 0, mcpbReadme.stderr);
assert.ok(mcpbReadme.stdout.includes(`/releases/download/v${manifest.version}/traecnclaw-${manifest.version}.tgz`));
assert.doesNotMatch(mcpbReadme.stdout, /Luckycat133\/TRAECNclaw/);

const rebuilt = spawnSync(process.execPath, [path.join(__dirname, 'package-skill.js')], {
  cwd: repoRoot,
  encoding: 'utf8'
});
assert.strictEqual(rebuilt.status, 0, rebuilt.stderr || rebuilt.stdout);
const rebuiltManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const rebuiltMcpb = rebuiltManifest.artifacts.find(item => item.path.endsWith('.mcpb'));
assert.strictEqual(
  rebuiltManifest.serverPackage.artifact.sha256,
  manifest.serverPackage.artifact.sha256,
  'scoped npm package must be deterministic across rebuilds'
);
assert.strictEqual(
  rebuiltMcpb.sha256,
  mcpb.sha256,
  'MCPB package must be deterministic across rebuilds'
);

console.log('[package-skill.test.js] PASS');
