'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

console.log('[start-mcp Test] Running tests...');

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

function expect(value) {
  return {
    toBe(expected) {
      if (value !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
      }
    },
    toEqual(expected) {
      if (JSON.stringify(value) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
      }
    },
    toBeDefined() {
      if (value === undefined) {
        throw new Error('Expected value to be defined');
      }
    },
    toBeNull() {
      if (value !== null) {
        throw new Error(`Expected null, got ${JSON.stringify(value)}`);
      }
    },
    toBeTruthy() {
      if (!value) {
        throw new Error(`Expected truthy value, got ${value}`);
      }
    },
    toContain(expected) {
      if (!value.includes(expected)) {
        throw new Error(`Expected ${JSON.stringify(value)} to contain ${JSON.stringify(expected)}`);
      }
    },
    not: {
      toBe(expected) {
        if (value === expected) {
          throw new Error(`Expected ${JSON.stringify(value)} not to be ${JSON.stringify(expected)}`);
        }
      }
    }
  };
}

// --- Test fixtures ---

/**
 * Create a temporary directory with a fake mcp-server.js file inside.
 * Returns { dir, serverFile } where serverFile is the path to the fake file.
 */
function makeFakeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-mcp-test-'));
  const serverFile = path.join(dir, 'mcp-server.js');
  fs.writeFileSync(serverFile, 'module.exports = { startStdioServer() {} };\n');
  return { dir, serverFile };
}

/**
 * Build a fake scripts dir structure so that `path.resolve(scriptDir, '../../..')`
 * points at `repoDir`. Structure: repoDir/x/y/scripts (scriptDir = repoDir/x/y/scripts).
 */
function makeFakeScriptDir(repoDir) {
  const scriptDir = path.join(repoDir, 'a', 'b', 'scripts');
  fs.mkdirSync(scriptDir, { recursive: true });
  return scriptDir;
}

function readStdioSurface(launcher, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher], {
      cwd,
      env: { PATH: '', NODE_PATH: '', TRAECN_GATEWAY_HOST: '127.0.0.1', TRAECN_GATEWAY_PORT: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const responses = new Map();
    let buffer = '';
    let stderr = '';
    let failure;
    const fail = error => {
      failure = error;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => fail(new Error('MCP launcher stdio response timed out')), 5000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      try {
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (!line) continue;
          const response = JSON.parse(line);
          if (response.id === 1 || response.id === 2) responses.set(response.id, response);
        }
        if (responses.size === 2) child.kill('SIGTERM');
      } catch (error) {
        fail(error);
      }
    });
    child.once('error', fail);
    child.stdin.on('error', fail);
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0 || responses.size !== 2) {
        return reject(new Error(`MCP launcher exited before initialize/list completed: ${stderr}`));
      }
      resolve([responses.get(1), responses.get(2)]);
    });
    child.stdin.write([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'start-mcp-test', version: '1' }
      } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' }
    ].map(message => `${JSON.stringify(message)}\n`).join(''));
  });
}

// --- Tests ---

test('module exports resolveServerPath and main', () => {
  const mod = require('./start-mcp');
  expect(typeof mod.resolveServerPath).toBe('function');
  expect(typeof mod.main).toBe('function');
});

test('resolveServerPath never loads an arbitrary server path from the environment', () => {
  const { dir, serverFile } = makeFakeRepo();
  try {
    const env = { TRAECN_MCP_SERVER_PATH: serverFile };
    const scriptDir = makeFakeScriptDir(path.join(dir, 'skill-root'));
    const result = require('./start-mcp').resolveServerPath(env, scriptDir, { cwd: dir });
    expect(result).toBeNull();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveServerPath falls back to in-repo path when env var is not set', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-mcp-repo-'));
  const scriptDir = makeFakeScriptDir(repoDir);
  const expectedServer = path.join(repoDir, 'mcp-server.js');
  fs.writeFileSync(expectedServer, 'module.exports = {};\n');
  try {
    const env = {};
    const result = require('./start-mcp').resolveServerPath(env, scriptDir, { cwd: repoDir });
    expect(result).toBe(fs.realpathSync(expectedServer));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('resolveServerPath uses the repository root for a .codex skills copy', () => {
  const { dir, serverFile } = makeFakeRepo();
  const scriptDir = path.join(dir, '.codex', 'skills', 'traecnclaw-mcp', 'scripts');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.codex', 'mcp-server.js'), 'throw new Error("wrong repository root");\n');
  try {
    const result = require('./start-mcp').resolveServerPath({}, scriptDir, { cwd: dir });
    expect(result).toBe(fs.realpathSync(serverFile));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveServerPath does not search arbitrary ancestor directories', () => {
  const { dir } = makeFakeRepo();
  const scriptDir = path.join(dir, 'unrelated', 'skills', 'traecnclaw-mcp', 'scripts');
  fs.mkdirSync(scriptDir, { recursive: true });
  try {
    const result = require('./start-mcp').resolveServerPath({}, scriptDir, { cwd: dir });
    expect(result).toBeNull();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveServerPath returns null when no candidate exists', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-mcp-empty-'));
  const scriptDir = makeFakeScriptDir(repoDir);
  try {
    const env = { TRAECN_MCP_SERVER_PATH: '/nonexistent/path/server.js' };
    const result = require('./start-mcp').resolveServerPath(env, scriptDir, { cwd: repoDir });
    expect(result).toBeNull();
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('resolveServerPath rejects directories even if they exist', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-mcp-dir-'));
  const scriptDir = makeFakeScriptDir(repoDir);
  try {
    // TRAECN_MCP_SERVER_PATH points at a directory, not a file
    const env = { TRAECN_MCP_SERVER_PATH: repoDir };
    const result = require('./start-mcp').resolveServerPath(env, scriptDir, { cwd: repoDir });
    expect(result).toBeNull();
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('resolveServerPath prefers the repository entry point over an environment override', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-mcp-prio-'));
  const scriptDir = makeFakeScriptDir(repoDir);
  const inRepoServer = path.join(repoDir, 'mcp-server.js');
  fs.writeFileSync(inRepoServer, 'module.exports = {};\n');
  const envServer = path.join(repoDir, 'custom-server.js');
  fs.writeFileSync(envServer, 'module.exports = {};\n');
  try {
    const env = { TRAECN_MCP_SERVER_PATH: envServer };
    const result = require('./start-mcp').resolveServerPath(env, scriptDir);
    expect(result).toBe(fs.realpathSync(inRepoServer));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('resolveServerPath ignores empty string env var', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-mcp-empty-env-'));
  const scriptDir = makeFakeScriptDir(repoDir);
  const inRepoServer = path.join(repoDir, 'mcp-server.js');
  fs.writeFileSync(inRepoServer, 'module.exports = {};\n');
  try {
    const env = { TRAECN_MCP_SERVER_PATH: '' };
    const result = require('./start-mcp').resolveServerPath(env, scriptDir);
    expect(result).toBe(fs.realpathSync(inRepoServer));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('resolveServerPath finds the installed traecnclaw package from the launch directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-mcp-package-'));
  const scriptDir = makeFakeScriptDir(path.join(root, 'skill-root'));
  const packageDir = path.join(root, 'runtime', 'node_modules', 'traecnclaw');
  const serverFile = path.join(packageDir, 'mcp-server.js');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: 'traecnclaw',
    exports: { './mcp': './mcp-server.js' }
  }));
  fs.writeFileSync(serverFile, 'module.exports = { startStdioServer() {} };\n');
  try {
    const result = require('./start-mcp').resolveServerPath({}, scriptDir, {
      cwd: path.join(root, 'runtime')
    });
    expect(result).toBe(fs.realpathSync(serverFile));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveServerPath finds the scoped public package from the launch directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-mcp-scoped-package-'));
  const scriptDir = makeFakeScriptDir(path.join(root, 'skill-root'));
  const packageDir = path.join(root, 'runtime', 'node_modules', '@luckycat133', 'traecnclaw');
  const serverFile = path.join(packageDir, 'mcp-server.js');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: '@luckycat133/traecnclaw',
    exports: { './mcp': './mcp-server.js' }
  }));
  fs.writeFileSync(serverFile, 'module.exports = { startStdioServer() {} };\n');
  try {
    const result = require('./start-mcp').resolveServerPath({}, scriptDir, {
      cwd: path.join(root, 'runtime')
    });
    expect(result).toBe(fs.realpathSync(serverFile));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveServerPath falls back to a traecnclaw-mcp executable on PATH', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-mcp-path-'));
  const scriptDir = makeFakeScriptDir(path.join(root, 'skill-root'));
  const binDir = path.join(root, 'bin');
  const serverFile = path.join(binDir, 'traecnclaw-mcp');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(serverFile, '#!/usr/bin/env node\nmodule.exports = { startStdioServer() {} };\n');
  fs.chmodSync(serverFile, 0o755);
  try {
    const result = require('./start-mcp').resolveServerPath({ PATH: binDir }, scriptDir, {
      cwd: root,
      platform: 'darwin'
    });
    expect(result).toBe(fs.realpathSync(serverFile));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PATH symlinks start in the server directory and load its local config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-mcp-symlink-'));
  const scriptDir = makeFakeScriptDir(path.join(root, 'skill-root'));
  const launcher = path.join(scriptDir, 'start-mcp.js');
  const runtimeDir = path.join(root, 'runtime');
  const binDir = path.join(root, 'bin');
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'start-mcp.js'), launcher);
    fs.writeFileSync(path.join(runtimeDir, '.env'), 'fixture=server-owned-config\n');
    const serverFile = path.join(runtimeDir, 'mcp-server.js');
    fs.writeFileSync(serverFile, [
      "const fs = require('fs');",
      'module.exports = { startStdioServer() {',
      "  process.stdout.write(JSON.stringify({ cwd: process.cwd(), config: fs.readFileSync('.env', 'utf8') }));",
      '} };'
    ].join('\n'));
    fs.symlinkSync(serverFile, path.join(binDir, 'traecnclaw-mcp'));
    const launched = spawnSync(process.execPath, [launcher], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: binDir, NODE_PATH: '' }
    });
    assert.strictEqual(launched.status, 0, launched.stderr || launched.stdout);
    assert.deepStrictEqual(JSON.parse(launched.stdout), {
      cwd: fs.realpathSync(runtimeDir),
      config: 'fixture=server-owned-config\n'
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('complete canonical and .codex Skill copies start the same real MCP stdio surface', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-mcp-codex-stdio-'));
  const repoRoot = path.resolve(__dirname, '../../..');
  const skillRoot = path.resolve(__dirname, '..');
  const canonicalSkill = path.join(root, 'skills', 'traecnclaw-mcp');
  const codexSkill = path.join(root, '.codex', 'skills', 'traecnclaw-mcp');
  const cwd = path.join(root, 'launch');
  try {
    fs.mkdirSync(cwd);
    fs.copyFileSync(path.join(repoRoot, 'mcp-server.js'), path.join(root, 'mcp-server.js'));
    fs.cpSync(path.join(repoRoot, 'src'), path.join(root, 'src'), { recursive: true });
    // Preserve runtime metadata without an installed-package self-reference,
    // so the package fallback cannot hide an incorrect repository path.
    const packageInfo = require(path.join(repoRoot, 'package.json'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: packageInfo.version }));
    fs.cpSync(skillRoot, canonicalSkill, { recursive: true });
    fs.cpSync(skillRoot, codexSkill, { recursive: true });

    const canonical = await readStdioSurface(path.join(canonicalSkill, 'scripts', 'start-mcp.js'), cwd);
    const generated = await readStdioSurface(path.join(codexSkill, 'scripts', 'start-mcp.js'), cwd);
    assert.deepStrictEqual(generated, canonical);
    assert.strictEqual(generated[0].result.protocolVersion, '2025-11-25');
    assert.strictEqual(generated[0].result.serverInfo.name, 'traecnclaw');
    assert.deepStrictEqual(generated[1].result.tools, require(path.join(repoRoot, 'mcp-server')).MCP_TOOLS);
    assert.strictEqual(generated[1].result.tools.length, 20);

    const setup = spawnSync(process.execPath, [path.join(codexSkill, 'scripts', 'setup-mcp.js')], {
      cwd,
      encoding: 'utf8',
      env: { PATH: '', NODE_PATH: '' }
    });
    assert.strictEqual(setup.status, 0, setup.stderr || setup.stdout);
    assert.deepStrictEqual(JSON.parse(setup.stdout).mcpServers.traecn.args, [
      fs.realpathSync(path.join(codexSkill, 'scripts', 'start-mcp.js'))
    ]);
    assert.ok(setup.stderr.includes(fs.realpathSync(path.join(root, 'mcp-server.js'))));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Runner ---

async function runTests() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
      failed++;
    }
  }

  console.log(`\n[start-mcp Test] Results: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

runTests().then(success => {
  process.exit(success ? 0 : 1);
}).catch(err => {
  console.error('[start-mcp Test] Fatal error:', err);
  process.exit(1);
});
