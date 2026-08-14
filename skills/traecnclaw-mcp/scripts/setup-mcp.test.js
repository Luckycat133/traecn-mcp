#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const skillDir = path.resolve(__dirname, '..');
const templatePath = path.join(skillDir, 'assets', 'mcp-client-config.json');
const templateBefore = fs.readFileSync(templatePath, 'utf8');
const { buildClientConfig } = require('./setup-mcp');

const config = buildClientConfig({ skillDir });
const launcherPath = path.join(skillDir, 'scripts', 'start-mcp.js');

assert.deepStrictEqual(config.mcpServers.traecn.args, [launcherPath]);
assert.strictEqual(config.mcpServers.traecn.command, 'node');
assert.strictEqual(config.mcpServers.traecn.env.TRAECN_GATEWAY_HOST, '127.0.0.1');
assert.strictEqual(config.mcpServers.traecn.env.TRAECN_GATEWAY_PORT, '8788');
assert.strictEqual(fs.readFileSync(templatePath, 'utf8'), templateBefore);

const cli = spawnSync(process.execPath, [path.join(__dirname, 'setup-mcp.js')], {
  cwd: path.resolve(skillDir, '../..'),
  encoding: 'utf8'
});
assert.strictEqual(cli.status, 0, cli.stderr || cli.stdout);
const printed = JSON.parse(cli.stdout);
assert.deepStrictEqual(printed, config);
assert.match(cli.stderr, /server ready:/i);

const help = spawnSync(process.execPath, [path.join(__dirname, 'setup-mcp.js'), '--help'], {
  cwd: path.resolve(skillDir, '../..'),
  encoding: 'utf8'
});
assert.strictEqual(help.status, 0, help.stderr || help.stdout);
assert.match(help.stdout, /Usage:.*setup-mcp\.js \[--output FILE\]/i);
assert.strictEqual(help.stderr, '');

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-setup-mcp-'));
const outputPath = path.join(outputDir, 'traecn-mcp.json');
try {
  const written = spawnSync(process.execPath, [
    path.join(__dirname, 'setup-mcp.js'),
    '--output',
    outputPath
  ], {
    cwd: path.resolve(skillDir, '../..'),
    encoding: 'utf8'
  });
  assert.strictEqual(written.status, 0, written.stderr || written.stdout);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), config);
  assert.match(written.stdout, /wrote .*traecn-mcp\.json/i);

  const refused = spawnSync(process.execPath, [
    path.join(__dirname, 'setup-mcp.js'),
    '--output',
    outputPath
  ], {
    cwd: path.resolve(skillDir, '../..'),
    encoding: 'utf8'
  });
  assert.notStrictEqual(refused.status, 0);
  assert.match(refused.stderr, /already exists/i);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), config);
} finally {
  fs.rmSync(outputDir, { recursive: true, force: true });
}

const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'traecn-setup-mcp-no-server-'));
const isolatedSkill = path.join(isolatedRoot, 'skills', 'traecnclaw-mcp');
try {
  fs.mkdirSync(path.join(isolatedSkill, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(isolatedSkill, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'setup-mcp.js'), path.join(isolatedSkill, 'scripts', 'setup-mcp.js'));
  fs.copyFileSync(path.join(__dirname, 'start-mcp.js'), path.join(isolatedSkill, 'scripts', 'start-mcp.js'));
  fs.copyFileSync(templatePath, path.join(isolatedSkill, 'assets', 'mcp-client-config.json'));
  const missingServer = spawnSync(process.execPath, [
    path.join(isolatedSkill, 'scripts', 'setup-mcp.js')
  ], {
    cwd: isolatedRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: '', NODE_PATH: '' }
  });
  assert.notStrictEqual(missingServer.status, 0);
  assert.match(missingServer.stderr, /server is not installed/i);
  assert.strictEqual(missingServer.stdout, '');
} finally {
  fs.rmSync(isolatedRoot, { recursive: true, force: true });
}

console.log('[setup-mcp.test.js] PASS');
